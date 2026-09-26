// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseTerminalWorkspace, readTerminalWorkspace, saveTerminalWorkspace, TERMINAL_WORKSPACE_KEY } from "./terminalWorkspace";

beforeEach(() => localStorage.clear());
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
    localStorage.setItem(TERMINAL_WORKSPACE_KEY, "{");
    expect(readTerminalWorkspace(14)).toBeNull();
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage disabled"); });
    expect(readTerminalWorkspace(14)).toBeNull();
    get.mockRestore();
  });
});
