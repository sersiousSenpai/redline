// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AskQuestion, ConvoAsk } from "./convo/types";

const { answers } = vi.hoisted(() => ({ answers: [] as unknown[] }));
vi.mock("./convo/api", () => ({ answerAsk: vi.fn(async (askId: string, answer: unknown) => void answers.push({ askId, answer })) }));
import { AskCard, StoppedCard, answerFor } from "./AskCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  answers.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const single: AskQuestion = { question: "Which?", options: [{ label: "A" }, { label: "B" }] };
const multi: AskQuestion = { question: "Also?", multiSelect: true, options: [{ label: "X" }, { label: "Y" }] };

describe("answerFor: what updatedInput.answers carries", () => {
  it.each<[string, AskQuestion, { labels: string[]; other: string } | undefined, string | null]>([
    ["nothing picked", single, undefined, null],
    ["one option", single, { labels: ["B"], other: "" }, "B"],
    ["your own words", single, { labels: [], other: "  neither  " }, "neither"],
    ["an option wins over stale words (single)", single, { labels: ["A"], other: "x" }, "A"],
    ["several, comma-joined", multi, { labels: ["X", "Y"], other: "" }, "X, Y"],
    ["several plus words", multi, { labels: ["Y"], other: "Z" }, "Y, Z"],
    ["blank words are nothing", multi, { labels: [], other: "   " }, null],
  ])("%s", (_label, question, pick, answer) => {
    expect(answerFor(question, pick)).toBe(answer);
  });
});

describe("AskCard", () => {
  const permission = (over: Partial<ConvoAsk> = {}): ConvoAsk => ({ askId: "a1", kind: "permission", toolName: "Bash", summary: "rm -rf build", openedAt: 0, ...over });

  it("a permission with no suggestions has no Always", async () => {
    await act(async () => root.render(<AskCard ask={permission()} onShowTerminal={() => {}} />));
    expect([...host.querySelectorAll(".rl-ask-btn")].map((b) => b.textContent)).toEqual(["Allow once", "Deny"]);
  });

  it("Always shows its rule and answers {kind: always}", async () => {
    await act(async () => root.render(<AskCard ask={permission({ suggestions: [{}], rule: "Always allow Bash(rm:*)" })} onShowTerminal={() => {}} />));
    expect(host.querySelector(".rl-ask-rule")?.textContent).toBe("Always: Always allow Bash(rm:*)");
    await act(async () => (host.querySelectorAll(".rl-ask-btn")[1] as HTMLButtonElement).click());
    expect(answers).toEqual([{ askId: "a1", answer: { kind: "always" } }]);
  });

  it("ExitPlanMode's leave to build reads as the CLI's proceed question, with its three answers", async () => {
    await act(async () => root.render(<AskCard ask={permission({ toolName: "ExitPlanMode", summary: "<!-- REDLINE_RESTORE:x -->", suggestions: [{}] })} onShowTerminal={() => {}} />));
    // A sentence and its answers: the one notice strip, not a card (D42).
    expect(host.querySelector(".rl-ask-card")).toBeNull();
    expect(host.querySelector(".rl-plan-notice-text")?.textContent).toBe("Ready to build this plan?");
    expect(host.textContent).not.toContain("REDLINE_RESTORE");
    expect([...host.querySelectorAll(".rl-plan-notice-btn")].map((b) => b.textContent)).toEqual(["Yes, build", "Yes, accept edits", "Keep planning", "Answer in terminal"]);
    await act(async () => (host.querySelectorAll(".rl-plan-notice-btn")[0] as HTMLButtonElement).click());
    expect(answers).toEqual([{ askId: "a1", answer: { kind: "allow" } }]);
  });

  it("Answer in terminal releases the hook, then shows the terminal", async () => {
    const onShowTerminal = vi.fn();
    await act(async () => root.render(<AskCard ask={permission()} onShowTerminal={onShowTerminal} />));
    await act(async () => (host.querySelector(".rl-ask-terminal") as HTMLButtonElement).click());
    expect(answers).toEqual([{ askId: "a1", answer: { kind: "terminal" } }]);
    expect(onShowTerminal).toHaveBeenCalledTimes(1);
  });

  it("a question can't be answered until every question has an answer", async () => {
    const ask: ConvoAsk = { askId: "q1", kind: "question", toolName: "AskUserQuestion", summary: "", openedAt: 0, questions: [single, multi] };
    await act(async () => root.render(<AskCard ask={ask} onShowTerminal={() => {}} />));
    const answer = () => host.querySelector(".rl-ask-btn[data-primary]") as HTMLButtonElement;
    expect(answer().disabled).toBe(true);
    await act(async () => (host.querySelectorAll(".rl-ask-option")[0] as HTMLButtonElement).click());
    expect(answer().disabled).toBe(true);
    await act(async () => (host.querySelectorAll(".rl-ask-option")[3] as HTMLButtonElement).click());
    expect(answer().disabled).toBe(false);
    await act(async () => answer().click());
    expect(answers).toEqual([{ askId: "q1", answer: { kind: "answers", answers: { "Which?": "A", "Also?": "Y" } } }]);
  });
});

describe("StoppedCard: an agent that died is never a bare needs-you", () => {
  it("offers Retry mid-build, and the terminal", async () => {
    const onRetry = vi.fn(), onShowTerminal = vi.fn();
    await act(async () => root.render(<StoppedCard harness="Claude" building onRetry={onRetry} onShowTerminal={onShowTerminal} />));
    expect(host.textContent).toContain("Claude stopped before the build finished");
    // The notice strip: amber pulse, one sentence, text actions — no box, no
    // filled button (D42).
    expect(host.querySelector(".rl-ask-card, .rl-ask-btn")).toBeNull();
    expect(host.querySelector(".rl-plan-notice .rl-plan-notice-mark .rl-term-badge--needs")).not.toBeNull();
    expect([...host.querySelectorAll(".rl-plan-notice-btn")].map((b) => b.textContent)).toEqual(["Retry", "Open terminal"]);
    const retry = [...host.querySelectorAll("button")].find((b) => b.textContent === "Retry")!;
    await act(async () => retry.click());
    expect(onRetry).toHaveBeenCalledOnce();
    expect(retry.textContent).toBe("Resuming…");
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Open terminal")!.click());
    expect(onShowTerminal).toHaveBeenCalledOnce();
  });

  it("outside a build there is no Retry (a plan in review has its own Restore)", async () => {
    await act(async () => root.render(<StoppedCard harness="Claude" building={false} onRetry={null} onShowTerminal={() => {}} />));
    expect(host.textContent).toContain("Claude stopped");
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Retry")).toBe(false);
  });
});
