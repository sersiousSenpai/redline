// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UseReview } from "../hooks/useReview";
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("./ReviewPanel", () => ({ default: () => null }));
import { RunReport } from "./RunReport";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
beforeEach(() => { invokeMock.mockReset(); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const report = { measured: true, summary: "Finished native run", subtasks: [{ nodeId: "n-api", title: "Implement API", verified: true, checks: [{ nodeId: "n-check", command: "npm test", status: "passed", exitCode: 0 }] }] };
async function mount() {
  await act(async () => root.render(createElement(RunReport, { planSessionId: "plan-1", planTitle: "Example", repoPath: null,
    review: { diff: [], review: null } as unknown as UseReview, projectOptions: [], onClose: () => {}, onResolved: () => {},
    canRelaunch: false, onRelaunch: () => {}, onStandDown: () => {} })));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
describe("native report provenance", () => {
  it("shows measured tasks and actual check exits for a registered native graph", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_plan_run") return { reportJson: JSON.stringify({ summary: "stale agent claims", subtasks: [] }), workflowRan: false, createdAt: 0 };
      if (command === "runner_list") return [{ runId: "run-1", planSessionId: "plan-1" }];
      if (command === "runner_report") return report;
      return null;
    });
    await mount();
    expect(host.textContent).toContain("native run graph · measured results");
    expect(host.textContent).toContain("Measured task");
    expect(host.textContent).toContain("npm test: exit 0");
    expect(host.textContent).not.toContain("sequential execution");
    expect(host.textContent).not.toContain("stale agent claims");
  });
  it("does not trust a legacy agent's measured:true assertion", async () => {
    invokeMock.mockImplementation(async (command: string) => command === "runner_list" ? [] : { reportJson: JSON.stringify(report), workflowRan: true, createdAt: 0 });
    await mount();
    expect(host.textContent).toContain("Claimed subtask");
    expect(host.textContent).toContain("multi-agent workflow");
    expect(host.textContent).not.toContain("measured results");
    expect(invokeMock.mock.calls.some(([command]) => command === "runner_report")).toBe(false);
  });
});
