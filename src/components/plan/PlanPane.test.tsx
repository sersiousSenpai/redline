// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewSession } from "../../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("../../hooks/useOrchestration", () => ({ useOrchestration: () => null }));
import PlanPane, { buildProgress, priorWithComments, type PlanPaneProps } from "./PlanPane";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
const q = (s: string) => host.querySelector(s);

const session = {
  sessionId: "s1",
  status: "in_review",
  revisions: [
    { versionNumber: 1, receivedAt: 1, comments: [{ id: "c1", type: "feedback", status: "submitted", body: "x" }], threadStart: true },
    { versionNumber: 2, receivedAt: 2, comments: [] },
  ],
} as unknown as ReviewSession;

function props(over: Partial<PlanPaneProps> = {}): PlanPaneProps {
  return {
    sessionId: "s1",
    session,
    latestVersion: 2,
    comments: [],
    viewing: null,
    contents: { open: false, onToggle: vi.fn() },
    footer: {
      author: "Claude",
      canSubmit: false,
      canApprove: true,
      waiting: false,
      waitingAsk: false,
      onSubmit: vi.fn(),
      onApprove: vi.fn(),
      onApproveLater: vi.fn(),
      approval: null,
      buildTargets: [],
      terminals: 1,
      onShowTerminal: vi.fn(),
    },
    notices: {
      askModeViolation: false,
      onDismissAskMode: vi.fn(),
      warning: null,
      onDismissWarning: vi.fn(),
      detached: null,
      onViewPrior: vi.fn(),
    },
    planMenu: { onExport: vi.fn(), onExportDocx: vi.fn(), onSaveObsidian: vi.fn(), onShare: vi.fn(), onInvite: null, onMove: vi.fn() },
    onShowTerminal: vi.fn(),
    children: <div data-body>the plan</div>,
    ...over,
  };
}
const render = (p: PlanPaneProps) => act(async () => root.render(<PlanPane {...p} />));

describe("PlanPane", () => {
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("draws the pane pose: Contents, the version, the ⋯, the body, and the footer's verbs — no Full screen or Close", async () => {
    await render(props());
    const head = q(".rl-plan-head")!;
    expect(head.getAttribute("data-pose")).toBe("pane");
    expect(head.textContent).toContain("Contents");
    expect(head.textContent).toContain("v2");
    expect(head.textContent).not.toContain("Full screen");
    expect(head.textContent).not.toContain("Close plan");
    expect(q('[aria-label="More plan actions"]')).not.toBeNull();
    expect(q("[data-body]")?.textContent).toBe("the plan");
    const foot = q(".rl-plan-foot")!;
    expect(foot.getAttribute("data-pose")).toBe("pane");
    expect(foot.textContent).toContain("Approve");
    expect(foot.textContent).toContain("Send marks to Claude");
  });

  it("points at the earlier version that holds last round's comments, as a notice", async () => {
    await render(props());
    expect(q(".rl-plan-notice, [data-plan-notices]")?.textContent ?? host.textContent).toContain("v1");
    expect(priorWithComments(session, 2)).toBe(1);
    expect(priorWithComments(session, 1)).toBe(null);
  });

  it("the version pill shows while an older version is on screen, and Go to latest is its one action", async () => {
    const onGoToLatest = vi.fn();
    await render(props({ viewing: { viewing: 1, latest: 2, onGoToLatest } }));
    expect(q("[data-version-pill]")?.textContent).toContain("Viewing v1");
    await act(async () => (q(".rl-version-pill-go") as HTMLButtonElement).click());
    expect(onGoToLatest).toHaveBeenCalledOnce();
  });

  it("a detached session reads as ended in the footer and offers the restore in the notices", async () => {
    await render(props({
      notices: {
        ...props().notices,
        detached: {
          restoring: false, status: null, failure: null,
          copy: { lede: "The session ended.", body: "Your plan is safe." },
          decision: { harness: "claude-code", legacy: false, chosen: false, label: "Claude Code" },
          onHarness: vi.fn(), blockers: [], onFix: vi.fn(async () => true), onRestore: vi.fn(), onCopyResume: vi.fn(), onDismiss: vi.fn(),
        },
      },
    }));
    expect(host.textContent).toContain("The session ended.");
    expect(q(".rl-plan-foot")?.textContent).toContain("session for this plan ended");
  });

  it("the ⋯ opens the shared popover: portalled out of the 28px header, fixed, with a height budget, and Escape closes it", async () => {
    await render(props());
    const more = q('[aria-label="More plan actions"]') as HTMLButtonElement;
    await act(async () => more.click());
    const panel = document.body.querySelector<HTMLElement>(".rl-plan-menu-panel");
    expect(panel).not.toBeNull();
    expect(host.contains(panel)).toBe(false);
    expect(panel!.style.position).toBe("fixed");
    expect(panel!.style.maxHeight).toMatch(/px$/);
    expect(panel!.querySelectorAll("[role=menuitem]").length).toBeGreaterThan(0);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(document.body.querySelector(".rl-plan-menu-panel")).toBeNull();
  });

  it("buildProgress reads a live run's totals", () => {
    expect(buildProgress(null)).toBe(null);
    expect(buildProgress({ totals: { plannedAgents: 11, done: 2, running: 1 } })).toEqual({ step: 3, of: 11 });
    expect(buildProgress({ totals: { plannedAgents: null, done: 2, running: 1 } })).toBe(null);
  });
});
