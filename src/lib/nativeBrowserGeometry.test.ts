import { afterEach, expect, it, vi } from "vitest";
import { clipNativeBrowserRect, createNativeBrowserGeometry, fullWindowRect, measureNativeBrowserRect, type NativeGeometryAdapter, type NativeRect } from "./nativeBrowserGeometry";

type View = { name: string };
const rect: NativeRect = { x: 40, y: 80, w: 600, h: 400 };
it("uses the entire native window for screen fullscreen and rejects invalid sizes", () => {
  expect(fullWindowRect({ width: 1440.8, height: 900.9 })).toEqual({ x: 0, y: 0, w: 1440, h: 900 });
  expect(fullWindowRect({ width: 1.9, height: 900 })).toBeNull();
  expect(fullWindowRect({ width: 1440, height: NaN })).toBeNull();
  expect(fullWindowRect({ width: Infinity, height: 900 })).toBeNull();
});
const cleanups: (() => void)[] = [];
let sequence = 0;
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(overrides: Partial<NativeGeometryAdapter<View>> = {}) {
  const log: string[] = [];
  const adapter: NativeGeometryAdapter<View> = {
    setPosition: async (_view, next) => { log.push(`position:${next.x},${next.y}`); },
    setSize: async (_view, next) => { log.push(`size:${next.w},${next.h}`); },
    show: async () => { log.push("show"); },
    hide: async () => { log.push("hide"); },
    onError: vi.fn(),
    ...overrides,
  };
  const controller = createNativeBrowserGeometry(adapter);
  cleanups.push(() => controller.stop());
  return { id: `browser-test-${++sequence}`, view: { name: "page" }, controller, log, adapter };
}
afterEach(async () => { cleanups.splice(0).forEach((stop) => stop()); await settle(); document.body.replaceChildren(); vi.restoreAllMocks(); });

it("establishes bounds before showing and avoids redundant native mutations", async () => {
  const f = fixture();
  f.controller.sync([{ ...f, rect }]); await settle();
  expect(f.log).toEqual(["position:40,80", "size:600,400", "show"]);
  f.controller.sync([{ ...f, rect: { ...rect } }]); await settle();
  expect(f.log).toHaveLength(3);
  f.controller.hide(f.id, f.view); await settle();
  f.controller.sync([{ ...f, rect }]); await settle();
  expect(f.log.slice(-3)).toEqual(["position:40,80", "size:600,400", "show"]);
});

it("finishes a queued hide after an already-issued show resolves", async () => {
  const shown = deferred();
  const f = fixture({ show: async () => { f.log.push("show"); await shown.promise; } });
  f.controller.sync([{ ...f, rect }]); await settle();
  expect(f.log[f.log.length - 1]).toBe("show");
  f.controller.hideAll();
  shown.resolve(); await settle();
  expect(f.log[f.log.length - 1]).toBe("hide");
  expect(f.controller.appliedRects().size).toBe(0);
});

it("never shows a removed workspace tile after its pending position completes", async () => {
  const positioned = deferred();
  const f = fixture({ setPosition: async () => { f.log.push("position"); await positioned.promise; } });
  f.controller.sync([{ ...f, rect }]); await settle();
  f.controller.sync([]);
  positioned.resolve(); await settle();
  expect(f.log).toEqual(["position", "hide"]);
});

it("serializes replacement geometry while a prior native size is pending", async () => {
  const sized = deferred(); let calls = 0;
  const f = fixture({ setSize: async (_view, next) => { f.log.push(`size:${next.w}`); if (++calls === 1) await sized.promise; } });
  f.controller.sync([{ ...f, rect }]); await settle();
  f.controller.sync([{ ...f, rect: { ...rect, x: 60, w: 350 } }]);
  sized.resolve(); await settle();
  expect(f.log).toEqual(["position:40,80", "size:600", "position:60,80", "size:350", "show"]);
  expect(f.controller.appliedRects().get(f.id)).toEqual({ ...rect, x: 60, w: 350 });
});

it("shares a label queue across remounts and ignores stale owner cleanup", async () => {
  const shown = deferred();
  const old = fixture({ show: async () => { old.log.push("old show"); await shown.promise; } });
  old.controller.sync([{ ...old, rect }]); await settle();
  old.controller.stop();
  const next = fixture();
  next.controller.sync([{ id: old.id, view: next.view, rect: { ...rect, x: 100 } }]);
  old.controller.hide(old.id, old.view);
  shown.resolve(); await settle();
  expect(old.log).not.toContain("hide");
  expect(next.log).toEqual(["position:100,80", "size:600,400"]);
  expect(next.controller.appliedRects().get(old.id)?.x).toBe(100);
  old.controller.sync([{ ...old, rect }]); await settle();
  expect(next.controller.appliedRects().get(old.id)?.x).toBe(100);
});

it("shows a new owner only after an old pending hide settles", async () => {
  const hidden = deferred();
  const old = fixture({ hide: async () => { old.log.push("hide"); await hidden.promise; } });
  old.controller.sync([{ ...old, rect }]); await settle();
  old.controller.stop(); await settle();
  const next = fixture();
  next.controller.sync([{ id: old.id, view: next.view, rect }]); await settle();
  expect(next.log).toEqual([]);
  hidden.resolve(); await settle();
  expect(next.log[next.log.length - 1]).toBe("show");
});

it("reports a native failure and permits an explicit retry of the same bounds", async () => {
  let calls = 0;
  const f = fixture({ setSize: async () => { if (++calls === 1) throw new Error("native resize failed"); } });
  f.controller.sync([{ ...f, rect }]); await settle();
  expect(f.adapter.onError).toHaveBeenCalledWith(f.id, expect.objectContaining({ message: "native resize failed" }));
  expect(f.log).not.toContain("show");
  f.controller.sync([{ ...f, rect }]); await settle();
  expect(f.log[f.log.length - 1]).toBe("show");
});

it("clamps oversized slots inward to their stage and viewport and rejects invalid geometry", () => {
  const viewport = { width: 1000, height: 700 };
  const stage = { left: 100.2, top: 80.7, width: 900, height: 700 };
  expect(clipNativeBrowserRect({ left: -100, top: -100, width: 5000, height: 5000 }, stage, viewport))
    .toEqual({ x: 101, y: 81, w: 899, h: 619 });
  expect(clipNativeBrowserRect({ left: 1200, top: 0, width: 600, height: 400 }, stage, viewport)).toBeNull();
  expect(clipNativeBrowserRect({ left: 0, top: 0, width: 0, height: 400 }, stage, viewport)).toBeNull();
  expect(clipNativeBrowserRect({ left: NaN, top: 0, width: 600, height: 400 }, stage, viewport)).toBeNull();
});

it("refuses detached, hidden or unrelated DOM slots", () => {
  const container = document.createElement("div");
  const stage = document.createElement("div");
  const slot = document.createElement("div");
  container.append(stage); stage.append(slot);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 20, 400, 300));
  expect(measureNativeBrowserRect(slot, stage)).toBeNull();
  document.body.append(container);
  expect(measureNativeBrowserRect(slot, stage)).toEqual({ x: 10, y: 20, w: 400, h: 300 });
  container.style.visibility = "hidden";
  expect(measureNativeBrowserRect(slot, stage)).toBeNull();
  container.style.visibility = "visible";
  container.style.display = "none";
  expect(measureNativeBrowserRect(slot, stage)).toBeNull();
  expect(measureNativeBrowserRect(document.body, stage)).toBeNull();
});

function fullscreenFixture() {
  const pane = document.createElement("div");
  const stage = document.createElement("div");
  const slot = document.createElement("div");
  pane.style.overflow = "hidden";
  stage.style.position = "fixed";
  stage.style.overflow = "hidden";
  pane.append(stage); stage.append(slot); document.body.append(pane);
  vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 80, 500, 300));
  const viewport = new DOMRect(0, 0, window.innerWidth, window.innerHeight);
  vi.spyOn(stage, "getBoundingClientRect").mockReturnValue(viewport);
  vi.spyOn(slot, "getBoundingClientRect").mockReturnValue(viewport);
  return { pane, stage, slot };
}

it("lets a fullscreen fixed stage escape pane overflow while still rejecting hidden ancestors", () => {
  const { pane, stage, slot } = fullscreenFixture();
  expect(measureNativeBrowserRect(slot, stage)).toEqual({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });
  pane.style.display = "none";
  expect(measureNativeBrowserRect(slot, stage)).toBeNull();
});

it.each(["transform", "filter", "contain", "will-change"])("retains fullscreen clipping when %s establishes a fixed containing block", (property) => {
  const { pane, stage, slot } = fullscreenFixture();
  pane.style.setProperty(property, { transform: "translateZ(0)", filter: "blur(0px)", contain: "paint", "will-change": "transform" }[property]!);
  expect(measureNativeBrowserRect(slot, stage)).toEqual({ x: 100, y: 80, w: 500, h: 300 });
});

it("clips a normal stage only in an ancestor's clipped axis", () => {
  const { pane, stage, slot } = fullscreenFixture();
  stage.style.position = "relative";
  pane.style.overflow = "";
  pane.style.overflowX = "clip";
  pane.style.overflowY = "visible";
  expect(measureNativeBrowserRect(slot, stage)).toEqual({ x: 100, y: 0, w: 500, h: window.innerHeight });
});
