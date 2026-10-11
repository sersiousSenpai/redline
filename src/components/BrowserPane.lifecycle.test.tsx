import { act, StrictMode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ mission: {} as Record<string, unknown>, chatRenders: [] as string[], invoke: vi.fn(), load: vi.fn(), save: vi.fn(), revision: vi.fn(), raceLabel: "", windowFullscreen: false, setFullscreen: vi.fn(), resized: null as (() => void) | null, listeners: new Map<string, (event: { payload: unknown }) => void>(), views: new Map<string, { label: string; log: string[]; visible: boolean; position?: { x: number; y: number }; size?: { width: number; height: number } }>(), createGates: new Map<string, Promise<void>>(), showGates: new Map<string, Promise<void>>() }));
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
vi.mock("../hooks/useMission", () => ({ useMission: () => ({ activeMissionId: null, activeMission: null, missions: [], missionsLoaded: true, findings: [], error: null, closeMission: () => {}, ...mocks.mission }) }));
// Memoized, as the real one is, so a render here is a change of props.
vi.mock("./BrowserChat", async () => ({ BrowserChat: (await import("react")).memo((props: { conversation: { kind: string; browseId: string; targetLabel: string }; onToggleTabChat?: () => void; onToggleLinkedMode?: () => void; onOpenLink?: (url: string) => void; onAddToMission?: (body: string, targetBrowseId?: string | null) => unknown; seed?: { text: string; source: { kind: string } }; pageActions?: ReadonlyMap<string, { kind: string; tab: number | null }>; onPickElement?: () => void; taskList?: { onOpen: () => void }; mission?: { title: string; onSynthesize: () => void } | null }) => {
  mocks.chatRenders.push(`${props.conversation.kind}:${props.conversation.browseId}`);
  const action = props.pageActions?.get(props.conversation.targetLabel);
  return <div data-conversation={props.conversation.browseId} data-label={props.conversation.targetLabel} data-seed={props.seed?.text} data-seed-source={props.seed?.source.kind}
    data-page-action={action ? `${action.kind}:${action.tab}` : undefined} data-mission={props.mission?.title} data-can-pick={props.onPickElement ? "yes" : "no"}><button onClick={props.onToggleTabChat}>Tab toggle</button><button onClick={props.onToggleLinkedMode}>Mode toggle</button>
    <button onClick={() => props.onOpenLink?.(document.body.dataset.link!)}>Reply link</button><button onClick={() => void props.onAddToMission?.("A finding")}>Pin reply</button>
    <button onClick={() => void props.onAddToMission?.("An older finding", document.body.dataset.pinTarget)}>Pin older reply</button>
    <button onClick={props.taskList?.onOpen}>Open task list</button><button onClick={props.mission?.onSynthesize}>Synthesize</button></div>;
}) }));
import { BrowserPane } from "./BrowserPane";
import { Webview as MockWebview } from "@tauri-apps/api/webview";

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
const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 160)); }); };
const event = async (name: string, payload: unknown) => { await act(async () => { mocks.listeners.get(name)?.({ payload }); }); await settle(); };
beforeEach(() => {
  localStorage.clear(); mocks.listeners.clear(); mocks.views.clear(); mocks.createGates.clear(); mocks.showGates.clear(); mocks.raceLabel = ""; mocks.mission = {}; mocks.chatRenders = [];
  mocks.windowFullscreen = false; mocks.resized = null;
  mocks.setFullscreen.mockReset().mockImplementation(async (value: boolean) => { mocks.windowFullscreen = value; mocks.resized?.(); });
  mocks.invoke.mockReset(); mocks.load.mockReset(); mocks.save.mockReset(); mocks.revision.mockReset();
  mocks.invoke.mockImplementation(async (command, args) => {
    // Tabs are built natively now; the mocked view stands in for the result.
    if (command === "browser_create_tab") { if (mocks.views.has(args.label)) return null; const view = new (MockWebview as unknown as new (window: unknown, label: string) => { label: string })(null, args.label); await (mocks.createGates.get(view.label) ?? Promise.resolve()); return null; }
    if (command === "browser_close") { const view = mocks.views.get(args.label); if (view) { view.visible = false; view.log.push("close"); mocks.views.delete(args.label); } }
    if (command === "browser_eval_result") return JSON.stringify({ ready: "complete", children: 2 });
    if (["shots_list", "mission_list"].includes(command)) return [];
    if (command === "browser_home_feed") return { recent: [], frequent: [], tasks: [], missions: [] };
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
// `usePersistedState` stores JSON, so this is the literal `true`.
const linkedModeOn = () => localStorage.setItem("redline.browser.linkedMode", "true");
const conversation = () => dock.querySelector("[data-conversation]")!.getAttribute("data-conversation");
const sharedThread = () => JSON.parse(localStorage.getItem("redline.browser.followByWorkspace")!).regular as string;
const clickTab = (id: string) => act(async () => host.querySelector<HTMLElement>(`[data-tab-id="t-${id}"]`)!.click());
const clickDock = (label: string) => act(async () => [...dock.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)!.click());

it.each(["button", "shortcut"])("opens the new-tab home without a native webview via %s", async (via) => {
  await mount();
  if (via === "button") await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="New tab"]')!.click());
  else await event("browser-page-event", { label: "browser-t-two", kind: "shortcut", value: "new-tab" });
  await settle();
  const tab = host.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')!;
  expect(tab.querySelector(".rb-tab-title")!.textContent).toBe("New tab");
  expect(mocks.views.has(`browser-${tab.dataset.tabId}`)).toBe(false);
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Address or search");
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

it("manual tab selection preserves the shared thread and retargets the page", async () => {
  linkedModeOn(); await mount(); const shared = dock.querySelector('[data-conversation]')!.getAttribute('data-conversation');
  for (const id of ["one", "two"]) {
    await act(async () => host.querySelector<HTMLElement>(`[data-tab-id="t-${id}"]`)!.click());
    expect(dock.querySelector('[data-conversation]')!.getAttribute('data-conversation')).toBe(shared);
    expect(dock.querySelector('[data-label]')!.getAttribute('data-label')).toBe(`browser-t-${id}`);
  }
});

it.each([0, 1])("commits an adjacent drag from slot %i to the previewed slot", async (from) => {
  await mount();
  const nodes = [...host.querySelectorAll<HTMLElement>("[data-tab-id]")], strip = nodes[0].parentElement!;
  nodes.forEach((node, index) => {
    node.getBoundingClientRect = () => ({ top: index * 100, bottom: (index + 1) * 100, height: 100, left: 0, right: 30, width: 30 }) as DOMRect;
    node.setPointerCapture = vi.fn(); node.releasePointerCapture = vi.fn(); node.hasPointerCapture = () => true;
  });
  strip.getBoundingClientRect = () => ({ left: 0, right: 30, width: 30, top: 0, bottom: 200, height: 200 }) as DOMRect;
  const pointer = (type: string, x: number) => Object.assign(new MouseEvent(type, { clientX: 12, clientY: x, button: 0, bubbles: true, cancelable: true }), { pointerId: 1 });
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
  expect(mocks.invoke).toHaveBeenCalledWith("browser_create_tab", expect.objectContaining({ label: "browser-t-two", selectionActions: true, zoom: 1, website: "default" }));
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

it("opts a tab out of shared chat and returns to the same shared thread", async () => {
  linkedModeOn(); await mount(); const shared = conversation();
  await clickDock("Tab toggle");
  expect(conversation()).toBe("two");
  await clickDock("Tab toggle");
  expect(conversation()).toBe(shared);
});

describe("linked mode decides tab chat vs shared chat", () => {
  it("gives every tab its own chat by default, and a flip to shared lasts until you switch away", async () => {
    await mount();
    expect(conversation()).toBe("two");
    for (const id of ["one", "two"]) { await clickTab(id); expect(conversation()).toBe(id); }
    await clickTab("one"); await clickDock("Tab toggle");
    expect(conversation()).toBe(sharedThread());
    expect(dock.querySelector("[data-label]")!.getAttribute("data-label")).toBe("browser-t-one");
    await clickTab("two"); expect(conversation()).toBe("two");
    await clickTab("one"); expect(conversation()).toBe("one");
  });

  it("switches every tab to the shared chat with the mode toggle, and back", async () => {
    await mount();
    await clickDock("Mode toggle");
    const shared = sharedThread();
    expect(conversation()).toBe(shared);
    expect(localStorage.getItem("redline.browser.linkedMode")).toBe("true");
    await clickTab("one"); expect(conversation()).toBe(shared);
    await clickDock("Tab toggle"); expect(conversation()).toBe("one");
    await clickTab("two"); expect(conversation()).toBe(shared);
    await clickTab("one"); expect(conversation()).toBe(shared);
    await clickDock("Mode toggle"); expect(conversation()).toBe("one");
  });

  it("keeps a flipped shared chat on screen while its agent opens a tab", async () => {
    await mount();
    await clickDock("Tab toggle");
    const shared = sharedThread();
    await event("browse-open-tab", { url: "https://three.test" });
    expect(host.querySelector<HTMLInputElement>('[aria-label="Address or search"]')!.value).toBe("https://three.test");
    expect(conversation()).toBe(shared);
    await clickTab("one"); expect(conversation()).toBe("one");
  });

  it("returns to the exact thread a conversation link names, in either mode", async () => {
    const open = (conversationId: string) => act(async () => { window.dispatchEvent(new CustomEvent("redline-open-conversation", { detail: { conversationKind: "browse", conversationId } })); });
    linkedModeOn(); await mount();
    const shared = conversation()!;
    await open("one"); expect(conversation()).toBe("one");
    await open(shared); expect(conversation()).toBe(shared);
    await clickDock("Mode toggle");
    await open("two"); expect(conversation()).toBe("two");
    await open(shared); expect(conversation()).toBe(shared);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("says so when a conversation link names a thread whose tab has closed", async () => {
    await mount();
    await act(async () => { window.dispatchEvent(new CustomEvent("redline-open-conversation", { detail: { conversationKind: "browse", conversationId: "closed" } })); });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("This page conversation's tab is no longer open.");
    expect(conversation()).toBe("two");
  });

  it("shows a shared chat on its own thread from its first render, never the tab's thread called shared", async () => {
    await mount();
    mocks.chatRenders = [];
    await clickDock("Tab toggle");
    const shared = sharedThread();
    expect(conversation()).toBe(shared);
    expect(new Set(mocks.chatRenders)).toEqual(new Set([`shared:${shared}`]));
  });

  it("advertises the shared thread to the dock while another panel is showing", async () => {
    linkedModeOn();
    const onDockState = vi.fn();
    await mount({ dockPill: "cart", onDockState });
    expect(onDockState).toHaveBeenLastCalledWith(expect.objectContaining({ browseId: sharedThread(), title: "Browser chat" }));
  });

  it("finds the shared chat an older build saved, with its title and origin beside it", async () => {
    linkedModeOn();
    localStorage.setItem("redline.browser.followByWorkspace", JSON.stringify({ regular: { browseId: "kept", title: "Browser chat", originTabId: "t-one" }, m1: null }));
    await mount();
    expect(conversation()).toBe("kept");
    expect(JSON.parse(localStorage.getItem("redline.browser.followByWorkspace")!)).toEqual({ regular: "kept" });
  });

  it("forgets the shared chat of a mission that no longer exists, and keeps a mosaic's until their list says", async () => {
    linkedModeOn();
    mocks.mission = { missions: [{ missionId: "m-live", title: "Live" }] };
    localStorage.setItem("redline.browser.followByWorkspace", JSON.stringify({ regular: "kept", "m-live": "a", "m-gone": "b", "mosaic:grid": "c" }));
    await mount();
    expect(conversation()).toBe("kept");
    expect(JSON.parse(localStorage.getItem("redline.browser.followByWorkspace")!)).toEqual({ regular: "kept", "m-live": "a", "mosaic:grid": "c" });
  });

  it("opens a link from a reply beside the conversation, and selects a page that is already open", async () => {
    await mount();
    document.body.dataset.link = "https://three.test/";
    await clickDock("Reply link");
    expect(host.querySelector<HTMLInputElement>('[aria-label="Address or search"]')!.value).toBe("https://three.test/");
    expect(conversation()).toBe("two");
    expect(dock.querySelector("[data-label]")!.getAttribute("data-label")).not.toBe("browser-t-two");
    document.body.dataset.link = "https://one.test";
    await clickDock("Reply link");
    expect(conversation()).toBe("one");
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(3);
    delete document.body.dataset.link;
  });

  it("pins a reply to the page it was about, not the tab the conversation is anchored to", async () => {
    const addFinding = vi.fn(async () => true);
    mocks.mission = { activeMission: { missionId: "m1", title: "Rate limits" }, addFinding };
    await mount();
    await event("browse-open-tab", { url: "https://three.test/" });
    expect(conversation()).toBe("two");
    await clickDock("Pin reply");
    const opened = dock.querySelector("[data-label]")!.getAttribute("data-label")!.replace("browser-t-", "");
    expect(addFinding).toHaveBeenCalledWith({ body: "A finding", browseId: opened, sourceUrl: "https://three.test/", sourceTitle: "three.test" });
  });

  it("pins an older shared-chat reply to the page its turn targeted, not the tab on screen now", async () => {
    linkedModeOn();
    const addFinding = vi.fn(async () => true);
    mocks.mission = { activeMission: { missionId: "m1", title: "Rate limits" }, addFinding };
    await mount();
    await clickTab("two");
    expect(dock.querySelector("[data-label]")!.getAttribute("data-label")).toBe("browser-t-two");
    // The reply was written about tab one, before the switch.
    document.body.dataset.pinTarget = "one";
    await clickDock("Pin older reply");
    expect(addFinding).toHaveBeenLastCalledWith({ body: "An older finding", browseId: "one", sourceUrl: "https://one.test", sourceTitle: "one" });
    // A tab since closed is still the page it was about, by its thread key.
    document.body.dataset.pinTarget = "gone";
    await clickDock("Pin older reply");
    expect(addFinding).toHaveBeenLastCalledWith({ body: "An older finding", browseId: "gone", sourceUrl: null, sourceTitle: null });
    delete document.body.dataset.pinTarget;
  });
});

it("re-renders the memoized page chat only when what it is handed changes", async () => {
  mocks.mission = { activeMission: { missionId: "m1", title: "Rate limits", goal: "Compare token buckets" }, findings: [] };
  await mount();
  const target = dock.querySelector("[data-label]")!.getAttribute("data-label")!;
  const other = target === "browser-t-one" ? "browser-t-two" : "browser-t-one";
  mocks.chatRenders = [];
  // Another tab's title moves the pane, not the chat.
  await event("browser-page-event", { label: other, kind: "state", url: "https://elsewhere.test/", title: "Elsewhere" });
  expect(host.querySelector(`[data-tab-id="${other.replace("browser-", "")}"] .rb-tab-title`)?.textContent).toBe("Elsewhere");
  expect(mocks.chatRenders).toEqual([]);
  // The page the chat follows is the chat's business.
  await event("browser-page-event", { label: target, kind: "state", url: "https://retitled.test/", title: "Retitled" });
  expect(mocks.chatRenders.length).toBeGreaterThan(0);
});

describe("the agent acting on a page", () => {
  it("dots the tab and names the action in the chat while it runs, and clears the dot when the turn ends", async () => {
    await mount();
    const label = dock.querySelector("[data-label]")!.getAttribute("data-label")!;
    const tab = () => host.querySelector(`[data-tab-id="${label.replace("browser-", "")}"]`)!;
    await event("browser-action", { label, kind: "click", tab: 1, status: "running", turns: ["one"] });
    expect(tab().hasAttribute("data-agent-acting")).toBe(true);
    expect(tab().getAttribute("aria-label")).toContain("the agent is acting on this page");
    expect(dock.querySelector("[data-page-action]")?.getAttribute("data-page-action")).toBe("click:1");
    // Done: the chat's live line moves on, the dot stays until the turn ends.
    await event("browser-action", { label, kind: "click", tab: 1, status: "completed", turns: ["one"] });
    expect(dock.querySelector("[data-page-action]")).toBeNull();
    expect(tab().hasAttribute("data-agent-acting")).toBe(true);
    await event("browse-done", { browseId: "one" });
    expect(tab().hasAttribute("data-agent-acting")).toBe(false);
  });

  it("hands the page chat the Task list, the mission's goal card and the element picker", async () => {
    mocks.mission = { activeMission: { missionId: "m1", title: "Rate limits", goal: "Compare token buckets" }, findings: [] };
    const openDockPill = vi.fn();
    await mount({ onOpenDockPill: openDockPill });
    expect(dock.querySelector("[data-mission]")?.getAttribute("data-mission")).toBe("Rate limits");
    expect(dock.querySelector("[data-can-pick]")?.getAttribute("data-can-pick")).toBe("yes");
    await clickDock("Open task list");
    expect(openDockPill).toHaveBeenLastCalledWith("cart");
    // Synthesize is the mission's own turn: it opens the Mission panel.
    await clickDock("Synthesize");
    expect(openDockPill).toHaveBeenLastCalledWith("mission");
  });
});

describe("plan Search", () => {
  const url = "https://search.test/?q=token+bucket";
  const search = (nonce: number) => ({ url, nonce, chat: { text: "Research token buckets", autoSend: true } });
  const tabCount = () => host.querySelectorAll('[role="tab"]').length;
  it.each([true, false])("opens a fresh tab with its own thread every time (linked mode %s)", async (linked) => {
    if (linked) linkedModeOn();
    const onOpenRequestConsumed = vi.fn();
    await mount({ onOpenRequestConsumed });
    const before = conversation();
    await mount({ onOpenRequestConsumed, openRequest: search(1) });
    const first = onOpenRequestConsumed.mock.lastCall![0] as string;
    expect(first).not.toBe(before);
    expect(tabCount()).toBe(3);
    // The research turn is seeded into the new tab's own thread — the one the
    // research comment links to.
    expect(conversation()).toBe(first);
    expect(dock.querySelector(`[data-conversation="${first}"]`)!.getAttribute("data-seed")).toBe("Research token buckets");
    expect(dock.querySelector(`[data-conversation="${first}"]`)!.getAttribute("data-seed-source")).toBe("plan-search");
    await mount({ onOpenRequestConsumed, openRequest: search(2) });
    const second = onOpenRequestConsumed.mock.lastCall![0] as string;
    expect(second).not.toBe(first);
    expect(tabCount()).toBe(4);
    expect(conversation()).toBe(second);
    // "View result" brings the first search's own thread back, not the shared one.
    await mount({ onOpenRequestConsumed, openRequest: { url, nonce: 3, focusBrowseId: first } });
    expect(conversation()).toBe(first);
    expect(tabCount()).toBe(4);
    // The Front Door's quiet reopen leaves the choice to linked mode.
    await mount({ onOpenRequestConsumed, openRequest: { url, nonce: 4, focusBrowseId: second, quiet: true } });
    expect(conversation()).toBe(linked ? sharedThread() : second);
  });
  it("waits for the restored pages when the search is what first opens the browser", async () => {
    // The pane mounts with the request, and the saved workspace swaps in
    // after it — the search's tab must land in that set, not before it.
    linkedModeOn();
    const onOpenRequestConsumed = vi.fn();
    await mount({ onOpenRequestConsumed, openRequest: search(1) });
    const browseId = onOpenRequestConsumed.mock.lastCall![0] as string;
    expect([...host.querySelectorAll('[role="tab"]')].map((tab) => tab.getAttribute("aria-label"))).toEqual(["one", "two", "search.test"]);
    expect(host.querySelector<HTMLInputElement>('[aria-label="Address or search"]')!.value).toBe(url);
    expect(conversation()).toBe(browseId);
    expect(dock.querySelector("[data-seed]")!.getAttribute("data-seed")).toBe("Research token buckets");
    expect(onOpenRequestConsumed).toHaveBeenCalledOnce();
  });
  it("still opens when last session's mission can't be restored because the list failed", async () => {
    // A mission was active last session and mission_list failed: the restore
    // falls back to regular browsing instead of holding the request for a Retry.
    const closeMission = vi.fn();
    mocks.mission = { activeMissionId: "m-last", activeMission: null, missionsLoaded: false, error: "Could not load research missions: database is locked", closeMission };
    const onOpenRequestConsumed = vi.fn();
    await mount({ onOpenRequestConsumed, openRequest: search(1) });
    expect(onOpenRequestConsumed).toHaveBeenCalledOnce();
    expect(closeMission).toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not load research missions");
    expect(conversation()).toBe(onOpenRequestConsumed.mock.lastCall![0]);
  });
});

it("forgets the retired per-tab chat key", async () => {
  localStorage.setItem("redline.browser.ownChatTabs", JSON.stringify({ regular: ["t-one"] }));
  await mount();
  expect(localStorage.getItem("redline.browser.ownChatTabs")).toBeNull();
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

it("tells the island about a press inside the visible page, never a scroll or a hidden page", async () => {
  const pressed = vi.fn();
  window.addEventListener("redline:page-press", pressed);
  try {
    await mount();
    await event("browser-page-event", { label: "browser-t-two", kind: "interaction", value: "wheel" });
    await event("browser-page-event", { label: "browser-t-two", kind: "interaction", value: "keydown" });
    expect(pressed).not.toHaveBeenCalled();
    await event("browser-page-event", { label: "browser-t-two", kind: "interaction", value: "pointerdown" });
    expect(pressed).toHaveBeenCalledOnce();
    await mount({ visible: false });
    await event("browser-page-event", { label: "browser-t-two", kind: "interaction", value: "pointerdown" });
    expect(pressed).toHaveBeenCalledOnce();
  } finally { window.removeEventListener("redline:page-press", pressed); }
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
  expect(view.log.indexOf("shown")).toBeLessThan(view.log.lastIndexOf("hide"));
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
  // A picked element waits for the user's question, with the caret placed.
  expect(dock.querySelector("[data-seed]")?.getAttribute("data-seed-source")).toBe("element");
  expect(host.textContent).not.toContain("Attach to chat");
});

it("reveals page chat before an element or text action seeds its composer", async () => {
  localStorage.setItem("redline.browser.selectedDiscussion", JSON.stringify({ regular: true }));
  linkedModeOn(); await mount();
  await event("browser-page-event", { label: "browser-t-two", kind: "selection", value: { id: 1, action: "ask", text: "Selected evidence", url: "https://two.test", title: "two" } });
  expect(dock.querySelector("[data-selected-discussion]")).toBeNull();
  const chat = dock.querySelector<HTMLElement>("[data-conversation]")!;
  expect(chat.parentElement!.style.display).not.toBe("none");
  expect(chat.getAttribute("data-conversation")).toBe(sharedThread());
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
  const followed = () => JSON.parse(localStorage.getItem("redline.browser.followByWorkspace")!) as Record<string, string>;
  async function openManager() {
    await act(async () => (host.querySelector('[aria-label="Page menu"]') as HTMLButtonElement).click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === "Mosaics…")!.click());
    await settle();
  }

  it("forgets a deleted mosaic's shared chat once the manager reads their list", async () => {
    linkedModeOn();
    localStorage.setItem("redline.browser.followByWorkspace", JSON.stringify({ regular: "kept", "mosaic:news": "news-chat", "mosaic:gone": "gone-chat" }));
    await mount();
    expect(followed()["mosaic:gone"]).toBe("gone-chat");
    await openManager();
    expect(followed()).toEqual({ regular: "kept", "mosaic:news": "news-chat" });
  });

  it("keeps every mosaic's shared chat when their list fails to load", async () => {
    linkedModeOn();
    localStorage.setItem("redline.browser.followByWorkspace", JSON.stringify({ regular: "kept", "mosaic:news": "news-chat" }));
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: { label: string }) => command === "browser_workspace_list" ? Promise.reject(new Error("offline")) : base(command, args));
    await mount();
    await openManager();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("could not be loaded");
    expect(followed()["mosaic:news"]).toBe("news-chat");
  });

  it("keeps a mosaic saved after its list loaded when the pane next renders", async () => {
    linkedModeOn();
    // What the pane saves is what it loads back.
    const saved = new Map<string, unknown>();
    mocks.save.mockImplementation(async (id: string, body: unknown) => { saved.set(id, body); });
    const regular = mocks.load.getMockImplementation()!;
    mocks.load.mockImplementation(async (id: string) => saved.get(id) ?? regular(id));
    await mount();
    await openManager();
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === "Save these pages as a mosaic")!.click());
    const name = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Morning");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === "Save mosaic")!.click());
    for (let i = 0; i < 4; i++) await settle();
    const id = [...saved.keys()].find((key) => key.startsWith("mosaic:"))!;
    expect(followed()[id]).toBeTruthy();
    // Back to regular browsing; the list the manager read before the save
    // does not speak for the mosaic made since.
    await act(async () => (host.querySelector('[aria-label="Close Morning"]') as HTMLButtonElement).click());
    for (let i = 0; i < 2; i++) await settle();
    mocks.mission = { missions: [{ missionId: "m-new", title: "New" }] };
    await mount();
    expect(followed()[id]).toBeTruthy();
  });

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


it("moves native pages when the tab rail collapses after a StrictMode remount", async () => {
  // StrictMode's effect replay used to cancel the pending sync frame without
  // clearing its guard, so every later scheduleSync (rail collapse, resizes)
  // was dropped and the page stayed at the expanded rail's bounds.
  await act(async () => root.render(<StrictMode><BrowserPane onClose={() => {}} dockSlot={dock} dockPill="page"/></StrictMode>));
  await settle();
  const view = mocks.views.get("browser-t-two")!;
  expect(view.position?.x).toBe(10);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 182, y: 80, left: 182, top: 80, right: 1210, bottom: 880, width: 1028, height: 800, toJSON: () => ({}) });
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Collapse tab rail"]')!.click());
  await settle();
  expect(view.position?.x).toBe(182);
});

describe("native lifecycle recovery", () => {
  it("forgets a backend-suspended handle and recreates a visible page", async () => {
    await mount(); const old = mocks.views.get("browser-t-two"); mocks.views.delete("browser-t-two");
    await event("browser-tab-suspended", { label: "browser-t-two" });
    expect(mocks.views.get("browser-t-two")).toBeDefined(); expect(mocks.views.get("browser-t-two")).not.toBe(old);
    expect(mocks.views.get("browser-t-two")?.visible).toBe(true);
  });
  it("recreates an exhausted process and marks a restarting visible page", async () => {
    await mount(); const old = mocks.views.get("browser-t-two");
    await event("browser-page-event", { label: "browser-t-two", kind: "terminated" });
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Reloading two");
    await event("browser-page-event", { label: "browser-t-two", kind: "dead" });
    expect(mocks.views.get("browser-t-two")).not.toBe(old); expect(mocks.views.get("browser-t-two")?.visible).toBe(true);
  });
  it("drops a hidden terminated page without waking it", async () => {
    await mount({ visible: false });
    await event("browser-page-event", { label: "browser-t-one", kind: "terminated" });
    expect(mocks.views.has("browser-t-one")).toBe(false);
  });
});
