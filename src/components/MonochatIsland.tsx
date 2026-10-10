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
import { beginWindowDrag, toggleWindowMaximize } from "../lib/windowDrag";
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

// The compact card is its own chunk: nothing on the boot path needs it until
// a pointer rests on the pill, and the dwell is long enough to fetch it.
const loadCard = () => import("./MonochatCard");
const MonochatCard = lazy(loadCard);

/** A menu, picker or dialog layered over the island owns the pointer and Esc. */
const hasChildOverlay = () => !!document.querySelector('[role="menu"], [role="dialog"]:not(.rl-frontdoor-focus), dialog[open]');
/** The composer the door puts the caret in — a chat's own when it holds one. */
const composerIn = (root: HTMLElement | null) =>
  root?.querySelector<HTMLElement>("[data-chat-composer] textarea") ?? root?.querySelector<HTMLElement>("textarea") ?? null;

export function MonochatIsland({ open, onOpenChange, compactOpen = false, onCompactChange, compact, landing = false, onVisibilityChange, context, busy, onNewChat, surfaceKey = "", clearanceKey = "", children }: {
  /** The door: the full-page room. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The compact card. Its content is rendered only while it is open. */
  compactOpen?: boolean;
  onCompactChange?: (open: boolean) => void;
  compact?: ReactNode;
  /** The empty plate: the door rests there, unengaged, instead of the pill. */
  landing?: boolean;
  onVisibilityChange?: (visible: boolean) => void;
  context: string;
  busy: boolean;
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

  /** Where the caret was before the island took it, to hand it back. */
  const remember = (active = document.activeElement) => {
    if (returnFocus.current || !(active instanceof HTMLElement) || active === document.body || active === launcher.current) return;
    if (layer.current?.contains(active) || active.closest(".rl-monochat-float")) return;
    returnFocus.current = active;
  };
  const openCompact = () => {
    remember();
    compactChange.current?.(true);
  };
  // Into the door, from the pill, a key or the resting composer. An open
  // compact card grows into it, draft and all.
  const engage = () => {
    window.clearTimeout(dwell.current);
    remember();
    if (live.current.compactOpen) compactChange.current?.(false);
    close.current(true);
  };
  // The card's last word as it leaves. Growing into the door keeps the
  // caret for the door; otherwise a card that held it hands it back.
  const releaseCard = (focusInside: boolean) => {
    if (live.current.open) return;
    const back = returnFocus.current?.isConnected ? returnFocus.current : null;
    returnFocus.current = null;
    const away = navigated.current;
    navigated.current = false;
    if (!focusInside) return;
    if (away || !back) (document.activeElement as HTMLElement | null)?.blur();
    else back.focus({ preventScroll: true });
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
    if (!open && !previousOpen.current && !compactOpen) return;
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
    // live above it.
    const restored: Array<[HTMLElement, boolean]> = [];
    let branch: HTMLElement | null = layer.current;
    while (branch && branch !== document.body) {
      for (const sibling of Array.from(branch.parentElement?.children ?? [])) {
        if (sibling !== branch && sibling instanceof HTMLElement && !sibling.matches('script, style, [role="dialog"], dialog, [data-rl-modal-layer]')) {
          restored.push([sibling, sibling.inert]); sibling.inert = true;
        }
      }
      branch = branch.parentElement;
    }
    return () => { for (const [element, inert] of restored) element.inert = inert; };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || inset || reduced || !room.current?.animate) return;
    // On the plate the composer is already in place: engaging it only fades
    // the backdrop in. From elsewhere the room rises gently, without squashing
    // its text down to the dimensions of the footer pill or measuring layout.
    const animation = room.current.animate([
      { transform: "translate3d(0, 16px, 0) scale(.985)", opacity: 0 },
      { transform: "none", opacity: 1 },
    ], { duration: 260, easing: "cubic-bezier(.2,.8,.2,1)" });
    return () => animation.cancel();
    // Only an opening rises; settling into a chat mid-visit does not replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reduced]);
  useEffect(() => {
    if (open && !previousOpen.current) {
      remember();
      // However it was summoned — a click, a key, ⌘J — the caret goes into
      // the composer: the door is for typing. The welcome stays until you do.
      composerIn(body.current)?.focus({ preventScroll: true });
    } else if (!open && previousOpen.current) {
      // A chat carried out to the dock took its focused composer with it,
      // which leaves the caret nowhere: that is the door's to hand back too.
      const active = document.activeElement;
      if (!active || active === document.body || layer.current?.contains(active)) {
        const back = returnFocus.current?.isConnected ? returnFocus.current : visible ? null : launcher.current;
        if (navigated.current || !back) (document.activeElement as HTMLElement | null)?.blur();
        else back.focus({ preventScroll: true });
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
    if (event.pointerType === "touch" || event.buttons || visible || compactOpen || !onCompactChange) return;
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
    const onKey = (event: KeyboardEvent) => {
      // Saved chats are App-owned portals. Follow DOM containment after
      // child handlers have run, rather than relying on React ancestry.
      if (!(event.target instanceof Node) || !layer.current?.contains(event.target) || event.defaultPrevented || event.isComposing || hasChildOverlay()) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(false); }
      if (event.key === "Tab") {
        const focusable = Array.from(layer.current.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [href], [tabindex="0"]')).filter(element => element.getClientRects().length && !element.closest('[hidden], [inert], [aria-hidden="true"]'));
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
  // nothing (WCAG 3.2.1), and a press on a recent goes where the recent goes.
  const restingEngage = landed && !open ? {
    onPointerDownCapture: (event: ReactPointerEvent) => { if (event.button === 0 && (event.target as Element).closest?.(".rl-fd-island")) engage(); },
    onKeyDownCapture: (event: ReactKeyboardEvent) => { if (!event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing && (event.key.length === 1 || event.key === "Enter" || event.key === "Backspace" || event.key === "Delete")) engage(); },
  } : {};

  const entrance = <button ref={launcher} type="button" className="rl-monochat-notch" data-hidden={visible} data-busy={busy} data-reduced={reduced}
    tabIndex={visible ? -1 : 0} aria-hidden={visible}
    aria-label={`Open front door${busy ? ", working" : ""}${draft ? ", draft saved" : ""}`}
    title="Open front door (Shift+Enter)" aria-keyshortcuts="Shift+Enter"
    aria-expanded={open} aria-controls="rl-monochat-content"
    onFocus={event => { if (event.relatedTarget instanceof HTMLElement && !layer.current?.contains(event.relatedTarget)) remember(event.relatedTarget); }}
    onPointerEnter={hoverIn} onPointerLeave={hoverOut}
    onClick={engage}>
    <span ref={membrane} className="rl-portal-membrane" aria-hidden="true"><span className="rl-monochat-signal"><i/><i/><i/></span><span>{busy ? "Working" : "Redline"}</span>{draft && <span className="rl-monochat-draft"/>}</span>
  </button>;

  return <>
    <div ref={dock} className="rl-frontdoor-dock">
      {entrance}
      {compactOpen && !visible && <Suspense fallback={null}>
        <MonochatCard pill={launcher} hovered={() => overPill.current} onClose={() => compactChange.current?.(false)} onRelease={releaseCard}>{compact}</MonochatCard>
      </Suspense>}
    </div>
    <div ref={layer} className="rl-frontdoor-focus" data-open={open} data-visible={visible} data-reduced={reduced}
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
            <span className="rl-monochat-title">{context}</span>
            <button type="button" className="rl-monochat-new" onClick={onNewChat} title="A blank composer; this conversation stays in History">New</button>
          </div>}
          <div ref={conversation} className="rl-monochat-conversation">{children}</div>
        </div>
      </div>
    </div>
  </>;
}
