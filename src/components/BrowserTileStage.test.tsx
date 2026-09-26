import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserTileStage } from "./BrowserTileStage";
import { DEFAULT_BROWSER_LAYOUT } from "../lib/browserLayout";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} }); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function stage() {
  const onLayout = vi.fn(), onFocus = vi.fn(), onDragging = vi.fn(), onAssign = vi.fn();
  const pages = ["one", "two", "three"].map((browseId) => ({ id: `t-${browseId}`, browseId, title: browseId, url: `https://${browseId}.test` }));
  await act(async () => root.render(<BrowserTileStage stageRef={createRef()} slots={{ current: new Map() }} pages={pages} tabs={pages} activeId="t-one" layout={{ ...DEFAULT_BROWSER_LAYOUT, preset: "research", horizontal: .5, vertical: .5 }} fullscreen={false} shots={new Map()} showShots={false} onLayout={onLayout} onFocus={onFocus} onDragging={onDragging} onAssign={onAssign}/>));
  return { onLayout, onFocus, onDragging, onAssign };
}
it("keeps fullscreen in the pane's flex layout without fixed positioning", async () => {
  const page = { id: "t-one", browseId: "one", title: "one", url: "https://one.test" };
  const ref = createRef<HTMLDivElement>();
  await act(async () => root.render(<BrowserTileStage stageRef={ref} slots={{ current: new Map() }} pages={[page]} tabs={[page]} activeId="t-one" layout={DEFAULT_BROWSER_LAYOUT} fullscreen shots={new Map()} showShots={false} onLayout={vi.fn()} onFocus={vi.fn()} onDragging={vi.fn()} onAssign={vi.fn()}/>));
  expect(ref.current!.style.position).not.toBe("fixed");
  expect(host.querySelectorAll("section")).toHaveLength(1);
  expect(host.querySelector('[role="separator"]')).toBeNull();
});
it("uses each divider's physical axis and supports bounded keyboard jumps", async () => {
  const { onLayout } = await stage();
  const columns = host.querySelector('[aria-label="Resize page columns"]')!;
  const rows = host.querySelector('[aria-label="Resize page rows"]')!;
  await act(async () => { columns.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); rows.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); columns.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); rows.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })); });
  expect(onLayout.mock.calls).toEqual([[{ horizontal: .525 }], [{ vertical: .525 }], [{ vertical: .8 }]]);
});
it("clears native-page drag hiding on cancellation and focuses before maximizing", async () => {
  const { onDragging, onFocus, onLayout } = await stage();
  await act(async () => host.querySelector('[role="separator"]')!.dispatchEvent(new Event("pointercancel", { bubbles: true })));
  expect(onDragging).toHaveBeenCalledWith(false);
  await act(async () => (host.querySelector('[aria-label="Maximize page"]') as HTMLButtonElement).click());
  expect(onFocus).toHaveBeenCalledWith("t-one"); expect(onLayout).toHaveBeenCalledWith({ maximized: "one" });
});
it("draws every mosaic cell with no dividers and offers empty slots", async () => {
  const onLayout = vi.fn(), onFocus = vi.fn(), onAddPage = vi.fn();
  const pages = ["one", "two", "three", "four"].map((browseId) => ({ id: `t-${browseId}`, browseId, title: browseId, url: `https://${browseId}.test` }));
  await act(async () => root.render(<BrowserTileStage stageRef={createRef()} slots={{ current: new Map() }} pages={pages} tabs={pages} activeId="t-one" layout={{ ...DEFAULT_BROWSER_LAYOUT, preset: "grid", grid: { rows: 2, cols: 3 }, tiles: pages.map((page) => page.browseId) }} fullscreen={false} shots={new Map()} showShots={false} onLayout={onLayout} onFocus={onFocus} onDragging={vi.fn()} onAssign={vi.fn()} onAddPage={onAddPage}/>));
  expect(host.querySelectorAll("section")).toHaveLength(6);
  expect(host.querySelector('[role="separator"]')).toBeNull();
  const empty = [...host.querySelectorAll("button")].filter((button) => button.textContent === "Add a page");
  expect(empty).toHaveLength(2);
  await act(async () => empty[1].click());
  expect(onAddPage).toHaveBeenCalledWith(5);
  const third = host.querySelector('[aria-label="Page 3: three"]') as HTMLElement;
  expect(third.style.left).toBe(`${200 / 3}%`);
  expect(third.style.top).toBe("0%");
});
it("maximizes on a header double-click but not on its controls", async () => {
  const onLayout = vi.fn(), onFocus = vi.fn();
  const pages = ["one", "two"].map((browseId) => ({ id: `t-${browseId}`, browseId, title: browseId, url: `https://${browseId}.test` }));
  await act(async () => root.render(<BrowserTileStage stageRef={createRef()} slots={{ current: new Map() }} pages={pages} tabs={pages} activeId="t-one" layout={{ ...DEFAULT_BROWSER_LAYOUT, preset: "grid", grid: { rows: 1, cols: 2 }, tiles: ["one", "two"] }} fullscreen={false} shots={new Map()} showShots={false} onLayout={onLayout} onFocus={onFocus} onDragging={vi.fn()} onAssign={vi.fn()}/>));
  const header = host.querySelector('[aria-label="Page 2: two"] > div') as HTMLElement;
  await act(async () => header.querySelector(".rb-tile-picker")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await act(async () => header.querySelector("button")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(onLayout).not.toHaveBeenCalled();
  await act(async () => header.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(onFocus).toHaveBeenCalledWith("t-two"); expect(onLayout).toHaveBeenCalledWith({ maximized: "two" });
  onLayout.mockClear();
  await act(async () => root.render(<BrowserTileStage stageRef={createRef()} slots={{ current: new Map() }} pages={[pages[1]]} tabs={pages} activeId="t-two" layout={{ ...DEFAULT_BROWSER_LAYOUT, preset: "grid", tiles: ["one", "two"], maximized: "two" }} fullscreen={false} shots={new Map()} showShots={false} onLayout={onLayout} onFocus={onFocus} onDragging={vi.fn()} onAssign={vi.fn()}/>));
  await act(async () => (host.querySelector('[aria-label="Page 1: two"] > div') as HTMLElement).dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(onLayout).toHaveBeenCalledWith({ maximized: null });
});

it("offers themed assignments with occupied tile numbers", async () => {
  const { onAssign } = await stage();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Assign tab to page 1"]')!.click());
  expect(document.querySelector("select")).toBeNull();
  const menu = document.querySelector('[role="menu"]')!;
  expect(menu.textContent).toContain("three · Tile 3");
  await act(async () => [...menu.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("three"))!.click());
  expect(onAssign).toHaveBeenCalledWith(0, "three");
});
