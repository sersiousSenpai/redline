// SPDX-License-Identifier: Apache-2.0
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type FocusEvent as ReactFocusEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDown } from "lucide-react";
import { isFrontDoorKey } from "../lib/keymap";
import { isEditableTarget } from "../lib/landing";
import { SHELL_EDGE } from "../lib/paneLayout";
import { DOOR_CLOSE_MS, fadeOutKeyframes, ISLAND_FADE_MS, SWAP_OUT_EASING } from "../lib/springSwap";
import { beginWindowDrag, toggleWindowMaximize } from "../lib/windowDrag";
import "./MonochatIsland.css";

// The Redline island: the door, the full-page room on its paper backdrop.
// Shift+Enter (outside a text field), ⌘J and ⌘⇧N open it with the caret in
// its composer; on a door pane that is on screen and focused it also RESTS,
// unengaged, in the plate's free area: headline, composer and recents.
//
// The door ZOOMS when the user puts the caret in its box: everything but the
// box recedes — headline up, recents down, the paper over the whole window —
// until only the box is left. It comes back when the keyboard walks the caret
// out of an empty box, or the door closes; nothing the app does sets or
// clears it.
//
// It used to come out of a pill in the status bar, with a compact card
// sprung out on a hover; D27 removed both (the compact composer lives on as
// the chat pane's). The door now rises where it opens and fades as it
// closes — except when it hands off into the plan it launched, which springs
// out of its composer while the door fades where it is. Engaged on the empty
// plate, the box glides from the plate's centre to the window's as the paper
// spreads out from the plate — after the release, never under a held
// pointer — and back on close.

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
/** The welcome is gone first when the door goes back. */
const WELCOME_OUT_MS = 100;
/** The gentle rise of a room holding a chat: no composer box to spring. */
const ROOM_RISE_MS = 260;
/** The resting door's box gliding to the window's centre, and back. */
const GLIDE_IN_MS = 340;
/** The status bar's row: the door's way back sits just above it. */
const STATUS_ROW_H = 28;
const GLIDE_OUT_MS = 300;
const GLIDE_EASE = "cubic-bezier(.2,.8,.2,1)";
/** Engaged by a key, the box waits this long before it glides: the welcome
 *  (a 160 ms fade, MonochatIsland.css) is down to a tenth by then, so it
 *  recedes where it stood instead of travelling with the box. A press needs
 *  no wait — it holds the glide well past that (`GLIDE_BEAT_MS`). */
const GLIDE_DELAY_MS = 100;
/** After a press in the resting box lets go, how long the box waits for the
 *  double-click's second press before it glides. */
const GLIDE_BEAT_MS = 300;
/** The door's ⌄ fading out once it shuts (MonochatIsland.css). */
const RETURN_OUT_MS = 120;
/** What a held glide listens to, to know the pointer is done with the box. */
const GLIDE_WAITS = ["pointerdown", "pointerup", "pointercancel", "keyup", "focusin"];

/** What owns the pointer and Esc while it is up, over the island: a menu, a modal (a dialog that says it is one, a modal
 *  `<dialog>`, the tour's layer) or a picker the island's composer opened
 *  (`data-rl-island-owned`). Not any `role="dialog"`: a review's inline
 *  annotation editor calls itself one, and it is part of the work, not over
 *  it. Not the door itself, nor one its sweep left inert behind it: that one
 *  is under. Also how a plan arriving finds someone choosing in the door. */
const OVERLAY = '[role="menu"], [aria-modal="true"]:not(.rl-frontdoor-focus), dialog[open], [data-rl-modal-layer], [data-rl-island-owned]';
export const hasChildOverlay = () => Array.from(document.querySelectorAll(OVERLAY)).some(overlay => !overlay.closest("[inert]"));
/** The door's own composer box, and the context chips that ride with what it
 *  sends: where the caret is "in the box". A chat's composer is not it. */
const BOX = ".has-welcome .rl-fd-island, .has-welcome .rl-context-chips";
/** A send control in the box (`data-rl-door-go`, the start screen's Start)
 *  is not the caret going into it: pressed at rest it launches where it is,
 *  instead of zooming the door for the moment the launch takes. */
const inBox = (target: EventTarget | null) => {
  const element = target as Element | null;
  return !!element?.closest?.(BOX) && !element.closest("[data-rl-door-go]");
};
/** A key that types into a field: what engages the resting door. */
const typing = (event: ReactKeyboardEvent) => !event.metaKey && !event.ctrlKey && !event.altKey && !event.nativeEvent.isComposing
  && (event.key.length === 1 || event.key === "Enter" || event.key === "Backspace" || event.key === "Delete");
/** Not in the chat slot while it is folded away (`hidden`). */
const shown = (element: Element) => !element.closest("[hidden]");
/** The composer the door puts the caret in — a chat's own when it holds one. */
const composerIn = (root: HTMLElement | null) => {
  const fields = Array.from(root?.querySelectorAll<HTMLTextAreaElement>("textarea") ?? []).filter(shown);
  return fields.find(field => field.closest("[data-chat-composer]")) ?? fields[0] ?? null;
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

export function MonochatIsland({ open, onOpenChange, handoff = false, landing = false, onVisibilityChange, context, announce = "", onNewChat, surfaceKey = "", clearanceKey = "", plateKey = "", children }: {
  /** The door: the full-page room. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The door is closing into the plan it launched: it fades where it is, as
   *  the plan springs out of its composer, and the caret goes to the plan. */
  handoff?: boolean;
  /** The empty plate: the door rests there, unengaged. */
  landing?: boolean;
  onVisibilityChange?: (visible: boolean) => void;
  context: string;
  /** Said politely to a screen reader: a launch handed off, a plan arrived. */
  announce?: string;
  /** The room is holding a chat. Its heading names it and carries the one
   *  New, back to the composer. */
  onNewChat?: () => void;
  /** Where the user is. A change is navigation they started: whatever is
   *  open closes behind them. Never a plan merely arriving. */
  surfaceKey?: string;
  /** Anything that moves the footer: the door re-measures its insets. */
  clearanceKey?: string;
  /** The workbench layout (sets, tabs, pane tree): a door plate replaced or
   *  moved without a surface change (⌘T in another set, a split) is
   *  re-measured, never landed on from a stale rect. */
  plateKey?: string;
  children: ReactNode;
}) {
  const [reduced, setReduced] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
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
  const close = useRef(onOpenChange); close.current = onOpenChange;
  // How much of the door the plate's free area can hold at rest. The door
  // lands in the space BETWEEN the header and the footer and sheds its
  // furniture rather than overflow: headline
  // first, then the recents, and below a bare composer it does not land at
  // all (⌘T, ⇧⏎ and the palette are still the way in).
  const [fit, setFit] = useState<LandingFit>("full");
  const landed = landing && fit !== "none";
  const visible = open || landed;
  // At rest on the empty plate, the door keeps the plate's insets. Open, it
  // has the window: the box glides there (a FLIP, below), and a chat needs
  // the whole room anyway.
  const inset = landed && !onNewChat && !open;
  // The door zoomed: the user put the caret in its box (see the note at the
  // top). Held through the door's way out, so its welcome never shows on
  // the way out; on the plate the welcome comes straight back.
  const [zoom, setZoom] = useState(false);
  const zoomed = zoom && (open || !landed);
  // How the door was last summoned, read as it opens: "press" — in the
  // resting box: the box glides only once the pointer lets go; else the caret
  // goes into the composer.
  const summon = useRef<"press" | "key">("key");
  // The last key walked the focus (Tab): only the keyboard leaves a zoom.
  const walked = useRef(false);
  // The resting door's glide, held at its start while the press is down.
  const held = useRef<Animation | null>(null);
  // That glide. While it runs, a press it has left on the paper — a slow
  // double-click's second — was aimed at the box: it never closes the door.
  const glideIn = useRef<Animation | null>(null);
  // The middle of the plate's free area, where the resting door is centred.
  const restCentre = useRef<{ x: number; y: number } | null>(null);
  const live = useRef({ open }); live.current = { open };
  // The door on its way out: still painted, already inert.
  const [closing, setClosing] = useState(false);
  // The ⌄ fading out after the door shuts — a stand-in that never takes the
  // pointer.
  const [returnOut, setReturnOut] = useState(false);
  const flight = useRef<Animation[]>([]);

  /** Where the caret was before the island took it, to hand it back. */
  const remember = (active = document.activeElement) => {
    if (returnFocus.current || !(active instanceof HTMLElement) || active === document.body) return;
    if (layer.current?.contains(active)) return;
    returnFocus.current = active;
  };
  // Into the door, from a key or the resting composer.
  const engage = (via: "press" | "key") => {
    if (!live.current.open) {
      navigated.current = false;
      summon.current = via;
      // With the caret, it arrives zoomed: its welcome never shows. A room
      // holding a chat has no box of the door's to zoom on.
      setZoom(!onNewChat);
      if (via === "press") {
        // The box glides only once the pointer is done with it: never while
        // a press is down, not for a double-click's beat after one lets go
        // (the second click lands where the first did, not on the paper, which
        // would close the door), and not while a menu that click opened on one
        // of its chips is up — placed where the chip rests, it would be left
        // behind. A key typed goes at once: typing never minds the box moving.
        let down = true, timer = 0;
        const stop = () => { window.clearTimeout(timer); for (const type of GLIDE_WAITS) window.removeEventListener(type, wait, true); };
        const wait = (event: Event) => {
          window.clearTimeout(timer);
          if (event.type === "pointerdown") down = true;
          else if (event.type === "pointerup" || event.type === "pointercancel") down = false;
          if (down) return;
          if (!held.current) return stop();
          timer = window.setTimeout(() => {
            if (!held.current) return stop();
            if (hasChildOverlay()) return;
            stop(); held.current.play(); held.current = null;
          }, event.type.startsWith("pointer") ? GLIDE_BEAT_MS : 0);
        };
        for (const type of GLIDE_WAITS) window.addEventListener(type, wait, true);
      }
    }
    remember();
    close.current(true);
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Capture before editors and xterm can consume the chord — but never
      // from a text field, where Shift+Enter is the newline (a composer, a
      // web form, Claude Code's own prompt in the terminal). Once the door is
      // open, Shift+Enter is a newline in its composer.
      if (open || event.isComposing || event.keyCode === 229 || !isFrontDoorKey(event)) return;
      if (isEditableTarget(event.target as HTMLElement | null)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (!event.repeat) engage("key");
    };
    const fromPage = () => engage("key");
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("redline:open-front-door", fromPage);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("redline:open-front-door", fromPage);
    };
    // Everything else these read is a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useLayoutEffect(() => {
    const footer = document.querySelector<HTMLElement>(".rl-app-footer");
    const header = document.querySelector<HTMLElement>(".rl-app-header");
    // The plate's column. Its horizontal edges bound the resting door the way
    // the header and footer bound it vertically — without them the layer spans
    // the whole window and the composer lands across the sessions sidebar.
    // The flow shell's stage names its own rect (`data-rl-door-plate`), and
    // that rect is the whole of the free area: its stage already sits between
    // the top bar, the sidebar and whatever is below.
    // Found here for the observer, and again on every measure: a plate whose
    // tab unmounted (a set switch, a closed door tab) measures as all zeros,
    // and a fit taken from it would leave the next door tab blank.
    const findPlate = () => {
      const found = document.querySelector<HTMLElement>("[data-rl-door-plate]");
      const stage = found?.isConnected ? found : null;
      return { stage, plate: stage ?? document.querySelector<HTMLElement>(".rl-doc-column") };
    };
    const { plate: observed } = findPlate();
    const position = () => {
      const { stage, plate } = findPlate();
      // Read afresh: the status bar is a lazy chunk whose placeholder holds
      // its row until it lands, so the element can change under the effect.
      const rect = (document.querySelector<HTMLElement>(".rl-app-footer") ?? footer)?.getBoundingClientRect();
      // The status bar's row (W6: 28px). This fixed overlay contributes no
      // height and never moves the bar or the main viewport.
      const clearance = rect && rect.height > 0
        ? window.innerHeight - (rect.top + rect.height / 2) - STATUS_ROW_H / 2
        : 8;
      layer.current?.style.setProperty("--portal-return-bottom", `${clearance + 4}px`);
      // Keep the existing title-bar reach without covering conversation
      // content. Only transparent hit regions use this measurement. The
      // room's box is read without its transform: an observer can land
      // mid-entrance, and a strip sized to the risen box would cover the
      // room's heading once it settles.
      const roomTop = room.current ? (layer.current?.getBoundingClientRect().top ?? 0) + room.current.offsetTop : 0;
      const top = Math.max(SHELL_EDGE, Math.min(header?.getBoundingClientRect().bottom || 28, roomTop || 28));
      layer.current?.style.setProperty("--portal-drag-top", `${top}px`);
      // The plate's free area: header bottom down to the footer's top.
      // Published as the insets the door
      // keeps at rest on the empty plate, and as where its paper spreads from
      // and its box glides from when it is engaged there.
      const stageRect = stage?.getBoundingClientRect();
      const areaTop = stageRect ? stageRect.top : header?.getBoundingClientRect().bottom ?? 0;
      const areaBottom = stageRect ? stageRect.bottom : rect && rect.height > 0 ? rect.top : window.innerHeight;
      layer.current?.style.setProperty("--fd-rest-top", `${Math.max(0, areaTop)}px`);
      layer.current?.style.setProperty("--fd-rest-bottom", `${Math.max(0, window.innerHeight - areaBottom)}px`);
      const plateRect = plate?.getBoundingClientRect();
      const areaLeft = plateRect && plateRect.width > 0 ? plateRect.left : 0;
      const areaRight = plateRect && plateRect.width > 0 ? plateRect.right : window.innerWidth;
      layer.current?.style.setProperty("--fd-rest-left", `${Math.max(0, areaLeft)}px`);
      layer.current?.style.setProperty("--fd-rest-right", `${Math.max(0, window.innerWidth - areaRight)}px`);
      const area = { left: Math.max(0, areaLeft), top: Math.max(0, areaTop), right: Math.min(window.innerWidth, areaRight), bottom: Math.min(window.innerHeight, areaBottom) };
      const scale = `scale(${Math.max(1, area.right - area.left) / window.innerWidth}, ${Math.max(1, area.bottom - area.top) / window.innerHeight})`;
      layer.current?.style.setProperty("--fd-paper-from", `translate(${area.left}px, ${area.top}px) ${scale}`);
      restCentre.current = { x: (area.left + area.right) / 2, y: (area.top + area.bottom) / 2 };
      // Too narrow for even a bare composer: don't land (the notch remains).
      setFit(areaRight - areaLeft < MIN_LANDING_WIDTH ? "none" : landingFit(areaBottom - areaTop));
    };
    position();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
    if (footer) observer?.observe(footer);
    if (header) observer?.observe(header);
    if (observed) observer?.observe(observed);
    window.addEventListener("resize", position);
    return () => { observer?.disconnect(); window.removeEventListener("resize", position); };
  }, [surfaceKey, clearanceKey, open, landing, plateKey]);

  useEffect(() => { onVisibilityChange?.(visible); }, [visible, onVisibilityChange]);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media?.matches ?? false);
    media?.addEventListener("change", update);
    return () => media?.removeEventListener("change", update);
  }, []);
  useLayoutEffect(() => {
    if (previousSurface.current === surfaceKey) return;
    previousSurface.current = surfaceKey;
    // An owner that closes the door on its way somewhere (a recent) is going
    // somewhere all the same: this runs before the close below, which reads it.
    if (!open && !previousOpen.current) {
      // A recent taken from the resting door by keyboard: the caret was on
      // it, and the door it rested in is going.
      if (layer.current?.contains(document.activeElement)) focusMain();
      return;
    }
    navigated.current = true;
    if (open) close.current(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfaceKey]);

  useLayoutEffect(() => {
    if (!open) return;
    // Keep the workspace mounted (including native browser state), but make
    // its controls unavailable while the opaque front door owns the screen.
    // A modal layer of its own — a dialog, or the tour that wraps one — stays
    // live above it, and so does a status line: it has nothing to press, and
    // silencing it would swallow what it says. So does a notice that rises
    // over the door because it can't wait (the decision countdown).
    const restored: Array<[HTMLElement, boolean]> = [];
    let branch: HTMLElement | null = layer.current;
    while (branch && branch !== document.body) {
      for (const sibling of Array.from(branch.parentElement?.children ?? [])) {
        if (sibling !== branch && sibling instanceof HTMLElement && !sibling.matches('script, style, [role="dialog"], dialog, [data-rl-modal-layer], [data-rl-over-door], [role="status"]')) {
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
  // Whether the room was holding a chat when it was last open: leaving, the
  // chat goes to the dock on its own, and the room has nothing to carry back.
  const heldChat = useRef(false);
  if (open) heldChat.current = !!onNewChat;
  // From the plate's centre to the window's: where the resting door's room
  // was, relative to where an open one is. The room is centred in both and
  // keeps its width (MonochatIsland.css), so this is the box's own travel.
  const travel = () => {
    const centre = restCentre.current;
    return centre ? { x: centre.x - window.innerWidth / 2, y: centre.y - window.innerHeight / 2 } : null;
  };
  const glide = (shell: HTMLElement, from: { x: number; y: number }, duration: number, delay = 0) => {
    if (Math.abs(from.x) + Math.abs(from.y) < 1) return null;
    // Held where it starts while it waits (`backwards`).
    const flight = shell.animate([{ transform: `translate3d(${from.x}px, ${from.y}px, 0)` }, { transform: "none" }], delay ? { duration, easing: GLIDE_EASE, delay, fill: "backwards" } : { duration, easing: GLIDE_EASE });
    flight.onfinish = settle;
    return flight;
  };
  useLayoutEffect(() => {
    const shell = room.current;
    // A glide still held when the door shuts never left the plate.
    const stayed = !!held.current;
    settle();
    held.current = null;
    const composer = shell && !heldChat.current ? Array.from(shell.querySelectorAll(".rl-frontdoor")).find(shown) : null;
    if (open) {
      setClosing(false);
      if (!shell?.animate) return;
      // Engaged on the plate, the box glides from where it rested to the
      // window's centre, the caret riding along — transform only. A press
      // holds it at its start until the pointer is done (see `engage`): the
      // box never moves under a held pointer, so a drag that selects text,
      // a double-click or a chip's menu is safe.
      const offset = landed && composer ? travel() : null;
      if (offset) {
        if (reduced) { flight.current = [shell.animate([{ opacity: 0 }, { opacity: 1 }], ISLAND_FADE_MS)]; return; }
        const pressed = summon.current === "press";
        const flown = glideIn.current = glide(shell, offset, GLIDE_IN_MS, pressed ? 0 : GLIDE_DELAY_MS);
        flight.current = flown ? [flown] : [];
        if (flown && pressed) { flown.pause(); held.current = flown; }
        return;
      }
      // Out of nothing: the room rises where it opens.
      flight.current = reduced
        ? [shell.animate([{ opacity: 0 }, { opacity: 1 }], ISLAND_FADE_MS)]
        : [shell.animate([
          { transform: "translate3d(0, 16px, 0) scale(.985)", opacity: 0 },
          { transform: "none", opacity: 1 },
        ], { duration: ROOM_RISE_MS, easing: "cubic-bezier(.2,.8,.2,1)" })];
      return;
    }
    if (!previousOpen.current) return;
    // Shut back to rest on the plate: the box glides home as the paper
    // contracts. Handing off, the plate is becoming the plan: only the paper
    // goes.
    if (landed) {
      setZoom(false);
      const offset = composer && !handoff && !stayed && shell?.animate ? travel() : null;
      if (!offset) return;
      if (reduced) { flight.current = [shell!.animate([{ opacity: 0 }, { opacity: 1 }], ISLAND_FADE_MS)]; return; }
      const flown = glide(shell!, { x: -offset.x, y: -offset.y }, GLIDE_OUT_MS);
      flight.current = flown ? [flown] : [];
      return;
    }
    setClosing(true);
    const timer = window.setTimeout(() => setClosing(false), reduced ? ISLAND_FADE_MS : DOOR_CLOSE_MS);
    if (shell?.animate) {
      flight.current = [
        reduced ? shell.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ISLAND_FADE_MS, fill: "forwards" })
          // Handing off, the box stays where the plan springs from: the door
          // steps back and away under it, gone well before the spring lands.
          : handoff ? shell.animate(fadeOutKeyframes(), { duration: DOOR_CLOSE_MS, easing: SWAP_OUT_EASING, fill: "forwards" })
          : shell.animate([{ opacity: 1 }, { opacity: 0 }], { duration: DOOR_CLOSE_MS, easing: SWAP_OUT_EASING, fill: "forwards" }),
      ];
      // The headline and recents are out of the way in its first moments.
      if (!reduced) {
        for (const welcome of shell.querySelectorAll<HTMLElement>(".rl-fd-welcome")) {
          flight.current.push(welcome.animate([{ opacity: 0, offset: 1 }], { duration: WELCOME_OUT_MS, fill: "forwards" }));
        }
      }
    }
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useLayoutEffect(() => {
    if (open || !previousOpen.current) return;
    setReturnOut(true);
    const timer = window.setTimeout(() => setReturnOut(false), RETURN_OUT_MS);
    return () => { window.clearTimeout(timer); setReturnOut(false); };
  }, [open]);
  // Shut: the layer goes, and its flight with it, in one frame — and the
  // zoom it held on the way.
  useLayoutEffect(() => {
    if (!closing && !live.current.open) { settle(); setZoom(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closing]);
  useEffect(() => {
    if (open && !previousOpen.current) {
      remember();
      // The door owns the caret as it opens: every summons — a key, ⌘J, a
      // press in the resting box, a room holding a chat — puts it in the
      // composer, at the end of the draft.
      const field = composerIn(body.current);
      if (field) {
        field.focus({ preventScroll: true });
        const end = field.value.length;
        field.setSelectionRange(end, end);
      }
      summon.current = "key";
    } else if (!open && previousOpen.current) {
      // A chat carried out to the dock took its focused composer with it,
      // which leaves the caret nowhere: that is the door's to hand back too —
      // to where it was; after navigation, a handoff into the plan, or with
      // where it was gone, to the new surface's main area.
      const active = document.activeElement;
      if (!active || active === document.body || layer.current?.contains(active)) {
        const remembered = returnFocus.current;
        if (navigated.current || handoff || remembered && !remembered.isConnected) focusMain();
        else if (remembered) remembered.focus({ preventScroll: true });
        else (active as HTMLElement | null)?.blur();
      }
      returnFocus.current = null;
      navigated.current = false;
    }
    previousOpen.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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
      backdropPress.current = event.button === 0 && !!event.target && isBackdrop(event.target) && !hasChildOverlay() && glideIn.current?.playState !== "running";
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
        // Laid out is not enough: the welcome hides itself with `visibility`
        // and stays in the layout, and Tab can't land there.
        const focusable = Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [href], [tabindex="0"]')).filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== "hidden" && !element.closest('[hidden], [inert], [aria-hidden="true"]'));
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === body.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === body.current)) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const node = layer.current;
    const key = (event: KeyboardEvent) => { walked.current = event.key === "Tab"; };
    const press = () => { walked.current = false; };
    // The keyboard walking the caret out of an empty box — not into one of
    // the box's own menus — brings the welcome back. Nothing else does: a
    // press lands on the paper (which closes) or in the box, and the window
    // losing focus, a menu opening or closing, or anything the app does
    // moves focus without the user leaving.
    const out = (event: FocusEvent) => {
      const tabbed = walked.current, next = event.relatedTarget;
      walked.current = false;
      if (!tabbed || !inBox(event.target) || !(next instanceof Element) || inBox(next)) return;
      if (next.closest("[data-rl-island-owned], [role=menu]") || hasChildOverlay() || composerIn(body.current)?.value.trim()) return;
      setZoom(false);
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", press, true);
    node?.addEventListener("focusout", out);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", press, true);
      node?.removeEventListener("focusout", out);
    };
  }, [open]);

  // Resting, the door engages on a press in its composer or a keystroke
  // typed into it — never on focus alone, so tabbing across the plate opens
  // nothing (WCAG 3.2.1), and a press or a key on a recent goes where the
  // recent goes. Open, it zooms when the user puts the caret in the box: a
  // press in it, or focus arriving in it (a click, Tab, a summons that puts
  // the caret there).
  const engaging = landed && !open ? {
    onPointerDownCapture: (event: ReactPointerEvent) => { if (event.button === 0 && inBox(event.target)) engage("press"); },
    onKeyDownCapture: (event: ReactKeyboardEvent) => { if (inBox(event.target) && typing(event)) engage("key"); },
  } : open ? {
    onPointerDownCapture: (event: ReactPointerEvent) => { if (event.button === 0 && inBox(event.target)) setZoom(true); },
    onFocusCapture: (event: ReactFocusEvent) => { if (inBox(event.target)) setZoom(true); },
  } : {};

  return <>
    {/* Outside the door, and spared by its inert sweep, so a launch from a
        door tab and one from the door are both heard. */}
    <div className="sr-only" role="status" aria-live="polite">{announce}</div>
    <div ref={layer} className="rl-frontdoor-focus" data-open={open} data-visible={visible} data-closing={closing || undefined} data-reduced={reduced}
      data-rest={inset ? fit : undefined} data-landed={landed || undefined} data-zoom={zoomed || undefined}
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
        {/* In a beat behind the paper, out ahead of it (MonochatIsland.css). */}
        {open ? <button className="rl-frontdoor-return" type="button" onClick={() => onOpenChange(false)} aria-label="Return to workspace" title="Return to workspace (Esc)"><ChevronDown size={18}/></button>
          : returnOut && <span className="rl-frontdoor-return" data-leaving aria-hidden="true"><ChevronDown size={18}/></span>}
      <div ref={room} className="rl-monochat" data-pose={open ? "conversation" : landed ? "entry" : "notch"} data-reduced={reduced} data-chat={onNewChat ? true : undefined}>
        <div ref={body} id="rl-monochat-content" className="rl-monochat-content" tabIndex={-1} aria-label={`Conversation · ${context}`} {...engaging}>
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
