// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act, createRef, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ windowFocused: true, focusChanged: null as null | ((event: { payload: boolean }) => void), notify: vi.fn(), invoke: vi.fn(), inventory: [] as { id: string; cwd: string | null; pid: number | null; alive: boolean }[], cwd: null as string | null, listeners: new Map<string, (event: { payload: unknown }) => void>(), attention: [] as unknown[], procs: [] as unknown[] }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-notification", () => ({ isPermissionGranted: async () => true, requestPermission: async () => "granted", sendNotification: mocks.notify }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async (name: string, handler: (event: { payload: unknown }) => void) => { mocks.listeners.set(name, handler); return () => { if (mocks.listeners.get(name) === handler) mocks.listeners.delete(name); }; } }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/Users/test/" }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({
  onCloseRequested: async () => () => {},
  isFocused: async () => mocks.windowFocused,
  onFocusChanged: async (handler: (event: { payload: boolean }) => void) => { mocks.focusChanged = handler; return () => {}; },
}) }));
vi.mock("../hooks/useRepoIcons", () => ({ useRepoIcons: () => new Map() }));
vi.mock("./TerminalView", async () => {
  const { enqueuePtyOp } = await import("../lib/ptyFence");
  return { enqueuePtyOp, focusTerminalView: () => {}, TerminalView: ({ id, visible, onUserInput, onInterrupt }: { id: string; visible: boolean; onUserInput: (id: string) => void; onInterrupt: (id: string) => void }) => <div data-terminal-id={id} data-visible={visible}><button data-type={id} onClick={() => onUserInput(id)}>Type</button><button data-esc={id} onClick={() => { onUserInput(id); onInterrupt(id); }}>Esc</button></div> };
});
vi.mock("./TerminalTileHeader", () => ({ TerminalTileHeader: ({ identity, tile, focused, zoomed, state, port, workText, pinned, actions }: { identity: { id: string }; tile: number; focused: boolean; zoomed: boolean; state: string; port: number | null; workText: string | null; pinned: boolean; actions: { onCloseTerminal: (id: string) => void; onNewHome: (tile: number) => void; onFocusTile: (tile: number) => void; onZoomTile: (tile: number) => void; onTogglePin: (id: string) => void; onDragStart: (id: string, e: unknown) => void } }) => <header data-header-id={identity.id} data-focused={focused} data-zoomed={zoomed} data-state={state} data-port={port ?? ""} data-work={workText ?? ""} data-pinned={pinned}><button data-pin={identity.id} onClick={() => actions.onTogglePin(identity.id)}>Pin</button><span data-drag={identity.id} onPointerDown={(e) => actions.onDragStart(identity.id, e)}>Drag</span><button data-close={identity.id} onClick={() => actions.onCloseTerminal(identity.id)}>Close</button><button data-new={identity.id} onClick={() => actions.onNewHome(tile)}>New home</button><button data-focus={identity.id} onClick={() => actions.onFocusTile(tile)}>Focus</button><button data-zoom={identity.id} onClick={() => actions.onZoomTile(tile)}>Zoom</button></header> }));

import { TerminalTabs, type TerminalTabsHandle } from "./TerminalTabs";
import { TERMINAL_WORKSPACE_KEY } from "../lib/terminalWorkspace";
import { enqueuePtyOp } from "../lib/ptyFence";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let handle = createRef<TerminalTabsHandle>();
const ids = () => [...host.querySelectorAll<HTMLElement>("[data-terminal-id]")].map((node) => node.dataset.terminalId!);
const tiled = () => [...host.querySelectorAll<HTMLElement>("[data-header-id]")].map((node) => node.dataset.headerId!);
const focused = () => host.querySelector<HTMLElement>('[data-focused="true"]')?.dataset.headerId;
const saved = () => JSON.parse(sessionStorage.getItem(TERMINAL_WORKSPACE_KEY)!);
const click = async (selector: string) => {
  const button = host.querySelector<HTMLButtonElement>(selector);
  expect(button).not.toBeNull();
  await act(async () => button!.click());
};
async function mount(props: { collapsed?: boolean; onNeedsYouChange?: (count: number) => void; onFocusedCwd?: (id: string, cwd: string) => void } = {}) {
  await act(async () => root.render(<StrictMode><TerminalTabs ref={handle} theme="light" onTabsChange={() => {}} collapsed={props.collapsed ?? false} onNeedsYouChange={props.onNeedsYouChange} onFocusedCwd={props.onFocusedCwd} /></StrictMode>));
}
async function open(background = false) {
  let id = "";
  await act(async () => { id = handle.current!.openSessionTerminal("/repo", { background }); });
  return id;
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  mocks.inventory = [];
  mocks.cwd = null;
  mocks.listeners.clear();
  mocks.notify.mockReset();
  mocks.windowFocused = true;
  mocks.focusChanged = null;
  mocks.attention = [];
  mocks.procs = [];
  mocks.invoke.mockReset().mockImplementation(async (command, args) => {
    if (command === "pty_list") return mocks.inventory;
    if (command === "term_attention_snapshot") return mocks.attention;
    if (command === "pty_procs") return mocks.procs;
    if (command === "pty_cwds") return mocks.cwd ? Object.fromEntries(args.ids.map((id: string) => [id, mocks.cwd])) : {};
    return null;
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  handle = createRef<TerminalTabsHandle>();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("convenience shell replacement", () => {
  it.each([false, true])("a session (background=%s) inherits the sole pristine shell's tile", async (background) => {
    await mount();
    const original = ids()[0];
    const next = await open(background);
    await enqueuePtyOp(original, async () => {});
    expect(ids()).toEqual([next]);
    expect(tiled()).toEqual([next]);
    expect(focused()).toBe(next);
    expect(mocks.invoke).toHaveBeenCalledWith("pty_kill", { id: original });
    expect(saved().tabs).toEqual([{ id: next, cwd: "/repo" }]);
  });

  it("typing makes the shell permanent and a background restore leaves its tile alone", async () => {
    await mount();
    const original = ids()[0];
    await click(`[data-type="${original}"]`);
    const next = await open(true);
    expect(ids()).toEqual([original, next]);
    expect(tiled()).toEqual([original]);
    expect(focused()).toBe(original);
    expect(saved().tabs[0].placeholder).not.toBe(true);
    expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "pty_kill")).toBe(false);
  });

  it("preserves a convenience shell that moved off its startup directory", async () => {
    mocks.cwd = "/away";
    await mount();
    const original = ids()[0];
    const next = await open();
    expect(ids()).toEqual([original, next]);
    expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "pty_kill")).toBe(false);
  });

  it("explicit menu shells never replace the placeholder and a launch preserves both", async () => {
    await mount();
    const original = ids()[0];
    await click(`[data-new="${original}"]`);
    const existing = ids();
    expect(existing).toHaveLength(2);
    const next = await open();
    expect(ids()).toEqual([...existing, next]);
    expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "pty_kill")).toBe(false);
  });

  it("closing the last terminal creates a replaceable convenience shell", async () => {
    await mount();
    const first = await open();
    await click(`[data-close="${first}"]`);
    const replacement = ids()[0];
    expect(replacement).not.toBe(first);
    expect(saved().tabs[0].placeholder).toBe(true);
    const second = await open();
    expect(ids()).toEqual([second]);
    expect(mocks.invoke).toHaveBeenCalledWith("pty_kill", { id: first });
    expect(mocks.invoke).toHaveBeenCalledWith("pty_kill", { id: replacement });
  });

  it("back-to-back launches replace the placeholder only once and keep both new tiles", async () => {
    await mount();
    let first = "", second = "";
    await act(async () => {
      first = handle.current!.openSessionTerminal("/one");
      second = handle.current!.openSessionTerminal("/two");
    });
    expect(ids()).toEqual([first, second]);
    expect(tiled()).toEqual([first, second]);
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "pty_kill")).toHaveLength(1);
  });
});

describe("terminal workspace recovery", () => {
  it("restores ids, visible and background slots, focus and zoom across remount", async () => {
    await mount();
    const first = await open();
    const second = await open();
    const background = await open(true);
    await click(`[data-focus="${first}"]`);
    await click(`[data-zoom="${first}"]`);
    const before = saved();
    mocks.invoke.mockClear();
    await act(async () => root.render(null));
    await mount();
    expect(ids()).toEqual([first, second, background]);
    expect(tiled()).toEqual([first, second]);
    expect(focused()).toBe(first);
    expect(host.querySelector<HTMLElement>('[data-zoomed="true"]')?.dataset.headerId).toBe(first);
    expect(saved()).toEqual(before);
    expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "pty_kill")).toBe(false);
  });

  it("a relaunch opens one fresh convenience shell instead of respawning the dead fleet", async () => {
    await mount();
    const before = [ids()[0], await open(), await open(), await open()];
    await act(async () => root.render(null));
    // Process death: every PTY is gone and so is the launch's sessionStorage.
    sessionStorage.clear();
    mocks.invoke.mockClear();
    await mount();
    expect(ids()).toHaveLength(1);
    const [fresh] = ids();
    expect(before).not.toContain(fresh);
    expect(tiled()).toEqual([fresh]);
    expect(saved().tabs).toEqual([{ id: fresh, cwd: null, placeholder: true }]);
    const touched = mocks.invoke.mock.calls.flatMap(([, args]) => Object.values(args ?? {}).flat());
    expect(touched.some((value) => before.includes(value as string))).toBe(false);
  });

  it("offers live orphaned PTYs and reattaches their original ids in place of a blank shell", async () => {
    mocks.inventory = [{ id: "orphan-one", cwd: "/one", pid: 10, alive: true }, { id: "orphan-two", cwd: null, pid: 20, alive: true }, { id: "ended", cwd: "/dead", pid: null, alive: false }];
    await mount();
    const original = ids()[0];
    expect(host.textContent).toContain("Reattach 2 detached terminals");
    await click('[role="status"] button');
    expect(ids()).toEqual(["orphan-one", "orphan-two"]);
    expect(tiled()).toEqual(["orphan-one", "orphan-two"]);
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(mocks.invoke).toHaveBeenCalledWith("pty_kill", { id: original });
  });

  it("rechecks recovery candidates so a terminal that exited after boot is not respawned", async () => {
    mocks.inventory = [{ id: "orphan", cwd: "/one", pid: 10, alive: true }];
    await mount();
    const original = ids()[0];
    mocks.inventory = [{ id: "orphan", cwd: "/one", pid: 10, alive: false }];
    await click('[role="status"] button');
    expect(ids()).toEqual([original]);
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it("never recovers the placeholder it just replaced, even when it follows the orphan in the inventory", async () => {
    mocks.inventory = [{ id: "a-orphan", cwd: "/one", pid: 10, alive: true }];
    await mount();
    const placeholder = ids()[0];
    mocks.inventory.push({ id: placeholder, cwd: null, pid: 20, alive: true });
    await click('[role="status"] button');
    expect(ids()).toEqual(["a-orphan"]);
    expect(tiled()).toEqual(["a-orphan"]);
    expect(mocks.invoke).toHaveBeenCalledWith("pty_kill", { id: placeholder });
  });

  it("a slow inventory cannot overwrite a launch or present its own terminal as detached", async () => {
    let resolve!: (value: typeof mocks.inventory) => void;
    const pending = new Promise<typeof mocks.inventory>((done) => { resolve = done; });
    const ordinary = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => command === "pty_list" ? pending : ordinary(command, args));
    await mount();
    const launched = await open();
    await act(async () => resolve([{ id: launched, cwd: "/repo", pid: 1, alive: true }, { id: "orphan", cwd: "/other", pid: 2, alive: true }]));
    expect(ids()).toEqual([launched]);
    expect(host.textContent).toContain("Reattach 1 detached terminals");
    await click('[role="status"] button');
    expect(ids()).toEqual([launched, "orphan"]);
  });

  it("keeps the dock usable when inventory fails and offers retry", async () => {
    const ordinary = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => command === "pty_list" ? Promise.reject(new Error("offline")) : ordinary(command, args));
    await mount();
    expect(ids()).toHaveLength(1);
    expect(host.textContent).toContain("Retry terminal recovery");
    mocks.invoke.mockImplementation(ordinary);
    await click('[role="status"] button');
    expect(host.querySelector('[role="status"]')).toBeNull();
  });
});

describe("terminal state", () => {
  const stateOf = (id: string) => host.querySelector<HTMLElement>(`[data-header-id="${id}"]`)?.dataset.state;
  const emit = async (payload: Record<string, unknown>) => {
    await act(async () => mocks.listeners.get("term-attention")!({ payload }));
  };
  const needsYou = (terminalId: string, at: number) => ({ terminalId, sessionId: "s", at, kind: "needs-you", reason: "permission_prompt", message: "Claude needs your permission" });
  const yourTurn = (terminalId: string, at: number, excerpt: string | null = "Which API key should I use?") => ({ terminalId, sessionId: "s", at, kind: "your-turn", excerpt });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a needs-you lights the tile with the agent's words, and typing answers it", async () => {
    await mount();
    const id = ids()[0];
    await emit(needsYou(id, 10));
    expect(stateOf(id)).toBe("needs-you");
    expect(host.querySelector<HTMLElement>(`[data-header-id="${id}"]`)?.dataset.work).toBe("Claude needs your permission");
    expect(host.querySelector<HTMLElement>(".rl-tile-wrap")?.dataset.termState).toBe("needs-you");
    await click(`[data-type="${id}"]`);
    expect(stateOf(id)).toBe("working");
    // A NEW card (new `at`) lights it again: the old answer can't swallow it.
    await emit(needsYou(id, 11));
    expect(stateOf(id)).toBe("needs-you");
  });

  it("Esc clears a working agent — an interrupt fires no hook, so nothing else would", async () => {
    await mount();
    const id = await open();
    await emit({ terminalId: id, sessionId: "s", at: 5, kind: "working" });
    expect(stateOf(id)).toBe("working");
    await click(`[data-esc="${id}"]`);
    expect(stateOf(id)).toBe("idle");
  });

  it("a your-turn is read after a second in the focused tile of a focused window, and stays read across a reload", async () => {
    vi.useFakeTimers();
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await mount();
    const id = await open();
    await emit(yourTurn(id, 20, null));
    // The excerpt fills in as a second event for the same transition.
    await emit(yourTurn(id, 20, "Which API key should I use?"));
    expect(stateOf(id)).toBe("your-turn");
    expect(host.querySelector<HTMLElement>(`[data-header-id="${id}"]`)?.dataset.work).toBe("Which API key should I use?");
    await act(async () => { vi.advanceTimersByTime(999); });
    expect(stateOf(id)).toBe("your-turn");
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(stateOf(id)).toBe("idle");
    expect(saved().acks).toEqual({ [id]: { at: 20, as: "seen" } });
    // A reload re-reads the daemon's snapshot — still that same turn.
    await act(async () => root.render(null));
    mocks.attention = [yourTurn(id, 20)];
    await mount();
    expect(stateOf(id)).toBe("idle");
    focus.mockRestore();
  });

  it("an unfocused window never reads a your-turn", async () => {
    vi.useFakeTimers();
    mocks.windowFocused = false;
    await mount();
    const id = await open();
    await emit(yourTurn(id, 20));
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(stateOf(id)).toBe("your-turn");
  });

  it("process samples: a server reads serving with its port; the shell back in front retires a working agent, never an unread turn", async () => {
    vi.useFakeTimers();
    mocks.windowFocused = false;
    await mount();
    const server = await open();
    const agent = await open();
    const oneShot = await open();
    mocks.procs = [
      { id: server, fgComm: "node", fgIsShell: false, ports: [5173, 24678] },
      { id: agent, fgComm: "claude", fgIsShell: false, ports: [] },
      { id: oneShot, fgComm: "claude", fgIsShell: false, ports: [] },
    ];
    await emit({ terminalId: agent, sessionId: "s", at: Date.now() - 1000, kind: "working" });
    await emit(yourTurn(oneShot, Date.now() - 1000));
    // Async: each fleet tick's reads land before the next tick fires.
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(stateOf(server)).toBe("serving");
    expect(host.querySelector<HTMLElement>(`[data-header-id="${server}"]`)?.dataset.port).toBe("5173");
    expect(stateOf(agent)).toBe("working");
    expect(stateOf(oneShot)).toBe("your-turn");
    // Both agents exit (one killed mid-turn, one a `claude -p` that ended
    // after its Stop): their shells hold the foreground in the next sample.
    mocks.procs = [mocks.procs[0], { id: agent, fgComm: "zsh", fgIsShell: true, ports: [] }, { id: oneShot, fgComm: "zsh", fgIsShell: true, ports: [] }];
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(stateOf(agent)).toBe("idle");
    expect(stateOf(oneShot)).toBe("your-turn");
  });

  it("samples one at a time: a slow scan never stacks another behind it", async () => {
    vi.useFakeTimers();
    let release: (rows: unknown[]) => void = () => {};
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command, args) =>
      command === "pty_procs" ? new Promise((resolve) => { release = resolve; }) : base(command, args));
    await mount();
    const scans = () => mocks.invoke.mock.calls.filter(([cmd]) => cmd === "pty_procs").length;
    // Run the fleet poll until a sample is out on a scan that never returns.
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    const first = scans();
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    expect(scans()).toBe(first);
    await act(async () => { release([]); });
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(scans()).toBe(first + 1);
  });
});

describe("the fleet poll", () => {
  const count = (command: string) => mocks.invoke.mock.calls.filter(([cmd]) => cmd === command).length;
  const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads every visible cwd on one clock, and what each terminal runs on every other tick", async () => {
    await mount();
    const cwds = count("pty_cwds");
    const procs = count("pty_procs");
    await tick(8000);
    expect(count("pty_cwds") - cwds).toBe(4);
    expect(count("pty_procs") - procs).toBe(2);
  });

  // The process scan is a system-wide `lsof` of listening sockets, the read
  // most likely to crawl or hang on a loaded machine. The cwd read is what
  // labels the tiles and what the shell's folder-follow runs on; it used to
  // be its own loop and must not wait behind that scan.
  it("a process scan that never returns holds up no cwd read", async () => {
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command, args) =>
      command === "pty_procs" ? new Promise(() => {}) : base(command, args));
    await mount();
    await tick(4000);
    const cwds = count("pty_cwds");
    const procs = count("pty_procs");
    await tick(8000);
    expect(count("pty_cwds") - cwds).toBe(4);
    expect(count("pty_procs")).toBe(procs);
  });

  it("a new tile is read at once without moving the process-sample cadence", async () => {
    await mount();
    await tick(1000);
    const cwds = count("pty_cwds");
    const procs = count("pty_procs");
    await open();
    expect(count("pty_cwds")).toBeGreaterThan(cwds);
    expect(count("pty_procs")).toBe(procs);
    await tick(3000);
    expect(count("pty_procs")).toBe(procs + 1);
  });

  it("stops while the window is hidden and samples everything the moment it is shown", async () => {
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const show = (state: DocumentVisibilityState) => act(async () => {
      visibility = state;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await mount();
    await show("hidden");
    const cwds = count("pty_cwds");
    const procs = count("pty_procs");
    await tick(20_000);
    expect(count("pty_cwds")).toBe(cwds);
    expect(count("pty_procs")).toBe(procs);
    await show("visible");
    expect(count("pty_cwds")).toBe(cwds + 1);
    expect(count("pty_procs")).toBe(procs + 1);
  });

  it("hands the host the focused terminal's cwd from the same reads, once per change", async () => {
    const seen: [string, string][] = [];
    mocks.cwd = "/work/api";
    await mount({ onFocusedCwd: (id, cwd) => seen.push([id, cwd]) });
    const id = focused()!;
    expect(seen).toEqual([[id, "/work/api"]]);
    await tick(4000);
    expect(seen).toHaveLength(1);
    mocks.cwd = "/work/web";
    await tick(2000);
    expect(seen).toEqual([[id, "/work/api"], [id, "/work/web"]]);
  });
});

describe("the wall: shelf, placement and arrangement", () => {
  const shelf = () => [...host.querySelectorAll<HTMLElement>("[data-shelf-id]")].map((chip) => chip.dataset.shelfId!);
  const emit = async (payload: Record<string, unknown>) => {
    await act(async () => mocks.listeners.get("term-attention")!({ payload }));
  };
  const needsYou = (terminalId: string, at: number) => ({ terminalId, sessionId: "s", at, kind: "needs-you", reason: "permission_prompt", message: "Claude needs your permission" });
  // Tile ORDER, as the grid lays it out. (`tiled()` reads the headers in DOM
  // order, which is creation order — the wrappers never move in the DOM.)
  const order = () => saved().tiles as string[];
  // jsdom lays nothing out. Give the dock a 1440×270 pane — wide enough for
  // two 80-column tiles side by side, not three — and every tile wrapper the
  // box its percentage style describes inside it.
  const PANE = { width: 1440, height: 270 };
  function layout() {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("rl-tile-wrap") && this.style.display !== "none" && this.style.left) {
        const pct = (v: string) => parseFloat(v) / 100;
        const left = pct(this.style.left) * PANE.width;
        const top = pct(this.style.top) * PANE.height;
        const width = pct(this.style.width) * PANE.width;
        const height = pct(this.style.height) * PANE.height;
        return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) } as DOMRect;
      }
      return { x: 0, y: 0, left: 0, top: 0, width: PANE.width, height: PANE.height, right: PANE.width, bottom: PANE.height, toJSON: () => ({}) } as DOMRect;
    });
  }
  // The pane measures itself a frame after mount.
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
  async function wall() {
    layout();
    await mount();
    const first = await open();
    const a = await open(true);
    const b = await open(true);
    await settle();
    return { first, a, b };
  }

  it("shows every terminal off the wall on the shelf, loud first", async () => {
    const { first, a, b } = await wall();
    expect(order()).toEqual([first]);
    expect(shelf()).toEqual([a, b]);
    await emit(needsYou(b, 5));
    expect(shelf()).toEqual([b, a]);
    expect(host.querySelector<HTMLElement>(`[data-shelf-id="${b}"]`)?.dataset.termState).toBe("needs-you");
    // A terminal that needs you is never pulled onto the wall on its own.
    expect(order()).toEqual([first]);
    // Every terminal is on the wall or on the shelf.
    await click(`[data-new="${first}"]`);
    expect(tiled()).toHaveLength(2);
    expect(shelf()).toEqual([b, a]);
  });

  it("a shelf click adds a tile while one more fits at 80 columns, then takes the quietest unpinned, unfocused tile", async () => {
    const { first, a, b } = await wall();
    await click(`[data-shelf-id="${a}"]`);
    expect(order()).toEqual([first, a]);
    expect(focused()).toBe(a);
    // A third tile would be 60 columns wide: b replaces the quietest tile
    // that isn't focused — `first` — and `first` goes to the shelf.
    await click(`[data-shelf-id="${b}"]`);
    expect(order()).toEqual([b, a]);
    expect(focused()).toBe(b);
    expect(shelf()).toEqual([first]);
  });

  it("a pinned tile is never the one replaced; the focused one goes last", async () => {
    const { first, a, b } = await wall();
    await click(`[data-pin="${first}"]`);
    expect(saved().pinned).toEqual([first]);
    await act(async () => handle.current!.selectTab(a));
    expect(order()).toEqual([first, a]);
    // first is pinned, a is focused: nothing else may give way, so a does.
    await act(async () => handle.current!.selectTab(b));
    expect(order()).toEqual([first, b]);
    // With the focused tile pinned too, no tile may give way at all: the
    // wall grows past the 80-column fit rather than break a pin.
    await click(`[data-pin="${b}"]`);
    await act(async () => handle.current!.selectTab(a));
    expect(order()).toEqual([first, b, a]);
    await click(`[data-pin="${first}"]`);
    await click(`[data-pin="${b}"]`);
    expect(saved().pinned).toBeUndefined();
  });

  it("App's reveal into a collapsed dock never grows the wall — App would pop the dock open for a new tile", async () => {
    const { first, a, b } = await wall();
    const counts: number[] = [];
    // Linked navigation (a folder-tab click) selects the folder's terminal
    // without opening the dock.
    await act(async () => root.render(<StrictMode><TerminalTabs ref={handle} theme="light" onTabsChange={() => {}} collapsed onTileCountChange={(n) => counts.push(n)} /></StrictMode>));
    await act(async () => handle.current!.selectTab(a));
    expect(order()).toEqual([a]);
    expect(Math.max(...counts)).toBe(1);
    // Open, the same reveal adds a tile while one more still fits.
    await mount();
    await act(async () => handle.current!.selectTab(b));
    expect(order()).toEqual([a, b]);
    expect(shelf()).toEqual([first]);
  });

  it("App's reveal focuses a terminal already on the wall instead of moving it", async () => {
    const { first, a } = await wall();
    await act(async () => handle.current!.selectTab(a));
    await click(`[data-focus="${first}"]`);
    await act(async () => handle.current!.selectTab(a));
    expect(order()).toEqual([first, a]);
    expect(focused()).toBe(a);
  });

  it("closing a tile pulls in only a terminal that needs you — otherwise the tile collapses", async () => {
    const { first, a, b } = await wall();
    await act(async () => handle.current!.selectTab(a));
    expect(order()).toEqual([first, a]);
    await click(`[data-close="${a}"]`);
    // b is quiet: nothing is resurrected.
    expect(order()).toEqual([first]);
    const c = await open(true);
    await act(async () => handle.current!.selectTab(b));
    await emit(needsYou(c, 9));
    await click(`[data-close="${b}"]`);
    expect(order()).toEqual([first, c]);
  });

  it("a new terminal at the tile cap takes the quietest tile, never the focused one", async () => {
    layout();
    await mount();
    const opened = [await open()];
    for (let i = 1; i < 14; i++) opened.push(await open());
    expect(tiled()).toHaveLength(14);
    await click(`[data-focus="${opened[0]}"]`);
    // One terminal is busy, so it's not the quietest.
    mocks.procs = [];
    await emit({ terminalId: opened[13], sessionId: "s", at: 3, kind: "working" });
    const next = await open();
    expect(order()).toHaveLength(14);
    // All but the focused and the busy one are equally idle: the later one
    // gives way, in place.
    expect(order()).toEqual([...opened.slice(0, 12), next, opened[13]]);
  });

  it("dragging header A onto tile B swaps them; a shelf chip dropped on a tile shelves its occupant", async () => {
    const { first, a, b } = await wall();
    await act(async () => handle.current!.selectTab(a));
    expect(order()).toEqual([first, a]);
    // The click a real release produces right after pointerup must reach
    // nobody once it ended a drag (it would open the menu, or place by rule).
    const clicked = vi.fn();
    window.addEventListener("click", clicked);
    const drag = async (target: Element, from: [number, number], to: [number, number]) => {
      await act(async () => {
        target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: from[0], clientY: from[1] }));
        window.dispatchEvent(new MouseEvent("pointermove", { clientX: to[0], clientY: to[1] }));
        window.dispatchEvent(new MouseEvent("pointerup", { clientX: to[0], clientY: to[1] }));
        target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    };
    // Header of tile 0 dropped on tile 1 (the right half of the pane).
    await drag(host.querySelector(`[data-drag="${first}"]`)!, [10, 10], [1100, 100]);
    expect(order()).toEqual([a, first]);
    expect(focused()).toBe(first);
    expect(clicked).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.rlTileDrag).toBeUndefined();
    expect(document.querySelector(".rl-tile-drag-ghost")).toBeNull();
    // A press that never travels is not a drag, and its click goes through.
    await drag(host.querySelector(`[data-drag="${a}"]`)!, [10, 10], [11, 11]);
    expect(order()).toEqual([a, first]);
    expect(clicked).toHaveBeenCalledTimes(1);
    // The shelf chip (b) dropped on tile 0: b takes it, a goes to the shelf.
    await drag(host.querySelector(`[data-shelf-id="${b}"]`)!, [5, 5], [300, 100]);
    expect(order()).toEqual([b, first]);
    expect(shelf()).toEqual([a]);
    expect(clicked).toHaveBeenCalledTimes(1);
    window.removeEventListener("click", clicked);
  });
});

describe("reach and notify", () => {
  const order = () => saved().tiles as string[];
  const tick = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });
  const emit = async (payload: Record<string, unknown>) => {
    await act(async () => mocks.listeners.get("term-attention")!({ payload }));
  };
  const needsYou = (terminalId: string, at: number) => ({ terminalId, sessionId: "s", at, kind: "needs-you", reason: "permission_prompt", message: "Claude needs your permission" });
  const yourTurn = (terminalId: string, at: number, excerpt: string | null) => ({ terminalId, sessionId: "s", at, kind: "your-turn", excerpt });
  const badges = () => mocks.invoke.mock.calls.filter(([cmd]) => cmd === "set_attention_badge").map(([, args]) => args.count);
  // The plugin import and the permission check settle over a few microtasks.
  const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts what needs you for the footer and the Dock badge, oldest first", async () => {
    const counts: number[] = [];
    await mount({ onNeedsYouChange: (n) => counts.push(n) });
    const a = await open();
    const b = await open(true);
    await emit(needsYou(b, 5));
    await emit(yourTurn(a, 6, "Done."));
    const last = <T,>(xs: T[]) => xs[xs.length - 1];
    expect(last(counts)).toBe(2);
    expect(last(badges())).toBe(2);
    await click(`[data-type="${b}"]`);
    expect(last(counts)).toBe(1);
    expect(last(badges())).toBe(1);
  });

  it("⌘⇧J walks the terminals that need you, oldest first, placing each by the rule", async () => {
    await mount();
    const a = await open();
    const b = await open(true);
    const c = await open(true);
    expect(handle.current!.jumpToNeedsYou()).toBe(false);
    await emit(needsYou(c, 5));
    await emit(needsYou(b, 7));
    let jumped = false;
    await act(async () => { jumped = handle.current!.jumpToNeedsYou(); });
    expect(jumped).toBe(true);
    expect(focused()).toBe(c);
    await act(async () => { handle.current!.jumpToNeedsYou(); });
    expect(focused()).toBe(b);
    // Never by replacing the tile you were on: a, b and c all hold tiles.
    expect(order()).toEqual([a, c, b]);
    // And round again.
    await act(async () => { handle.current!.jumpToNeedsYou(); });
    expect(focused()).toBe(c);
  });

  it("⌘⇧J and App's reveal end a zoom on another tile, so the terminal they land on is on screen", async () => {
    await mount();
    const a = await open();
    const b = await open();
    await click(`[data-zoom="${a}"]`);
    const visible = (id: string) => host.querySelector<HTMLElement>(`[data-terminal-id="${id}"]`)?.dataset.visible;
    expect(visible(b)).toBe("false");
    await emit(needsYou(b, 5));
    await act(async () => { handle.current!.jumpToNeedsYou(); });
    expect(focused()).toBe(b);
    expect(visible(b)).toBe("true");
    expect(host.querySelector('[data-zoomed="true"]')).toBeNull();
    // A zoom on the terminal itself stays: it is already what you see.
    await click(`[data-zoom="${b}"]`);
    await act(async () => handle.current!.selectTab(b));
    expect(host.querySelector<HTMLElement>('[data-zoomed="true"]')?.dataset.headerId).toBe(b);
    await click(`[data-zoom="${a}"]`);
    await act(async () => handle.current!.selectTab(b));
    expect(visible(b)).toBe("true");
  });

  it("notifies once per transition while the window is unfocused, never for what the snapshot already held", async () => {
    mocks.windowFocused = false;
    mocks.attention = [];
    await mount();
    const a = await open();
    await flush();
    await emit(needsYou(a, 10));
    await flush();
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify).toHaveBeenLastCalledWith({ title: "repo 1 · needs you", body: "Claude needs your permission" });
    // The same transition again (a re-sent event) is not news.
    await emit(needsYou(a, 10));
    await flush();
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    // A new card is.
    await emit(needsYou(a, 11));
    await flush();
    expect(mocks.notify).toHaveBeenCalledTimes(2);
    // A reload: the daemon's snapshot holds that same card — no repeat.
    await act(async () => root.render(null));
    mocks.attention = [needsYou(a, 11)];
    await mount();
    await flush();
    expect(mocks.notify).toHaveBeenCalledTimes(2);
  });

  it("stays quiet while you're looking, and speaks up when the dock is collapsed", async () => {
    await mount();
    const a = await open();
    await flush();
    await emit(needsYou(a, 10));
    await flush();
    expect(mocks.notify).not.toHaveBeenCalled();
    await mount({ collapsed: true });
    await emit(needsYou(a, 12));
    await flush();
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it("counts a caret in one of Redline's own browser pages as looking, and another app in front as away", async () => {
    // The page's native webview has the caret: the main webview has no focus,
    // but Redline's window is still the one in front.
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    await mount();
    const a = await open();
    await flush();
    await emit(needsYou(a, 10));
    await flush();
    expect(mocks.notify).not.toHaveBeenCalled();
    await act(async () => mocks.focusChanged!({ payload: false }));
    await emit(needsYou(a, 11));
    await flush();
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it("a your-turn notifies after a beat, with the excerpt that filled in — or not at all once read", async () => {
    vi.useFakeTimers();
    mocks.windowFocused = false;
    await mount();
    const a = await open();
    const b = await open();
    await flush();
    await emit(yourTurn(a, 20, null));
    await emit(yourTurn(a, 20, "Which API key should I use?"));
    await emit(yourTurn(b, 21, "All done."));
    // b's turn is answered (typed into) before the beat is up.
    await click(`[data-type="${b}"]`);
    await tick(2499);
    await flush();
    expect(mocks.notify).not.toHaveBeenCalled();
    await tick(1);
    await flush();
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify).toHaveBeenLastCalledWith({ title: "repo 1 · your turn", body: "Which API key should I use?" });
  });
});

describe("solo: the flow shell's terminal view", () => {
  const view = (id: string) => host.querySelector<HTMLElement>(`[data-terminal-id="${id}"]`)!;
  const shown = () => [...host.querySelectorAll<HTMLElement>('[data-visible="true"]')].map((node) => node.dataset.terminalId!);
  async function render(solo: string | null, onActiveTabChange?: (id: string) => void) {
    await act(async () => root.render(<StrictMode><TerminalTabs ref={handle} theme="light" onTabsChange={() => {}} collapsed={false} solo={solo} onActiveTabChange={onActiveTabChange} /></StrictMode>));
  }

  it("shows one terminal alone and gives the wall back untouched — no shell spawned, killed or remounted", async () => {
    await render(null);
    const a = await open();
    const b = await open();
    const before = { ids: ids(), tiles: saved().tiles, nodes: [view(a), view(b)] };
    expect(before.tiles).toEqual([a, b]);
    const kills = () => mocks.invoke.mock.calls.filter(([cmd]) => cmd === "pty_kill").length;
    const killed = kills();

    await render(a);
    expect(shown()).toEqual([a]);
    // No tile header and no gutters: the stage's own top bar is the chrome.
    expect(tiled()).toEqual([]);
    expect(ids()).toEqual(before.ids);
    expect(saved().tiles).toEqual(before.tiles);

    await render(null);
    expect(shown().sort()).toEqual([a, b].sort());
    expect(tiled()).toEqual([a, b]);
    // The same DOM nodes: React kept both views mounted through the switch.
    expect([view(a), view(b)]).toEqual(before.nodes);
    expect(view(a)).toBe(before.nodes[0]);
    expect(kills()).toBe(killed);
  });

  it("shows a terminal that has no tile, without putting it on the wall", async () => {
    await render(null);
    const first = await open();
    await click(`[data-type="${first}"]`);
    const background = await open(true);
    expect(tiled()).toEqual([first]);
    await render(background);
    expect(shown()).toEqual([background]);
    await render(null);
    expect(tiled()).toEqual([first]);
    expect(shown()).toEqual([first]);
  });

  it("ignores an id that isn't open, and reports the solo terminal as the one watched", async () => {
    const active = vi.fn();
    await render(null, active);
    const a = await open();
    await click(`[data-type="${a}"]`);
    const b = await open(true);
    await render("gone", active);
    expect(shown()).toEqual([a]);
    expect(tiled()).toEqual([a]);
    await render(b, active);
    expect(active).toHaveBeenLastCalledWith(b);
    await render(null, active);
    expect(active).toHaveBeenLastCalledWith(a);
  });
});
