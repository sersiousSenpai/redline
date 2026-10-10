// SPDX-License-Identifier: Apache-2.0
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDown } from "lucide-react";
import { useNativeOverlayRegion } from "../hooks/useNativeOverlayRegion";
import { useHasSharedDraft } from "../hooks/useSharedDraft";
import { BOOT_ATTR } from "../lib/boot";
import { FRONT_DOOR_TEXT_KEY } from "../lib/frontDoor";
import { isFrontDoorKey } from "../lib/keymap";
import { isEditableTarget } from "../lib/landing";
import { SHELL_EDGE } from "../lib/paneLayout";
import { DOOR_CLOSE_MS, DOOR_GROW_MS, flipBackKeyframes, flipKeyframes, ISLAND_EASE_IN, ISLAND_FADE_MS, SWAP_SPRING, type SwapRect } from "../lib/springSwap";
import { beginWindowDrag, toggleWindowMaximize } from "../lib/windowDrag";
import type { CardRelease } from "./MonochatCard";
import "./MonochatIsland.css";

// One Redline island on every surface, in two poses.
//
// The COMPACT card springs out of the footer pill when the pointer rests on
// it: a small composer that never takes the caret and leaves when you do (see
// MonochatCard). A click on the pill — or Shift+Enter, ⌘J, ⌘⇧N — opens the
// DOOR: the full-page room on its paper backdrop, modal, with the caret in its
// composer. On the document's empty plate the door also RESTS, unengaged, in
// the plate's free area: headline, composer and recents, and no pill, because
// the door itself is the way in.
//
// Both poses come out of the pill and go back into it. The door springs from
// the card it grows out of (draft, caret and selection carried over), else
// from the pill; the paper fades in behind it, the welcome a beat later.
// Closing, it falls back toward the pill while the paper fades. On the empty
// plate the composer never moves at all — engaging it only brings the paper.

export type LandingFit = "full" | "pills" | "bare" | "none";

/** What a resting door can show in `height` px of free plate: headline +
 *  composer + pills, composer + pills, the composer alone, or nothing. */
export function landingFit(height: number): LandingFit {
  // The pills are up to three labelled rows hung below the composer, and
  // the composer is centred, so each threshold pays for the taller side twice.
  // The page list sizes itself to whatever is left below (FrontDoor's
  // `browseRoom`), so these only budget for the headline and the chip rows.
  if (height >= 480) return "full";
  if (height >= 360) return "pills";
  if (height >= 170) return "bare";
  return "none";
}

/** Below this much plate width the resting door does not land at all. */
const MIN_LANDING_WIDTH = 360;
/** A pointer RESTING on the pill, not one crossing the footer on its way to
 *  the terminal under it. */
const HOVER_OPEN_MS = 150;
/** The welcome waits for the door to be under way before it fades in... */
const WELCOME_DELAY_MS = 120;
const WELCOME_FADE_MS = 260;
/** ...and is gone first when the door goes back. */
const WELCOME_OUT_MS = 100;
/** The gentle rise of a room holding a chat: no composer box to spring. */
const ROOM_RISE_MS = 260;

// The compact card is its own chunk: nothing on the boot path needs it until
// a pointer rests on the pill, and the dwell is long enough to fetch it.
const loadCard = () => import("./MonochatCard");
const MonochatCard = lazy(loadCard);

/** A menu, picker or dialog layered over the island owns the pointer and Esc.
 *  Not one the open door's sweep left inert behind it: that one is under. */
const hasChildOverlay = () => Array.from(document.querySelectorAll('[role="menu"], [role="dialog"]:not(.rl-frontdoor-focus), dialog[open]')).some(overlay => !overlay.closest("[inert]"));
/** Not in the chat slot while it is folded away (`hidden`). */
const shown = (element: Element) => !element.closest("[hidden]");
/** The composer the door puts the caret in — a chat's own when it holds one. */
const composerIn = (root: HTMLElement | null) => {
  const fields = Array.from(root?.querySelectorAll<HTMLTextAreaElement>("textarea") ?? []).filter(shown);
  return fields.find(field => field.closest("[data-chat-composer]")) ?? fields[0] ?? null;
};
const box = (element: Element): SwapRect => {
  const r = element.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
};
/** Where focus goes when where it was is gone: the surface's own main area,
 *  never nothing (WCAG 2.4.3). Focusable only until focus moves on, so a
 *  click on the page's plain text still focuses nothing. */
const focusMain = () => {
  const main = document.querySelector<HTMLElement>(".rl-doc-column");
  if (!main) return (document.activeElement as HTMLElement | null)?.blur();
  if (!main.hasAttribute("tabindex")) {
    main.tabIndex = -1;
    main.addEventListener("blur", () => main.removeAttribute("tabindex"), { once: true });
  }
  main.focus({ preventScroll: true });
};

export function MonochatIsland({ open, onOpenChange, compactOpen = false, onCompactChange, compact, landing = false, onVisibilityChange, context, busy, arrivals = 0, announce = "", onNewChat, surfaceKey = "", clearanceKey = "", children }: {
  /** The door: the full-page room. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The compact card. Its content is rendered while it is open, and held as
   *  it last was while the card goes back into the pill. */
  compactOpen?: boolean;
  onCompactChange?: (open: boolean) => void;
  compact?: ReactNode;
  /** The empty plate: the door rests there, unengaged, instead of the pill. */
  landing?: boolean;
  onVisibilityChange?: (visible: boolean) => void;
  context: string;
  busy: boolean;
  /** Plans that arrived while you were busy elsewhere and are still unseen:
   *  the pill wears their count. Nothing opens for them. */
  arrivals?: number;
  /** Said politely to a screen reader: a launch handed off, a plan arrived.
   *  The pill only shows "Working", and a label change is never read out. */
  announce?: string;
  /** The room is holding a chat. Its heading names it and carries the one
   *  New, back to the composer. */
  onNewChat?: () => void;
  /** Where the user is. A change is navigation they started: whatever is
   *  open closes behind them. Never a plan merely arriving. */
  surfaceKey?: string;
  /** Anything that moves the footer: the pill re-measures its row. */
  clearanceKey?: string;
  children: ReactNode;
}) {
  const [reduced, setReduced] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  const launcher = useRef<HTMLButtonElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const membrane = useRef<HTMLSpanElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const room = useRef<HTMLDivElement>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const backdropPress = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  // Closed by navigation: the new surface owns focus.
  const navigated = useRef(false);
  const previousSurface = useRef(surfaceKey);
  const previousOpen = useRef(false);
  const overPill = useRef(false);
  const dwell = useRef(0);
  const close = useRef(onOpenChange); close.current = onOpenChange;
  const compactChange = useRef(onCompactChange); compactChange.current = onCompactChange;
  // A sentence waiting in the composer: the pill wears a dot for it. It never
  // holds anything open — the draft is kept either way.
  const draft = useHasSharedDraft(FRONT_DOOR_TEXT_KEY);
  // How much of the door the plate's free area can hold at rest. The door
  // lands in the space BETWEEN the header and the terminal dock — never on top
  // of the terminals — and sheds its furniture rather than overflow: headline
  // first, then the recents, and below a bare composer it does not land at
  // all (the pill in the footer is still the way in).
  const [fit, setFit] = useState<LandingFit>("full");
  const landed = landing && fit !== "none";
  const visible = open || landed;
  // Open on the empty plate, the door keeps the plate's insets: only the
  // backdrop spreads to the window, so the box you clicked or typed into
  // never moves under the caret. A chat needs the whole room.
  const inset = landed && !onNewChat;
  const live = useRef({ open, compactOpen }); live.current = { open, compactOpen };
  useNativeOverlayRegion(launcher, !visible);
  // The door on its way back toward the pill: still painted, already inert.
  const [closing, setClosing] = useState(false);
  const flight = useRef<Animation[]>([]);
  // The card a door is growing out of: where to spring from, and the
  // selection its field had.
  const growFrom = useRef<Pick<CardRelease, "rect" | "selection"> | null>(null);
  // The card stays mounted on its way back into the pill, showing what it
  // held as it left; it is gone at once when the door grows out of it.
  const [cardOut, setCardOut] = useState(false);
  const cardOpen = compactOpen && !visible;
  const cardContent = useRef<ReactNode>(null);
  if (cardOpen) cardContent.current = compact;

  /** Where the caret was before the island took it, to hand it back. */
  const remember = (active = document.activeElement) => {
    if (returnFocus.current || !(active instanceof HTMLElement) || active === document.body || active === launcher.current) return;
    if (layer.current?.contains(active) || active.closest(".rl-monochat-float")) return;
    returnFocus.current = active;
  };
  // Every opening starts clean: a navigation nothing was open for leaves
  // no mark on the next one.
  const openCompact = () => {
    navigated.current = false;
    remember();
    compactChange.current?.(true);
  };
  // Into the door, from the pill, a key or the resting composer. An open
  // compact card grows into it, draft and all.
  const engage = () => {
    window.clearTimeout(dwell.current);
    if (!live.current.open) navigated.current = false;
    remember();
    if (live.current.compactOpen) compactChange.current?.(false);
    close.current(true);
  };
  // The card's last word as it leaves. Growing into the door, it hands over
  // its box and selection and the door keeps the caret; otherwise a card that
  // held the caret hands it back — to where it was, or after navigation (or
  // with that gone) to the new surface's main area.
  const releaseCard = ({ caret, rect, selection }: CardRelease) => {
    if (live.current.open) { growFrom.current = { rect, selection }; return; }
    const remembered = returnFocus.current;
    returnFocus.current = null;
    const away = navigated.current;
    navigated.current = false;
    if (!caret) return;
    if (away || remembered && !remembered.isConnected) focusMain();
    else if (remembered) remembered.focus({ preventScroll: true });
    else (document.activeElement as HTMLElement | null)?.blur();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Capture before editors and xterm can consume the chord — but never
      // from a text field, where Shift+Enter is the newline (a composer, a
      // web form, Claude Code's own prompt in the terminal). With the
      // pointer on the pill it is aimed at the pill. Once the door is open,
      // Shift+Enter is a newline in its composer.
      if (open || event.isComposing || event.keyCode === 229 || !isFrontDoorKey(event)) return;
      if (isEditableTarget(event.target as HTMLElement | null) && !overPill.current) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (!event.repeat) engage();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("redline:open-front-door", engage);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("redline:open-front-door", engage);
    };
    // Everything else these read is a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useLayoutEffect(() => {
    const footer = document.querySelector<HTMLElement>(".rl-app-footer");
    const header = document.querySelector<HTMLElement>(".rl-app-header");
    const termDock = document.querySelector<HTMLElement>(".rl-term-dock");
    // The plate's column. Its horizontal edges bound the resting door the way
    // the header and dock bound it vertically — without them the layer spans
    // the whole window and the composer lands across the sessions sidebar.
    const plate = document.querySelector<HTMLElement>(".rl-doc-column");
    const position = () => {
      const rect = footer?.getBoundingClientRect();
      // Center within the existing footer row. This fixed overlay contributes
      // no height and never moves the footer or the main viewport.
      const clearance = rect && rect.height >= 32
        ? window.innerHeight - (rect.top + rect.height / 2) - 20
        : 8;
      if (dock.current) dock.current.style.bottom = `${clearance}px`;
      layer.current?.style.setProperty("--portal-return-bottom", `${clearance + 4}px`);
      // Keep the existing title-bar reach without covering conversation
      // content. Only transparent hit regions use this measurement. The
      // room's box is read without its transform: an observer can land
      // mid-entrance, and a strip sized to the risen box would cover the
      // room's heading once it settles.
      const roomTop = room.current ? (layer.current?.getBoundingClientRect().top ?? 0) + room.current.offsetTop : 0;
      const top = Math.max(SHELL_EDGE, Math.min(header?.getBoundingClientRect().bottom || 28, roomTop || 28));
      layer.current?.style.setProperty("--portal-drag-top", `${top}px`);
      // The plate's free area: header bottom down to the dock's top (or the
      // footer's, with the dock folded). Published as insets the door keeps
      // on the empty plate, resting or engaged; a chat lets go of them.
      const dockRect = termDock?.getBoundingClientRect();
      const areaTop = header?.getBoundingClientRect().bottom ?? 0;
      const areaBottom = dockRect && dockRect.height > 0 ? dockRect.top : rect && rect.height > 0 ? rect.top : window.innerHeight;
      layer.current?.style.setProperty("--fd-rest-top", `${Math.max(0, areaTop)}px`);
      layer.current?.style.setProperty("--fd-rest-bottom", `${Math.max(0, window.innerHeight - areaBottom)}px`);
      const plateRect = plate?.getBoundingClientRect();
      const areaLeft = plateRect && plateRect.width > 0 ? plateRect.left : 0;
      const areaRight = plateRect && plateRect.width > 0 ? plateRect.right : window.innerWidth;
      layer.current?.style.setProperty("--fd-rest-left", `${Math.max(0, areaLeft)}px`);
      layer.current?.style.setProperty("--fd-rest-right", `${Math.max(0, window.innerWidth - areaRight)}px`);
      // Too narrow for even a bare composer: don't land (the notch remains).
      setFit(areaRight - areaLeft < MIN_LANDING_WIDTH ? "none" : landingFit(areaBottom - areaTop));
    };
    position();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
    if (footer) observer?.observe(footer);
    if (header) observer?.observe(header);
    if (termDock) observer?.observe(termDock);
    if (plate) observer?.observe(plate);
    window.addEventListener("resize", position);
    return () => { observer?.disconnect(); window.removeEventListener("resize", position); };
  }, [surfaceKey, clearanceKey, open]);

  useEffect(() => { onVisibilityChange?.(visible); }, [visible, onVisibilityChange]);
  // The door coming up takes the card's place; it never comes back by itself.
  useEffect(() => { if (visible && compactOpen) compactChange.current?.(false); }, [visible, compactOpen]);
  useLayoutEffect(() => { if (cardOpen) setCardOut(true); }, [cardOpen]);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media?.matches ?? false);
    media?.addEventListener("change", update);
    return () => media?.removeEventListener("change", update);
  }, []);
  useEffect(() => () => window.clearTimeout(dwell.current), []);
  useLayoutEffect(() => {
    if (previousSurface.current === surfaceKey) return;
    previousSurface.current = surfaceKey;
    // An owner that closes the door on its way somewhere (a recent) is going
    // somewhere all the same: this runs before the close below, which reads it.
    if (!open && !previousOpen.current && !compactOpen) {
      // A recent taken from the resting door by keyboard: the caret was on
      // it, and the door it rested in is going.
      if (layer.current?.contains(document.activeElement)) focusMain();
      return;
    }
    navigated.current = true;
    if (open) close.current(false);
    if (compactOpen) compactChange.current?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfaceKey]);

  useLayoutEffect(() => {
    if (!open) return;
    // Keep the workspace mounted (including native browser state), but make
    // its controls unavailable while the opaque front door owns the screen.
    // A modal layer of its own — a dialog, or the tour that wraps one — stays
    // live above it, and so does a status line: it has nothing to press, and
    // silencing it would swallow what it says.
    const restored: Array<[HTMLElement, boolean]> = [];
    let branch: HTMLElement | null = layer.current;
    while (branch && branch !== document.body) {
      for (const sibling of Array.from(branch.parentElement?.children ?? [])) {
        if (sibling !== branch && sibling instanceof HTMLElement && !sibling.matches('script, style, [role="dialog"], dialog, [data-rl-modal-layer], [role="status"]')) {
          restored.push([sibling, sibling.inert]); sibling.inert = true;
        }
      }
      branch = branch.parentElement;
    }
    return () => { for (const [element, inert] of restored) element.inert = inert; };
  }, [open]);
  // The door's flights (see the note at the top). The paper is a CSS
  // transition on the layer's backdrop; these move the room — transform and
  // opacity only, since they run past 300 ms (perf rule 6).
  const settle = () => {
    for (const animation of flight.current) animation.cancel();
    flight.current = [];
    if (room.current) room.current.style.transformOrigin = "";
  };
  // Lines the room's transform up on its composer, so a FLIP of the room is
  // a FLIP of the box you type in.
  const aim = (shell: HTMLElement, composer: Element) => {
    const target = box(composer), frame = shell.getBoundingClientRect();
    shell.style.transformOrigin = `${target.left - frame.left}px ${target.top - frame.top}px`;
    return target;
  };
  // Whether the room was holding a chat when it was last open: leaving, the
  // chat goes to the dock on its own, and the room has nothing to carry back.
  const heldChat = useRef(false);
  if (open) heldChat.current = !!onNewChat;
  useLayoutEffect(() => {
    const shell = room.current;
    settle();
    const composer = shell && !heldChat.current ? Array.from(shell.querySelectorAll(".rl-frontdoor")).find(shown) : null;
    const from = growFrom.current?.rect ?? (membrane.current ? box(membrane.current) : null);
    if (open) {
      setClosing(false);
      // On the plate the composer is already in place: engaging it only fades
      // the paper in, and the box you clicked or typed into never moves.
      if (inset || !shell?.animate) return;
      if (reduced) {
        flight.current = [shell.animate([{ opacity: 0 }, { opacity: 1 }], ISLAND_FADE_MS)];
      } else if (!composer || !from) {
        // A chat has no composer box to spring from the pill: it rises.
        flight.current = [shell.animate([
          { transform: "translate3d(0, 16px, 0) scale(.985)", opacity: 0 },
          { transform: "none", opacity: 1 },
        ], { duration: ROOM_RISE_MS, easing: "cubic-bezier(.2,.8,.2,1)" })];
      } else {
        flight.current = [
          shell.animate(flipKeyframes(from, aim(shell, composer)), { duration: DOOR_GROW_MS, easing: SWAP_SPRING }),
          // The headline and recents follow once the box is on its way — up
          // to whatever they rest at (a sentence in the box keeps them out):
          // one keyframe at 0, the end left to the stylesheet.
          ...Array.from(shell.querySelectorAll<HTMLElement>(".rl-fd-welcome"), (welcome) =>
            welcome.animate([{ opacity: 0, offset: 0 }], { duration: WELCOME_FADE_MS, delay: WELCOME_DELAY_MS, fill: "backwards" })),
        ];
        // Out of the pill the box starts pill-sized, and its squeezed text
        // stays a blur until the shape is mostly there. Out of a card it is
        // the composer you were just typing in, solid all the way.
        if (!growFrom.current) flight.current.push(shell.animate([{ opacity: 0.35 }, { opacity: 1, offset: 0.35 }], DOOR_GROW_MS));
        flight.current[0].onfinish = settle;
      }
      return;
    }
    // Shut back to rest on the plate: only the paper goes.
    if (!previousOpen.current || landed) return;
    setClosing(true);
    const timer = window.setTimeout(() => setClosing(false), reduced ? ISLAND_FADE_MS : DOOR_CLOSE_MS);
    if (shell?.animate) {
      flight.current = [
        reduced ? shell.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ISLAND_FADE_MS, fill: "forwards" })
          : !composer || !from ? shell.animate([{ opacity: 0 }, { opacity: 0 }], { duration: DOOR_CLOSE_MS, fill: "forwards" })
          : shell.animate(flipBackKeyframes(from, aim(shell, composer)), { duration: DOOR_CLOSE_MS, easing: ISLAND_EASE_IN, fill: "forwards" }),
      ];
      // Only the box goes back into the pill: the headline and recents are
      // out of the way in its first moments, not shrinking over the work.
      if (!reduced) {
        for (const welcome of shell.querySelectorAll<HTMLElement>(".rl-fd-welcome")) {
          flight.current.push(welcome.animate([{ opacity: 0, offset: 1 }], { duration: WELCOME_OUT_MS, fill: "forwards" }));
        }
      }
    }
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // Back at the pill: the layer goes, and its flight with it, in one frame.
  useLayoutEffect(() => {
    if (!closing && !live.current.open) settle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closing]);
  useEffect(() => {
    if (open && !previousOpen.current) {
      remember();
      // However it was summoned — a click, a key, ⌘J — the caret goes into
      // the composer, at the end of the draft: the door is for typing. The
      // welcome stays until you do. Grown out of a card whose field was in
      // use, the caret (or selection) lands where the card had it.
      const field = composerIn(body.current);
      field?.focus({ preventScroll: true });
      if (field) {
        const end = field.value.length, [start, stop, direction] = growFrom.current?.selection ?? [end, end, "none"];
        field.setSelectionRange(Math.min(start, end), Math.min(stop, end), direction);
      }
      growFrom.current = null;
    } else if (!open && previousOpen.current) {
      // A chat carried out to the dock took its focused composer with it,
      // which leaves the caret nowhere: that is the door's to hand back too —
      // to where it was, else the pill; after navigation, or with where it
      // was gone, to the new surface's main area.
      const active = document.activeElement;
      if (!active || active === document.body || layer.current?.contains(active)) {
        const remembered = returnFocus.current;
        if (navigated.current || remembered && !remembered.isConnected) focusMain();
        else if (remembered) remembered.focus({ preventScroll: true });
        else if (!visible) launcher.current?.focus({ preventScroll: true });
        else (active as HTMLElement | null)?.blur();
      }
      returnFocus.current = null;
      navigated.current = false;
    }
    previousOpen.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    const button = launcher.current, skin = membrane.current;
    if (!button || !skin || visible || reduced) return;
    let rect = button.getBoundingClientRect(), frame = 0;
    let point: { x: number; y: number } | null = null;
    let last = "";
    const reset = () => { point = null; schedule(); };
    const paint = () => {
      frame = 0;
      const dx = point ? point.x - (rect.left + rect.width / 2) : 0;
      const dy = point ? point.y - (rect.top + rect.height / 2) : 0;
      const distance = point ? Math.hypot(Math.max(0, Math.abs(dx) - rect.width / 2), dy) : Infinity;
      const pull = Math.max(0, 1 - distance / 180) ** 2;
      const x = Math.max(-2, Math.min(2, dx * .02)) * pull;
      // A small lift inside the fixed hit region; never move browser geometry.
      const y = -3 * pull;
      const key = `${x.toFixed(2)},${y.toFixed(2)},${pull.toFixed(3)}`;
      if (key === last) return;
      last = key;
      skin.style.setProperty("--portal-x", `${x.toFixed(2)}px`);
      skin.style.setProperty("--portal-y", `${y.toFixed(2)}px`);
      skin.style.setProperty("--portal-pull", pull.toFixed(3));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };
    const move = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      point = { x: event.clientX, y: event.clientY }; schedule();
    };
    const measure = () => { rect = button.getBoundingClientRect(); reset(); };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(button);
    const placement = new MutationObserver(measure);
    if (dock.current) placement.observe(dock.current, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("pointermove", move, { passive: true });
    document.documentElement.addEventListener("pointerleave", reset);
    window.addEventListener("blur", reset);
    window.addEventListener("resize", measure);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect(); placement.disconnect();
      window.removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("pointerleave", reset);
      window.removeEventListener("blur", reset);
      window.removeEventListener("resize", measure);
      skin.style.removeProperty("--portal-x"); skin.style.removeProperty("--portal-y"); skin.style.removeProperty("--portal-pull");
    };
  }, [visible, reduced, surfaceKey, clearanceKey]);

  // Hover means LOOK: a pointer resting on the pill springs the compact card
  // out without touching the caret. Mouse and trackpad only, and never mid-
  // press, mid-drag, under a menu or dialog, or while the boot doors move.
  const hoverIn = (event: ReactPointerEvent) => {
    overPill.current = true;
    void loadCard();
    if (event.pointerType === "touch" || event.buttons || visible || closing || compactOpen || !onCompactChange) return;
    window.clearTimeout(dwell.current);
    dwell.current = window.setTimeout(() => {
      if (hasChildOverlay() || document.documentElement.hasAttribute(BOOT_ATTR)) return;
      openCompact();
    }, HOVER_OPEN_MS);
  };
  const hoverOut = () => { overPill.current = false; window.clearTimeout(dwell.current); };

  const isBackdrop = (target: EventTarget) =>
    target === layer.current || target === room.current || target === body.current || target === conversation.current;
  const dragWindow = (event: ReactMouseEvent) => {
    if (event.button !== 0) return;
    event.preventDefault(); // Moving the window must not blur the composer.
    beginWindowDrag(event);
  };
  useEffect(() => {
    if (!open) return;
    const start = (event: PointerEvent) => {
      // Observe the DOM capture phase because the selected chat can be a
      // React portal owned by App, outside this component's event ancestry.
      backdropPress.current = event.button === 0 && !!event.target && isBackdrop(event.target) && !hasChildOverlay();
    };
    document.addEventListener("pointerdown", start, true);
    return () => { document.removeEventListener("pointerdown", start, true); backdropPress.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!open) return;
    // Modal for keys too: a window-level listener behind the door must never
    // hear a Space pressed in it. Its default — the space in the composer, a
    // button's press — stands. The release is left to reach the window: the
    // voice panel hears it only to end a talk held since before the door
    // opened, which must still end.
    const onKey = (event: KeyboardEvent) => {
      if (event.code === "Space") event.stopPropagation();
      // Saved chats are App-owned portals. Follow DOM containment after
      // child handlers have run, rather than relying on React ancestry. With
      // the caret nowhere at all, the door is all there is to act on.
      const target = event.target, root = layer.current;
      if (!root || !(target instanceof Node) || !(target === document.body || root.contains(target)) || event.defaultPrevented || event.isComposing || hasChildOverlay()) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(false); }
      if (event.key === "Tab") {
        const focusable = Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [href], [tabindex="0"]')).filter(element => element.getClientRects().length && !element.closest('[hidden], [inert], [aria-hidden="true"]'));
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === body.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === body.current)) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Resting, the door engages on a press in its composer or a keystroke
  // typed into it — never on focus alone, so tabbing across the plate opens
  // nothing (WCAG 3.2.1), and a press or a key on a recent goes where the
  // recent goes.
  const inBox = (target: EventTarget) => !!(target as Element).closest?.(".rl-fd-island");
  const restingEngage = landed && !open ? {
    onPointerDownCapture: (event: ReactPointerEvent) => { if (event.button === 0 && inBox(event.target)) engage(); },
    onKeyDownCapture: (event: ReactKeyboardEvent) => { if (inBox(event.target) && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing && (event.key.length === 1 || event.key === "Enter" || event.key === "Backspace" || event.key === "Delete")) engage(); },
  } : {};

  const entrance = <button ref={launcher} type="button" className="rl-monochat-notch" data-hidden={visible} data-busy={busy} data-reduced={reduced}
    tabIndex={visible ? -1 : 0} aria-hidden={visible}
    aria-label={`Open front door${busy ? ", working" : ""}${draft ? ", draft saved" : ""}${arrivals ? `, ${arrivals} new plan${arrivals === 1 ? "" : "s"}` : ""}`}
    title="Open front door (Shift+Enter)" aria-keyshortcuts="Shift+Enter"
    aria-expanded={open} aria-controls="rl-monochat-content"
    onFocus={event => { if (event.relatedTarget instanceof HTMLElement && !layer.current?.contains(event.relatedTarget)) remember(event.relatedTarget); }}
    // Tabbed on past, with nothing opened: where it came from is no longer
    // where anyone was.
    onBlur={() => { if (!live.current.open && !live.current.compactOpen) returnFocus.current = null; }}
    onPointerEnter={hoverIn} onPointerLeave={hoverOut}
    onClick={engage}>
    <span ref={membrane} className="rl-portal-membrane" aria-hidden="true"><span className="rl-monochat-signal"><i/><i/><i/></span><span>{busy ? "Working" : "Redline"}</span>{draft && <span className="rl-monochat-draft"/>}{arrivals > 0 && <span className="rl-monochat-news">{arrivals}</span>}</span>
  </button>;

  return <>
    <div ref={dock} className="rl-frontdoor-dock">
      {entrance}
      {(cardOpen || cardOut) && <Suspense fallback={null}>
        <MonochatCard pill={launcher} open={cardOpen} growing={visible} hovered={() => overPill.current}
          onClose={() => compactChange.current?.(false)} onRelease={releaseCard} onGone={() => setCardOut(false)}>{cardContent.current}</MonochatCard>
      </Suspense>}
    </div>
    {/* Outside the door, and spared by its inert sweep, so a launch from the
        card and one from the door are both heard. */}
    <div className="sr-only" role="status" aria-live="polite">{announce}</div>
    <div ref={layer} className="rl-frontdoor-focus" data-open={open} data-visible={visible} data-closing={closing || undefined} data-reduced={reduced}
      data-rest={inset ? fit : undefined}
      role={open ? "dialog" : undefined} aria-modal={open || undefined} aria-label={open ? "Front door" : undefined}
      inert={!visible} aria-hidden={!visible}
      onClickCapture={event => {
        // Preserve text-selection drags and let menus handle their own dismissal.
        const dismiss = backdropPress.current && isBackdrop(event.target);
        backdropPress.current = false;
        if (!open || !dismiss || hasChildOverlay()) return;
        event.preventDefault(); event.stopPropagation(); onOpenChange(false);
      }}>
        {open && <div aria-hidden="true" style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 3 }}>
          {/* Match the shell's edges using invisible hit regions. These do
              not participate in layout or change the front door's paint. */}
          <div data-window-drag-edge="top" onMouseDown={dragWindow} onDoubleClick={toggleWindowMaximize} style={{ position: "absolute", top: 0, left: 0, right: 0, height: "var(--portal-drag-top, 28px)", pointerEvents: "auto" }}/>
          <div data-window-drag-edge="left" onMouseDown={dragWindow} style={{ position: "absolute", top: "var(--portal-drag-top, 28px)", bottom: SHELL_EDGE, left: 0, width: SHELL_EDGE, pointerEvents: "auto" }}/>
          <div data-window-drag-edge="right" onMouseDown={dragWindow} style={{ position: "absolute", top: "var(--portal-drag-top, 28px)", bottom: SHELL_EDGE, right: 0, width: SHELL_EDGE, pointerEvents: "auto" }}/>
          <div data-window-drag-edge="bottom" onMouseDown={dragWindow} style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: SHELL_EDGE, pointerEvents: "auto" }}/>
        </div>}
        {open && <button className="rl-frontdoor-return" type="button" onClick={() => onOpenChange(false)} aria-label="Return to workspace" title="Return to workspace (Esc)"><ChevronDown size={18}/></button>}
      <div ref={room} className="rl-monochat" data-pose={open ? "conversation" : landed ? "entry" : "notch"} data-reduced={reduced}>
        <div ref={body} id="rl-monochat-content" className="rl-monochat-content" tabIndex={-1} aria-label={`Conversation · ${context}`} {...restingEngage}>
          {open && onNewChat && <div className="rl-monochat-heading">
            <h2 className="rl-monochat-title">{context}</h2>
            <button type="button" className="rl-monochat-new" onClick={onNewChat} title="A blank composer; this conversation stays in History">New</button>
          </div>}
          <div ref={conversation} className="rl-monochat-conversation">{children}</div>
        </div>
      </div>
    </div>
  </>;
}
