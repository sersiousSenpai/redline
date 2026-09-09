import { describe, expect, it } from "vitest";
import { formatLastRun, middleTruncate } from "./ServersPane";

describe("middleTruncate", () => {
  it("leaves a short path alone", () => {
    expect(middleTruncate("/Users/me/app")).toBe("/Users/me/app");
  });

  it("keeps BOTH ends — the anchor and the identifying leaf", () => {
    const path = "/Users/me/code/clients/acme/2026/q3/frontend-web";
    const got = middleTruncate(path, 30);
    expect(got.length).toBeLessThanOrEqual(30);
    expect(got).toContain("…");
    expect(got.startsWith("/Users")).toBe(true);
    expect(got.endsWith("frontend-web")).toBe(true);
  });

  it("never truncates below a legible floor", () => {
    // Even an absurd budget must leave something on each side rather than
    // collapsing to a bare ellipsis.
    const got = middleTruncate("/a/very/long/path/to/somewhere", 4);
    expect(got).toMatch(/^.+….+$/);
  });
});

describe("formatLastRun", () => {
  const now = 1_700_000_000_000;
  const ago = (ms: number) => formatLastRun(now - ms, now);

  it("uses the coarse unit a glance wants", () => {
    expect(ago(5_000)).toBe("just now");
    expect(ago(20 * 60_000)).toBe("20m ago");
    expect(ago(3 * 3_600_000)).toBe("3h ago");
    expect(ago(2 * 86_400_000)).toBe("2d ago");
    expect(ago(60 * 86_400_000)).toBe("2mo ago");
    expect(ago(400 * 86_400_000)).toBe("1y ago");
  });

  it("a clock that skewed backwards reads as just now, never a negative", () => {
    expect(formatLastRun(now + 10_000, now)).toBe("just now");
  });
});

// Exercise the actual two-click control, including asynchronous dry-run races.
import { afterEach, beforeEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StopButton } from "./ServersPane";
import { RunProjectDialog } from "./RunProjectDialog";
import type { ProbeView, StopPlan } from "../lib/devServerTypes";
import { scriptCommand } from "../lib/devServerTypes";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), browse: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.browse }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.browse.mockReset();
  HTMLElement.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function mountComponent(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(element));
  return container;
}
async function clickText(text: string) {
  const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  expect(button, `button containing ${text}`).toBeDefined();
  await act(async () => button!.click());
}
const plan: StopPlan = { root: 20, rootLabel: "npm", pids: [20, 21, 22], collateralPorts: [] };

describe("StopButton", () => {
  it.each([
    [{ ...plan, collateralPorts: [3103] }, "Really stop? · also :3103"],
    [plan, "Really stop? · 3 procs"],
  ] as [StopPlan, string][])("shows the planned impact before confirming", async (next, expected) => {
    const onStop = vi.fn();
    const c = mountComponent(createElement(StopButton, { onArm: async () => next, onStop }));
    await clickText("Stop");
    expect(c.textContent).toContain(expected);
    expect(onStop).not.toHaveBeenCalled();
    await clickText("Really stop?");
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("allows confirmation with the plain label when the dry run rejects", async () => {
    const onStop = vi.fn();
    const c = mountComponent(createElement(StopButton, { onArm: async () => { throw new Error("gone"); }, onStop }));
    await clickText("Stop");
    expect(c.textContent).toBe("Really stop?");
    await clickText("Really stop?");
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("disarms after three seconds and ignores a late plan from an older arm", async () => {
    vi.useFakeTimers();
    let resolve!: (value: StopPlan) => void;
    const onArm = vi.fn().mockReturnValueOnce(new Promise<StopPlan>((r) => { resolve = r; })).mockResolvedValue(plan);
    const c = mountComponent(createElement(StopButton, { onArm, onStop: vi.fn() }));
    await clickText("Stop");
    await act(async () => vi.advanceTimersByTime(3000));
    expect(c.textContent).toBe("Stop");
    await clickText("Stop");
    await act(async () => resolve({ ...plan, collateralPorts: [9999] }));
    expect(c.textContent).toBe("Really stop? · 3 procs");
  });
});

const probe: ProbeView = { projectName: "web", stack: "Node — web", runCommand: "pnpm run dev", scripts: ["dev", "test"], exists: true, packageManager: "pnpm" };
function mountRunDialog() {
  const onRun = vi.fn();
  const c = mountComponent(createElement(RunProjectDialog, {
    options: [{ path: "/projects/web", name: "web", source: "workspace" }], onRun, onCancel: vi.fn(),
  }));
  return { c, onRun };
}
async function chooseProject() {
  await clickText("Home (~)");
  await clickText("web");
}
function editCommand(c: HTMLElement, command: string) {
  const input = c.querySelector("input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, command);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("RunProjectDialog", () => {
  it("prefills a known project's command and runs a script quick pick in its directory", async () => {
    mocks.invoke.mockResolvedValue(probe);
    const { c, onRun } = mountRunDialog();
    await chooseProject();
    expect(mocks.invoke).toHaveBeenCalledWith("dev_server_probe", { projectPath: "/projects/web" });
    expect(c.querySelector("input")!.value).toBe("pnpm run dev");
    await clickText("test");
    await clickText("Run ▶");
    expect(onRun).toHaveBeenCalledWith("/projects/web", "pnpm run test");
  });

  it("browses an unknown directory and runs a hand-edited command when there is no default", async () => {
    mocks.browse.mockResolvedValue("/projects/unknown");
    mocks.invoke.mockResolvedValue({ ...probe, runCommand: "", scripts: [] });
    const { c, onRun } = mountRunDialog();
    await clickText("Home (~)");
    await clickText("Browse…");
    expect(mocks.browse).toHaveBeenCalledWith({ directory: true, multiple: false });
    editCommand(c, "python -m http.server 4321");
    await clickText("Run ▶");
    expect(onRun).toHaveBeenCalledWith("/projects/unknown", "python -m http.server 4321");
  });

  it("does not overwrite a command typed while the manifest probe is pending", async () => {
    let resolve!: (value: ProbeView) => void;
    mocks.invoke.mockReturnValue(new Promise<ProbeView>((r) => { resolve = r; }));
    const { c, onRun } = mountRunDialog();
    await chooseProject();
    editCommand(c, "pnpm dev --port 4321");
    await act(async () => resolve(probe));
    expect(c.querySelector("input")!.value).toBe("pnpm dev --port 4321");
    await clickText("Run ▶");
    expect(onRun).toHaveBeenCalledWith("/projects/web", "pnpm dev --port 4321");
  });

  it("allows a manual command after a failed probe but blocks a known missing folder", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("unavailable"));
    const first = mountRunDialog();
    await chooseProject();
    editCommand(first.c, "make serve");
    await clickText("Run ▶");
    expect(first.onRun).toHaveBeenCalledWith("/projects/web", "make serve");
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    mocks.invoke.mockResolvedValue({ ...probe, exists: false });
    const second = mountRunDialog();
    await chooseProject();
    expect(second.c.textContent).toContain("folder no longer exists");
    expect(second.c.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  });

  it("quotes manifest script names as one shell argument", () => {
    expect(scriptCommand("bun", "dev:web")).toBe("bun run dev:web");
    expect(scriptCommand("pnpm", "dev; touch /tmp/nope")).toBe("pnpm run 'dev; touch /tmp/nope'");
    expect(scriptCommand("npm", "it's dev")).toBe("npm run 'it'\\''s dev'");
  });
});

import { useDevServers, type UseDevServers } from "../hooks/useDevServers";

describe("useDevServers stop protocol", () => {
  it("passes the displayed port and retains stop failures across a successful sweep", async () => {
    mocks.invoke.mockImplementation((command: string) => command === "dev_server_stop"
      ? Promise.reject(new Error("that server is no longer on :3103"))
      : Promise.resolve({ running: [], recent: [], others: [] }));
    let servers!: UseDevServers;
    function Harness() {
      servers = useDevServers(false);
      return createElement("div", null, servers.error);
    }
    const c = mountComponent(createElement(Harness));
    await act(async () => servers.stopServer(21, 3103, "/projects/web"));
    expect(mocks.invoke).toHaveBeenCalledWith("dev_server_stop", { pid: 21, port: 3103, projectPath: "/projects/web" });
    expect(c.textContent).toContain("no longer on :3103");
    await act(async () => servers.refresh());
    expect(c.textContent).toBe("");
  });

  it("returns null for a failed dry run and still refreshes", async () => {
    mocks.invoke.mockImplementation((command: string) => command === "dev_server_stop_plan"
      ? Promise.reject(new Error("tree changed"))
      : Promise.resolve({ running: [], recent: [], others: [] }));
    let servers!: UseDevServers;
    function Harness() { servers = useDevServers(false); return null; }
    mountComponent(createElement(Harness));
    let result: StopPlan | null = plan;
    await act(async () => { result = await servers.planStop(21, 3103, "/projects/web"); });
    expect(result).toBeNull();
    expect(mocks.invoke).toHaveBeenCalledWith("dev_server_stop_plan", { pid: 21, port: 3103, projectPath: "/projects/web" });
    expect(mocks.invoke).toHaveBeenCalledWith("dev_servers_scan");
  });
});
