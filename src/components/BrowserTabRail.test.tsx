// SPDX-License-Identifier: Apache-2.0
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import BrowserTabRail from "./BrowserTabRail";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const tabs = ["First", "Second", "Third"].map((title, i) => ({ id:`tab-${i}`,browseId:`page-${i}`,url:`https://page${i}.test`,title,favicon:i === 0 ? "https://page0.test/icon.png" : undefined }));
beforeEach(() => { localStorage.clear(); host=document.createElement("div"); document.body.append(host); root=createRoot(host); });
afterEach(() => { act(()=>root.unmount()); host.remove(); vi.unstubAllGlobals(); });
function mount(overrides = {}) { const handlers={onSelect:vi.fn(),onCloseTab:vi.fn(),onNewTab:vi.fn(),onTabDrag:vi.fn(),onResize:vi.fn(),onMode:vi.fn(),onOrganize:vi.fn(),onToggleGroup:vi.fn()}; act(()=>root.render(<BrowserTabRail tabs={tabs} activeId="tab-0" organized={false} organizing={false} groups={[]} {...handlers} {...overrides}/>)); return handlers; }
it("uses vertical keyboard navigation, Delete and middle-click close", () => {
  const handlers=mount(), first=host.querySelector<HTMLElement>('[data-tab-id="tab-0"]')!;
  act(()=>{ first.focus(); first.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true})); }); expect(handlers.onSelect).toHaveBeenLastCalledWith("tab-1"); expect(document.activeElement?.getAttribute("data-tab-id")).toBe("tab-1");
  act(()=>document.activeElement!.dispatchEvent(new KeyboardEvent("keydown",{key:"End",bubbles:true}))); expect(handlers.onSelect).toHaveBeenLastCalledWith("tab-2");
  act(()=>document.activeElement!.dispatchEvent(new KeyboardEvent("keydown",{key:"Delete",bubbles:true}))); expect(handlers.onCloseTab).toHaveBeenLastCalledWith("tab-2");
  act(()=>first.dispatchEvent(new MouseEvent("auxclick",{button:1,bubbles:true}))); expect(handlers.onCloseTab).toHaveBeenLastCalledWith("tab-0");
});
it("starts as the icon strip, persists showing and hiding titles, and falls back when a favicon fails", () => {
  mount(); const icon=host.querySelector("img")!;
  expect(host.querySelector("aside")?.hasAttribute("data-collapsed")).toBe(true);
  // Icon mode closes a page from the ✕ on its icon (shown on hover).
  expect(host.querySelectorAll(".rb-tab-close")).toHaveLength(3);
  expect(host.querySelector('[data-tab-id="tab-1"]')!.getAttribute("title")).toBe("2 · Second\nhttps://page1.test");
  act(()=>icon.dispatchEvent(new Event("error"))); expect(host.querySelector("img")).toBeNull(); expect(host.querySelector('[data-tab-id="tab-0"] svg')).not.toBeNull();
  act(()=>host.querySelector<HTMLButtonElement>('[aria-label="Show tab titles"]')!.click()); expect(localStorage.getItem("redline.browser.railWidth")).toBe("220"); expect(host.querySelector("aside")?.hasAttribute("data-collapsed")).toBe(false);
  expect(host.querySelectorAll(".rb-tab-close")).toHaveLength(3);
  act(()=>host.querySelector<HTMLButtonElement>('[aria-label="Hide tab titles"]')!.click()); expect(localStorage.getItem("redline.browser.railWidth")).toBe("40"); expect(host.querySelector("aside")?.hasAttribute("data-collapsed")).toBe(true);
});
it("reads the old 48 px collapsed width as the icon strip", () => {
  localStorage.setItem("redline.browser.railWidth","48"); mount();
  expect(host.querySelector("aside")?.hasAttribute("data-collapsed")).toBe(true);
  expect(host.querySelector<HTMLElement>("aside")!.style.getPropertyValue("--browser-rail-width")).toBe("40px");
});
it("speaks the one status vocabulary in each icon's corner and keeps tile numbers on the icons", () => {
  mount({ acting: new Set(["tab-0"]), loading: new Set(["tab-1"]), suspended: new Set(["tab-2"]), tileBadges: { "page-0": 1, "page-2": 2 } });
  const tab = (i: number) => host.querySelector<HTMLElement>(`[data-tab-id="tab-${i}"]`)!;
  expect(tab(0).dataset.status).toBe("working"); expect(tab(0).querySelector(".rl-spinner")).not.toBeNull();
  expect(tab(0).getAttribute("aria-label")).toContain("the agent is acting on this page");
  expect(tab(1).dataset.status).toBe("working"); expect(tab(1).querySelector(".rl-spinner")).not.toBeNull();
  expect(tab(2).dataset.status).toBe("suspended"); expect(tab(2).querySelector(".rl-spinner, .rb-needs-dot")).toBeNull();
  expect(tab(0).querySelector('[aria-label="Tile 1"]')?.textContent).toBe("1");
  expect(tab(2).querySelector('[aria-label="Tile 2"]')?.textContent).toBe("2");
  mount({ failed: { "tab-1": "Could not connect" }, suspended: new Set(["tab-1"]) });
  expect(tab(1).dataset.status).toBe("needs"); expect(tab(1).querySelector(".rb-needs-dot")).not.toBeNull();
  expect(tab(1).getAttribute("aria-label")).toContain("this page could not load");
  expect(tab(0).dataset.status).toBeUndefined();
  // A refused address never commits, so its navigation still "loads": the
  // failure wins, the amber dot shows (the re-walk's 127.0.0.1:1).
  mount({ failed: { "tab-1": "Could not connect" }, loading: new Set(["tab-1"]) });
  expect(tab(1).dataset.status).toBe("needs"); expect(tab(1).querySelector(".rb-needs-dot")).not.toBeNull();
  expect(tab(1).querySelector(".rl-spinner")).toBeNull();
});
it("lists recently closed pages at the strip's foot and reopens one", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  mount();
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Recently closed"]')!.disabled).toBe(true);
  const onReopen = vi.fn(), closed = [{ url: "https://gone.test", title: "Gone", at: 1 }, { url: "https://older.test", title: "Older", at: 0 }];
  mount({ closed, onReopen });
  const button = host.querySelector<HTMLButtonElement>('.rb-rail-foot [aria-label="Recently closed"]')!;
  expect(button.title).toBe("Recently closed · 2");
  act(() => button.click());
  const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"][aria-label="Recently closed"] button')];
  expect(items.map((b) => b.textContent)).toEqual(["Gone", "Older"]);
  act(() => items[1].click());
  expect(onReopen).toHaveBeenCalledWith(closed[1]);
  expect(document.querySelector('[role="menu"][aria-label="Recently closed"]')).toBeNull();
});
it("closes a page from the ✕ on its icon in the icon strip", () => {
  const handlers = mount();
  act(() => host.querySelector<HTMLButtonElement>('[data-tab-id="tab-1"] .rb-tab-close')!.click());
  expect(handlers.onCloseTab).toHaveBeenCalledWith("tab-1");
  expect(handlers.onSelect).not.toHaveBeenCalled();
});
