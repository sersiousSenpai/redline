// SPDX-License-Identifier: Apache-2.0
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Maximize2, Minimize2 } from "lucide-react";
import { useNativeOverlayRegion } from "../hooks/useNativeOverlayRegion";
import { isFrontDoorKey } from "../lib/keymap";
import { springInKeyframes, SWAP_MS, SWAP_SPRING } from "../lib/springSwap";
import "./MonochatIsland.css";

// One Redline island on every surface: a pill centred in the footer that
// springs into a floating card above it. The card is a region, not a modal —
// the workspace under it stays live, and on the browser surface it is cut out
// of the native webview rather than hiding the page.
//
// How it closes depends on how it was opened. A hover is a PEEK: it never
// takes focus and it leaves when the pointer does. Anything deliberate — a
// click, Shift+Enter, a summon, or a press or focus inside the card — ENGAGES
// it, and an engaged card (or any card holding a chat) stays put until it is
// closed on purpose: ⌄, Esc, the chord again, ⌘J, or going somewhere else.
// A click on the page, the terminal or the sidebar is work, not a dismissal.

/** How the owner was asked to open the card. Only a hover leaves the caret
 *  where it was. */
export type SummonVia = "hover" | "click" | "key";
/** `compose` is the Front Door's composer; `chat` grows to hold a thread. */
export type IslandPose = "compose" | "chat";
export type IslandSize = "regular" | "tall";

/** A deliberate hover, not a pointer passing through the footer. */
const HOVER_OPEN_MS = 120;
const LEAVE_CLOSE_MS = 400;
/** The pill's box plus the breath between it and the card. */
const CARD_OFFSET = 44;
/** The card's distance from the footer's top edge, when the row is taller
 *  than the pill and would otherwise reach under it. */
const FOOTER_GAP = 8;

/** A menu, picker or dialog layered over the card owns the pointer and Esc. */
const hasChildOverlay = () => !!document.querySelector('[role="menu"], [role="dialog"], dialog[open]');
/** The composer a summon puts the caret in — the chat's own in the chat pose. */
const composerIn = (box: HTMLElement | null) =>
  box?.querySelector<HTMLElement>("[data-chat-composer] textarea") ?? box?.querySelector<HTMLElement>("textarea") ?? null;

export function MonochatIsland({ open, onOpenChange, pose = "compose", size = "regular", onSizeChange, onNewChat, context, busy, surfaceKey = "", clearanceKey = "", chips, children }: {
  open: boolean;
  onOpenChange: (open: boolean, via?: SummonVia) => void;
  pose?: IslandPose;
  /** The chat pose's ⤢ toggle. Compose always sizes to its content. */
  size?: IslandSize;
  onSizeChange?: (size: IslandSize) => void;
  /** The heading's New: back to a blank composer, the chat kept in History. */
  onNewChat?: () => void;
  /** "Redline · {context}" — where the card is. */
  context: string | null;
  busy: boolean;
  /** A change means the user went somewhere: the card closes behind them. */
  surfaceKey?: string;
  /** Anything that moves the footer: the pill re-measures its row. */
  clearanceKey?: string;
  /** The surface's context chips, above everything the card sends. */
  chips?: ReactNode;
  children: ReactNode;
}) {
  const [reduced, setReduced] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  const [springing, setSpringing] = useState(false);
  const [resizing, setResizing] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  const membrane = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const change = useRef(onOpenChange); change.current = onOpenChange;
  const busyRef = useRef(busy); busyRef.current = busy;
  // True only while the card is a hover peek nobody has touched.
  const peek = useRef(false);
  const focusOnOpen = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  // Closed by navigation: the new surface owns focus.
  const navigated = useRef(false);
  const previousOpen = useRef(false);
  const previousSurface = useRef(surfaceKey);
  const enterTimer = useRef(0), leaveTimer = useRef(0);
  useNativeOverlayRegion(pill, !open);
  // The hole in the native webview tracks the spring and every size change.
  useNativeOverlayRegion(card, open, springing || resizing);

  const clearTimers = () => { window.clearTimeout(enterTimer.current); window.clearTimeout(leaveTimer.current); };
  const sticky = () => busyRef.current
    || !!card.current?.querySelector<HTMLTextAreaElement>("textarea")?.value.trim()
    || !!card.current?.contains(document.activeElement)
    || hasChildOverlay();
  const summon = (via: "click" | "key") => {
    clearTimers();
    peek.current = false;
    if (open) composerIn(card.current)?.focus({ preventScroll: true });
    else focusOnOpen.current = true;
    change.current(true, via);
  };
  const collapse = () => { clearTimers(); change.current(false); };

  useEffect(() => {
    const onChord = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || !isFrontDoorKey(event)) return;
      // Captured before editors and xterm can consume it. Open, the chord is
      // a newline in the card's composer and belongs to anything over it.
      if (open && ((event.target instanceof Node && card.current?.contains(event.target)) || hasChildOverlay())) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.repeat) return;
      // A peek is only showing you the card; the summon key takes you in.
      if (open && !peek.current) collapse(); else summon("key");
    };
    // After child handlers, so a menu or dialog closes itself first. Only from
    // inside the card or from nowhere in particular: Esc in the terminal or
    // the editor is theirs.
    const onEscape = (event: KeyboardEvent) => {
      if (!open || event.key !== "Escape" || event.defaultPrevented || event.isComposing || hasChildOverlay()) return;
      const target = event.target;
      const loose = !(target instanceof Element) || target === document.body || target === document.documentElement;
      if (!loose && !card.current?.contains(target)) return;
      event.preventDefault(); event.stopPropagation();
      collapse();
    };
    // Opens; never toggles an open card shut.
    const onSummon = () => summon("key");
    window.addEventListener("keydown", onChord, true);
    window.addEventListener("keydown", onEscape);
    window.addEventListener("redline:open-front-door", onSummon);
    return () => {
      window.removeEventListener("keydown", onChord, true);
      window.removeEventListener("keydown", onEscape);
      window.removeEventListener("redline:open-front-door", onSummon);
    };
    // Everything else these read is a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Native listeners, not React's: a chat is App's portal into the card, so
  // its events never pass through this component's React ancestry.
  useEffect(() => {
    const island = root.current, box = card.current;
    if (!island || !box) return;
    const over = (event: PointerEvent) => {
      window.clearTimeout(leaveTimer.current);
      if (open || event.pointerType === "touch" || !(event.target instanceof Node) || !pill.current?.contains(event.target)) return;
      window.clearTimeout(enterTimer.current);
      enterTimer.current = window.setTimeout(() => { peek.current = true; change.current(true, "hover"); }, HOVER_OPEN_MS);
    };
    const out = (event: PointerEvent) => {
      if (event.relatedTarget instanceof Node && island.contains(event.relatedTarget)) return;
      window.clearTimeout(enterTimer.current);
      if (!open || !peek.current || pose === "chat") return;
      window.clearTimeout(leaveTimer.current);
      leaveTimer.current = window.setTimeout(() => { if (peek.current && !sticky()) change.current(false); }, LEAVE_CLOSE_MS);
    };
    const engage = () => { peek.current = false; window.clearTimeout(leaveTimer.current); };
    island.addEventListener("pointerover", over);
    island.addEventListener("pointerout", out);
    box.addEventListener("pointerdown", engage, true);
    box.addEventListener("focusin", engage);
    return () => {
      island.removeEventListener("pointerover", over);
      island.removeEventListener("pointerout", out);
      box.removeEventListener("pointerdown", engage, true);
      box.removeEventListener("focusin", engage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pose]);
  useEffect(() => () => clearTimers(), []);

  useLayoutEffect(() => {
    const footer = document.querySelector<HTMLElement>(".rl-app-footer");
    const position = () => {
      const rect = footer?.getBoundingClientRect();
      // Centred on the existing footer row. Both layers are fixed: they add no
      // height and never move the footer or the main viewport.
      const clearance = rect && rect.height >= 32
        ? window.innerHeight - (rect.top + rect.height / 2) - 20
        : 8;
      if (dock.current) dock.current.style.bottom = `${clearance}px`;
      const footerTop = rect && rect.height > 0 ? window.innerHeight - rect.top : 0;
      if (card.current) card.current.style.bottom = `${Math.max(clearance + CARD_OFFSET, footerTop + FOOTER_GAP)}px`;
    };
    position();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
    if (footer) observer?.observe(footer);
    window.addEventListener("resize", position);
    return () => { observer?.disconnect(); window.removeEventListener("resize", position); };
  }, [surfaceKey, clearanceKey]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media?.matches ?? false);
    media?.addEventListener("change", update);
    return () => media?.removeEventListener("change", update);
  }, []);
  useLayoutEffect(() => {
    if (previousSurface.current === surfaceKey) return;
    previousSurface.current = surfaceKey;
    // An owner that closes the card on its way somewhere (a recent) is going
    // somewhere all the same: it runs before the close below, which reads it.
    if (!open && !previousOpen.current) return;
    navigated.current = true;
    if (open) change.current(false);
  }, [surfaceKey, open]);

  useLayoutEffect(() => {
    if (open && !previousOpen.current) {
      // However it opened, a hover still counting down would only re-label
      // it a peek.
      window.clearTimeout(enterTimer.current);
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body && active !== pill.current && !card.current?.contains(active)) returnFocus.current = active;
      if (focusOnOpen.current) composerIn(card.current)?.focus({ preventScroll: true });
    } else if (!open && previousOpen.current) {
      clearTimers();
      // A hidden card must not keep the caret: keystrokes would land in it.
      if (card.current?.contains(document.activeElement)) {
        const back = returnFocus.current?.isConnected ? returnFocus.current : pill.current;
        if (navigated.current || !back) (document.activeElement as HTMLElement | null)?.blur();
        else back.focus({ preventScroll: true });
      }
      returnFocus.current = null;
      navigated.current = false;
      peek.current = false;
    }
    previousOpen.current = open;
    focusOnOpen.current = false;
  }, [open]);

  // The card springs out of the pill's own box.
  useLayoutEffect(() => {
    const box = card.current, from = membrane.current?.getBoundingClientRect();
    if (!open || reduced || !box?.animate || !from) return;
    setSpringing(true);
    const animation = box.animate(springInKeyframes(from, box.getBoundingClientRect()), { duration: SWAP_MS, easing: SWAP_SPRING });
    animation.onfinish = () => setSpringing(false);
    return () => { animation.cancel(); setSpringing(false); };
    // Only an opening springs; motion settings changing mid-flight do not replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Pose and size changes are CSS transitions; count them so the native
  // cut-out follows every frame until the last one lands.
  useEffect(() => {
    const box = card.current;
    if (!box) return;
    let running = 0;
    const start = (event: TransitionEvent) => { if (event.target === box) { running++; setResizing(true); } };
    const end = (event: TransitionEvent) => { if (event.target === box && --running <= 0) { running = 0; setResizing(false); } };
    box.addEventListener("transitionrun", start);
    box.addEventListener("transitionend", end);
    box.addEventListener("transitioncancel", end);
    return () => { box.removeEventListener("transitionrun", start); box.removeEventListener("transitionend", end); box.removeEventListener("transitioncancel", end); };
  }, []);

  useEffect(() => {
    const button = pill.current, skin = membrane.current;
    if (!button || !skin || open || reduced) return;
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
  }, [open, reduced, surfaceKey, clearanceKey]);

  return <div ref={root} className="rl-monochat-island">
    <div ref={dock} className="rl-frontdoor-dock">
      <button ref={pill} type="button" className="rl-monochat-notch" data-hidden={open} data-busy={busy} data-reduced={reduced}
        tabIndex={open ? -1 : 0} aria-hidden={open}
        aria-label={`Open Redline${busy ? ", working" : ""}`}
        title="Redline (Shift+Enter)" aria-keyshortcuts="Shift+Enter"
        aria-expanded={open} aria-controls="rl-monochat-card"
        onFocus={event => { if (event.relatedTarget instanceof HTMLElement && !card.current?.contains(event.relatedTarget)) returnFocus.current = event.relatedTarget; }}
        onClick={() => summon("click")}>
        <span ref={membrane} className="rl-portal-membrane" aria-hidden="true"><span className="rl-monochat-signal"><i/><i/><i/></span><span>{busy ? "Working" : "Redline"}</span></span>
      </button>
    </div>
    <div ref={card} id="rl-monochat-card" className="rl-monochat-card" role="region" aria-label="Redline"
      data-pose={pose} data-size={pose === "chat" ? size : undefined} data-reduced={reduced}
      hidden={!open} inert={!open}>
      <div className="rl-monochat-heading">
        <span className="rl-monochat-title">Redline{context && <span className="rl-monochat-context"> · {context}</span>}</span>
        {pose === "chat" && <button type="button" className="rl-monochat-new" onClick={onNewChat} title="A blank composer; this conversation stays in History">New</button>}
        {pose === "chat" && <button type="button" aria-pressed={size === "tall"}
          aria-label={size === "tall" ? "Shrink the card" : "Enlarge the card"} title={size === "tall" ? "Shrink" : "Enlarge"}
          onClick={() => onSizeChange?.(size === "tall" ? "regular" : "tall")}>
          {size === "tall" ? <Minimize2 size={14}/> : <Maximize2 size={14}/>}
        </button>}
        <button type="button" aria-label="Collapse Redline" title="Collapse (Esc)" onClick={collapse}><ChevronDown size={16}/></button>
      </div>
      {chips}
      <div className="rl-monochat-body">{children}</div>
    </div>
  </div>;
}
