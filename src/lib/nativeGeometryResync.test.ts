import { expect, it, vi } from "vitest";
import { resyncForcesReapply, subscribeGeometryResync, type GeometryResyncReason, type GeometryResyncSources } from "./nativeGeometryResync";

function harness() {
  const handlers: Record<string, (value?: unknown) => void> = {};
  const unlistened: string[] = [];
  const frames: (() => void)[] = [];
  const subscribe = (name: string) => (handler: (value?: unknown) => void) => {
    handlers[name] = handler;
    return Promise.resolve(() => { unlistened.push(name); });
  };
  const sources: GeometryResyncSources = {
    onResized: subscribe("resized"),
    onMoved: subscribe("moved"),
    onScaleChanged: subscribe("scale"),
    onFocusChanged: subscribe("focus") as GeometryResyncSources["onFocusChanged"],
    onNativeStale: subscribe("native"),
    document,
    requestFrame: (callback) => frames.push(callback),
    cancelFrame: (handle) => { frames[handle - 1] = () => {}; },
  };
  const calls: Set<GeometryResyncReason>[] = [];
  const resync = vi.fn((reasons: Set<GeometryResyncReason>) => { calls.push(new Set(reasons)); });
  const stop = subscribeGeometryResync(sources, resync);
  const flush = () => { for (const frame of frames.splice(0)) frame(); };
  return { handlers, unlistened, frames, calls, resync, stop, flush };
}
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const setVisibility = (state: DocumentVisibilityState) => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
};

it.each([
  ["resized", undefined, "resized"],
  ["moved", undefined, "moved"],
  ["scale", undefined, "scale"],
  ["focus", true, "focused"],
  ["native", undefined, "native"],
] as const)("the %s event asks for one resync on the next frame", async (source, value, reason) => {
  const h = harness();
  await settle();
  h.handlers[source](value);
  expect(h.resync).not.toHaveBeenCalled();
  h.flush();
  expect(h.calls).toEqual([new Set([reason])]);
  h.stop();
});

it("the document becoming visible asks for a resync; becoming hidden does not", async () => {
  const h = harness();
  setVisibility("hidden"); h.flush();
  expect(h.resync).not.toHaveBeenCalled();
  setVisibility("visible"); h.flush();
  expect(h.calls).toEqual([new Set(["visible"])]);
  h.stop();
});

it("losing focus is not a resync", async () => {
  const h = harness();
  await settle();
  h.handlers.focus(false); h.flush();
  expect(h.resync).not.toHaveBeenCalled();
  h.stop();
});

it("coalesces a burst of events into one resync per frame", async () => {
  const h = harness();
  await settle();
  h.handlers.resized(); h.handlers.resized(); h.handlers.moved(); h.handlers.native();
  expect(h.frames).toHaveLength(1);
  h.flush();
  expect(h.calls).toEqual([new Set(["resized", "moved", "native"])]);
  h.handlers.scale(); h.flush();
  expect(h.calls).toHaveLength(2);
  h.stop();
});

it("unsubscribes everything and drops a pending frame on stop", async () => {
  const h = harness();
  await settle();
  h.handlers.native();
  h.stop();
  h.flush();
  setVisibility("visible"); h.flush();
  expect(h.resync).not.toHaveBeenCalled();
  expect(h.unlistened.sort()).toEqual(["focus", "moved", "native", "resized", "scale"]);
});

it("re-applies equal rects for discrete moments, not for a stream of moves or a live resize", () => {
  expect(resyncForcesReapply(new Set(["moved"]))).toBe(false);
  expect(resyncForcesReapply(new Set(["resized", "moved"]))).toBe(false);
  for (const reason of ["scale", "focused", "visible", "native"] as const) {
    expect(resyncForcesReapply(new Set([reason]))).toBe(true);
  }
});

it("a source that cannot subscribe leaves the others working", async () => {
  const resync = vi.fn();
  const frames: (() => void)[] = [];
  let native: () => void = () => {};
  const stop = subscribeGeometryResync({
    onResized: () => { throw new TypeError("unavailable"); },
    onMoved: () => Promise.reject(new Error("denied")),
    onScaleChanged: () => Promise.resolve(() => {}),
    onFocusChanged: () => Promise.resolve(() => {}),
    onNativeStale: (handler) => { native = handler; return Promise.resolve(() => {}); },
    document, requestFrame: (callback) => frames.push(callback), cancelFrame: () => {},
  }, resync);
  await settle();
  native(); frames.splice(0).forEach((frame) => frame());
  expect(resync).toHaveBeenCalledTimes(1);
  stop();
});
