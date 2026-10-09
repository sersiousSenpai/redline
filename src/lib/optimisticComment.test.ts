// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Comment, Revision, ReviewSession } from "../types";
import { withOptimisticComment } from "./optimisticComment";

function comment(id: string): Comment {
  return { id, type: "feedback", anchorId: "s1p1", body: id, createdAt: 0, status: "draft" };
}

function revision(versionNumber: number, comments: Comment[]): Revision {
  return {
    versionNumber,
    receivedAt: versionNumber,
    rawPlanMarkdown: "",
    sections: [],
    comments,
    threadStart: false,
    restored: false,
  };
}

function session(revisions: Revision[], sessionId = "s-1"): ReviewSession {
  return {
    sessionId,
    projectPath: "/p",
    projectName: "p",
    createdAt: 0,
    revisions,
    status: "in_review",
    attachState: "held",
  };
}

describe("withOptimisticComment", () => {
  it("appends the saved comment to the latest revision", () => {
    const v1 = revision(1, [comment("c-001")]);
    const v2 = revision(2, [comment("c-002")]);
    const next = withOptimisticComment(session([v1, v2]), "s-1", comment("c-003"));
    expect(next?.revisions.map((r) => r.comments.map((c) => c.id))).toEqual([
      ["c-001"],
      ["c-002", "c-003"],
    ]);
  });

  it("lands the first comment on a fresh revision", () => {
    const next = withOptimisticComment(session([revision(1, [])]), "s-1", comment("c-001"));
    expect(next?.revisions[0].comments.map((c) => c.id)).toEqual(["c-001"]);
  });

  it("is immutable: earlier revisions keep their identity, the latest is new", () => {
    const v1 = revision(1, []);
    const v2 = revision(2, []);
    const before = session([v1, v2]);
    const next = withOptimisticComment(before, "s-1", comment("c-001"))!;
    expect(next).not.toBe(before);
    expect(next.revisions[0]).toBe(v1);
    expect(next.revisions[1]).not.toBe(v2);
    expect(next.revisions[1].sections).toBe(v2.sections);
    expect(v2.comments).toEqual([]);
  });

  it("is idempotent on an id the session already has, in any revision", () => {
    // The reload can land before the optimistic insert does.
    const before = session([revision(1, [comment("c-001")]), revision(2, [])]);
    expect(withOptimisticComment(before, "s-1", comment("c-001"))).toBe(before);
    const once = withOptimisticComment(session([revision(1, [])]), "s-1", comment("c-002"));
    expect(withOptimisticComment(once, "s-1", comment("c-002"))).toBe(once);
  });

  it("leaves a different session alone", () => {
    const other = session([revision(1, [])], "s-2");
    expect(withOptimisticComment(other, "s-1", comment("c-001"))).toBe(other);
  });

  it("is a no-op with no session or no revisions", () => {
    expect(withOptimisticComment(null, "s-1", comment("c-001"))).toBeNull();
    const empty = session([]);
    expect(withOptimisticComment(empty, "s-1", comment("c-001"))).toBe(empty);
  });
});

// The wiring is the fix: the helper only helps if App applies it in the same
// tick that closes the composer, and the first card only lands in that frame
// if its lazy chunk was warmed before Save.
describe("App saves a comment without a gap", () => {
  const app = readFileSync(join(process.cwd(), "src", "App.tsx"), "utf8");
  const body = (from: string, to: string) => {
    const start = app.indexOf(from);
    expect(start, from).toBeGreaterThan(-1);
    const end = app.indexOf(to, start);
    expect(end, to).toBeGreaterThan(start);
    return app.slice(start, end);
  };

  it("inserts the saved comment before closing the composer, with no await between", () => {
    const submit = body("const submitComment = async", "const addEditorComment");
    const insert = submit.indexOf("withOptimisticComment(prev, sessionId, saved)");
    const close = submit.indexOf("setComposing(null)");
    expect(insert).toBeGreaterThan(submit.indexOf('invoke<Comment>("add_comment"'));
    expect(close).toBeGreaterThan(insert);
    expect(submit.slice(insert, close)).not.toContain("await");
  });

  it("warms the comment card's chunk when the composer opens", () => {
    expect(app).toMatch(/const CommentCard = lazy\(commentCardChunk\.load\)/);
    expect(body("const beginCompose = ", "setComposing({")).toContain("commentCardChunk.warm()");
  });
});
