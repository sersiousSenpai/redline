// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => { invoke.mockReset(); vi.resetModules(); });
describe("durable browser workspace coordination", () => {
  it("can reload after a failed save without swallowing the original failure", async () => {
    const workspace = await import("./browserWorkspace");
    invoke.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("Disk unavailable")).mockResolvedValueOnce({ tabs: [], revision: 4 });
    await expect(workspace.saveBrowserWorkspace("one", { tabs: [] })).rejects.toThrow("Disk unavailable");
    await expect(workspace.loadBrowserWorkspace("one")).resolves.toMatchObject({ revision: 4 });
    expect(invoke.mock.calls.map(c => c[0])).toEqual(["browser_workspace_read", "browser_workspace_write", "browser_workspace_read"]);
  });
  it("serializes writes and adopts backend revisions without letting older events regress them", async () => {
    const workspace = await import("./browserWorkspace");
    let release!: (value: unknown) => void;
    invoke.mockResolvedValueOnce({ tabs: [], revision: 2 });
    await workspace.loadBrowserWorkspace("one");
    invoke.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValueOnce({ tabs: [], revision: 4 });
    const first = workspace.saveBrowserWorkspace("one", { tabs: [] });
    const second = workspace.saveBrowserWorkspace("one", { tabs: [] });
    await Promise.resolve(); await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(2);
    release({ tabs: [], revision: 3 });
    await Promise.all([first, second]);
    expect(invoke.mock.calls[2][1].expectedRevision).toBe(3);
    workspace.noteWorkspaceRevision("one", 6); workspace.noteWorkspaceRevision("one", 5);
    invoke.mockResolvedValueOnce({ tabs: [], revision: 7 });
    await workspace.saveBrowserWorkspace("one", { tabs: [] });
    expect(invoke.mock.calls[3][1].expectedRevision).toBe(6);
  });
  it("rejects an old queued snapshot after a background page arrives", async () => {
    const workspace = await import("./browserWorkspace");
    invoke.mockResolvedValueOnce({ tabs: [], revision: 1 });
    await workspace.loadBrowserWorkspace("mission");
    const save = workspace.saveBrowserWorkspace("mission", { tabs: [] });
    workspace.noteWorkspaceRevision("mission", 2);
    await expect(save).rejects.toThrow("newer state has been preserved");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
