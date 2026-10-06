// SPDX-License-Identifier: Apache-2.0
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type MouseEvent as ReactMouseEvent } from "react";
import { ChevronDown } from "lucide-react";
import { useNativeOverlayRegion } from "../hooks/useNativeOverlayRegion";
import { isFrontDoorKey } from "../lib/keymap";
import { SHELL_EDGE } from "../lib/paneLayout";
import { beginWindowDrag, toggleWindowMaximize } from "../lib/windowDrag";
import "./MonochatIsland.css";

export type SummonVia = "pointer" | "key";
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

/** A quiet entrance, not the host for surface discussions. The hit target and
 * native browser geometry stay still while only the inner membrane responds. */
function FullMonochatIsland({ open, onOpenChange, context, busy, children, landing = false, surfaceKey = "", onVisibilityChange, clearanceKey = "" }: {
  /** `via` is set only when the door is SUMMONED from elsewhere (footer pill or
   *  shortcut) — the owner resets it to its home. "pointer" opens on the full
   *  welcome without reaching for the composer; "key" puts the caret in it. */
  open: boolean; onOpenChange: (open: boolean, via?: SummonVia) => void;
  context: string; busy: boolean; children: ReactNode;
  landing?: boolean; surfaceKey?: string; clearanceKey?: string; onVisibilityChange?: (visible: boolean) => void;
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
  const previousSurface = useRef(surfaceKey);
  const previousOpen = useRef(false);
  const close = useRef(onOpenChange); close.current = onOpenChange;
  const summonVia = useRef<SummonVia | null>(null);
  // How much of the door the plate's free area can hold at rest. The door
  // lands in the space BETWEEN the header and the terminal dock — never on top
  // of the terminals — and sheds its furniture rather than overflow: headline
  // first, then the starters, and below a bare composer it does not land at
  // all (the notch in the footer is still the way in).
  const [fit, setFit] = useState<LandingFit>("full");
  const landed = landing && fit !== "none";
  const visible = open || landed;
  useNativeOverlayRegion(launcher, !visible);

  useEffect(() => {
    const summon = () => { summonVia.current = "key"; close.current(true, "key"); };
    const onKey = (event: KeyboardEvent) => {
      // Capture before editors/xterm can consume the chord. Once the front
      // door is open, Shift+Enter remains a newline in its composer.
      if (open || event.isComposing || event.keyCode === 229 || !isFrontDoorKey(event)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (!event.repeat) summon();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("redline:open-front-door", summon);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("redline:open-front-door", summon);
    };
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
      // content. Only transparent hit regions use this measurement.
      const top = Math.max(SHELL_EDGE, Math.min(header?.getBoundingClientRect().bottom || 28, room.current?.getBoundingClientRect().top || 28));
      layer.current?.style.setProperty("--portal-drag-top", `${top}px`);
      // The plate's free area: header bottom down to the dock's top (or the
      // footer's, with the dock folded). Published as insets the resting
      // pose applies; engaged, the layer lets go of them and fills the window.
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
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media?.matches ?? false);
    media?.addEventListener("change", update);
    return () => media?.removeEventListener("change", update);
  }, []);
  useLayoutEffect(() => {
    if (previousSurface.current === surfaceKey) return;
    previousSurface.current = surfaceKey;
    // Navigation owns the new focus; closing must not pull it back.
    returnFocus.current = null;
    close.current(false);
  }, [surfaceKey]);

  useLayoutEffect(() => {
    if (!open) return;
    // Keep the workspace mounted (including native browser state), but make
    // its controls unavailable while the opaque front door owns the screen.
    const restored: Array<[HTMLElement, boolean]> = [];
    let branch: HTMLElement | null = layer.current;
    while (branch && branch !== document.body) {
      for (const sibling of Array.from(branch.parentElement?.children ?? [])) {
        if (sibling !== branch && sibling instanceof HTMLElement && !sibling.matches('script, style, [role="dialog"], dialog')) {
          restored.push([sibling, sibling.inert]); sibling.inert = true;
        }
      }
      branch = branch.parentElement;
    }
    return () => { for (const [element, inert] of restored) element.inert = inert; };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || landed || reduced || !room.current?.animate) return;
    // The home composer is already in place: focusing it only fades the
    // backdrop. A tucked-away chat enters gently without squashing its text
    // down to the dimensions of the footer pill or measuring layout.
    const animation = room.current.animate([
      { transform: "translate3d(0, 16px, 0) scale(.985)", opacity: 0 },
      { transform: "none", opacity: 1 },
    ], { duration: 260, easing: "cubic-bezier(.2,.8,.2,1)" });
    return () => animation.cancel();
  }, [open, landed, reduced]);
  useEffect(() => {
    if (open && !previousOpen.current) {
      const active = document.activeElement;
      if (!returnFocus.current && active instanceof HTMLElement && active !== document.body && !layer.current?.contains(active)) returnFocus.current = active;
      // Summoned by pointer, the door arrives on its welcome: focus the room,
      // not the composer, so the headline and pills stay until you click in.
      const quiet = summonVia.current === "pointer";
      ((quiet ? null : body.current?.querySelector<HTMLElement>("textarea")) ?? body.current)?.focus({ preventScroll: true });
    } else if (!open && previousOpen.current) {
      if (layer.current?.contains(document.activeElement)) {
        const target = returnFocus.current?.isConnected ? returnFocus.current : launcher.current;
        if (landed && target === launcher.current) (document.activeElement as HTMLElement)?.blur();
        else target?.focus({ preventScroll: true });
      }
      returnFocus.current = null;
    }
    previousOpen.current = open;
    summonVia.current = null;
  }, [open]);

  useEffect(() => {
    const button = launcher.current, skin = membrane.current;
    if (!button || !skin || open || landed || reduced) return;
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
  }, [open, landed, reduced, surfaceKey, clearanceKey]);

  const engage = (via?: SummonVia) => {
    const active = document.activeElement;
    if (!returnFocus.current && active instanceof HTMLElement && active !== document.body && !layer.current?.contains(active)) returnFocus.current = active;
    summonVia.current = via ?? null;
    onOpenChange(true, via);
  };
  const isBackdrop = (target: EventTarget) =>
    target === layer.current || target === room.current || target === body.current || target === conversation.current;
  const dragWindow = (event: ReactMouseEvent) => {
    if (event.button !== 0) return;
    event.preventDefault(); // Moving the window must not blur the composer.
    beginWindowDrag(event);
  };
  const hasChildOverlay = () => !!document.querySelector('[role="menu"], [role="dialog"]:not(.rl-frontdoor-focus), dialog[open]');
  useEffect(() => {
    if (!open) return;
    const start = (event: PointerEvent) => {
      // Observe the DOM capture phase because the selected chat can be a
      // React portal owned by App, outside this component's event ancestry.
      backdropPress.current = event.button === 0 && !!event.target && isBackdrop(event.target) && !hasChildOverlay();
    };
    document.addEventListener("pointerdown", start, true);
    return () => { document.removeEventListener("pointerdown", start, true); backdropPress.current = false; };
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
  const entrance = <button ref={launcher} type="button" className="rl-monochat-notch" data-hidden={visible} data-busy={busy} data-reduced={reduced}
    tabIndex={visible ? -1 : 0} aria-hidden={visible}
    aria-label={`Open front door${busy ? ", working" : ""}`}
    title="Open front door (Shift+Enter)" aria-keyshortcuts="Shift+Enter"
    aria-expanded={open} aria-controls="rl-monochat-content"
    onFocus={event => { if (event.relatedTarget instanceof HTMLElement && !layer.current?.contains(event.relatedTarget)) returnFocus.current = event.relatedTarget; }}
    onClick={() => engage("pointer")}>
    <span ref={membrane} className="rl-portal-membrane" aria-hidden="true"><span className="rl-monochat-signal"><i/><i/><i/></span><span>{busy ? "Working" : "Redline"}</span></span>
  </button>;

  return <>
    <div ref={dock} className="rl-frontdoor-dock">{entrance}</div>
    <div ref={layer} className="rl-frontdoor-focus" data-open={open} data-visible={visible} data-reduced={reduced}
      data-rest={landed && !open ? fit : undefined}
      role={open ? "dialog" : undefined} aria-modal={open || undefined} aria-label={open ? "Front door" : undefined}
      inert={!visible} aria-hidden={!visible}
      onClickCapture={event => {
        // Preserve text-selection drags and let menus handle their own dismissal.
        const dismiss = backdropPress.current && isBackdrop(event.target);
        backdropPress.current = false;
        if (!open || !dismiss || hasChildOverlay()) return;
        event.preventDefault(); event.stopPropagation(); onOpenChange(false);
      }}>
        {open && <div aria-hidden="true" style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 3 }}>
          {/* Match the shell's edges using invisible hit regions. These do
              not participate in layout or change the front door's paint. */}
          <div data-window-drag-edge="top" onMouseDown={dragWindow} onDoubleClick={toggleWindowMaximize} style={{ position: "absolute", top: 0, left: 0, right: 0, height: "var(--portal-drag-top, 28px)", pointerEvents: "auto" }}/>
          <div data-window-drag-edge="left" onMouseDown={dragWindow} style={{ position: "absolute", top: "var(--portal-drag-top, 28px)", bottom: SHELL_EDGE, left: 0, width: SHELL_EDGE, pointerEvents: "auto" }}/>
          <div data-window-drag-edge="right" onMouseDown={dragWindow} style={{ position: "absolute", top: "var(--portal-drag-top, 28px)", bottom: SHELL_EDGE, right: 0, width: SHELL_EDGE, pointerEvents: "auto" }}/>
          <div data-window-drag-edge="bottom" onMouseDown={dragWindow} style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: SHELL_EDGE, pointerEvents: "auto" }}/>
        </div>}
        {open && <button className="rl-frontdoor-return" type="button" onClick={() => onOpenChange(false)} aria-label="Return to workspace" title="Return to workspace (Esc)"><ChevronDown size={18}/></button>}
      <div ref={room} className="rl-monochat" data-pose={open ? "conversation" : landed ? "entry" : "notch"} data-reduced={reduced}>
        <div ref={body} id="rl-monochat-content" className="rl-monochat-content" tabIndex={-1} aria-label={`Conversation · ${context}`} onFocusCapture={() => { if (landed && !open) engage(); }}>
          <div ref={conversation} className="rl-monochat-conversation">{children}</div>
        </div>
      </div>
    </div>
  </>;
}

const FloatingBrowserIsland = lazy(() => import("./FloatingBrowserIsland"));
export function MonochatIsland(props: Parameters<typeof FullMonochatIsland>[0] & {
  floating?: boolean; floatingContent?: ReactNode;
  floatingOpen?: boolean; onFloatingOpenChange?: (open: boolean) => void;
}) {
  return props.floating ? <Suspense fallback={null}><FloatingBrowserIsland busy={props.busy} open={props.floatingOpen} onOpenChange={props.onFloatingOpenChange}>{props.floatingContent ?? props.children}</FloatingBrowserIsland></Suspense> : <FullMonochatIsland {...props}/>;
}
