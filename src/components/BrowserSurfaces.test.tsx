import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserDialog, BrowserMenuItem, BrowserPopover } from "./BrowserSurfaces";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement, trigger: HTMLButtonElement;
let popupHeight: number;
let observers: { callback: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[];
beforeEach(() => {
  host = document.createElement("div"); trigger = document.createElement("button");
  trigger.textContent = "Open menu"; document.body.append(trigger, host); root = createRoot(host); trigger.focus();
  popupHeight = 100; observers = [];
  vi.stubGlobal("innerWidth", 1000); vi.stubGlobal("innerHeight", 800);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 100, 30)] as unknown as DOMRectList);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("rb-popover") ? new DOMRect(0, 0, 272, popupHeight) : new DOMRect(600, 500, 32, 32);
  });
  vi.stubGlobal("ResizeObserver", class {
    callback: () => void; observe = vi.fn(); disconnect = vi.fn();
    constructor(callback: () => void) { this.callback = callback; observers.push(this); }
  });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); trigger.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const render = async (children: ReactNode, menu = false, close = vi.fn()) => {
  await act(async () => root.render(<BrowserPopover anchor={{ current: trigger }} title="Choices" onClose={close} menu={menu}>{children}</BrowserPopover>));
  return document.querySelector<HTMLElement>(".rb-popover")!;
};
const key = async (target: Element, value: string, shiftKey = false) => {
  const event = new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true });
  await act(async () => { target.dispatchEvent(event); }); return event;
};

it("focuses a select-only popover and restores its trigger when dismissed", async () => {
  await render(<select aria-label="Choice"><option>One</option></select>);
  expect(document.activeElement?.tagName).toBe("SELECT");
  await act(async () => root.render(null));
  expect(document.activeElement).toBe(trigger);
});

it("uses a focusable container when no visible enabled controls exist", async () => {
  const panel = await render(<><button disabled>Unavailable</button><div hidden><textarea aria-label="Hidden"/></div></>);
  expect(document.activeElement).toBe(panel);
  expect((await key(panel, "Tab")).defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(panel);
});

it("traps links and textareas in native tabindex order and skips collapsed details", async () => {
  const panel = await render(<>
    <button style={{ display: "none" }}>Hidden</button>
    <details><summary>More</summary><button>Collapsed child</button><details open><summary>Nested</summary><a href="#nested">Nested hidden link</a></details></details>
    <textarea aria-label="Notes"/><button tabIndex={2}>First in tab order</button><button tabIndex={-1}>Programmatic only</button><a href="#last">Last link</a>
  </>);
  const first = panel.querySelector<HTMLElement>('[tabindex="2"]')!;
  const last = panel.querySelector<HTMLElement>('a[href="#last"]')!;
  expect(document.activeElement).toBe(first);
  await key(first, "Tab", true); expect(document.activeElement).toBe(last);
  await key(last, "Tab"); expect(document.activeElement).toBe(first);
  first.tabIndex = -1;
  (panel.querySelector("summary") as HTMLElement).focus();
  await key(document.activeElement!, "Tab", true); expect(document.activeElement).toBe(last);
});

it("wraps only available menu items and handles Escape", async () => {
  const close = vi.fn();
  const panel = await render(<>
    <BrowserMenuItem onClick={() => {}}>First</BrowserMenuItem>
    <BrowserMenuItem disabled onClick={() => {}}>Disabled</BrowserMenuItem>
    <div hidden><BrowserMenuItem onClick={() => {}}>Hidden</BrowserMenuItem></div>
    <BrowserMenuItem onClick={() => {}}>Last</BrowserMenuItem>
  </>, true, close);
  expect(document.activeElement?.textContent).toBe("First");
  await key(document.activeElement!, "ArrowUp"); expect(document.activeElement?.textContent).toBe("Last");
  await key(document.activeElement!, "Home"); expect(document.activeElement?.textContent).toBe("First");
  await key(panel, "Escape"); expect(close).toHaveBeenCalledOnce();
});

it("uses pressed buttons inside dialogs and reserves radio menu roles for menus", async () => {
  let panel = await render(<BrowserMenuItem selected onClick={() => {}}>Current conversation</BrowserMenuItem>);
  const button = panel.querySelector("button")!;
  expect(button.getAttribute("role")).toBeNull();
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(button.getAttribute("aria-checked")).toBeNull();
  panel = await render(<BrowserMenuItem selected onClick={() => {}}>Current conversation</BrowserMenuItem>, true);
  expect(panel.querySelector('[role="menuitemradio"]')?.getAttribute("aria-checked")).toBe("true");
});

it("repositions growing content without stealing focus and disconnects its observers", async () => {
  const panel = await render(<textarea aria-label="Draft"/>);
  const textarea = panel.querySelector("textarea")!;
  expect(panel.style.top).toBe("540px");
  expect(observers[0].observe).toHaveBeenCalledWith(trigger);
  expect(observers[0].observe).toHaveBeenCalledWith(panel);
  popupHeight = 400;
  await act(async () => observers[0].callback());
  expect(panel.style.top).toBe("384px");
  expect(document.activeElement).toBe(textarea);
  await act(async () => root.render(null));
  expect(observers[0].disconnect).toHaveBeenCalledOnce();
});

it("keeps dialog focus inside its visible controls and restores prior focus", async () => {
  await act(async () => root.render(<BrowserDialog title="Preferences" onClose={() => {}}><textarea aria-label="Notes"/></BrowserDialog>));
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(document.activeElement).toBe(dialog);
  await key(dialog, "Tab", true);
  expect(document.activeElement?.textContent).toBe("Done");
  await key(document.activeElement!, "Tab");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Close preferences");
  await act(async () => root.render(null)); expect(document.activeElement).toBe(trigger);
});
