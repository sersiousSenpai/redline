import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThumbCapture } from "./useThumbCapture";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), zoom: vi.fn(), hide: vi.fn(), show: vi.fn(), position: vi.fn(), size: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ Window: { getCurrent: () => ({}) } }));
vi.mock("@tauri-apps/api/webview", () => ({
  Webview: class {
    static async getByLabel() { return null; }
    once(event: string, callback: () => void) { if (event === "tauri://created") queueMicrotask(callback); }
    setPosition = mocks.position;
    setSize = mocks.size;
    setZoom = mocks.zoom;
    show = mocks.show;
    hide = mocks.hide;
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const targets = [{ key: "p3000-test", url: "http://localhost:3000", live: true }];
let root: Root;
let container: HTMLDivElement;
let captured: ReturnType<typeof vi.fn>;
let bounds: DOMRect;
function Harness({ active = true }: { active?: boolean }) {
  const capture = useThumbCapture(targets, active, captured);
  useEffect(() => {
    const el = document.createElement("div");
    container.append(el);
    el.getBoundingClientRect = () => bounds;
    capture.registerRect(targets[0].key, el);
    return () => { capture.registerRect(targets[0].key, null); el.remove(); };
  }, [capture.registerRect]);
  return <span>{capture.thumbs.get(targets[0].key) ?? "empty"}</span>;
}
beforeEach(() => {
  vi.useFakeTimers();
  Object.values(mocks).forEach(mock => mock.mockReset().mockResolvedValue(undefined));
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  bounds = { x: 10, y: 20, left: 10, top: 20, right: 330, bottom: 220, width: 320, height: 200, toJSON() {} };
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "thumbs_list") return [];
    if (command === "browser_eval_result") return "http://localhost:3000/";
    if (command === "browser_take_thumbnail") return { path: "/thumb.png", pixelWidth: 640, pixelHeight: 400 };
    if (command === "read_file_base64") return { data: "png" };
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  captured = vi.fn();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("thumbnail capture lifecycle", () => {
  it("zooms to desktop layout, preserves pixel density and releases the native view", async () => {
    await act(async () => root.render(<Harness />));
    expect(mocks.zoom).toHaveBeenCalledWith(0.25);
    expect(mocks.invoke).toHaveBeenCalledWith("browser_take_thumbnail", { label: "browser-thumbcap", key: "p3000-test", width: 320 });
    expect(captured).toHaveBeenCalledWith("p3000-test", "/thumb.png");
    expect(container.textContent).toContain("data:image/png;base64,png");
    expect(mocks.invoke).toHaveBeenCalledWith("browser_close", { label: "browser-thumbcap" });
  });

  it("does not show a native page after the surface closes during navigation", async () => {
    let finish!: () => void;
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args: unknown) => command === "browser_navigate"
      ? new Promise<void>(resolve => { finish = resolve; }) : original(command, args));
    await act(async () => root.render(<Harness />));
    await act(async () => root.render(<Harness active={false} />));
    await act(async () => finish());
    expect(mocks.show).not.toHaveBeenCalled();
    expect(captured).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("browser_close", { label: "browser-thumbcap" });
  });

  it("defers clipped cards instead of placing a native view over adjacent UI", async () => {
    bounds = { ...bounds, top: -20, y: -20 };
    await act(async () => root.render(<Harness />));
    expect(mocks.show).not.toHaveBeenCalled();
    expect(mocks.zoom).not.toHaveBeenCalled();
  });

  it("keeps the saved preview after capture fails", async () => {
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args: unknown) => {
      if (command === "thumbs_list") return Promise.resolve([{ key: "p3000-test", path: "/saved.png", modifiedMs: 0 }]);
      if (command === "browser_take_thumbnail") return Promise.reject(new Error("blank snapshot"));
      return original(command, args);
    });
    await act(async () => root.render(<Harness />));
    expect(container.textContent).toContain("data:image/png;base64,png");
    expect(captured).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("browser_close", { label: "browser-thumbcap" });
  });
});
