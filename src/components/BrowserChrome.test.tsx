import { act, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserChrome } from "./BrowserChrome";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
const noop = () => {};
const initial = ["one", "two", 'three:quoted"id'].map((id) => ({ id, browseId: id, title: id, url: `https://example.test/${id}` }));
function Harness() {
  const [tabs, setTabs] = useState(initial), [activeId, setActive] = useState("one");
  const props: ComponentProps<typeof BrowserChrome> = {
    tabs, activeId, address: "https://example.test", onAddress: noop, onAddressFocus: noop, onNavigate: noop,
    onBack: noop, onForward: noop, onReload: noop, onSelect: setActive,
    onCloseTab: (id) => { const next = tabs.filter((tab) => tab.id !== id); setTabs(next); if (activeId === id) setActive(next[0]?.id ?? ""); },
    onNewTab: noop, onTabDrag: (event) => event.preventDefault(), chatOpen: false, onToggleChat: noop,
    tileBadges: { one: 1, two: 2 },
    split: false, onArrange: noop, onMosaics: noop, menuOpen: false, onMenu: noop, onBookmarks: noop, onAppearance: noop,
    onPreferences: noop, onInspect: noop, onCloseBrowser: noop,
  };
  return <BrowserChrome {...props}/>;
}
beforeEach(async () => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); await act(async () => root.render(<Harness/>)); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const tabs = () => [...host.querySelectorAll<HTMLElement>('[role="tab"]')];
const key = async (target: Element, value: string) => act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })); });

it.each([0, 1])("moves focus out of the address bar when pressing tab %i", async (index) => {
  const address = host.querySelector("input")!, tab = tabs()[index];
  address.focus();
  expect(address.selectionEnd).toBe(address.value.length);
  await act(async () => tab.dispatchEvent(new MouseEvent("pointerdown", { button: 0, bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(tab);
  await act(async () => tab.click());
  expect(tab.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(tab);
});

it("keeps inactive close controls outside the sequential tab order", async () => {
  expect(tabs().map((tab) => tab.querySelector("button")!.tabIndex)).toEqual([0, -1, -1]);
  tabs()[0].focus(); await key(tabs()[0], "ArrowRight");
  expect(document.activeElement).toBe(tabs()[1]);
  expect(tabs().map((tab) => tab.querySelector("button")!.tabIndex)).toEqual([-1, 0, -1]);
  await key(tabs()[1], "End"); expect(document.activeElement).toBe(tabs()[2]);
});

it("returns focus to a surviving tab after closing the active tab", async () => {
  const close = tabs()[0].querySelector("button")!; close.focus();
  await act(async () => close.click());
  expect(tabs()).toHaveLength(2);
  expect(document.activeElement).toBe(tabs()[0]);
  expect(tabs()[0].getAttribute("aria-selected")).toBe("true");
});

it("supports Delete on a focused tab without stealing address focus for inactive closes", async () => {
  const address = host.querySelector("input")!; address.focus();
  await act(async () => tabs()[1].querySelector("button")!.click());
  expect(document.activeElement).toBe(address);
  tabs()[0].focus(); await key(tabs()[0], "Delete");
  expect(tabs()).toHaveLength(1); expect(document.activeElement).toBe(tabs()[0]);
});

it("places the new-tab control directly after the final tab and numbers assigned tiles", () => {
  expect(tabs()[2].nextElementSibling?.getAttribute("aria-label")).toBe("New tab");
  expect(tabs()[0].querySelector('[aria-label="Tile 1"]')?.textContent).toBe("1");
  expect(tabs()[2].querySelector('.rb-tile-badge')).toBeNull();
});

it("preserves first-click address selection without replacing later partial selections", () => {
  const input = host.querySelector("input")!;
  input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 20 }));
  input.focus(); input.setSelectionRange(5, 5); // WebKit's native mouseup default.
  input.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: 20 }));
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
  input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 20 }));
  input.setSelectionRange(8, 15);
  input.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: 20 }));
  expect([input.selectionStart, input.selectionEnd]).toEqual([8, 15]);
});

it("puts the actual address selection on the clipboard, including partial ranges", () => {
  const input = host.querySelector("input")!, setData = vi.fn();
  for (const [start, end] of [[0, input.value.length], [8, 15]]) {
    input.setSelectionRange(start, end);
    const copy = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copy, "clipboardData", { value: { setData } });
    input.dispatchEvent(copy);
    expect(setData).toHaveBeenLastCalledWith("text/plain", input.value.slice(start, end));
    expect(copy.defaultPrevented).toBe(true);
  }
});

it("handles Cmd+C directly without waiting for the native menu's responder", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const input = host.querySelector("input")!; input.focus(); input.setSelectionRange(8, 15);
  const copy = new KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true, cancelable: true });
  await act(async () => input.dispatchEvent(copy));
  expect(writeText).toHaveBeenCalledWith(input.value.slice(8, 15));
  expect(copy.defaultPrevented).toBe(true);
  writeText.mockClear(); input.setSelectionRange(0, 0);
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true, cancelable: true })));
  expect(writeText).not.toHaveBeenCalled();
});

it("falls back to native Copy if clipboard API access fails", async () => {
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("Denied")) } });
  const execCommand = vi.fn(() => true); Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
  const input = host.querySelector("input")!; input.focus();
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true, cancelable: true })));
  expect(execCommand).toHaveBeenCalledWith("copy");
  delete (document as unknown as Record<string, unknown>).execCommand;
});
