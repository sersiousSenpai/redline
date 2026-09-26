// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { EMPTY_CONFLICT_SCAN, type HookConflict, type HookConflictScan, type HookRemovalReport } from "../lib/hookConflicts";
const { invokeMock, listenMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), listenMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(() => Promise.resolve()) }));
import { useHookConflicts, type HookConflictHealth } from "./useHookConflicts";
import { HookConflictModal } from "../components/HookConflictModal";
import { HookConflictWarning } from "../components/HookConflictWarning";
import { MenuOverlayProvider } from "../components/menuOverlay";
import { SettingsMenu } from "../components/SettingsMenu";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const conflict: HookConflict = {
  identity: { id: "a", sourcePath: "/tmp/hooks.json", snapshot: "before" }, backend: "codex", event: "Stop", installationKind: "direct", action: "removeHooks",
  detail: "Remove only the identified Plannotator plan handlers. Keep the executable and saved reviews.", command: "/bin/plannotator", pluginId: null,
};
const found: HookConflictScan = { ...EMPTY_CONFLICT_SCAN, conflicts: [conflict] };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
let current: HookConflictHealth, root: Root, host: HTMLDivElement;
let scanReply: () => Promise<HookConflictScan>;
let removalReply: () => Promise<HookRemovalReport>;
const registerOverlay = vi.fn();
function Probe({ project = "/tmp/a", ready = true }: { project?: string; ready?: boolean }) {
  current = useHookConflicts("codex", project, ready);
  return <MenuOverlayProvider value={registerOverlay}>
    <header>Window controls<SettingsMenu mode={null} theme={null} font={null} lint={null} agents={null} surfaces={null} extensions={null} notifications={null} onOpenIntegrationHooks={current.openDialog}/></header>
    <HookConflictWarning health={current}/>
    {current.dialogOpen && <HookConflictModal health={current}/>}
  </MenuOverlayProvider>;
}
const modal = () => document.querySelector<HTMLElement>('[role="dialog"]');
const warning = () => host.querySelector<HTMLElement>('aside[aria-label="Integration hook status"]');
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;
const tick = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };
beforeEach(() => {
  scanReply = () => Promise.resolve(found);
  removalReply = () => Promise.resolve({ results: [{ sourcePath: "/tmp/hooks.json", changed: true, backupPath: "/tmp/backup", error: null }], scan: EMPTY_CONFLICT_SCAN });
  invokeMock.mockReset(); listenMock.mockReset(); listenMock.mockResolvedValue(() => {});
  registerOverlay.mockClear();
  invokeMock.mockImplementation((command: string) => {
    if (command === "scan_hook_conflicts") return scanReply();
    if (command === "remove_hook_conflicts") return removalReply();
    return Promise.resolve(command === "watch_hook_conflicts" ? "watch-id" : undefined);
  });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it("scans only after the shell is ready, independently of expensive integration probes", async () => {
  await act(async () => root.render(createElement(Probe, { ready: false }))); await tick();
  expect(invokeMock).not.toHaveBeenCalled();
  await act(async () => root.render(createElement(Probe))); await tick();
  expect(warning()?.textContent).toContain("Plannotator hooks may interfere with Redline");
  expect(warning()?.textContent).toContain("/tmp/hooks.json");
  expect(modal()).toBeNull();
  expect(invokeMock.mock.calls.every(([name]) => String(name).includes("hook_conflicts"))).toBe(true);
});

it("disables repeat removal, displays inline failure, and retains unresolved warnings", async () => {
  const removal = deferred<HookRemovalReport>(); removalReply = () => removal.promise;
  await act(async () => root.render(createElement(Probe))); await tick();
  await act(async () => current.openDialog());
  await act(async () => { void current.remove([conflict.identity]); void current.remove([conflict.identity]); });
  expect(invokeMock.mock.calls.filter(([name]) => name === "remove_hook_conflicts")).toHaveLength(1);
  expect(current.pending).toBe(true);
  expect(Array.from(modal()!.querySelectorAll("button")).filter((b) => b.textContent?.includes("Updating"))[0]?.disabled).toBe(true);
  await act(async () => removal.resolve({ results: [{ sourcePath: "/tmp/hooks.json", changed: false, backupPath: null, error: "file changed" }], scan: found }));
  expect(current.pending).toBe(false); expect(modal()?.textContent).toContain("file changed");
  expect(modal()?.textContent).toContain("Plannotator hooks may interfere");
});

it("replaces a verified resolved warning with a restart notice", async () => {
  await act(async () => root.render(createElement(Probe))); await tick();
  await act(async () => { await current.remove([conflict.identity]); });
  expect(warning()?.textContent).not.toContain("Plannotator hooks may interfere");
  expect(warning()?.textContent).toContain("Restart the affected Codex session");
  expect(modal()).toBeNull();
});

it("discards a scan started before removal", async () => {
  await act(async () => root.render(createElement(Probe))); await tick();
  const stale = deferred<HookConflictScan>(); scanReply = () => stale.promise;
  await act(async () => { void current.refresh(); });
  await act(async () => { await current.remove([conflict.identity]); });
  await act(async () => stale.resolve(found));
  expect(current.scan.conflicts).toHaveLength(0); expect(current.restart).toBe(true);
});

it("discards obsolete project scan/removal results and releases the previous watch", async () => {
  const stale = deferred<HookConflictScan>(); scanReply = () => stale.promise;
  await act(async () => root.render(createElement(Probe))); await tick();
  scanReply = () => Promise.resolve(EMPTY_CONFLICT_SCAN);
  await act(async () => root.render(createElement(Probe, { project: "/tmp/b" }))); await tick();
  await act(async () => stale.resolve(found));
  expect(current.scan.conflicts).toHaveLength(0);
  expect(invokeMock).toHaveBeenCalledWith("unwatch_hook_conflicts", { watchId: "watch-id" });
  expect(invokeMock).toHaveBeenCalledWith("scan_hook_conflicts", { backend: "codex", projectPath: "/tmp/b" });
});

it("shows inspection errors rather than claiming the configuration is conflict-free", async () => {
  scanReply = () => Promise.resolve({ ...EMPTY_CONFLICT_SCAN, errors: [{ sourcePath: "/tmp/bad.json", message: "invalid JSON" }] });
  await act(async () => root.render(createElement(Probe))); await tick();
  expect(warning()?.textContent).toContain("Could not inspect integration hooks");
  await act(async () => current.openDialog());
  expect(modal()?.textContent).toContain("Could not inspect hook configuration");
  expect(modal()?.textContent).toContain("invalid JSON"); expect(modal()?.textContent).not.toContain("No configured");
});

it("debounces configuration changes and keeps watcher failure recoverable by focus refresh", async () => {
  let changed!: (event: { payload: { watchId: string } }) => void;
  listenMock.mockImplementation((_name, listener) => { changed = listener; return Promise.resolve(() => {}); });
  await act(async () => root.render(createElement(Probe))); await tick();
  const before = invokeMock.mock.calls.filter(([name]) => name === "scan_hook_conflicts").length;
  await act(async () => {
    changed({ payload: { watchId: "watch-id" } }); changed({ payload: { watchId: "watch-id" } });
    await new Promise((r) => setTimeout(r, 110));
  });
  expect(invokeMock.mock.calls.filter(([name]) => name === "scan_hook_conflicts")).toHaveLength(before + 1);
});

it("keeps the warning below window controls and opens one explicit details modal", async () => {
  await act(async () => root.render(createElement(Probe))); await tick();
  expect(modal()).toBeNull();
  expect(warning()).not.toBeNull();
  await act(async () => button("Review integration hooks").click());
  const dialog = modal();
  expect(dialog).not.toBeNull();
  expect(host.contains(dialog)).toBe(false);
  expect(host.querySelector("header")?.textContent).not.toContain("Plannotator");
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(registerOverlay).toHaveBeenCalledWith(1);
  await act(async () => button("Uninstall Plannotator hooks").click());
  expect(modal()).toBe(dialog);
  expect(dialog?.querySelector('[role="status"]')?.textContent).toContain("Restart the affected Codex session");
  expect(warning()?.textContent).toContain("Hook changes saved");
  await act(async () => button("Done").click());
  expect(modal()).toBeNull();
  expect(current.restart).toBe(true);
  expect(warning()?.textContent).toContain("Restart the affected Codex session");
  expect(registerOverlay).toHaveBeenLastCalledWith(-1);
});

it("does not reopen dismissed findings on refresh, but Settings can reopen them", async () => {
  await act(async () => root.render(createElement(Probe))); await tick();
  await act(async () => current.openDialog());
  await act(async () => button("Not now").click());
  await act(async () => current.refresh());
  expect(modal()).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());
  await act(async () => button("Review…").click());
  expect(host.querySelector('[aria-expanded="true"]')).toBeNull();
  expect(modal()?.textContent).toContain("Plannotator hooks may interfere");
  await act(async () => { modal()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(modal()).toBeNull();
  expect(document.activeElement).toBe(host.querySelector('[aria-haspopup="menu"]'));
  scanReply = () => Promise.resolve({ ...found, conflicts: [{ ...conflict, identity: { ...conflict.identity, snapshot: "changed" } }] });
  await act(async () => current.refresh());
  expect(modal()).toBeNull();
  expect(warning()).not.toBeNull();
});

it("never takes focus or opens an overlay when a conflict is discovered", async () => {
  const otherControl = document.createElement("button"); document.body.appendChild(otherControl); otherControl.focus();
  await act(async () => root.render(createElement(Probe))); await tick();
  expect(current.scan.conflicts).toHaveLength(1);
  expect(modal()).toBeNull();
  expect(document.activeElement).toBe(otherControl);
  expect(registerOverlay).not.toHaveBeenCalled();
  otherControl.remove();
});

it("contains keyboard focus and prevents dismissal while removal is pending", async () => {
  const removal = deferred<HookRemovalReport>(); removalReply = () => removal.promise;
  await act(async () => root.render(createElement(Probe))); await tick();
  await act(async () => current.openDialog());
  const last = button("Not now");
  await act(async () => {
    last.focus();
    last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  });
  expect(document.activeElement).toBe(modal()!.querySelector("button"));
  await act(async () => button("Uninstall Plannotator hooks").click());
  await act(async () => {
    modal()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    modal()!.parentElement!.click();
  });
  expect(modal()).not.toBeNull();
  await act(async () => removal.resolve({ results: [{ sourcePath: "/tmp/hooks.json", changed: true, backupPath: "/tmp/backup", error: null }], scan: EMPTY_CONFLICT_SCAN }));
  expect(modal()!.contains(document.activeElement)).toBe(true);
});
