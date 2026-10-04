import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ release: vi.fn(), rendererDispose: vi.fn(), loseContext: vi.fn(), orbitDispose: vi.fn(), disconnect: vi.fn(), failObserve: true }));
vi.mock("../../lib/graphicsAllocation", () => ({ acquireGraphics: () => mocks.release }));
vi.mock("three", async () => {
  const real = await vi.importActual<typeof import("three")>("three");
  return { ...real, WebGLRenderer: class {
    domElement = document.createElement("canvas");
    setPixelRatio() {} setClearColor() {} setSize() {}
    dispose = mocks.rendererDispose; forceContextLoss = mocks.loseContext;
  } };
});
vi.mock("three/addons/controls/OrbitControls.js", async () => {
  const { Vector3 } = await vi.importActual<typeof import("three")>("three");
  return { OrbitControls: class { target = new Vector3(); update() {} addEventListener() {} dispose = mocks.orbitDispose; } };
});
import { CosmosScene } from "./scene";
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks(); mocks.failObserve = true;
  vi.stubGlobal("ResizeObserver", class { observe() { if (mocks.failObserve) throw new Error("detached native host"); } disconnect = mocks.disconnect; });
  vi.stubGlobal("IntersectionObserver", undefined);
  host = document.createElement("div"); document.body.appendChild(host);
});
afterEach(() => { host.remove(); vi.unstubAllGlobals(); });
const events = () => ({ select: vi.fn(), edge: vi.fn(), camera: vi.fn(), error: vi.fn(), orbit: vi.fn(), stats: vi.fn() });
it("cleans partially initialized graphics and DOM resources so a failed host can retry", () => {
  expect(() => new CosmosScene(host, events())).toThrow("detached native host");
  expect(host.children).toHaveLength(0);
  expect(mocks.disconnect).toHaveBeenCalledOnce(); expect(mocks.orbitDispose).toHaveBeenCalledOnce();
  expect(mocks.rendererDispose).toHaveBeenCalledOnce(); expect(mocks.loseContext).toHaveBeenCalledOnce(); expect(mocks.release).toHaveBeenCalledOnce();
  mocks.failObserve = false;
  const scene = new CosmosScene(host, events()); expect(host.children).toHaveLength(2);
  scene.dispose(); scene.dispose();
  expect(host.children).toHaveLength(0); expect(mocks.release).toHaveBeenCalledTimes(2);
});
