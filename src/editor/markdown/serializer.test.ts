// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { planSchema } from "./schema";
import { planDocToMarkdown } from "./serializer";

/**
 * The `codeBlock` case must accept tracked changes just like inline prose does:
 * a proposed deletion (`rl_del`) contributes nothing, a proposed insertion
 * (`rl_ins`) contributes its text as accepted, and code content stays literal
 * (no markdown delimiters). This is the counterpart to the schema change that
 * lets strikes land inside fenced blocks in the first place — see
 * `schema.test.ts` and `CodeBlockView.richCodeBlock`.
 */
describe("serializer — tracked changes inside code blocks", () => {
  const s = planSchema();
  const del = s.marks.rl_del.create({ status: "pending" });
  const ins = s.marks.rl_ins.create({ status: "pending" });

  it("drops struck code text and keeps inserted text, with no delimiters added", () => {
    const cb = s.nodes.codeBlock.create({ language: "rust" }, [
      s.text("keep "),
      s.text("struck", [del]),
      s.text(" ins", [ins]),
    ]);
    const doc = s.nodes.doc.create(null, cb);
    expect(planDocToMarkdown(doc)).toBe("```rust\nkeep  ins\n```\n");
  });

  it("serializes a plain (unmarked) code block byte-identically to its raw text", () => {
    const cb = s.nodes.codeBlock.create(
      { language: "python" },
      s.text("print('hi')"),
    );
    const doc = s.nodes.doc.create(null, cb);
    expect(planDocToMarkdown(doc)).toBe("```python\nprint('hi')\n```\n");
  });
});
