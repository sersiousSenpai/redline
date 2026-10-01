import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), load: vi.fn(), save: vi.fn(), revision: vi.fn(), raceLabel: "", windowFullscreen: false, setFullscreen: vi.fn(), resized: null as (() => void) | null, listeners: new Map<string, (event: { payload: unknown }) => void>(), views: new Map<string, { label: string; log: string[]; visible: boolean; position?: { x: number; y: number }; size?: { width: number; height: number } }>(), createGates: new Map<string, Promise<void>>(), showGates: new Map<string, Promise<void>>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, fn) => { mocks.listeners.set(name, fn); return () => { mocks.listeners.delete(name); }; }) }));
vi.mock("../lib/browserWorkspace", () => ({ loadBrowserWorkspace: mocks.load, saveBrowserWorkspace: mocks.save, noteWorkspaceRevision: mocks.revision }));
vi.mock("@tauri-apps/api/window", () => ({ Window: { getCurrent: () => ({ onResized: async (callback: () => void) => { mocks.resized = callback; return () => { mocks.resized = null; }; }, isFullscreen: async () => mocks.windowFullscreen, setFullscreen: mocks.setFullscreen }) } }));
vi.mock("@tauri-apps/api/webview", () => ({ Webview: class {
  static getCurrent() { return { setFocus: () => mocks.invoke("focus_main_webview") }; }
  log: string[] = [];
  visible = false;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  constructor(_window: unknown, public label: string) { mocks.views.set(label, this); if (mocks.raceLabel === label) { mocks.raceLabel = ""; throw new Error("Native manager already created this label"); } }
  static async getByLabel(label: string) { return mocks.views.get(label) ?? null; }
  static async getAll() { return [...mocks.views.values()]; }
  async once(name: string, fn: () => void) { if (name === "tauri://created") void (mocks.createGates.get(this.label) ?? Promise.resolve()).then(fn); }
  async setPosition(position: { x: number; y: number }) { this.position = position; this.log.push("position"); }
  async setSize(size: { width: number; height: number }) { this.size = size; this.log.push("size"); }
  async setFocus() { this.log.push("focus"); }
  async show() { this.log.push("show"); await mocks.showGates.get(this.label); this.visible = true; this.log.push("shown"); }
  async hide() { this.log.push("hide"); this.visible = false; }
} }));
vi.mock("../hooks/useMission", () => ({ useMission: () => ({ activeMissionId: null, activeMission: null, missions: [], missionsLoaded: true, findings: [], error: null, closeMission: () => {} }) }));
vi.mock("./BrowserChat", () => ({ BrowserChat: (props: { browseId: string; label: string; onToggleLinked?: () => void; seed?: { text: string } }) => <div data-conversation={props.browseId} data-label={props.label} data-seed={props.seed?.text}><button onClick={props.onToggleLinked}>Linked toggle</button></div> }));
import { BrowserPane } from "./BrowserPane";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, dock: HTMLDivElement, root: Root;
const pendingGates: (() => void)[] = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  pendingGates.push(resolve);
  return { promise, resolve };
}
const tabs = ["one", "two"].map((browseId) => ({ id: `t-${browseId}`, browseId, title: browseId, url: `https://${browseId}.test` }));
const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); }); };
const event = async (name: string, payload: unknown) => { await act(async () => { mocks.listeners.get(name)?.({ payload }); }); await settle(); };
beforeEach(() => {
  localStorage.clear(); mocks.listeners.clear(); mocks.views.clear(); mocks.createGates.clear(); mocks.showGates.clear(); mocks.raceLabel = "";
  mocks.windowFullscreen = false; mocks.resized = null;
  mocks.setFullscreen.mockReset().mockImplementation(async (value: boolean) => { mocks.windowFullscreen = value; mocks.resized?.(); });
  mocks.invoke.mockReset(); mocks.load.mockReset(); mocks.save.mockReset(); mocks.revision.mockReset();
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "browser_close") { const view = mocks.views.get(args.label); if (view) { view.visible = false; view.log.push("close"); mocks.views.delete(args.label); } }
    return command === "get_browse_thread" ? [] : null;
  });
  mocks.load.mockResolvedValue({ tabs, revision: 1, layout: { preset: "compare", tiles: ["one", "two"], horizontal: .5, vertical: .5, focused: "two", maximized: null } });
  mocks.save.mockResolvedValue(undefined);
  localStorage.setItem("redline.browser.tabs", JSON.stringify(tabs));
  localStorage.setItem("redline.browser.activeId", "t-one");
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 10, y: 80, left: 10, top: 80, right: 1210, bottom: 880, width: 1200, height: 800, toJSON: () => ({}) });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) { return [this.getBoundingClientRect()] as unknown as DOMRectList; });
  vi.stubGlobal("ResizeObserver", class { constructor(private callback: () => void) {} observe() { this.callback(); } disconnect() {} });
  host = document.createElement("div"); dock = document.createElement("div"); document.body.append(host, dock); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); dock.remove();
  pendingGates.splice(0).forEach((resolve) => resolve());
  await new Promise((resolve) => setTimeout(resolve, 170));
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function mount(props: Partial<ComponentProps<typeof BrowserPane>> = {}) {
  await act(async () => root.render(<BrowserPane onClose={() => {}} dockSlot={dock} dockPill="page" {...props}/>));
  await settle();
}

it.each(["button", "shortcut"])("opens a new tab with Google from its first render via %s", async (via) => {
  await mount();
  if (via === "button") {
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="New tab"]')!.click());
  } else {
    await event("browser-page-event", { label: "browser-t-two", kind: "shortcut", value: "new-tab" });
  }
  const tab = host.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')!;
  const label = `browser-${tab.dataset.tabId}`;
  const title = () => tab.querySelector(".rb-tab-title")!.textContent;
  expect(title()).toBe("Google");
  for (const state of [
    { url: "about:blank", title: "" },
    { url: "https://www.google.com/", title: "" },
    { url: "https://www.google.com/", title: "Google" },
    { url: "https://www.google.com/", title: "" },
  ]) {
    await event("browser-page-event", { label, kind: "state", ...state });
    expect(title()).toBe("Google");
  }
});

it("ignores an older URL poll after a page event provides a newer URL and title", async () => {
  const intervals = vi.spyOn(window, "setInterval");
  await mount();
  const tick = intervals.mock.calls.find(([, delay]) => delay === 5000)![0] as () => Promise<void>;
  let finish!: (url: string) => void;
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command, args) => command === "browser_url"
    ? new Promise<string>((resolve) => { finish = resolve; }) : original(command, args));
  let pending!: Promise<void>;
  act(() => { pending = tick(); });
  await event("browser-page-event", { label: "browser-t-two", kind: "state", url: "https://two.test/latest", title: "Latest page" });
  await act(async () => { finish("https://two.test/"); await pending; });
  expect(host.querySelector('[data-tab-id="t-two"] .rb-tab-title')?.textContent).toBe("Latest page");
  expect(host.querySelector<HTMLInputElement>('[aria-label="Address or search"]')!.value).toBe("https://two.test/latest");
});

it("keeps a closed dock closed across remounts", async () => {
  const onOpenDockPill = vi.fn();
  await mount({ dockPill: null, onOpenDockPill });
  await act(async () => root.render(null));
  await mount({ dockPill: null, onOpenDockPill });
  expect(onOpenDockPill).not.toHaveBeenCalled();
});

it("gives native Edit commands back to the address input and reselects on Cmd+L", async () => {
  await mount();
  const input = host.querySelector<HTMLInputElement>('[aria-label="Address or search"]')!;
  await act(async () => input.focus());
  expect(mocks.invoke).toHaveBeenCalledWith("focus_main_webview");
  expect(input.selectionEnd).toBe(input.value.length);
  input.setSelectionRange(3, 3); mocks.invoke.mockClear();
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "l", metaKey: true, bubbles: true, cancelable: true })));
  await settle();
  expect(mocks.invoke).toHaveBeenCalledWith("focus_main_webview");
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
});

it("manual tab selection switches its thread while keeping the panel open", async () => {
  await mount();
  await act(async () => host.querySelector<HTMLElement>('[data-tab-id="t-one"]')!.click());
  expect(dock.querySelector('[data-conversation="one"]')).not.toBeNull();
  await act(async () => host.querySelector<HTMLElement>('[data-tab-id="t-two"]')!.click());
  expect(dock.querySelector('[data-conversation="two"]')).not.toBeNull();
});

it.each([0, 1])("commits an adjacent drag from slot %i to the previewed slot", async (from) => {
  await mount();
  const nodes = [...host.querySelectorAll<HTMLElement>("[data-tab-id]")], strip = nodes[0].parentElement!;
  nodes.forEach((node, index) => {
    node.getBoundingClientRect = () => ({ left: index * 100, right: (index + 1) * 100, width: 100 }) as DOMRect;
    node.setPointerCapture = vi.fn(); node.releasePointerCapture = vi.fn(); node.hasPointerCapture = () => true;
  });
  strip.getBoundingClientRect = () => ({ left: 0, right: 200, width: 200, top: 0, bottom: 30 }) as DOMRect;
  const pointer = (type: string, x: number) => Object.assign(new MouseEvent(type, { clientX: x, clientY: 12, button: 0, bubbles: true, cancelable: true }), { pointerId: 1 });
  const start = from * 100 + 50, end = start + (from === 0 ? 58 : -58);
  await act(async () => nodes[from].dispatchEvent(pointer("pointerdown", start)));
  await act(async () => window.dispatchEvent(pointer("pointermove", end)));
  expect([...host.querySelectorAll<HTMLElement>("[data-tab-id]")].map(node => node.dataset.tabId)).toEqual(["t-one", "t-two"]);
  await act(async () => window.dispatchEvent(pointer("pointerup", end)));
  expect([...host.querySelectorAll<HTMLElement>("[data-tab-id]")].map(node => node.dataset.tabId)).toEqual(["t-two", "t-one"]);
});

it("restores saved focus and sizes newly created native tiles before their first show", async () => {
  await mount();
  expect((host.querySelector('[aria-label="Address or search"]') as HTMLInputElement).value).toBe("https://two.test");
  for (const label of ["browser-t-one", "browser-t-two"]) {
    const log = mocks.views.get(label)!.log;
    expect(log).toContain("show");
    expect(log.indexOf("position")).toBeLessThan(log.indexOf("show"));
    expect(log.indexOf("size")).toBeLessThan(log.indexOf("show"));
  }
  expect(mocks.invoke).toHaveBeenCalledWith("browser_protect_tabs", { labels: ["browser-t-one", "browser-t-two"] });
});

it("adopts a page created concurrently by the native manager instead of retrying duplicate IDs", async () => {
  mocks.raceLabel = "browser-t-two";
  await mount();
  expect(mocks.views.get("browser-t-two")?.log).toContain("show");
  expect(mocks.invoke).toHaveBeenCalledWith("browser_enable_autoresize", { label: "browser-t-two", enabled: false });
  expect(mocks.invoke).toHaveBeenCalledWith("browser_enable_gestures", { label: "browser-t-two" });
  expect(mocks.invoke).toHaveBeenCalledWith("browser_install_shims", { label: "browser-t-two", selectionActions: true });
});

it("adopts background mission tabs without stealing focus and ignores foreign workspace events", async () => {
  await mount();
  await event("browser-workspace-tab-added", { workspaceId: "other-mission", revision: 9, tab: { browseId: "foreign", url: "https://foreign.test" } });
  expect(host.querySelector('[data-tab-id="t-foreign"]')).toBeNull();
  await event("browser-workspace-tab-added", { workspaceId: "regular", revision: 2, tab: { browseId: "three", id: "legacy-id", url: "https://three.test" } });
  expect(host.querySelector('[data-tab-id="t-three"]')).not.toBeNull();
  expect((host.querySelector('[aria-label="Address or search"]') as HTMLInputElement).value).toBe("https://two.test");
  expect(mocks.revision).toHaveBeenCalledWith("regular", 2);
  await event("browser-page-event", { label: "browser-t-foreign", kind: "shortcut", value: "next-tab" });
  expect((host.querySelector('[aria-label="Address or search"]') as HTMLInputElement).value).toBe("https://two.test");
  await event("browser-page-event", { label: "browser-t-two", kind: "shortcut", value: "next-tab" });
  expect((host.querySelector('[aria-label="Address or search"]') as HTMLInputElement).value).toBe("https://three.test");
});

it("keeps the linked thread across pages and releases it when switched off", async () => {
  await mount();
  expect(dock.querySelector("[data-selected-discussion]")).toBeNull();
  await act(async () => (dock.querySelector('[data-conversation="two"] button') as HTMLButtonElement).click());
  await event("browser-page-event", { label: "browser-t-two", kind: "shortcut", value: "next-tab" });
  expect(dock.querySelector("[data-conversation]")?.getAttribute("data-conversation")).toBe("two");
  expect(dock.querySelector("[data-conversation]")?.getAttribute("data-label")).toBe("browser-t-one");
  await act(async () => dock.querySelector<HTMLButtonElement>("button")!.click());
  expect(dock.querySelector("[data-conversation]")?.getAttribute("data-conversation")).toBe("one");
});

it("shows the same native bounds again after an overlay hides both tiles", async () => {
  await mount();
  const views = [...mocks.views.values()];
  const firstShowCounts = views.map((view) => view.log.filter((entry) => entry === "show").length);
  await mount({ visible: false });
  expect(views.every((view) => !view.visible && view.log[view.log.length - 1] === "hide")).toBe(true);
  await mount({ visible: true });
  views.forEach((view, index) => {
    expect(view.visible).toBe(true);
    expect(view.log.filter((entry) => entry === "show").length).toBe(firstShowCounts[index] + 1);
    expect(view.log.slice(-4)).toEqual(["position", "size", "show", "shown"]);
  });
});

describe("video fullscreen", () => {
  const enter = () => event("browser-page-event", { label: "browser-t-two", kind: "state", url: "https://two.test", fullscreen: true });
  const escape = () => act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  const screen = async () => { await act(async () => { (host.querySelector('[aria-label="Video fullscreen controls"] button') as HTMLButtonElement).click(); }); await settle(); };
  it("keeps the dock mounted, preserves a hidden session, and exits from the host header", async () => {
    await mount(); const chat = dock.querySelector("[data-conversation]");
    await enter(); expect(host.querySelector('[aria-label="Address or search"]')).toBeNull();
    expect(dock.querySelector("[data-conversation]")).toBe(chat);
    await mount({ visible: false }); await mount({ visible: true });
    expect(host.querySelector('[aria-label="Video fullscreen controls"]')).not.toBeNull();
    const composer = document.createElement("textarea"); dock.appendChild(composer);
    await act(async () => composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(host.querySelector('[aria-label="Video fullscreen controls"]')).not.toBeNull(); composer.remove();
    await escape(); await settle();
    expect(host.querySelector('[aria-label="Address or search"]')).not.toBeNull();
    expect(mocks.invoke).toHaveBeenCalledWith("browser_eval", { label: "browser-t-two", script: "window.__redline_fs_exit&&window.__redline_fs_exit()" });
    expect([...mocks.views.values()].every((view) => view.visible)).toBe(true);
  });
  it("covers the native window in stage two, demotes on window exit, and restores an owned window on Escape", async () => {
    await mount(); await enter(); await screen();
    expect(mocks.setFullscreen).toHaveBeenCalledWith(true);
    const view = mocks.views.get("browser-t-two")!;
    expect(view.position).toMatchObject({ x: 0, y: 0 });
    expect(view.size).toMatchObject({ width: innerWidth, height: innerHeight });
    expect(view.log).toContain("focus");
    await act(async () => { mocks.windowFullscreen = false; mocks.resized?.(); }); await settle();
    expect(host.querySelector('[aria-label="Video fullscreen controls"]')).not.toBeNull();
    await screen(); await escape(); await settle();
    expect(mocks.setFullscreen).toHaveBeenLastCalledWith(false);
    expect(host.querySelector('[aria-label="Address or search"]')).not.toBeNull();
  });
  it("leaves preexisting window fullscreen alone and exits on navigation or a surface switch", async () => {
    mocks.windowFullscreen = true;
    await mount(); await enter(); await screen(); await escape(); await settle();
    expect(mocks.setFullscreen).not.toHaveBeenCalled();
    await enter(); await event("browser-page-event", { label: "browser-t-two", kind: "state", url: "https://two.test/next", fullscreen: false });
    expect(host.querySelector('[aria-label="Address or search"]')).not.toBeNull();
    await event("browser-page-event", { label: "browser-t-two", kind: "state", url: "https://two.test/next", fullscreen: true });
    await mount({ surfaceActive: false }); await mount({ surfaceActive: true });
    expect(host.querySelector('[aria-label="Address or search"]')).not.toBeNull();
  });
});

it("ignores native and app keyboard shortcuts while another surface is active", async () => {
  await mount({ surfaceActive: false });
  const address = host.querySelector('[aria-label="Address or search"]') as HTMLInputElement;
  for (const value of ["next-tab", "new-tab", "toggle-focus", "location"]) {
    await event("browser-page-event", { label: "browser-t-two", kind: "shortcut", value });
  }
  await event("browser-page-event", { label: "browser-t-one", kind: "focus" });
  await event("browser-page-event", { label: "browser-t-one", kind: "interaction" });
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "l", metaKey: true, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, shiftKey: true, bubbles: true }));
  });
  expect(address.value).toBe("https://two.test");
  expect(document.activeElement).not.toBe(address);
  expect(host.querySelectorAll('[role="tab"]')).toHaveLength(2);
  expect(host.textContent).not.toContain("Exit focus");
  expect([...mocks.views.values()].every((view) => !view.visible && !view.log.includes("show"))).toBe(true);
});

it("finishes hiding a pending native show after the pane unmounts", async () => {
  const shown = deferred();
  mocks.showGates.set("browser-t-two", shown.promise);
  await mount();
  const view = mocks.views.get("browser-t-two")!;
  expect(view.log[view.log.length - 1]).toBe("show");
  await act(async () => root.render(null));
  await act(async () => { shown.resolve(); });
  await settle();
  expect(view.log.slice(-2)).toEqual(["shown", "hide"]);
  expect(view.visible).toBe(false);
});

it("keeps native pages hidden when their creation callbacks arrive after unmount", async () => {
  const created = deferred();
  mocks.createGates.set("browser-t-one", created.promise);
  mocks.createGates.set("browser-t-two", created.promise);
  await mount();
  const views = [...mocks.views.values()];
  expect(views).toHaveLength(2);
  await act(async () => root.render(null));
  await act(async () => { created.resolve(); });
  await settle();
  views.forEach((view) => {
    expect(view.log).toContain("hide");
    expect(view.log).not.toContain("show");
    expect(view.visible).toBe(false);
  });
});

it("flushes pending layout state when the pane closes", async () => {
  await mount();
  await event("browser-page-event", { label: "browser-t-two", kind: "shortcut", value: "next-tab" });
  await act(async () => root.render(null));
  expect(mocks.save).toHaveBeenLastCalledWith("regular", expect.objectContaining({ layout: expect.objectContaining({ focused: "one" }) }));
});

it("an inspector click immediately opens chat with the element attached", async () => {
  const onOpenDockPill = vi.fn();
  await mount({ onOpenDockPill });
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Page menu"]')!.click());
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === "Select an element to discuss")!.click());
  expect(host.textContent).toContain("Click an element · Esc to cancel");
  await event("browser-page-event", { label: "browser-t-two", kind: "inspect", value: { tag: "h1", accessibleName: "Heading" } });
  expect(onOpenDockPill).toHaveBeenLastCalledWith("page");
  expect(dock.querySelector("[data-seed]")?.getAttribute("data-seed")).toContain('"accessibleName": "Heading"');
  expect(host.textContent).not.toContain("Attach to chat");
});

it("reveals page chat before an element or text action seeds its composer", async () => {
  localStorage.setItem("redline.browser.selectedDiscussion", JSON.stringify({ regular: true }));
  await mount();
  await event("browser-page-event", { label: "browser-t-two", kind: "selection", value: { id: 1, action: "ask", text: "Selected evidence", url: "https://two.test", title: "two" } });
  expect(dock.querySelector("[data-selected-discussion]")).toBeNull();
  const chat = dock.querySelector<HTMLElement>("[data-conversation]")!;
  expect(chat.parentElement!.style.display).not.toBe("none");
  expect(chat.getAttribute("data-conversation")).toBe("two");
});

describe("mosaics", () => {
  const cells = Array.from({ length: 9 }, (_, i) => ({ browseId: `news${i + 1}`, url: `https://news${i + 1}.test/`, label: `P${i + 1}` }));
  const mosaicBody = { name: "Stock News", grid: { rows: 3, cols: 3 }, cells, tabs: cells.map((cell) => ({ id: `t-${cell.browseId}`, browseId: cell.browseId, url: `${cell.url}yesterday` })), layout: { preset: "grid", grid: { rows: 3, cols: 3 }, tiles: cells.map((cell) => cell.browseId), maximized: "news2" }, revision: 3 };
  const mosaicLabels = cells.map((cell) => `browser-t-${cell.browseId}`);
  const liveMosaicViews = () => [...mocks.views.keys()].filter((label) => mosaicLabels.includes(label));
  beforeEach(() => {
    const regular = mocks.load.getMockImplementation();
    mocks.load.mockImplementation(async (id: string) => id === "mosaic:news" ? mosaicBody : regular?.(id));
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: { label: string }) => command === "browser_workspace_list"
      ? [{ id: "mosaic:news", name: "Stock News", grid: { rows: 3, cols: 3 }, tabCount: 9, updatedAt: Date.now() }]
      : base(command, args));
  });
  async function openFromMenu() {
    await act(async () => (host.querySelector('[aria-label="Page menu"]') as HTMLButtonElement).click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === "Mosaics…")!.click());
    await settle();
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent?.startsWith("Stock News"))!.click());
  }
  const stageSections = () => [...host.querySelectorAll("section")].map((section) => section.getAttribute("aria-label"));

  it("opens a saved 3×3 as nine live, sized tiles created in staggered batches, and closing restores the regular pages", async () => {
    await mount();
    const created = deferred();
    mosaicLabels.forEach((label) => mocks.createGates.set(label, created.promise));
    await openFromMenu();
    await settle();
    expect(mocks.save).toHaveBeenCalledWith("regular", expect.objectContaining({ tabs: expect.arrayContaining([expect.objectContaining({ browseId: "one" })]) }));
    expect(liveMosaicViews()).toHaveLength(3);
    await act(async () => { created.resolve(); });
    for (let i = 0; i < 4; i++) await settle();
    expect(liveMosaicViews()).toHaveLength(9);
    for (const label of mosaicLabels) {
      const log = mocks.views.get(label)!.log;
      expect(log).toContain("show");
      expect(log.indexOf("size")).toBeLessThan(log.indexOf("show"));
    }
    // Opening resets to the definition: all nine tiles, none maximized, at their saved titles.
    expect(stageSections()).toEqual(cells.map((cell, i) => `Page ${i + 1}: ${cell.label}`));
    expect(host.querySelector("[data-grid]")?.getAttribute("data-grid")).toBe("3x3");
    expect(mocks.invoke).toHaveBeenCalledWith("browser_protect_tabs", { labels: mosaicLabels });
    // A mosaic persists only to its own row — never the regular bucket, never as a mission.
    await event("browser-page-event", { label: "browser-t-news4", kind: "focus" });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    expect(JSON.parse(localStorage.getItem("redline.browser.tabs")!).map((tab: { browseId: string }) => tab.browseId)).toEqual(["one", "two"]);
    expect(localStorage.getItem("redline.browser.activeId")).not.toBe("t-news4");
    expect(mocks.save).toHaveBeenLastCalledWith("mosaic:news", expect.objectContaining({ layout: expect.objectContaining({ grid: { rows: 3, cols: 3 }, focused: "news4" }) }));

    await act(async () => (host.querySelector('[aria-label="Close Stock News"]') as HTMLButtonElement).click());
    await settle();
    expect(mocks.save).toHaveBeenCalledWith("mosaic:news", expect.objectContaining({ tabs: expect.any(Array) }));
    expect([...host.querySelectorAll('[role="tab"]')].map((tab) => tab.getAttribute("aria-label"))).toEqual(["one", "two"]);
    expect(host.querySelector('[aria-label="Close Stock News"]')).toBeNull();
    expect(JSON.parse(localStorage.getItem("redline.browser.tabs")!).map((tab: { browseId: string }) => tab.browseId)).toEqual(["one", "two"]);
  });

  it("maximizes a tile from its header and restores the grid on Escape", async () => {
    await mount();
    await openFromMenu();
    for (let i = 0; i < 4; i++) await settle();
    const header = host.querySelector('[aria-label="Page 5: P5"] > div') as HTMLElement;
    await act(async () => header.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(stageSections()).toEqual(["Page 1: P5"]);
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(stageSections()).toHaveLength(9);
    await act(async () => (host.querySelector('[aria-label="Page 2: P2"] > div') as HTMLElement).dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    await event("browser-page-event", { label: "browser-t-news2", kind: "shortcut", value: "exit-focus" });
    expect(stageSections()).toHaveLength(9);
  });

  it("sends pages that were left open back to their saved addresses when the mosaic reopens", async () => {
    await mount();
    await openFromMenu();
    for (let i = 0; i < 4; i++) await settle();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "browser_navigate")).toEqual([]);
    await act(async () => (host.querySelector('[aria-label="Close Stock News"]') as HTMLButtonElement).click());
    await settle();
    await openFromMenu();
    for (let i = 0; i < 4; i++) await settle();
    const navigations = mocks.invoke.mock.calls.filter(([command]) => command === "browser_navigate").map(([, args]) => args);
    expect(navigations).toHaveLength(9);
    expect(navigations).toEqual(expect.arrayContaining(cells.map((cell) => ({ label: `browser-t-${cell.browseId}`, url: cell.url }))));
  });

  it("opens the startup mosaic once per app session", async () => {
    vi.resetModules();
    const { BrowserPane: FreshPane } = await import("./BrowserPane");
    localStorage.setItem("redline.browser.startupMosaic", JSON.stringify("mosaic:news"));
    await act(async () => root.render(<FreshPane onClose={() => {}} dockSlot={dock} dockPill="page"/>));
    for (let i = 0; i < 4; i++) await settle();
    expect(host.querySelector('[aria-label="Close Stock News"]')).not.toBeNull();
    expect(mocks.load).toHaveBeenCalledWith("mosaic:news");
    await act(async () => root.render(null));
    mocks.load.mockClear();
    await act(async () => root.render(<FreshPane onClose={() => {}} dockSlot={dock} dockPill="page"/>));
    for (let i = 0; i < 2; i++) await settle();
    expect(mocks.load).not.toHaveBeenCalledWith("mosaic:news");
    expect(host.querySelector('[aria-label="Close Stock News"]')).toBeNull();
  });
});
