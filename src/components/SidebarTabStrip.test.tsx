import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SidebarTabStrip } from "./SidebarTabStrip";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const folders = [{ id:"a", path:"/code/alpha", name:"alpha" }, { id:"b", path:"/code/beta", name:"beta" }];
function mount(openFolders = folders) {
  const actions = { onSelectSessions:vi.fn(), onSelectFolder:vi.fn(), onCloseFolder:vi.fn(), onToggleLink:vi.fn() };
  act(() => root.render(<SidebarTabStrip openFolders={openFolders} sidebarTab={{kind:"folder",id:"b"}} linkNav {...actions}/>));
  return actions;
}
it("hides with no folders and names the selected view", () => {
  mount([]); expect(host.textContent).toBe("");
  mount(); expect(host.querySelector('[aria-haspopup="menu"]')?.textContent).toBe('beta');
});
it("selects a repo or Sessions and returns focus to the trigger", () => {
  const actions = mount(); const trigger = host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
  act(() => trigger.click());
  const menu = () => document.querySelector('[aria-label="Sidebar view"]')!;
  act(() => menu().querySelector<HTMLButtonElement>('[title="/code/alpha"]')!.click());
  expect(actions.onSelectFolder).toHaveBeenCalledWith('a'); expect(document.activeElement).toBe(trigger);
  act(() => trigger.click());
  act(() => menu().querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
  expect(actions.onSelectSessions).toHaveBeenCalledOnce();
});
it("closes a folder without selecting it or dismissing the picker", () => {
  const actions = mount();
  act(() => host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Close alpha"]')!.click());
  expect(actions.onCloseFolder).toHaveBeenCalledWith('a'); expect(actions.onSelectFolder).not.toHaveBeenCalled();
  expect(document.querySelector('[aria-label="Sidebar view"]')).not.toBeNull();
});
