// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AskQuestion, ConvoAsk } from "../lib/convo/types";

const { answers } = vi.hoisted(() => ({ answers: [] as unknown[] }));
vi.mock("../lib/convo/api", () => ({ answerAsk: vi.fn(async (askId: string, answer: unknown) => void answers.push({ askId, answer })) }));
import { AskCard, answerFor } from "./AskCard";

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
