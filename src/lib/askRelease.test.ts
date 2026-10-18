// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import type { ConvoAsk } from "./convo/types";
import { questionsToRelease } from "./askRelease";

const ask = (askId: string, kind: ConvoAsk["kind"]): ConvoAsk => ({ askId, kind, toolName: kind === "question" ? "AskUserQuestion" : "Bash", summary: "", openedAt: 1 });

describe("questionsToRelease", () => {
  it("releases open questions, never permission asks, each once", () => {
    const open = [ask("q1", "question"), ask("p1", "permission"), ask("q2", "question")];
    expect(questionsToRelease(open, new Set())).toEqual(["q1", "q2"]);
    expect(questionsToRelease(open, new Set(["q1"]))).toEqual(["q2"]);
    expect(questionsToRelease([ask("p1", "permission")], new Set())).toEqual([]);
    expect(questionsToRelease([], new Set())).toEqual([]);
  });
});
