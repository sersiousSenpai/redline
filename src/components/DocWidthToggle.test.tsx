import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DocWidthToggle } from "./DocWidthToggle";
import { isResizing } from "../lib/resizeSession";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement, container: HTMLDivElement, article: HTMLElement;
let toggle: ReturnType<typeof vi.fn>, commit: ReturnType<typeof vi.fn>;
const pointer = (target: EventTarget, type: string, y: number) => {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientY: y });
  Object.defineProperty(event, "pointerId", { value: 1 });
  act(() => target.dispatchEvent(event));
};
const click = (detail = 1) => act(() => host.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail })));
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div"); container = document.createElement("div"); article = document.createElement("article");
  document.body.append(host, container); container.append(article);
  Object.defineProperty(container, "clientWidth", { value: 1220, configurable: true });
  article.style.maxWidth = "820px"; article.style.paddingRight = "32px";
  toggle = vi.fn(); commit = vi.fn(); root = createRoot(host);
  const articleRef = createRef<HTMLElement>(); articleRef.current = article;
  act(() => root.render(<DocWidthToggle wide={false} measure={820} articleRef={articleRef} onToggle={toggle} onCommit={commit} />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); container.remove(); vi.useRealTimers(); expect(isResizing()).toBe(false); });
describe("document width gesture", () => {
  it("taps and keyboard clicks toggle", () => { pointer(host.querySelector("button")!, "pointerdown", 200); pointer(window, "pointerup", 200); click(); click(0); expect(toggle).toHaveBeenCalledTimes(2); expect(commit).not.toHaveBeenCalled(); });
  it("upward drag commits full width and swallows the click", () => { pointer(host.querySelector("button")!, "pointerdown", 200); pointer(window, "pointermove", 40); expect(isResizing()).toBe(true); pointer(window, "pointerup", 40); click(); expect(commit).toHaveBeenCalledWith({ wide: true, measure: 820 }); expect(article.style.maxWidth).toBe("none"); expect(toggle).not.toHaveBeenCalled(); });
  it("commits the live middle measure", () => { pointer(host.querySelector("button")!, "pointerdown", 200); pointer(window, "pointermove", 120); act(() => vi.advanceTimersByTime(20)); expect(article.style.maxWidth).toBe("1020px"); pointer(window, "pointerup", 120); expect(commit).toHaveBeenCalledWith({ wide: false, measure: 1020 }); });
  it("Escape restores the original styles and releases resize ownership", () => { pointer(host.querySelector("button")!, "pointerdown", 200); pointer(window, "pointermove", 120); act(() => vi.advanceTimersByTime(20)); act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))); expect(article.style.maxWidth).toBe("820px"); expect(commit).not.toHaveBeenCalled(); expect(isResizing()).toBe(false); });
  it("holding without movement is a no-op", () => { pointer(host.querySelector("button")!, "pointerdown", 200); act(() => vi.advanceTimersByTime(260)); pointer(window, "pointerup", 200); click(); expect(toggle).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled(); });
  it("has no drag range below the narrow measure, but tapping works", () => { Object.defineProperty(container, "clientWidth", { value: 700 }); pointer(host.querySelector("button")!, "pointerdown", 200); pointer(window, "pointermove", 10); pointer(window, "pointerup", 10); click(); expect(commit).not.toHaveBeenCalled(); expect(toggle).not.toHaveBeenCalled(); click(0); expect(toggle).toHaveBeenCalledOnce(); });
  it("cancel and unmount restore live styles and release resources", () => { pointer(host.querySelector("button")!, "pointerdown", 200); pointer(window, "pointermove", 80); act(() => vi.advanceTimersByTime(20)); pointer(window, "pointercancel", 80); expect(article.style.maxWidth).toBe("820px"); expect(isResizing()).toBe(false); });
});
