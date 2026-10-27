// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Comment } from "../../types";
import { hasNotices, PlanNotices, type PlanNoticesProps } from "./PlanNotices";
import { footerTally } from "./PlanPanelFooter";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const none: PlanNoticesProps = {
  askModeViolation: false,
  onDismissAskMode: vi.fn(),
  warning: null,
  onDismissWarning: vi.fn(),
  detached: null,
  prior: null,
  onViewPrior: vi.fn(),
  onShowTerminal: null,
};
const detached = (over: Partial<NonNullable<PlanNoticesProps["detached"]>> = {}): NonNullable<PlanNoticesProps["detached"]> => ({
  restoring: false,
  status: null,
  failure: null,
  copy: { lede: "The session ended.", body: "Your plan is safe." },
  decision: { harness: "claude-code", legacy: false, chosen: false, label: "Claude Code" },
  onHarness: vi.fn(),
  blockers: [],
  onFix: vi.fn(async () => true),
  onRestore: vi.fn(),
  onCopyResume: vi.fn(),
  onDismiss: vi.fn(),
  ...over,
});
const render = (p: PlanNoticesProps) => act(async () => root.render(<PlanNotices {...p} />));
const buttons = () => [...host.querySelectorAll("button")].map((b) => b.textContent || b.getAttribute("aria-label"));
const press = (label: string) => act(async () => [...host.querySelectorAll("button")].find((b) => (b.textContent || b.getAttribute("aria-label")) === label)!.click());

describe("PlanNotices: classic's plan-pane notices in flow", () => {
  it("draws nothing when there is nothing to say", async () => {
    expect(hasNotices(none)).toBe(false);
    await render(none);
    expect(host.innerHTML).toBe("");
  });

  it("a session that ended: Restore, Copy resume command and Dismiss, each wired", async () => {
    const d = detached();
    await render({ ...none, detached: d });
    expect(host.textContent).toContain("The session ended.");
    await press("Restore plan session");
    await press("Copy resume command");
    await press("Dismiss: The session ended.");
    expect([d.onRestore, d.onCopyResume, d.onDismiss].map((f) => (f as ReturnType<typeof vi.fn>).mock.calls.length)).toEqual([1, 1, 1]);
    expect(buttons()).not.toContain("Claude Code");
  });

  it("a legacy plan asks which harness wrote it", async () => {
    const d = detached({ decision: { harness: "claude-code", legacy: true, chosen: false, label: "Claude Code" } });
    await render({ ...none, detached: d });
    await press("Codex");
    expect(d.onHarness).toHaveBeenCalledWith("codex");
  });

  it("a blocker disables the restore and says why", async () => {
    await render({ ...none, detached: detached({ blockers: [{ id: "provider-missing", state: "blocked", label: "Claude CLI not found", detail: "" }] }) });
    const restore = [...host.querySelectorAll("button")].find((b) => b.textContent === "Restore plan session")!;
    expect(restore.disabled).toBe(true);
    expect(restore.title).toMatch(/^Claude CLI not found/);
    expect(host.textContent).toContain("Claude CLI not found");
  });

  it("restoring shows its progress and the way to its terminal; a failure offers Retry", async () => {
    const show = vi.fn();
    await render({ ...none, detached: detached({ restoring: true, status: "Resuming in the background" }), onShowTerminal: show });
    expect(host.textContent).toContain("Reopening this plan…");
    expect(host.textContent).toContain("Resuming in the background");
    await press("Show the terminal");
    expect(show).toHaveBeenCalledTimes(1);
    const d = detached({ failure: "claude exited" });
    await render({ ...none, detached: d });
    await press("Retry");
    expect(d.onRestore).toHaveBeenCalledTimes(1);
  });

  it("the ask-mode and resolution notices dismiss; the clean slate points at its version", async () => {
    const p = { ...none, askModeViolation: true, warning: { parseError: "bad json", unmatchedIds: ["c-9"], unresolvedSubmittedIds: [] }, prior: 2 };
    await render(p);
    expect(host.textContent).toContain("Plan modified during Ask");
    expect(host.textContent).toContain("could not be parsed: bad json");
    expect(host.textContent).toContain("unknown comments: c-9");
    await press("Dismiss: Plan modified during Ask");
    await press("Dismiss: Resolution block issue");
    await press("Review them");
    expect(p.onDismissAskMode).toHaveBeenCalled();
    expect(p.onDismissWarning).toHaveBeenCalled();
    expect(p.onViewPrior).toHaveBeenCalledWith(2);
  });
});

describe("footerTally: what classic's footer read off the comments", () => {
  const c = (id: string, over: Partial<Comment>): Comment => ({ id, type: "feedback", anchorId: "A", body: "x", createdAt: 1, status: "draft", ...over });
  it("counts what the next Send carries, by kind", () => {
    const t = footerTally([c("1", {}), c("2", { type: "question" }), c("3", { type: "edit" }), c("4", { status: "accepted" })], false);
    expect(t).toMatchObject({ marks: 3, askOnly: false, tally: "3 marks to send · 1 edit · 1 feedback · 1 question", allHandled: false });
  });
  it("a batch of plain questions only asks", () => {
    expect(footerTally([c("1", { type: "question" }), c("2", { type: "question" })], false)).toMatchObject({ askOnly: true, tally: "2 marks to send · 2 questions" });
    expect(footerTally([c("1", { type: "question", actionable: true })], false).askOnly).toBe(false);
  });
  it("every resolution handled: nothing pending or awaiting a verdict, something settled, nothing in flight", () => {
    expect(footerTally([c("1", { status: "accepted" })], false).allHandled).toBe(true);
    expect(footerTally([c("1", { status: "accepted" }), c("2", { status: "resolved" })], false).allHandled).toBe(false);
    expect(footerTally([c("1", { status: "accepted" })], true).allHandled).toBe(false);
    expect(footerTally([], false).allHandled).toBe(false);
  });
});
