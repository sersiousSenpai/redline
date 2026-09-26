// SPDX-License-Identifier: Apache-2.0
/** Native child webviews outlive React renders. Every mutation of one durable
 * label shares a drain, including across a StrictMode remount or workspace swap.
 * A hide remains queued until an already-issued show has settled. */
export interface NativeRect { x: number; y: number; w: number; h: number }
/** Stage two belongs to the native window, outside DOM clipping ancestors. */
export function fullWindowRect(viewport: { width: number; height: number }): NativeRect | null {
  const w = Math.floor(viewport.width), h = Math.floor(viewport.height);
  return Number.isFinite(w) && Number.isFinite(h) && w >= 2 && h >= 2 ? { x: 0, y: 0, w, h } : null;
}
export interface NativeGeometryAdapter<View> {
  setPosition(view: View, position: { x: number; y: number }): Promise<unknown>;
  setSize(view: View, size: { w: number; h: number }): Promise<unknown>;
  show(view: View): Promise<unknown>;
  hide(view: View): Promise<unknown>;
  onError?(id: string, error: unknown): void;
}
export interface NativeGeometryEntry<View> { id: string; view: View; rect: NativeRect | null }
interface Target {
  owner: symbol;
  view: unknown;
  rect: NativeRect | null;
  adapter: NativeGeometryAdapter<unknown>;
}
interface State {
  target: Target;
  running: boolean;
  applied: NativeRect | null;
  shown: boolean;
  failed: boolean;
}
const nativeViews = new Map<string, State>();
const sameRect = (a: NativeRect | null, b: NativeRect | null) => a === b || !!a && !!b
  && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
const validRect = (rect: NativeRect) => Object.values(rect).every(Number.isFinite)
  && rect.x >= 0 && rect.y >= 0 && rect.w >= 2 && rect.h >= 2;

function drain(id: string, state: State) {
  if (state.running) return;
  state.running = true;
  void (async () => {
    let target: Target;
    do {
      target = state.target;
      try {
        const { view, adapter, rect } = target;
        if (!rect) {
          await adapter.hide(view);
          state.shown = false;
          state.applied = null;
        } else {
          const previous = state.applied;
          if (!previous || previous.x !== rect.x || previous.y !== rect.y) {
            await adapter.setPosition(view, rect);
            if (state.target !== target) { state.applied = null; continue; }
          }
          if (!previous || previous.w !== rect.w || previous.h !== rect.h) {
            await adapter.setSize(view, rect);
            if (state.target !== target) { state.applied = null; continue; }
          }
          if (!state.shown) {
            await adapter.show(view);
            state.shown = true;
          }
          state.applied = state.target === target ? rect : null;
        }
        state.failed = false;
      } catch (error) {
        state.applied = null;
        state.shown = false;
        state.failed = true;
        try { target.adapter.onError?.(id, error); }
        catch (reportError) { console.error("Native browser geometry error reporting failed", reportError); }
      }
    } while (state.target !== target);
    state.running = false;
    // Hidden released labels need no JS handle or geometry cache. A future
    // adoption starts unknown and must establish bounds before showing again.
    if (!state.target.rect && !state.failed && nativeViews.get(id) === state) nativeViews.delete(id);
  })();
}

export function createNativeBrowserGeometry<View>(adapter: NativeGeometryAdapter<View>) {
  const owner = Symbol("native browser geometry owner");
  let active = true;
  const erased = adapter as NativeGeometryAdapter<unknown>;
  function request(id: string, view: View, rect: NativeRect | null, claim: boolean) {
    const current = nativeViews.get(id);
    if (!claim && current && current.target.owner !== owner) return;
    const next = rect && validRect(rect) ? { ...rect } : null;
    if (current && current.target.owner === owner && current.target.view === view
      && sameRect(current.target.rect, next) && !current.failed) return;
    const target: Target = { owner, view, rect: next, adapter: erased };
    if (current) {
      if (current.target.view !== view || current.target.owner !== owner) {
        current.applied = null;
        current.shown = false;
      }
      current.target = target;
      drain(id, current);
    } else {
      const state: State = { target, running: false, applied: null, shown: false, failed: false };
      nativeViews.set(id, state);
      drain(id, state);
    }
  }
  const hideAll = () => {
    for (const [id, state] of nativeViews) {
      if (state.target.owner === owner) request(id, state.target.view as View, null, false);
    }
  };
  return {
    start() { active = true; },
    stop() { active = false; hideAll(); },
    sync(entries: Iterable<NativeGeometryEntry<View>>) {
      if (!active) return;
      const present = new Set<string>();
      for (const { id, view, rect } of entries) { present.add(id); request(id, view, rect, true); }
      for (const [id, state] of nativeViews) {
        if (state.target.owner === owner && !present.has(id)) request(id, state.target.view as View, null, false);
      }
    },
    hide(id: string, view: View) { request(id, view, null, false); },
    hideAll,
    appliedRects(): Map<string, NativeRect> {
      return new Map([...nativeViews].filter(([, state]) => state.target.owner === owner && state.applied)
        .map(([id, state]) => [id, { ...state.applied! }]));
    },
  };
}

interface ElementRect { left: number; top: number; width: number; height: number }
/** Bound native pixels to the intersection of their slot, stage and viewport.
 * Rounding inward prevents a fractional DOM edge from covering adjacent chrome. */
export function clipNativeBrowserRect(slot: ElementRect, stage: ElementRect, viewport: { width: number; height: number }): NativeRect | null {
  if (![slot.left, slot.top, slot.width, slot.height, stage.left, stage.top, stage.width, stage.height, viewport.width, viewport.height].every(Number.isFinite)
    || slot.width < 2 || slot.height < 2 || stage.width < 2 || stage.height < 2 || viewport.width < 2 || viewport.height < 2) return null;
  const x = Math.ceil(Math.max(0, slot.left, stage.left));
  const y = Math.ceil(Math.max(0, slot.top, stage.top));
  const right = Math.floor(Math.min(viewport.width, slot.left + slot.width, stage.left + stage.width));
  const bottom = Math.floor(Math.min(viewport.height, slot.top + slot.height, stage.top + stage.height));
  return right - x >= 2 && bottom - y >= 2 ? { x, y, w: right - x, h: bottom - y } : null;
}

export function measureNativeBrowserRect(slot: HTMLElement | undefined | null, stage: HTMLElement | undefined | null): NativeRect | null {
  if (!slot?.isConnected || !stage?.isConnected || !stage.contains(slot)) return null;
  let clipping = stage.getBoundingClientRect();
  let escapedByFixed = false;
  for (let node: HTMLElement | null = slot; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (node.hidden || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0" || style.contentVisibility === "hidden") return null;
    // A fullscreen fixed stage escapes ordinary overflow ancestors, but a
    // transform/filter/contain ancestor can establish its fixed containing block.
    // Visibility still applies through every ancestor, including escaped ones.
    if (escapedByFixed && establishesFixedContainingBlock(style)) escapedByFixed = false;
    const clipX = /^(hidden|clip|scroll|auto)$/.test(style.overflowX || style.overflow);
    const clipY = /^(hidden|clip|scroll|auto)$/.test(style.overflowY || style.overflow);
    if (!escapedByFixed && node !== slot && (clipX || clipY)) {
      const box = node.getBoundingClientRect();
      const left = clipX ? Math.max(clipping.left, box.left) : clipping.left;
      const top = clipY ? Math.max(clipping.top, box.top) : clipping.top;
      const right = clipX ? Math.min(clipping.right, box.right) : clipping.right;
      const bottom = clipY ? Math.min(clipping.bottom, box.bottom) : clipping.bottom;
      clipping = new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
    }
    if (style.position === "fixed") escapedByFixed = true;
  }
  return clipNativeBrowserRect(slot.getBoundingClientRect(), clipping, { width: window.innerWidth, height: window.innerHeight });
}

function establishesFixedContainingBlock(style: CSSStyleDeclaration): boolean {
  return ["transform", "translate", "rotate", "scale", "perspective", "filter", "backdrop-filter"]
    .some((property) => { const value = style.getPropertyValue(property); return !!value && value !== "none"; })
    || /\b(layout|paint|strict|content)\b/.test(style.contain)
    || /\b(transform|translate|rotate|scale|perspective|filter|backdrop-filter|contain)\b/.test(style.willChange)
    || style.contentVisibility === "auto";
}
