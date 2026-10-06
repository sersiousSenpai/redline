// SPDX-License-Identifier: Apache-2.0
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import BrowserTabRail from "./BrowserTabRail";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const tabs = ["First", "Second", "Third"].map((title, i) => ({ id:`tab-${i}`,browseId:`page-${i}`,url:`https://page${i}.test`,title,favicon:i === 0 ? "https://page0.test/icon.png" : undefined }));
beforeEach(() => { localStorage.clear(); host=document.createElement("div"); document.body.append(host); root=createRoot(host); });
afterEach(() => { act(()=>root.unmount()); host.remove(); });
function mount(overrides = {}) { const handlers={onSelect:vi.fn(),onCloseTab:vi.fn(),onNewTab:vi.fn(),onTabDrag:vi.fn(),onResize:vi.fn(),onMode:vi.fn(),onOrganize:vi.fn(),onToggleGroup:vi.fn()}; act(()=>root.render(<BrowserTabRail tabs={tabs} activeId="tab-0" organized={false} organizing={false} groups={[]} {...handlers} {...overrides}/>)); return handlers; }
it("uses vertical keyboard navigation, Delete and middle-click close", () => {
  const handlers=mount(), first=host.querySelector<HTMLElement>('[data-tab-id="tab-0"]')!;
  act(()=>{ first.focus(); first.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true})); }); expect(handlers.onSelect).toHaveBeenLastCalledWith("tab-1"); expect(document.activeElement?.getAttribute("data-tab-id")).toBe("tab-1");
  act(()=>document.activeElement!.dispatchEvent(new KeyboardEvent("keydown",{key:"End",bubbles:true}))); expect(handlers.onSelect).toHaveBeenLastCalledWith("tab-2");
  act(()=>document.activeElement!.dispatchEvent(new KeyboardEvent("keydown",{key:"Delete",bubbles:true}))); expect(handlers.onCloseTab).toHaveBeenLastCalledWith("tab-2");
  act(()=>first.dispatchEvent(new MouseEvent("auxclick",{button:1,bubbles:true}))); expect(handlers.onCloseTab).toHaveBeenLastCalledWith("tab-0");
});
it("persists collapse width and falls back when a favicon fails", () => {
  mount(); const icon=host.querySelector("img")!;
  act(()=>icon.dispatchEvent(new Event("error"))); expect(host.querySelector("img")).toBeNull(); expect(host.querySelector('[data-tab-id="tab-0"] svg')).not.toBeNull();
  act(()=>host.querySelector<HTMLButtonElement>('[aria-label="Collapse tab rail"]')!.click()); expect(localStorage.getItem("redline.browser.railWidth")).toBe("48"); expect(host.querySelector("aside")?.hasAttribute("data-collapsed")).toBe(true);
});
