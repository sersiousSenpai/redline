// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The anchor display truth table: every kind of block a plan anchor can
// name, the selection that picks a step or a row inside one, an anchor the
// tree no longer has, and a section renamed between versions. The ids stay
// exactly what the parser minted; only the words shown change.
import { describe, expect, it } from "vitest";

import type { Paragraph, Section } from "../types";
import { anchorLabel, blockKind, createAnchorDisplay, sectionLabel } from "./anchorDisplay";

const para = (anchorId: string, blockId: string, markdown: string): Paragraph => ({
  anchorId,
  blockId,
  markdown,
  text: markdown,
});

const section = (
  anchorId: string,
  blockId: string,
  level: number,
  title: string,
  paragraphs: Paragraph[] = [],
  children: Section[] = [],
): Section => ({ anchorId, blockId, level, title, bodyMarkdown: "", paragraphs, children });

/** The shape parser.rs mints: one H1 wrapping the plan, H2 sections under
 *  it as `A.n`, blocks as `<section>.pN`. */
function plan(contextTitle = "Context", extraFirst: Section[] = []): Section[] {
  const n = extraFirst.length;
  const at = (i: number) => `A.${i + n}`;
  return [
    section("A", "blk-title", 1, "Dialcrown: fastest credible launch", [para("A.p1", "blk-lede", "A launch-first plan.")], [
      ...extraFirst,
      section(at(1), "blk-ctx", 2, contextTitle, [
        para(`${at(1)}.p1`, "blk-ctx1", "Benchmarks Dialcrown against the field."),
        para(`${at(1)}.p2`, "blk-ctx2", "Evaluates the agent platform."),
        para(`${at(1)}.p3`, "blk-ctx3", "The test throughout: the smallest release a customer can use and pay for."),
      ]),
      section(
        at(2),
        "blk-rel",
        2,
        "4. Releases",
        [
          para(`${at(2)}.p1`, "blk-ol", "1. Compile the build.\n2. Apply the migration.\n   - check the vault\n3. Deploy the Worker.\n4. Use one shared type-coercion helper.\n5. Ship it."),
          para(`${at(2)}.p2`, "blk-lead", "**Releases.** R1 is internal dogfooding."),
          para(`${at(2)}.p3`, "blk-table", "| Topic | Decision |\n|---|---|\n| First pilot | A law firm |\n| Voice agent | Fast-follow |"),
          para(`${at(2)}.p4`, "blk-code", "```ts\nconst x = 1;\n```"),
          para(`${at(2)}.p5`, "blk-quote", "> Keep both gates."),
          para(`${at(2)}.p6`, "blk-ul", "- **API keys:** rotate them\n- plain second item"),
          para(`${at(2)}.p7`, "blk-rule", "---"),
          para(`${at(2)}.p8`, "blk-after", "Then a closing paragraph."),
        ],
        [section(`${at(2)}.1`, "blk-rollback", 3, "Rollback", [para(`${at(2)}.1.p1`, "blk-rb1", "Revert the Worker.")])],
      ),
      section(at(3), "blk-rollout", 2, "4.2 Rollout plan", [
        para(`${at(3)}.p1`, "blk-later", "3. Third step first.\n4. Fourth step."),
      ]),
      section(at(4), "blk-long", 2, "A very long section title that keeps going on and on"),
    ]),
  ];
}

const v1 = plan();
const label = (target: Parameters<ReturnType<typeof createAnchorDisplay>["label"]>[0], sections = v1) =>
  createAnchorDisplay(sections).label(target);

describe("headings", () => {
  it.each([
    ["A", "Plan"],
    ["A.1", "Context"],
    ["A.2", "§4"],
    ["A.2.1", "Rollback"],
    ["A.3", "§4.2"],
    ["A.4", "A very long section title…"],
  ])("%s reads %s", (anchorId, expected) => {
    expect(label(anchorId)).toBe(expected);
  });

  it.each([
    ["4. Releases", "§4"],
    ["4) Releases", "§4"],
    ["4: Releases", "§4"],
    ["4.2 Rollout", "§4.2"],
    ["4.2. Rollout", "§4.2"],
    ["7 — Verification", "§7"],
    ["2026 roadmap", "2026 roadmap"],
    ["2026-10-17 updates", "2026-10-17 updates"],
    ["Phase 2: Build", "Phase 2: Build"],
    ["Decisions you made:", "Decisions you made"],
  ])("a heading titled %j reads %j", (title, expected) => {
    expect(sectionLabel(title)).toBe(expected);
  });

  it("a plan of several H1s numbers none of them as the title", () => {
    const flat = [section("A", "b1", 1, "Context", [para("A.p1", "b1p", "One.")]), section("B", "b2", 1, "2. Build")];
    expect(anchorLabel(flat, "A")).toBe("Context");
    expect(anchorLabel(flat, "A.p1")).toBe("Context · ¶1");
    expect(anchorLabel(flat, "B")).toBe("§2");
  });
});

describe("paragraphs", () => {
  it("count prose paragraphs within their section", () => {
    expect(label("A.1.p1")).toBe("Context · ¶1");
    expect(label("A.1.p3")).toBe("Context · ¶3");
  });

  it("skip the lists, tables and code around them when counting", () => {
    // p8 is the section's second paragraph: the lead-in paragraph counts,
    // the list, table, code, quote, bullets and rule between are not "¶".
    expect(label("A.2.p8")).toBe("§4 · ¶2");
  });

  it("a bold lead-in names its paragraph", () => {
    expect(label("A.2.p2")).toBe("§4 · releases");
  });

  it("directly under the title carry no section part", () => {
    expect(label("A.p1")).toBe("¶1");
  });

  it("in an unnumbered subsection read by its title", () => {
    expect(label("A.2.1.p1")).toBe("Rollback · ¶1");
  });
});

describe("numbered steps", () => {
  it("the line axis picks the step", () => {
    expect(label({ anchorId: "A.2.p1", selection: { subBlockId: "blk-ol.l4" } })).toBe("§4 · step 3");
    expect(label({ anchorId: "A.2.p1", selection: { subBlockId: "blk-ol.l5.w2-w3" } })).toBe("§4 · step 4");
  });

  it("a nested item belongs to the step it sits under", () => {
    // li 3 in document order is the nested "check the vault", under step 2.
    expect(label({ anchorId: "A.2.p1", selection: { subBlockId: "blk-ol.l3" } })).toBe("§4 · step 2");
  });

  it("the quoted text picks the step when there is no sub-block id", () => {
    expect(label({ anchorId: "A.2.p1", selection: { quotedText: "one shared  type-coercion" } })).toBe("§4 · step 4");
  });

  it("a list that starts at 3 counts from 3", () => {
    expect(label({ anchorId: "A.3.p1", selection: { quotedText: "Fourth step" } })).toBe("§4.2 · step 4");
  });

  it("a mark on the whole list, or one it can't place, reads steps", () => {
    expect(label("A.2.p1")).toBe("§4 · steps");
    expect(label({ anchorId: "A.2.p1", selection: { quotedText: "nowhere in this list" } })).toBe("§4 · steps");
  });
});

describe("table rows", () => {
  it("the line axis counts cells, header first", () => {
    // Two columns: cells 1–2 are the header, 3–4 the first row, 5–6 the second.
    expect(label({ anchorId: "A.2.p3", selection: { subBlockId: "blk-table.l6" } })).toBe("§4 · voice agent");
    expect(label({ anchorId: "A.2.p3", selection: { subBlockId: "blk-table.l3" } })).toBe("§4 · first pilot");
  });

  it("the header row is the table", () => {
    expect(label({ anchorId: "A.2.p3", selection: { subBlockId: "blk-table.l1" } })).toBe("§4 · table");
  });

  it("the quoted text finds the row", () => {
    expect(label({ anchorId: "A.2.p3", selection: { quotedText: "law firm" } })).toBe("§4 · first pilot");
  });

  it("with no selection the whole table", () => {
    expect(label("A.2.p3")).toBe("§4 · table");
  });
});

describe("other blocks", () => {
  it.each([
    ["A.2.p4", "§4 · code"],
    ["A.2.p5", "§4 · quote"],
    ["A.2.p7", "§4 · rule"],
    ["A.2.p6", "§4 · list"],
  ])("%s reads %s", (anchorId, expected) => {
    expect(label(anchorId)).toBe(expected);
  });

  it("a bullet item reads by its lead-in, an acronym kept, else by its number", () => {
    expect(label({ anchorId: "A.2.p6", selection: { subBlockId: "blk-ul.l1" } })).toBe("§4 · API keys");
    expect(label({ anchorId: "A.2.p6", selection: { quotedText: "plain second" } })).toBe("§4 · item 2");
  });

  it.each([
    ["Plain words.", "prose"],
    ["1. one", "ordered"],
    ["3) three", "ordered"],
    ["- one", "bullet"],
    ["* one", "bullet"],
    ["```\ncode\n```", "code"],
    ["~~~\ncode\n~~~", "code"],
    ["    indented code", "code"],
    ["> quote", "quote"],
    ["---", "rule"],
    ["***", "rule"],
    ["| a | b |\n|---|---|\n| 1 | 2 |", "table"],
    ["| not a table", "prose"],
  ])("%j is %s", (markdown, kind) => {
    expect(blockKind(markdown)).toBe(kind);
  });
});

describe("a missing anchor", () => {
  it("falls back to its section when the section is still there", () => {
    expect(label("A.1.p99")).toBe("Context");
  });

  it("falls back to Plan, never the raw id", () => {
    expect(label("Z.9.p9")).toBe("Plan");
    expect(label("")).toBe("Plan");
    expect(anchorLabel([], "A.1.p3")).toBe("Plan");
  });

  it("a block this revision lost, with something else at its position, shows only the section", () => {
    expect(label({ anchorId: "A.1.p3", blockId: "blk-gone" })).toBe("Context");
  });

  it("a stale block id with nothing at the position goes up to the section", () => {
    expect(label({ anchorId: "A.1.p9", blockId: "blk-gone" })).toBe("Context");
  });
});

describe("a section renamed across versions", () => {
  // v2 inserts a Summary ahead of Context and renames Context to Background:
  // the paragraph v1's comment was made on is now A.2.p3, same block id.
  const v2 = plan("Background", [section("A.1", "blk-summary", 2, "Summary", [para("A.1.p1", "blk-sum1", "Short.")])]);
  const comment = { anchorId: "A.1.p3", blockId: "blk-ctx3", selection: { quotedText: "the smallest release" } };

  it("against its own version, the label it was made with", () => {
    expect(label(comment, v1)).toBe("Context · ¶3");
  });

  it("against the later version, the block's new home and name", () => {
    expect(label(comment, v2)).toBe("Background · ¶3");
  });

  it("without the block id, the positional anchor is all there is", () => {
    expect(label("A.1.p3", v2)).toBe("Summary");
  });

  it("never touches the ids it reads", () => {
    const frozen = JSON.parse(JSON.stringify(comment));
    const tree = JSON.parse(JSON.stringify(v2));
    label(comment, tree);
    expect(comment).toEqual(frozen);
    expect(tree).toEqual(v2);
  });
});
