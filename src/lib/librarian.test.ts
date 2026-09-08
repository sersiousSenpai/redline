// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  actionHint,
  categoryLabel,
  categoryTone,
  coerceRun,
  parseStoredRun,
} from "./librarian";

describe("coerceRun", () => {
  it("accepts a wire reply, stamps the fallback timestamp, and re-ranks 1..N", () => {
    const run = coerceRun(
      {
        summary: "412 events unstructured; one stalled review.",
        checklist: [
          { priority: 5, category: "bulging_branch", title: "1 branch bulging", detail: "140 links under one class.", action: "organize", count: 1 },
          { priority: 5, category: "stalled_review", title: "15 comments unresolved", detail: "" },
        ],
      },
      1754400000000,
    );
    expect(run).not.toBeNull();
    expect(run!.ranAtMs).toBe(1754400000000);
    expect(run!.checklist.map((c) => c.priority)).toEqual([1, 2]);
    expect(run!.checklist[0].action).toBe("organize");
    expect(run!.checklist[0].count).toBe(1);
  });

  it("drops titleless items, defaults categories, and normalizes action 'none' away", () => {
    const run = coerceRun(
      {
        checklist: [
          { category: "mission", detail: "no title so dropped" },
          { title: "   ", detail: "blank title dropped" },
          { title: "Real item", action: "none", count: 7.9 },
          { title: "Odd shapes", category: "", action: "   ", count: "12" },
        ],
      },
      1,
    );
    expect(run!.checklist).toHaveLength(2);
    expect(run!.checklist[0]).toMatchObject({
      title: "Real item",
      category: "unstructured_backlog",
      action: undefined,
      count: 7, // truncated, mirroring the i64 on the Rust side
    });
    // Non-numeric counts and blank actions vanish rather than render as junk.
    expect(run!.checklist[1].count).toBeUndefined();
    expect(run!.checklist[1].action).toBeUndefined();
  });

  it("rejects non-objects and values with no usable timestamp", () => {
    expect(coerceRun(null, 1)).toBeNull();
    expect(coerceRun([1, 2], 1)).toBeNull();
    expect(coerceRun({ summary: "no timestamp anywhere", checklist: [] })).toBeNull();
    // A stored ranAtMs wins over the fallback.
    const run = coerceRun({ ranAtMs: 42, checklist: [] }, 99);
    expect(run!.ranAtMs).toBe(42);
  });
});

describe("parseStoredRun", () => {
  it("round-trips a stored run and never throws on garbage", () => {
    const stored = JSON.stringify({
      summary: "All clear.",
      checklist: [{ priority: 3, category: "mission", title: "1 stale mission" }],
      ranAtMs: 1754400000000,
    });
    const run = parseStoredRun(stored);
    expect(run!.summary).toBe("All clear.");
    expect(run!.checklist[0].priority).toBe(1);
    expect(parseStoredRun(null)).toBeNull();
    expect(parseStoredRun("not json {")).toBeNull();
    expect(parseStoredRun('"a bare string"')).toBeNull();
  });
});

describe("category vocabulary", () => {
  it("labels the known categories and prettifies unknown snake_case", () => {
    expect(categoryLabel("bulging_branch")).toBe("Bulging branch");
    // B3 retired the category; an old stored run's label prettifies, nothing throws.
    expect(categoryLabel("held_proposal")).toBe("Held proposal");
    expect(categoryLabel("unstructured_backlog")).toBe("Backlog");
    expect(categoryLabel("brand_new_signal")).toBe("Brand new signal");
    expect(categoryLabel("")).toBe("Item");
  });

  it("tones: stalled warning, stewardship info, unknown (and the retired held_proposal) muted", () => {
    expect(categoryTone("held_proposal")).toBe("var(--color-ink-muted)");
    expect(categoryTone("stalled_review")).toBe("var(--color-warning)");
    expect(categoryTone("unstructured_backlog")).toBe("var(--color-info)");
    expect(categoryTone("something_else")).toBe("var(--color-ink-muted)");
  });
});

describe("actionHint", () => {
  it("maps only in-surface navigations — never a dispatch", () => {
    expect(actionHint("organize")).toEqual({
      label: "Organize in the Catalog",
      target: "catalog",
    });
    // B3: there is nothing to review — the gardener's queue takes no verdict.
    expect(actionHint("review_proposals")).toBeNull();
    expect(actionHint("open_session")).toBeNull();
    expect(actionHint("export_bundle")).toBeNull();
    expect(actionHint(undefined)).toBeNull();
  });
});
