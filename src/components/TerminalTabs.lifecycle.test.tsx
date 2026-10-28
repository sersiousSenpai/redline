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
vi.mock("./TerminalTileHeader", () => ({ TerminalTileHeader: ({ identity, tile, focused, zoomed, state, port, workText, pinned, actions }: { identity: { id: string }; tile: number; focused: boolean; zoomed: boolean; state: string; port: number | null; workText: string | null; pinned: boolean; actions: { onPick: (tile: number, id: string) => void; onRename?: (id: string, name: string) => void; onCloseTerminal: (id: string) => void; onNewHome: (tile: number) => void; onFocusTile: (tile: number) => void; onZoomTile: (tile: number) => void; onTogglePin: (id: string) => void; onDragStart: (id: string, e: unknown) => void } }) => <header data-header-id={identity.id} data-focused={focused} data-zoomed={zoomed} data-state={state} data-port={port ?? ""} data-work={workText ?? ""} data-pinned={pinned}><button data-pin={identity.id} onClick={() => actions.onTogglePin(identity.id)}>Pin</button><button data-pick={identity.id} onClick={() => actions.onPick(tile, (globalThis as { __pick?: string }).__pick!)}>Pick</button><button data-rename={identity.id} onClick={() => actions.onRename?.(identity.id, "api server")}>Rename</button><span data-label={identity.id}>{(identity as { label?: string }).label}</span><span data-drag={identity.id} onPointerDown={(e) => actions.onDragStart(identity.id, e)}>Drag</span><button data-close={identity.id} onClick={() => actions.onCloseTerminal(identity.id)}>Close</button><button data-new={identity.id} onClick={() => actions.onNewHome(tile)}>New home</button><button data-focus={identity.id} onClick={() => actions.onFocusTile(tile)}>Focus</button><button data-zoom={identity.id} onClick={() => actions.onZoomTile(tile)}>Zoom</button></header> }));

import { TerminalTabs, type TerminalTabsHandle } from "./TerminalTabs";
import { TERMINAL_WORKSPACE_KEY } from "../lib/terminalWorkspace";
import { __resetTerminalSwapForTest } from "../lib/terminalSwap";
import { lastMeasure, resetMeasuresForTest } from "../workbench/perf";
import type { WallData } from "../workbench/model";
import { EMPTY_WALL, placeOnWall } from "../workbench/wall";

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

// The host's side of the wall, as the workbench keeps it: walls by pane id,
// the one on screen, and the placement the reducer's `revealTerminal` does
// (this wall while it has room).
let walls: Record<string, WallData> = {};
let wallKey: string | null = "w1";
let changes: [string, WallData][] = [];
type MountProps = { onStatesChange?: (states: ReadonlyMap<string, { state: string; label: string }>) => void; collapsed?: boolean; onNeedsYouChange?: (count: number) => void; onFocusedCwd?: (id: string, cwd: string) => void; onActiveTabChange?: (id: string) => void; solo?: string | null };
let props: MountProps = {};
const order = () => (wallKey ? walls[wallKey]?.tiles ?? [] : []);
function view() {
  return (
    <StrictMode>
      <TerminalTabs
        ref={handle}
        theme="light"
        wallKey={wallKey}
        wall={wallKey ? (walls[wallKey] ?? EMPTY_WALL) : null}
        onWallChange={(key, data) => { walls = { ...walls, [key]: data }; changes.push([key, data]); root.render(view()); }}
        onPlaceTerminal={(id) => place(id)}
        onTabsChange={() => {}}
        collapsed={props.collapsed ?? false}
        onNeedsYouChange={props.onNeedsYouChange}
        onStatesChange={props.onStatesChange}
        onFocusedCwd={props.onFocusedCwd}
        onActiveTabChange={props.onActiveTabChange}
        solo={props.solo ?? null}
      />
    </StrictMode>
  );
}
function place(id: string) {
  if (!wallKey) return;
  walls = { ...walls, [wallKey]: placeOnWall(walls[wallKey] ?? EMPTY_WALL, id) };
  root.render(view());
}
async function mount(next: MountProps = {}) {
  props = next;
  await act(async () => root.render(view()));
}
async function rerender() {
  await act(async () => root.render(view()));
}
/** A terminal the host opens and (unless `background`) shows, as App's
 *  `openTerminal` does. */
async function open(background = false) {
  let id = "";
  await act(async () => {
    id = handle.current!.openSessionTerminal("/repo");
    if (!background) place(id);
  });
  return id;
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  walls = {};
  wallKey = "w1";
  changes = [];
  props = {};
  __resetTerminalSwapForTest();
  resetMeasuresForTest();
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

const ptyLifecycle = () => mocks.invoke.mock.calls.filter(([cmd]) => ["pty_spawn", "pty_attach", "pty_kill"].includes(cmd));

describe("walls: one fleet, many views", () => {
  const visible = (id: string) => host.querySelector<HTMLElement>(`[data-terminal-id="${id}"]`)?.dataset.visible;
  const frame = () => act(async () => { await new Promise((done) => requestAnimationFrame(() => done(null))); });

  it("opens a terminal without placing it; the host shows it, and nothing is ever spawned unasked", async () => {
    await mount();
    expect(ids()).toEqual([]);
    expect(host.textContent).toContain("No terminals on this wall");
    let id = "";
    await act(async () => { id = handle.current!.openSessionTerminal("/repo"); });
    expect(ids()).toEqual([id]);
    expect(tiled()).toEqual([]);
    expect(visible(id)).toBe("false");
    await act(async () => place(id));
    expect(tiled()).toEqual([id]);
    expect(visible(id)).toBe("true");
  });

  it("the empty wall's New terminal asks the host to place it", async () => {
    await mount();
    await click(".rl-wall-empty button");
    expect(ids()).toHaveLength(1);
    expect(order()).toEqual(ids());
  });

  it("swapping walls re-points the tiles in one render: the same views, no PTY attach or spawn, the swap measured to its painted frame", async () => {
    await mount();
    const a = await open();
    const b = await open();
    walls.w2 = { tiles: [], focus: 0, zoomed: null, pinned: [] };
    wallKey = "w2";
    await rerender();
    const c = await open();
    const nodes = ids().map((id) => host.querySelector(`[data-terminal-id="${id}"]`));
    mocks.invoke.mockClear();
    wallKey = "w1";
    await rerender();
    expect(tiled().sort()).toEqual([a, b].sort());
    expect([visible(a), visible(b), visible(c)]).toEqual(["true", "true", "false"]);
    expect(ids().map((id) => host.querySelector(`[data-terminal-id="${id}"]`))).toEqual(nodes);
    expect(ptyLifecycle()).toEqual([]);
    await frame();
    await frame();
    expect(lastMeasure("wb:terminal-swap")).not.toBeNull();
    wallKey = "w2";
    await rerender();
    expect(tiled()).toEqual([c]);
    expect(focused()).toBe(c);
    expect(ptyLifecycle()).toEqual([]);
  });

  it("adopts the host's change to the wall, and sends back only its own", async () => {
    await mount();
    const a = await open();
    const b = await open(true);
    changes = [];
    // A reveal elsewhere put b on this wall: adopted, not echoed.
    walls = { ...walls, w1: { tiles: [a, b], focus: 1, zoomed: null, pinned: [] } };
    await rerender();
    expect(tiled()).toEqual([a, b]);
    expect(focused()).toBe(b);
    expect(changes).toEqual([]);
    await click(`[data-focus="${a}"]`);
    await click(`[data-zoom="${a}"]`);
    await click(`[data-pin="${a}"]`);
    expect(walls.w1).toEqual({ tiles: [a, b], focus: 0, zoomed: a, pinned: [a] });
    expect(changes.every(([key]) => key === "w1")).toBe(true);
  });

  it("closing a terminal kills it and collapses its tile, pulling nothing in; the last one leaves an empty wall", async () => {
    await mount();
    const a = await open();
    const b = await open();
    await open(true);
    await click(`[data-close="${b}"]`);
    expect(mocks.invoke).toHaveBeenCalledWith("pty_kill", { id: b });
    expect(order()).toEqual([a]);
    await click(`[data-close="${a}"]`);
    expect(order()).toEqual([]);
    expect(changes[changes.length - 1][1].tiles).toEqual([]);
  });

  it("reports every terminal's state and label to the host, only when one changes; closeTerminals kills several at once", async () => {
    const reports: Map<string, { state: string; label: string }>[] = [];
    await mount({ onStatesChange: (states) => reports.push(new Map(states)) });
    const a = await open();
    const b = await open(true);
    const last = () => reports[reports.length - 1];
    expect(last().get(a)).toEqual({ state: "idle", label: "repo 1" });
    expect(last().get(b)).toEqual({ state: "idle", label: "repo 2" });
    const count = reports.length;
    await rerender();
    expect(reports.length).toBe(count);
    await act(async () => mocks.listeners.get("term-attention")!({ payload: { terminalId: b, sessionId: "s", at: 3, kind: "working" } }));
    expect(last().get(b)?.state).toBe("working");
    await act(async () => handle.current!.closeTerminals([a, b]));
    expect(mocks.invoke).toHaveBeenCalledWith("pty_kill", { id: a });
    expect(mocks.invoke).toHaveBeenCalledWith("pty_kill", { id: b });
    expect(ids()).toEqual([]);
  });

  it("re-pointing a tile from the menu is a style change in the same frame: no attach, no spawn, the wall sent back", async () => {
    await mount();
    const a = await open();
    const b = await open(true);
    const frame = () => act(async () => { await new Promise((done) => requestAnimationFrame(() => done(null))); });
    mocks.invoke.mockClear();
    (globalThis as { __pick?: string }).__pick = b;
    await click(`[data-pick="${a}"]`);
    expect(tiled()).toEqual([b]);
    expect([visible(a), visible(b)]).toEqual(["false", "true"]);
    expect(ptyLifecycle()).toEqual([]);
    expect(walls.w1.tiles).toEqual([b]);
    await frame();
    await frame();
    expect(lastMeasure("wb:terminal-swap")).not.toBeNull();
  });

  it("a renamed terminal wears its name, across a reload", async () => {
    await mount();
    const a = await open();
    await click(`[data-rename="${a}"]`);
    expect(host.querySelector(`[data-label="${a}"]`)?.textContent).toBe("api server");
    await act(async () => root.render(null));
    await mount();
    expect(host.querySelector(`[data-label="${a}"]`)?.textContent).toBe("api server");
  });

  it("closing asks what is running NOW: one fresh sample, and a terminal it has no sample for counts as running", async () => {
    await mount({ collapsed: true });
    const shell = await open(true);
    const server = await open(true);
    const unsampled = await open(true);
    // The fleet poll never ran (no wall on screen): only a fresh read can tell.
    mocks.procs = [
      { id: shell, fgComm: "zsh", fgIsShell: true, ports: [] },
      { id: server, fgComm: "node", fgIsShell: false, ports: [5173] },
    ];
    const before = mocks.invoke.mock.calls.filter(([cmd]) => cmd === "pty_procs").length;
    let running: string[] = [];
    await act(async () => { running = await handle.current!.runningNow([shell, server, unsampled]); });
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "pty_procs").length).toBe(before + 1);
    expect(running).toEqual([server, unsampled]);
    // A read that fails asks about everything.
    const ordinary = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => command === "pty_procs" ? Promise.reject(new Error("lsof hung")) : ordinary(command, args));
    await act(async () => { running = await handle.current!.runningNow([shell]); });
    expect(running).toEqual([shell]);
  });

  it("a menu row's New terminal goes to the host's placement, never into a tile it takes from someone", async () => {
    await mount();
    const a = await open();
    await click(`[data-new="${a}"]`);
    expect(order()).toHaveLength(2);
    expect(order()[0]).toBe(a);
  });

  it("dragging header A onto tile B swaps them", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("rl-tile-wrap") && this.style.display !== "none" && this.style.left) {
        const pct = (v: string) => parseFloat(v) / 100;
        const left = pct(this.style.left) * 1440;
        const width = pct(this.style.width) * 1440;
        const top = pct(this.style.top) * 270;
        const height = pct(this.style.height) * 270;
        return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) } as DOMRect;
      }
      return { x: 0, y: 0, left: 0, top: 0, width: 1440, height: 270, right: 1440, bottom: 270, toJSON: () => ({}) } as DOMRect;
    });
    await mount();
    const first = await open();
    const a = await open();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
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
    await drag(host.querySelector(`[data-drag="${first}"]`)!, [10, 10], [1100, 100]);
    expect(order()).toEqual([a, first]);
    expect(focused()).toBe(first);
    expect(clicked).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.rlTileDrag).toBeUndefined();
    // A press that never travels is not a drag, and its click goes through.
    await drag(host.querySelector(`[data-drag="${a}"]`)!, [10, 10], [11, 11]);
    expect(order()).toEqual([a, first]);
    expect(clicked).toHaveBeenCalledTimes(1);
    window.removeEventListener("click", clicked);
  });
});

describe("terminal workspace recovery", () => {
  it("restores the terminals across a reload, and the wall shows the same tiles", async () => {
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

  it("a relaunch starts with no terminals and spawns none: dead ids on a wall are not resurrected", async () => {
    await mount();
    const before = [await open(), await open()];
    await act(async () => root.render(null));
    // Process death: every PTY is gone and so is the launch's sessionStorage.
    sessionStorage.clear();
    mocks.invoke.mockClear();
    await mount();
    expect(ids()).toEqual([]);
    expect(tiled()).toEqual([]);
    const touched = mocks.invoke.mock.calls.flatMap(([, args]) => Object.values(args ?? {}).flat());
    expect(touched.some((value) => before.includes(value as string))).toBe(false);
  });

  it("offers live orphaned PTYs and reattaches their original ids, placed by the host", async () => {
    mocks.inventory = [{ id: "orphan-one", cwd: "/one", pid: 10, alive: true }, { id: "orphan-two", cwd: null, pid: 20, alive: true }, { id: "ended", cwd: "/dead", pid: null, alive: false }];
    await mount();
    expect(host.textContent).toContain("Reattach 2 detached terminals");
    await click('[data-recovery] button');
    expect(ids()).toEqual(["orphan-one", "orphan-two"]);
    expect(order()).toEqual(["orphan-one", "orphan-two"]);
    expect(host.querySelector("[data-recovery]")).toBeNull();
    expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "pty_kill")).toBe(false);
  });

  it("rechecks recovery candidates so a terminal that exited after boot is not respawned", async () => {
    mocks.inventory = [{ id: "orphan", cwd: "/one", pid: 10, alive: true }];
    await mount();
    mocks.inventory = [{ id: "orphan", cwd: "/one", pid: 10, alive: false }];
    await click('[data-recovery] button');
    expect(ids()).toEqual([]);
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
    await click('[data-recovery] button');
    expect(ids()).toEqual([launched, "orphan"]);
  });

  it("keeps the wall usable when inventory fails and offers retry", async () => {
    const ordinary = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => command === "pty_list" ? Promise.reject(new Error("offline")) : ordinary(command, args));
    await mount();
    expect(host.textContent).toContain("Retry terminal recovery");
    mocks.invoke.mockImplementation(ordinary);
    await click('[data-recovery] button');
    expect(host.textContent).not.toContain("Retry terminal recovery");
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
    const id = await open();
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
    // Async: each fleet tick's reads land before the next tick fires; the
    // process sample rides every 12 s tick.
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    expect(stateOf(server)).toBe("serving");
    expect(host.querySelector<HTMLElement>(`[data-header-id="${server}"]`)?.dataset.port).toBe("5173");
    expect(stateOf(agent)).toBe("working");
    expect(stateOf(oneShot)).toBe("your-turn");
    // Both agents exit (one killed mid-turn, one a `claude -p` that ended
    // after its Stop): their shells hold the foreground in the next sample.
    mocks.procs = [mocks.procs[0], { id: agent, fgComm: "zsh", fgIsShell: true, ports: [] }, { id: oneShot, fgComm: "zsh", fgIsShell: true, ports: [] }];
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
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
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    const first = scans();
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    expect(scans()).toBe(first);
    await act(async () => { release([]); });
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
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

  it("reads every visible cwd and what each terminal runs on one 12 s clock, while the dock is open", async () => {
    await mount();
    const cwds = count("pty_cwds");
    const procs = count("pty_procs");
    await tick(48_000);
    expect(count("pty_cwds") - cwds).toBe(4);
    expect(count("pty_procs") - procs).toBe(4);
  });

  it("reads nothing while the dock is collapsed, and everything the moment it opens", async () => {
    await mount({ collapsed: true });
    const cwds = count("pty_cwds");
    const procs = count("pty_procs");
    await tick(48_000);
    expect(count("pty_cwds")).toBe(cwds);
    expect(count("pty_procs")).toBe(procs);
    await mount({ collapsed: false });
    expect(count("pty_cwds")).toBeGreaterThan(cwds);
    expect(count("pty_procs")).toBeGreaterThan(procs);
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
    await tick(6000);
    const cwds = count("pty_cwds");
    const procs = count("pty_procs");
    await tick(48_000);
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
    await tick(12_000);
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
    const id = await open();
    expect(focused()).toBe(id);
    expect(seen).toEqual([[id, "/work/api"]]);
    await tick(6000);
    expect(seen).toHaveLength(1);
    mocks.cwd = "/work/web";
    await tick(6000);
    expect(seen).toEqual([[id, "/work/api"], [id, "/work/web"]]);
  });
});

describe("reach and notify", () => {
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

  it("⌘⇧J names the terminals that need you, oldest first, walking on from the focused tile; the host shows each", async () => {
    await mount();
    const a = await open();
    const b = await open(true);
    const c = await open(true);
    expect(handle.current!.nextNeedsYou()).toBeNull();
    await emit(needsYou(c, 5));
    await emit(needsYou(b, 7));
    const jump = async () => {
      const target = handle.current!.nextNeedsYou();
      // The host's reveal: its wall, its tile.
      await act(async () => { if (target) place(target); });
      return target;
    };
    expect(await jump()).toBe(c);
    expect(focused()).toBe(c);
    expect(await jump()).toBe(b);
    expect(focused()).toBe(b);
    // Never by replacing the tile you were on: a, b and c all hold tiles.
    expect(order()).toEqual([a, c, b]);
    // And round again.
    expect(await jump()).toBe(c);
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

describe("solo: an Agent pane's CLI view", () => {
  const view = (id: string) => host.querySelector<HTMLElement>(`[data-terminal-id="${id}"]`)!;
  const shown = () => [...host.querySelectorAll<HTMLElement>('[data-visible="true"]')].map((node) => node.dataset.terminalId!);
  async function render(solo: string | null, onActiveTabChange?: (id: string) => void) {
    await mount({ solo, onActiveTabChange });
  }

  it("shows one terminal alone and gives the wall back untouched — no shell spawned, killed or remounted", async () => {
    await render(null);
    const a = await open();
    const b = await open();
    const before = { ids: ids(), tiles: order(), nodes: [view(a), view(b)] };
    expect(before.tiles).toEqual([a, b]);
    const kills = () => mocks.invoke.mock.calls.filter(([cmd]) => cmd === "pty_kill").length;
    const killed = kills();

    await render(a);
    expect(shown()).toEqual([a]);
    // No tile header and no gutters: the stage's own top bar is the chrome.
    expect(tiled()).toEqual([]);
    expect(ids()).toEqual(before.ids);
    expect(order()).toEqual(before.tiles);

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
