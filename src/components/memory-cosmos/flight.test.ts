import { PerspectiveCamera } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlightControls } from "./flight";

let canvas: HTMLCanvasElement, camera: PerspectiveCamera, controls: FlightControls;
let locked: Element | null;
const exit = vi.fn(), release = vi.fn();
const lockDescriptor = Object.getOwnPropertyDescriptor(document, "pointerLockElement");
const exitDescriptor = Object.getOwnPropertyDescriptor(document, "exitPointerLock");
const changed = () => document.dispatchEvent(new Event("pointerlockchange"));
const key = (code: string, extra: KeyboardEventInit = {}) => window.dispatchEvent(new KeyboardEvent("keydown", { code, key: code === "Escape" ? "Escape" : code.slice(-1).toLowerCase(), bubbles: true, cancelable: true, ...extra }));
beforeEach(() => {
  exit.mockClear(); release.mockReset(); locked = null;
  Object.defineProperty(document, "pointerLockElement", { configurable: true, get: () => locked });
  Object.defineProperty(document, "exitPointerLock", { configurable: true, value: release.mockImplementation(() => { locked = null; changed(); }) });
  canvas = document.createElement("canvas"); canvas.tabIndex = 0; document.body.appendChild(canvas);
  camera = new PerspectiveCamera(); controls = new FlightControls(canvas, camera, exit); controls.enabled = true;
});
afterEach(() => {
  controls.dispose(); canvas.remove(); vi.restoreAllMocks();
  if (lockDescriptor) Object.defineProperty(document, "pointerLockElement", lockDescriptor); else delete (document as unknown as Record<string, unknown>).pointerLockElement;
  if (exitDescriptor) Object.defineProperty(document, "exitPointerLock", exitDescriptor); else delete (document as unknown as Record<string, unknown>).exitPointerLock;
});
describe("Cosmos flight ownership", () => {
  it("moves only with canvas focus and clears held keys on focus loss", () => {
    key("KeyW"); controls.step(.05); expect(camera.position.z).toBe(0);
    canvas.focus(); key("KeyW", { metaKey: true }); controls.step(.05); expect(camera.position.z).toBe(0);
    key("KeyW"); controls.step(.05); expect(camera.position.z).toBeLessThan(0);
    const before = camera.position.z;
    canvas.blur(); canvas.focus(); controls.step(.05); expect(camera.position.z).toBe(before);
    controls.dispose(); key("KeyW"); controls.step(.05); expect(camera.position.z).toBe(before);
  });
  it("returns to Orbit for ordinary Escape and pointer-lock Escape consumed by the browser", async () => {
    canvas.focus(); key("Escape"); expect(exit).toHaveBeenCalledOnce(); exit.mockClear();
    canvas.requestPointerLock = vi.fn(async () => { locked = canvas; changed(); });
    await controls.capture(); key("KeyW");
    locked = null; changed();
    expect(exit).toHaveBeenCalledOnce(); controls.step(.05); expect(camera.position.z).toBe(0);
  });
  it("releases capture on stop without incorrectly treating mode switches as Escape", async () => {
    canvas.requestPointerLock = vi.fn(async () => { locked = canvas; changed(); });
    await controls.capture(); controls.stop();
    expect(release).toHaveBeenCalledOnce(); expect(locked).toBeNull(); expect(exit).not.toHaveBeenCalled();
  });
  it("releases a late native capture after changing mode or disposing", async () => {
    let resolve!: () => void;
    canvas.requestPointerLock = vi.fn(() => new Promise<void>(done => { resolve = done; }));
    const capture = controls.capture(); controls.stop(); controls.enabled = false;
    locked = canvas; changed(); resolve(); await capture; await Promise.resolve();
    expect(locked).toBeNull(); expect(exit).not.toHaveBeenCalled();
    controls.enabled = true;
    const second = controls.capture(); controls.dispose();
    locked = canvas; resolve(); await second; await Promise.resolve();
    expect(locked).toBeNull();
  });
  it("reports rejected modern and legacy capture requests while preserving drag navigation", async () => {
    canvas.requestPointerLock = vi.fn(async () => { throw new Error("denied"); });
    await expect(controls.capture()).rejects.toThrow("Drag to look instead");
    canvas.requestPointerLock = vi.fn(() => undefined) as unknown as typeof canvas.requestPointerLock;
    const legacy = controls.capture(); document.dispatchEvent(new Event("pointerlockerror"));
    await expect(legacy).rejects.toThrow("Drag to look instead");
    expect(controls.enabled).toBe(true); key("KeyW"); controls.step(.05); expect(camera.position.z).toBeLessThan(0);
  });
  it("rejects capture when detached or outside Fly mode", async () => {
    controls.enabled = false; await expect(controls.capture()).rejects.toThrow("Choose Fly");
    controls.enabled = true; canvas.remove(); await expect(controls.capture()).rejects.toThrow("Choose Fly");
  });
});
