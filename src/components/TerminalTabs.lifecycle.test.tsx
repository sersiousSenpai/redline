// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act, createRef, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), inventory: [] as { id: string; cwd: string | null; pid: number | null; alive: boolean }[], cwd: null as string | null, listeners: new Map<string, (event: { payload: unknown }) => void>(), attention: [] as unknown[], procs: [] as unknown[] }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async (name: string, handler: (event: { payload: unknown }) => void) => { mocks.listeners.set(name, handler); return () => { if (mocks.listeners.get(name) === handler) mocks.listeners.delete(name); }; } }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/Users/test/" }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {} }) }));
vi.mock("../hooks/useRepoIcons", () => ({ useRepoIcons: () => new Map() }));
vi.mock("./TerminalView", async () => {
  const { enqueuePtyOp } = await import("../lib/ptyFence");
  return { enqueuePtyOp, tauriHandoffDeps: {}, focusTerminalView: () => {}, TerminalView: ({ id, visible, onUserInput, onInterrupt }: { id: string; visible: boolean; onUserInput: (id: string) => void; onInterrupt: (id: string) => void }) => <div data-terminal-id={id} data-visible={visible}><button data-type={id} onClick={() => onUserInput(id)}>Type</button><button data-esc={id} onClick={() => { onUserInput(id); onInterrupt(id); }}>Esc</button></div> };
});
vi.mock("./TerminalTileHeader", () => ({ TerminalTileHeader: ({ identity, tile, focused, zoomed, state, port, workText, actions }: { identity: { id: string }; tile: number; focused: boolean; zoomed: boolean; state: string; port: number | null; workText: string | null; actions: { onCloseTerminal: (id: string) => void; onNewHome: (tile: number) => void; onFocusTile: (tile: number) => void; onZoomTile: (tile: number) => void } }) => <header data-header-id={identity.id} data-focused={focused} data-zoomed={zoomed} data-state={state} data-port={port ?? ""} data-work={workText ?? ""}><button data-close={identity.id} onClick={() => actions.onCloseTerminal(identity.id)}>Close</button><button data-new={identity.id} onClick={() => actions.onNewHome(tile)}>New home</button><button data-focus={identity.id} onClick={() => actions.onFocusTile(tile)}>Focus</button><button data-zoom={identity.id} onClick={() => actions.onZoomTile(tile)}>Zoom</button></header> }));

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
async function mount() {
  await act(async () => root.render(<StrictMode><TerminalTabs ref={handle} theme="light" onTabsChange={() => {}} onActivityChange={() => {}} collapsed={false} /></StrictMode>));
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
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    await mount();
    const id = await open();
    await emit(yourTurn(id, 20));
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(stateOf(id)).toBe("your-turn");
  });

  it("process samples: a server reads serving with its port; the shell back in front retires an older turn", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    await mount();
    const server = await open();
    const agent = await open();
    mocks.procs = [
      { id: server, fgComm: "node", fgIsShell: false, ports: [5173, 24678] },
      { id: agent, fgComm: "claude", fgIsShell: false, ports: [] },
    ];
    await emit(yourTurn(agent, Date.now() - 1000));
    await act(async () => { vi.advanceTimersByTime(4000); });
    expect(stateOf(server)).toBe("serving");
    expect(host.querySelector<HTMLElement>(`[data-header-id="${server}"]`)?.dataset.port).toBe("5173");
    expect(stateOf(agent)).toBe("your-turn");
    // The agent exits: its shell holds the foreground in the next sample.
    mocks.procs = [mocks.procs[0], { id: agent, fgComm: "zsh", fgIsShell: true, ports: [] }];
    await act(async () => { vi.advanceTimersByTime(4000); });
    expect(stateOf(agent)).toBe("idle");
  });
});
