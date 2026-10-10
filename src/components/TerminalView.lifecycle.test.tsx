// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeChannel { onmessage: (bytes: ArrayBuffer) => void }
interface FakeTerminal {
  disposed: boolean;
  focused: number;
  output: string;
  data: (text: string) => void;
  key: () => void;
  write: (data: string | Uint8Array, done?: () => void) => void;
}
interface FakePty { pid: number; history: string; attachmentId: string; channel: FakeChannel | null }
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  terminals: [] as FakeTerminal[],
  shells: new Map<string, FakePty>(),
  drops: new Set<(event: { payload: unknown }) => void>(),
  events: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  nextPid: 100,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, Channel: class { onmessage = (_bytes: ArrayBuffer) => {}; } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async (name: string, fn: (event: { payload: unknown }) => void) => {
  const set = mocks.events.get(name) ?? new Set();
  set.add(fn);
  mocks.events.set(name, set);
  return () => set.delete(fn);
} }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onFocusChanged: async () => () => {} }) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async (fn: (event: { payload: unknown }) => void) => { mocks.drops.add(fn); return () => mocks.drops.delete(fn); } }) }));
vi.mock("../lib/xtermLoader", () => {
  class Terminal {
    cols = 80;
    rows = 24;
    options = {};
    disposed = false;
    focused = 0;
    output = "";
    data = (_text: string) => {};
    key = () => {};
    constructor() { mocks.terminals.push(this); }
    loadAddon() {}
    open() {}
    onTitleChange() { return { dispose() {} }; }
    onData(fn: (text: string) => void) { this.data = fn; return { dispose: () => { this.data = () => {}; } }; }
    onKey(fn: () => void) { this.key = fn; return { dispose: () => { this.key = () => {}; } }; }
    write(data: string | Uint8Array, done?: () => void) {
      const text = typeof data === "string" ? data : new TextDecoder().decode(data);
      this.output += text;
      // xterm's parser answers DSR through onData, even with no user input.
      if (text.includes("\x1b[6n")) this.data("\x1b[1;1R");
      done?.();
    }
    writeln(text: string) { this.output += text; }
    resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; }
    refresh() {}
    focus() { this.focused++; }
    dispose() { this.disposed = true; }
  }
  class FitAddon { fit() {} proposeDimensions() { return { cols: 80, rows: 24 }; } }
  class WebglAddon { onContextLoss() {} dispose() {} }
  const mods = { Terminal, FitAddon, WebglAddon };
  return { xtermMods: () => mods, loadXterm: async () => mods };
});

import { TerminalView } from "./TerminalView";
import { __resetRevealFocus, suppressTerminalRevealFocus, tauriHandoffDeps, whenPtySpawned } from "../lib/terminalSeams";
import { enqueuePtyOp } from "../lib/ptyFence";
import { PROMISED_DROP_EVENT } from "../lib/nativeFileDrop";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let id: string;
const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const currentTerm = () => mocks.terminals[mocks.terminals.length - 1];
/** The element TerminalView registers as its drop target. */
const terminalHost = () => host.firstElementChild!.firstElementChild!;
/** jsdom has no layout: say which layers are under the pointer, topmost first. */
const layersAtPointer = (stack: Element[]) => { document.elementsFromPoint = () => stack; };
const elementsFromPoint = document.elementsFromPoint;
const emit = (text: string) => {
  const pty = mocks.shells.get(id)!;
  pty.history += text;
  pty.channel?.onmessage(bytes(text));
};
async function settle() {
  await act(async () => { await enqueuePtyOp(id, async () => {}); });
}
async function mount(visible = true, strict = false, onUserInput = vi.fn()) {
  const view = <TerminalView id={id} cwd="/repo" theme="light" visible={visible} onActivity={() => {}} onExit={() => {}} onUserInput={onUserInput} />;
  await act(async () => root.render(strict ? <StrictMode>{view}</StrictMode> : view));
  await settle();
  return onUserInput;
}
beforeEach(() => {
  id = crypto.randomUUID();
  mocks.terminals.length = 0;
  mocks.shells.clear();
  mocks.drops.clear();
  mocks.events.clear();
  layersAtPointer([]);
  mocks.invoke.mockReset().mockImplementation(async (command, args) => {
    const pty = mocks.shells.get(args.id);
    switch (command) {
      case "pty_is_live": return !!pty;
      case "pty_spawn":
        mocks.shells.set(args.id, { pid: ++mocks.nextPid, history: "", attachmentId: args.attachmentId, channel: args.onOutput });
        args.onOutput.onmessage(bytes(""));
        break;
      case "pty_attach":
        if (!pty) throw new Error("terminal ended");
        pty.attachmentId = args.attachmentId;
        pty.channel = args.onOutput;
        pty.channel!.onmessage(bytes(pty.history));
        break;
      case "pty_detach": if (pty && pty.attachmentId === args.attachmentId) pty.channel = null; break;
      case "pty_kill": mocks.shells.delete(args.id); break;
    }
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 500, bottom: 300, width: 500, height: 300, toJSON: () => ({}) });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  await settle();
  host.remove();
  document.elementsFromPoint = elementsFromPoint;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("terminal view lifecycle", () => {
  it("reattaches a surviving shell with one replay and the same PID after a view reload", async () => {
    await mount();
    const pid = mocks.shells.get(id)!.pid;
    act(() => emit("before reload\r\n"));
    expect(currentTerm().output).toBe("before reload\r\n");
    await act(async () => root.render(null));
    await settle();
    expect(mocks.shells.get(id)?.pid).toBe(pid);
    expect(mocks.shells.get(id)?.channel).toBeNull();
    act(() => emit("while detached\r\n"));
    await mount();
    expect(currentTerm().output).toBe("before reload\r\nwhile detached\r\n");
    expect(mocks.shells.get(id)?.pid).toBe(pid);
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "pty_spawn")).toHaveLength(1);
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "pty_attach")).toHaveLength(1);
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "pty_kill" || cmd === "pty_write")).toHaveLength(0);
  });

  it("StrictMode creates one shell and delivers a handoff once after its surviving attachment", async () => {
    await mount(true, true);
    await whenPtySpawned(id, 1000);
    await tauriHandoffDeps.writeChecked(id, "claude --resume\r");
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "pty_spawn")).toHaveLength(1);
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "pty_write_checked")).toHaveLength(1);
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "pty_kill")).toHaveLength(0);
    expect(mocks.shells.get(id)?.channel).not.toBeNull();
  });

  it("a mount replaced during an in-flight spawn detaches in order and reuses the surviving shell", async () => {
    let start!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ordinary = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "pty_spawn") { start(); await gate; }
      return ordinary(command, args);
    });
    const view = <TerminalView id={id} cwd="/repo" theme="light" visible={true} onActivity={() => {}} onExit={() => {}} />;
    await act(async () => root.render(view));
    await started;
    await act(async () => root.render(null));
    await act(async () => root.render(view));
    await act(async () => { release(); await enqueuePtyOp(id, async () => {}); });
    await whenPtySpawned(id, 1000);
    const lifecycle = mocks.invoke.mock.calls.map(([cmd]) => cmd).filter((cmd) => ["pty_spawn", "pty_attach", "pty_detach", "pty_kill"].includes(cmd));
    expect(lifecycle).toEqual(["pty_spawn", "pty_detach", "pty_attach"]);
    expect(mocks.shells.get(id)?.channel).not.toBeNull();
    act(() => emit("still alive"));
    expect(currentTerm().output).toBe("still alive");
  });

  it("discards the old hidden buffer and stale channel callbacks before replaying into a new view", async () => {
    await mount(false);
    act(() => emit("hidden history"));
    const oldChannel = mocks.shells.get(id)!.channel!;
    const oldToken = mocks.shells.get(id)!.attachmentId;
    await act(async () => root.render(null));
    await settle();
    await mount(false, true);
    const newToken = mocks.shells.get(id)!.attachmentId;
    expect(newToken).not.toBe(oldToken);
    act(() => oldChannel.onmessage(bytes("stale callback")));
    await mount(true, true);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(currentTerm().output).toBe("hidden history");
    expect(mocks.invoke.mock.calls.filter(([cmd, args]) => cmd === "pty_ack" && args.attachmentId === newToken)).toHaveLength(1);
  });

  it("marks keystrokes and native file drops as user input, but never output replay", async () => {
    const touched = await mount();
    act(() => emit("prompt"));
    expect(touched).not.toHaveBeenCalled();
    act(() => emit("\x1b[6n"));
    expect(mocks.invoke).toHaveBeenCalledWith("pty_write", { id, data: "\x1b[1;1R" });
    expect(touched).not.toHaveBeenCalled();
    act(() => { currentTerm().key(); currentTerm().data("ls\r"); });
    expect(touched).toHaveBeenCalledWith(id);
    layersAtPointer([terminalHost()]);
    act(() => mocks.drops.forEach((fn) => fn({ payload: { type: "drop", paths: ["/tmp/a file.txt"], position: { x: 30, y: 30 } } })));
    expect(touched).toHaveBeenCalledTimes(2);
    expect(mocks.invoke).toHaveBeenCalledWith("pty_write", { id, data: "'/tmp/a file.txt' " });
  });

  it("takes a file drop through an overlay that sits on the terminal without being a drop target", async () => {
    await mount();
    const notch = document.body.appendChild(document.createElement("div"));
    layersAtPointer([notch, terminalHost()]);
    act(() => mocks.drops.forEach((fn) => fn({ payload: { type: "drop", paths: ["/tmp/x.png"], position: { x: 30, y: 30 } } })));
    expect(mocks.invoke).toHaveBeenCalledWith("pty_write", { id, data: "'/tmp/x.png' " });
    notch.remove();
  });

  it("types a promised drop's quoted path when it lands over the terminal, and ignores one outside", async () => {
    const touched = await mount();
    const promised = (payload: unknown) => act(() => mocks.events.get(PROMISED_DROP_EVENT)?.forEach((fn) => fn({ payload })));
    layersAtPointer([document.body]);
    promised({ paths: ["/cache/drops/1/Screenshot 1.png"], position: { x: 900, y: 900 } });
    expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "pty_write")).toBe(false);
    expect(touched).not.toHaveBeenCalled();
    layersAtPointer([terminalHost()]);
    promised({ paths: ["/cache/drops/1/Screenshot 1.png"], position: { x: 30, y: 30 } });
    expect(mocks.invoke).toHaveBeenCalledWith("pty_write", { id, data: "'/cache/drops/1/Screenshot 1.png' " });
    expect(touched).toHaveBeenCalledWith(id);
  });

  it("never types a dropped file name that holds a control character", async () => {
    const touched = await mount();
    layersAtPointer([terminalHost()]);
    act(() => mocks.drops.forEach((fn) => fn({ payload: { type: "drop", paths: ["/tmp/x\rrm -rf ~\r"], position: { x: 30, y: 30 } } })));
    expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "pty_write")).toBe(false);
    expect(touched).not.toHaveBeenCalled();
    act(() => mocks.drops.forEach((fn) => fn({ payload: { type: "drop", paths: ["/tmp/bad\nname", "/tmp/ok.png"], position: { x: 30, y: 30 } } })));
    expect(mocks.invoke).toHaveBeenCalledWith("pty_write", { id, data: "'/tmp/ok.png' " });
  });

  it("ignores a drop onto a hidden terminal", async () => {
    await mount(false);
    layersAtPointer([terminalHost()]);
    act(() => mocks.drops.forEach((fn) => fn({ payload: { type: "drop", paths: ["/tmp/x"], position: { x: 30, y: 30 } } })));
    expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "pty_write")).toBe(false);
  });

  it("marks text paste and IME input without treating terminal replies as gestures", async () => {
    const touched = await mount();
    const paste = new Event("paste", { bubbles: true });
    Object.defineProperty(paste, "clipboardData", { value: { items: [], getData: () => "pasted" } });
    act(() => terminalHost().dispatchEvent(paste));
    expect(touched).toHaveBeenCalledTimes(1);
    act(() => terminalHost().dispatchEvent(new Event("compositionstart", { bubbles: true })));
    expect(touched).toHaveBeenCalledTimes(2);
  });

  it("suppresses query replies in historical replay, including hidden reattachment, and still answers live queries", async () => {
    mocks.shells.set(id, { pid: 123, history: "history\x1b[6n", attachmentId: "old", channel: null });
    await mount(false);
    expect(currentTerm().output).toBe("history\x1b[6n");
    expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "pty_write")).toBe(false);
    await mount(true);
    act(() => emit("live\x1b[6n"));
    expect(mocks.invoke).toHaveBeenCalledWith("pty_write", { id, data: "\x1b[1;1R" });
  });
});

// The terminal guard (10/10, "never steal focus"): a reveal hands the
// terminal the caret only when nothing else holds it.
describe("a revealed terminal takes the caret only when nothing else holds it", () => {
  const frame = () => act(async () => { await new Promise((done) => requestAnimationFrame(() => done(null))); });
  async function reveal() {
    await mount(false);
    await mount(true);
    await frame();
    return currentTerm().focused;
  }
  const press = () => window.dispatchEvent(new Event("pointerdown"));
  beforeEach(() => __resetRevealFocus());
  afterEach(() => { document.querySelectorAll("[data-elsewhere]").forEach((element) => element.remove()); });

  it("takes nothing at boot, before the user has pressed or typed anything", async () => {
    expect(await reveal()).toBe(0);
  });

  it("takes it on a reveal the user asked for", async () => {
    press();
    expect(await reveal()).toBe(1);
  });

  it("a key counts as asking, too", async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true }));
    expect(await reveal()).toBe(1);
  });

  it("never from a text field elsewhere: a composer keeps its caret", async () => {
    press();
    const composer = document.createElement("textarea");
    composer.dataset.elsewhere = "";
    document.body.appendChild(composer);
    composer.focus();
    expect(await reveal()).toBe(0);
    expect(document.activeElement).toBe(composer);
  });

  it("another terminal's caret is fair game: a tile switch is aimed at the terminals", async () => {
    press();
    const other = document.createElement("div");
    other.className = "xterm";
    other.dataset.elsewhere = "";
    other.appendChild(document.createElement("textarea"));
    document.body.appendChild(other);
    other.querySelector("textarea")!.focus();
    expect(await reveal()).toBe(1);
  });

  it("never under the open door, which sweeps everything behind it inert", async () => {
    press();
    // The attribute `inert` reflects to in the app's webview (jsdom keeps
    // the property to itself).
    host.setAttribute("inert", "");
    expect(await reveal()).toBe(0);
  });

  it("never inside a programmatic reveal's window", async () => {
    press();
    suppressTerminalRevealFocus();
    expect(await reveal()).toBe(0);
  });
});
