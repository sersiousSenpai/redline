// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseTerminalWorkspace, readTerminalWorkspace, saveTerminalWorkspace, TERMINAL_WORKSPACE_KEY } from "./terminalWorkspace";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
describe("terminal workspace persistence", () => {
  it("round-trips visible and background tabs, focus, zoom and placeholder state", () => {
    const workspace = { tabs: [{ id: "a", cwd: null, placeholder: true }, { id: "b", cwd: "/repo" }, { id: "hidden", cwd: "/work" }], tiles: ["b", "a"], focusedTile: 1, zoomedId: "b" };
    saveTerminalWorkspace(workspace);
    expect(readTerminalWorkspace(14)).toEqual(workspace);
  });
  it("repairs malformed layout, drops invalid/duplicate tabs and clamps focus", () => {
    expect(parseTerminalWorkspace({ tabs: [null, { id: "a", cwd: "/repo" }, { id: "a", cwd: null }, { id: "bad", cwd: 4 }, { id: "b", cwd: null }], tiles: ["missing", "b", "b", "a"], focusedTile: 20, zoomedId: "missing" }, 1)).toEqual({ tabs: [{ id: "a", cwd: "/repo" }, { id: "b", cwd: null }], tiles: ["b"], focusedTile: 0, zoomedId: null });
    expect(parseTerminalWorkspace({ tabs: [{ id: "a", cwd: null }], tiles: [] }, 14)?.tiles).toEqual(["a"]);
  });
  it("falls back cleanly when storage is corrupt or unavailable", () => {
    sessionStorage.setItem(TERMINAL_WORKSPACE_KEY, "{");
    expect(readTerminalWorkspace(14)).toBeNull();
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage disabled"); });
    expect(readTerminalWorkspace(14)).toBeNull();
    get.mockRestore();
  });
  it("lives in sessionStorage so a relaunch, unlike a reload, starts empty", () => {
    const workspace = { tabs: [{ id: "a", cwd: "/repo" }], tiles: ["a"], focusedTile: 0, zoomedId: null };
    saveTerminalWorkspace(workspace);
    expect(sessionStorage.getItem(TERMINAL_WORKSPACE_KEY)).not.toBeNull();
    expect(localStorage.getItem(TERMINAL_WORKSPACE_KEY)).toBeNull();
    sessionStorage.clear();
    expect(readTerminalWorkspace(14)).toBeNull();
  });
  it("ignores and removes a legacy localStorage workspace", () => {
    localStorage.setItem(TERMINAL_WORKSPACE_KEY, JSON.stringify({ tabs: [{ id: "dead", cwd: "/repo" }], tiles: ["dead"], focusedTile: 0, zoomedId: null }));
    expect(readTerminalWorkspace(14)).toBeNull();
    expect(localStorage.getItem(TERMINAL_WORKSPACE_KEY)).toBeNull();
  });
  it("keeps attention acknowledgements for live tabs only, and tolerates layouts without them", () => {
    const base = { tabs: [{ id: "a", cwd: null }, { id: "b", cwd: null }], tiles: ["a"], focusedTile: 0, zoomedId: null };
    expect(parseTerminalWorkspace(base, 14)).toEqual(base);
    expect(parseTerminalWorkspace({ ...base, acks: { a: { at: 5, as: "seen" }, b: { at: 6, as: "bogus" }, gone: { at: 1, as: "seen" }, c: null } }, 14)?.acks).toEqual({ a: { at: 5, as: "seen" } });
    expect(parseTerminalWorkspace({ ...base, acks: "nope" }, 14)).toEqual(base);
    const withAcks = { ...base, acks: { b: { at: 9, as: "cleared" as const } } };
    saveTerminalWorkspace(withAcks);
    expect(readTerminalWorkspace(14)).toEqual(withAcks);
  });
});
