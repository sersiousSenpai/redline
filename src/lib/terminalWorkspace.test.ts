// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseTerminalWorkspace, readTerminalWorkspace, saveTerminalWorkspace, TERMINAL_WORKSPACE_KEY } from "./terminalWorkspace";

beforeEach(() => localStorage.clear());
describe("terminal workspace persistence", () => {
  it("round-trips visible and background tabs, focus, zoom and placeholder state", () => {
    const workspace = { tabs: [{ id: "a", cwd: null, placeholder: true }, { id: "b", cwd: "/repo" }, { id: "hidden", cwd: "/work" }], tiles: ["b", "a"], focusedTile: 1, zoomedId: "b" };
    saveTerminalWorkspace(workspace);
    expect(readTerminalWorkspace(14)).toEqual({...workspace,tabs:workspace.tabs.map(tab=>({...tab,kind:"shell",view:"shell"}))});
  });
  it("repairs malformed layout, drops invalid/duplicate tabs and clamps focus", () => {
    expect(parseTerminalWorkspace({ tabs: [null, { id: "a", cwd: "/repo" }, { id: "a", cwd: null }, { id: "bad", cwd: 4 }, { id: "b", cwd: null }], tiles: ["missing", "b", "b", "a"], focusedTile: 20, zoomedId: "missing" }, 1)).toEqual({ tabs: [{ id: "a", cwd: "/repo",kind:"shell",view:"shell" }, { id: "b", cwd: null,kind:"shell",view:"shell" }], tiles: ["b"], focusedTile: 0, zoomedId: null });
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

it("persists hosted identity and view without replaying the first prompt or trusting stale alive state",()=>{
 const parsed=parseTerminalWorkspace({tabs:[{id:"a",cwd:"/repo",kind:"agent",view:"raw",sessionId:"session",alive:true,launch:{cwd:"/repo",prompt:"must not replay",permissionMode:"plan"}}],tiles:["a"]},14)!;
 expect(parsed.tabs[0]).toMatchObject({kind:"agent",view:"raw",sessionId:"session",launch:{prompt:""}});expect(parsed.tabs[0].alive).toBeUndefined();
});
