// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
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

  it("a session that ended: Restore, Copy command and Dismiss, each wired; the explanation is the tooltip", async () => {
    const d = detached();
    await render({ ...none, detached: d });
    expect(host.textContent).toContain("The session ended.");
    expect(host.textContent).not.toContain("Your plan is safe.");
    expect(host.querySelector<HTMLElement>(".rl-plan-notice")!.title).toContain("Your plan is safe.");
    const restore = [...host.querySelectorAll("button")].find((b) => b.textContent === "Restore")!;
    expect(restore.title).toContain("Your plan is safe.");
    await press("Restore");
    await press("Copy command");
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
    const restore = [...host.querySelectorAll("button")].find((b) => b.textContent === "Restore")!;
    expect(restore.disabled).toBe(true);
    expect(restore.title).toMatch(/^Claude CLI not found/);
    expect(host.textContent).toContain("Claude CLI not found");
  });

  it("a CLI still running in a kept terminal is not offered a Restore: it says where it runs", async () => {
    const show = vi.fn();
    const d = detached({ stillRunning: "claude 2" });
    await render({ ...none, detached: d, onShowTerminal: show });
    expect(host.textContent).toContain("Still running in claude 2");
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Restore")).toBe(false);
    await press("Open terminal");
    expect(show).toHaveBeenCalledTimes(1);
    expect(d.onRestore).not.toHaveBeenCalled();
  });

  it("restoring shows its progress and the way to its terminal; a failure offers Retry", async () => {
    const show = vi.fn();
    await render({ ...none, detached: detached({ restoring: true, status: "Resuming in the background" }), onShowTerminal: show });
    expect(host.textContent).toContain("Reopening this plan…");
    expect(host.textContent).toContain("Resuming in the background");
    await press("Show terminal");
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
    expect(host.textContent).not.toContain("returned a revised plan anyway");
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

describe("PlanNotices: an interrupted plan resuming on its own", () => {
  it("running: Resuming… attempt N of 3, the progress, and no Retry (one at a time)", async () => {
    await render({ ...none, onShowTerminal: vi.fn(), detached: detached({ restoring: true, status: "Reopening in the background…", auto: { phase: "resuming", attempt: 2, of: 3 } }) });
    expect(host.textContent).toContain("Resuming… attempt 2 of 3");
    expect(host.textContent).toContain("Reopening in the background…");
    expect(buttons()).toEqual(["Show terminal"]);
    expect(host.querySelector(".rl-plan-notice-mark .rl-spinner")).not.toBeNull();
  });

  it("between tries: when, why (on hover), and Retry / Copy command, each taking over", async () => {
    const onStopAuto = vi.fn();
    const d = detached({ failure: "The reopened session hasn't answered.", auto: { phase: "scheduled", attempt: 3, of: 3, inSeconds: 30 }, onStopAuto });
    await render({ ...none, detached: d });
    expect(host.textContent).toContain("Resuming… attempt 3 of 3");
    expect(host.querySelector<HTMLElement>(".rl-plan-notice")!.title).toContain("The reopened session hasn't answered.");
    expect(host.textContent).toContain("Trying again in 30 seconds.");
    await press("Retry");
    expect(d.onRestore).toHaveBeenCalledTimes(1);
    await press("Copy command");
    expect(d.onCopyResume).toHaveBeenCalledTimes(1);
    await press("Dismiss: Resuming… attempt 3 of 3");
    expect(d.onDismiss).toHaveBeenCalledTimes(1);
    // Copying and dismissing both stop the timer; Retry is a click,
    // which the restore machine itself reports.
    expect(onStopAuto).toHaveBeenCalledTimes(2);
  });

  it("given up: the failure with Retry and Copy, saying it tried", async () => {
    await render({ ...none, detached: detached({ failure: "boom", auto: { phase: "stopped", attempts: 3 } }) });
    expect(host.textContent).toContain("Couldn't reopen this plan.");
    expect(host.textContent).toContain("boom");
    expect(host.querySelector<HTMLElement>(".rl-plan-notice")!.title).toContain("tried 3 times on its own");
    expect(buttons()).toContain("Retry");
    expect(buttons()).toContain("Copy command");
  });
});

describe("PlanNotices: every notice is one 28 px strip (D41)", () => {
  // The detached notice was a five-line amber block with two large buttons;
  // every notice is now one strip: a mark, ONE text element, the actions, ×.
  const strips = () => [...host.querySelectorAll<HTMLElement>(".rl-plan-notice")];
  const shape = (el: HTMLElement) => [...el.children].map((c) => c.className.split(" ")[0]);
  const allowed = new Set(["rl-plan-notice-mark", "rl-plan-notice-text", "rl-plan-notice-actions", "rl-plan-notice-x"]);
  const states: [string, PlanNoticesProps][] = [
    ["detached", { ...none, detached: detached() }],
    ["detached, blocked", { ...none, detached: detached({ blockers: [{ id: "provider-missing", state: "blocked", label: "Claude CLI not found", detail: "" }] }) }],
    ["legacy", { ...none, detached: detached({ decision: { harness: "claude-code", legacy: true, chosen: false, label: "Claude Code" } }) }],
    ["restoring", { ...none, onShowTerminal: vi.fn(), detached: detached({ restoring: true, status: "Resuming in the background" }) }],
    ["failed", { ...none, detached: detached({ failure: "claude exited", auto: { phase: "stopped", attempts: 3 } }) }],
    ["auto, running", { ...none, detached: detached({ restoring: true, status: "…", auto: { phase: "resuming", attempt: 2, of: 3 } }) }],
    ["auto, scheduled", { ...none, detached: detached({ failure: "x", auto: { phase: "scheduled", attempt: 3, of: 3, inSeconds: 30 } }) }],
    ["ask, warning, prior", { ...none, askModeViolation: true, warning: { parseError: "bad", unmatchedIds: ["c-1"], unresolvedSubmittedIds: ["c-2"] }, prior: 2 }],
  ];
  it.each(states)("%s: a mark, one text element, actions and ×, nothing else", async (_name, p) => {
    await render(p);
    expect(strips().length).toBeGreaterThan(0);
    for (const el of strips()) {
      const kids = shape(el);
      expect(kids.filter((k) => k === "rl-plan-notice-text")).toHaveLength(1);
      expect(kids.every((k) => allowed.has(k))).toBe(true);
      // No paragraph inside: the text element holds the sentence and at
      // most one faint tail, and no block-level child anywhere.
      const text = el.querySelector(".rl-plan-notice-text")!;
      expect(text.querySelectorAll("*").length).toBeLessThanOrEqual(1);
      expect(el.querySelector("p, div, br, .rl-plan-notice-line")).toBeNull();
    }
  });

  it("needs you is the amber pulse; a restore in flight is the shared Spinner", async () => {
    await render({ ...none, detached: detached() });
    expect(host.querySelector(".rl-plan-notice-mark .rl-term-badge--needs")).not.toBeNull();
    await render({ ...none, detached: detached({ restoring: true }) });
    expect(host.querySelector(".rl-plan-notice-mark .rl-spinner")).not.toBeNull();
    expect(host.querySelector(".rl-term-badge--needs")).toBeNull();
  });

  it("the stylesheet holds the strip to one line of at most 28 px, 13 px text, a 16 px ×", () => {
    const css = readFileSync("src/components/plan/plan.css", "utf8");
    const rule = (sel: string) => {
      const m = new RegExp(`\\n${sel.replace(/[.[\]"=-]/g, (c) => `\\${c}`)} \\{([^}]*)\\}`).exec(css);
      expect(m, sel).not.toBeNull();
      return m![1];
    };
    const strip = rule(".rl-plan-notice");
    const px = /\bheight:\s*(\d+)px/.exec(strip);
    expect(Number(px?.[1])).toBeLessThanOrEqual(28);
    expect(strip).toContain("box-sizing: border-box");
    expect(strip).toContain("white-space: nowrap");
    expect(strip).toContain("overflow: hidden");
    expect(strip).toContain("font-size: var(--rl-text-row)"); // 13 px
    expect(rule(".rl-plan-notice-text")).toContain("text-overflow: ellipsis");
    expect(readFileSync("src/components/plan/NoticeStrip.tsx", "utf8")).toContain("<X size={16} aria-hidden />");
    expect(readFileSync("src/components/plan/PlanNotices.tsx", "utf8")).not.toContain("rl-plan-notice-line");
  });

  it("under 480 px of strip, Copy command folds into a ▾ menu beside Restore", async () => {
    const css = readFileSync("src/components/plan/plan.css", "utf8");
    expect(css).toMatch(/\.rl-plan-notices \{[^}]*container-type: inline-size/);
    const fold = css.slice(css.indexOf("@container (max-width: 480px)"));
    expect(fold).toMatch(/^@container \(max-width: 480px\) \{\s*\.rl-plan-notice-wide \{\s*display: none;/);
    expect(fold).toMatch(/\.rl-plan-notice-x\.rl-plan-notice-more \{\s*display: grid;/);
    const d = detached();
    await render({ ...none, detached: d });
    await press("More restore actions");
    const item = [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((b) => b.textContent === "Copy resume command")!;
    await act(async () => item.click());
    expect(d.onCopyResume).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[role=menuitem]")).toBeNull();
  });
});
