// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseTerminalWorkspace, readTerminalWorkspace, saveTerminalWorkspace, TERMINAL_WORKSPACE_KEY } from "./terminalWorkspace";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
describe("terminal workspace persistence", () => {
  it("round-trips the terminals and their placeholder state", () => {
    const workspace = { tabs: [{ id: "a", cwd: null, placeholder: true }, { id: "b", cwd: "/repo" }, { id: "hidden", cwd: "/work" }] };
    saveTerminalWorkspace(workspace);
    expect(readTerminalWorkspace()).toEqual(workspace);
  });
  it("drops invalid and duplicate tabs", () => {
    expect(parseTerminalWorkspace({ tabs: [null, { id: "a", cwd: "/repo" }, { id: "a", cwd: null }, { id: "bad", cwd: 4 }, { id: "b", cwd: null }] })).toEqual({ tabs: [{ id: "a", cwd: "/repo" }, { id: "b", cwd: null }] });
  });
  it("reads past an older build's layout: which wall shows what is the workbench's now", () => {
    const older = { tabs: [{ id: "a", cwd: null }, { id: "b", cwd: "/repo" }], tiles: ["a", "b"], focusedTile: 1, zoomedId: "a", pinned: ["b"] };
    expect(parseTerminalWorkspace(older)).toEqual({ tabs: older.tabs });
  });
  it("falls back cleanly when storage is corrupt or unavailable", () => {
    sessionStorage.setItem(TERMINAL_WORKSPACE_KEY, "{");
    expect(readTerminalWorkspace()).toBeNull();
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage disabled"); });
    expect(readTerminalWorkspace()).toBeNull();
    get.mockRestore();
  });
  it("lives in sessionStorage so a relaunch, unlike a reload, starts empty", () => {
    saveTerminalWorkspace({ tabs: [{ id: "a", cwd: "/repo" }] });
    expect(sessionStorage.getItem(TERMINAL_WORKSPACE_KEY)).not.toBeNull();
    expect(localStorage.getItem(TERMINAL_WORKSPACE_KEY)).toBeNull();
    sessionStorage.clear();
    expect(readTerminalWorkspace()).toBeNull();
  });
  it("ignores and removes a legacy localStorage workspace", () => {
    localStorage.setItem(TERMINAL_WORKSPACE_KEY, JSON.stringify({ tabs: [{ id: "dead", cwd: "/repo" }] }));
    expect(readTerminalWorkspace()).toBeNull();
    expect(localStorage.getItem(TERMINAL_WORKSPACE_KEY)).toBeNull();
  });
  it("keeps attention acknowledgements for live tabs only, and tolerates workspaces without them", () => {
    const base = { tabs: [{ id: "a", cwd: null }, { id: "b", cwd: null }] };
    expect(parseTerminalWorkspace(base)).toEqual(base);
    expect(parseTerminalWorkspace({ ...base, acks: { a: { at: 5, as: "seen" }, b: { at: 6, as: "bogus" }, gone: { at: 1, as: "seen" }, c: null } })?.acks).toEqual({ a: { at: 5, as: "seen" } });
    expect(parseTerminalWorkspace({ ...base, acks: "nope" })).toEqual(base);
    const withAcks = { ...base, acks: { b: { at: 9, as: "cleared" as const } } };
    saveTerminalWorkspace(withAcks);
    expect(readTerminalWorkspace()).toEqual(withAcks);
  });
});
