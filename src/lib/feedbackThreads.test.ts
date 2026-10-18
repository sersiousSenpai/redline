// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import type { Comment, ReviewSession, Revision } from "../types";
import {
  commentTarget,
  feedbackSummary,
  initials,
  isUndecidedSuggestion,
  isVoiceNote,
  noteInitials,
  noteText,
  orderFeedback,
  revisionAt,
  statusNote,
  summarize,
} from "./feedbackThreads";

const comment = (over: Partial<Comment>): Comment => ({
  id: "c-001",
  type: "feedback",
  anchorId: "A.1",
  body: "note",
  createdAt: 1,
  status: "draft",
  ...over,
});

const resolution = (v: number) => ({ body: "Done.", appearedInVersion: v, acceptedAt: null });

const revision = (versionNumber: number, comments: Comment[]): Revision => ({
  versionNumber,
  receivedAt: versionNumber,
  rawPlanMarkdown: "",
  sections: [
    {
      anchorId: "A",
      blockId: "b-a",
      level: 1,
      title: "Plan",
      bodyMarkdown: "",
      paragraphs: [],
      children: [
        { anchorId: "A.1", blockId: "b-1", level: 2, title: "Context", bodyMarkdown: "", paragraphs: [{ anchorId: "A.1.p1", blockId: "b-1p1", markdown: "One.", text: "One." }], children: [] },
        { anchorId: "A.2", blockId: "b-2", level: 2, title: "4. Releases", bodyMarkdown: "", paragraphs: [], children: [] },
      ],
    },
  ],
  comments,
  threadStart: versionNumber === 1,
  restored: false,
});

const session = (revisions: Revision[]): ReviewSession => ({
  sessionId: "s-1",
  projectPath: "/p",
  projectName: "p",
  createdAt: 1,
  revisions,
  status: "in_review",
  attachState: "idle",
});

describe("the revision shown", () => {
  const s = session([revision(1, []), revision(2, [])]);
  it("is the version asked for", () => expect(revisionAt(s, 1)?.versionNumber).toBe(1));
  it("is the latest when the version is unknown", () => expect(revisionAt(s, 9)?.versionNumber).toBe(2));
  it("is nothing without a session", () => expect(revisionAt(null, 1)).toBeNull());
});

describe("the tab's count and All resolved", () => {
  it("counts every thread and calls them all resolved once each has an answer", () => {
    const all = [
      comment({ id: "c-1", status: "resolved", resolution: resolution(2) }),
      comment({ id: "c-2", status: "accepted", resolution: resolution(2) }),
      comment({ id: "c-3", status: "withdrawn" }),
    ];
    expect(summarize(all)).toEqual({ count: 3, open: 1, allResolved: true });
  });

  it.each(["draft", "submitted", "reopened"] as const)("a %s thread keeps it from all resolved", (status) => {
    expect(summarize([comment({ status: "accepted" }), comment({ id: "c-2", status })]).allResolved).toBe(false);
  });

  it("an empty revision is not all resolved", () => {
    expect(summarize([])).toEqual({ count: 0, open: 0, allResolved: false });
  });

  it("reads the revision the panel shows", () => {
    const s = session([revision(1, [comment({ status: "accepted" }), comment({ id: "c-2", status: "accepted" })]), revision(2, [])]);
    expect(feedbackSummary(s, 1).count).toBe(2);
    expect(feedbackSummary(s, 2).count).toBe(0);
  });
});

describe("order", () => {
  it("open threads first, then resolved; each in the order they were written", () => {
    const { open, settled } = orderFeedback([
      comment({ id: "late", anchorId: "A.2", status: "resolved", createdAt: 5 }),
      comment({ id: "done-late", anchorId: "A.1", status: "accepted", createdAt: 7 }),
      comment({ id: "done-early", anchorId: "A.2", status: "accepted", createdAt: 3 }),
      comment({ id: "early", anchorId: "A.1.p1", status: "draft", createdAt: 1 }),
      comment({ id: "withdrawn", anchorId: "Z.9", status: "withdrawn", createdAt: 1 }),
    ]);
    expect(open.map((c) => c.id)).toEqual(["early", "late"]);
    expect(settled.map((c) => c.id)).toEqual(["withdrawn", "done-early", "done-late"]);
  });

  it("labels a structural comment by its own block when it names no other", () => {
    expect(commentTarget(comment({ structural: { op: "delete", blockId: "b-x" } })).blockId).toBe("b-x");
    expect(commentTarget(comment({ blockId: "b-y", structural: { op: "delete", blockId: "b-x" } })).blockId).toBe("b-y");
  });
});

describe("status line", () => {
  it.each([
    [{ status: "resolved", resolution: resolution(2) }, "Resolved in v2", "build"],
    [{ status: "accepted", resolution: resolution(3) }, "Resolved in v3", "build"],
    [{ status: "reopened" }, "Reopened", "redline"],
    [{ status: "reopened", type: "question", actionable: true }, "Change pending", "redline"],
    [{ status: "submitted" }, "With Claude", "muted"],
    [{ status: "submitted", reopenNote: "again" }, "Follow-up with Claude", "muted"],
    [{ status: "draft" }, "Not sent yet", "muted"],
    [{ status: "withdrawn" }, "Withdrawn", "muted"],
  ] as const)("%j reads %s", (over, text, tone) => {
    expect(statusNote(comment(over as Partial<Comment>))).toEqual({ text, tone });
  });

  it("names the plan's own harness", () => {
    expect(statusNote(comment({ status: "submitted" }), "codex").text).toBe("With Codex");
  });

  it("an agent's undecided suggestion says whose it is", () => {
    const c = comment({ type: "edit", author: "agent-1", status: "draft", edit: { original: "a", revised: "b" } });
    expect(isUndecidedSuggestion(c)).toBe(true);
    expect(statusNote(c).text).toBe("Suggested by agent-1");
  });
});

describe("provenance and text", () => {
  it("a voice note is one the voice agent wrote", () => {
    expect(isVoiceNote(comment({ author: "voice" }))).toBe(true);
    expect(isVoiceNote(comment({}))).toBe(false);
    // Voice captures are never mistaken for an agent's suggested edit.
    expect(isUndecidedSuggestion(comment({ author: "voice", type: "edit", edit: { original: "a", revised: "b" } }))).toBe(false);
  });

  it("the note is the body, or the edit, or the structural change", () => {
    expect(noteText(comment({ body: "  two\n words " }))).toBe("two words");
    expect(noteText(comment({ body: "(edit)", edit: { original: "a", revised: "b" } }))).toBe('"a" → "b"');
    expect(noteText(comment({ body: "", structural: { op: "delete", blockId: "b", markdown: "Gone\nblock" } }))).toBe("Gone block");
    expect(noteText(comment({ body: "", structural: { op: "move", blockId: "b" } }))).toBe("Block move");
  });

  it.each([
    ["Imani Moore", "IM"],
    ["imani", "IM"],
    ["Ana María de la Cruz", "AC"],
    ["  ", ""],
  ])("initials of %j are %j", (name, expected) => {
    expect(initials(name)).toBe(expected);
  });

  it("a note's initials: the external reviewer, else the owner, else Me", () => {
    expect(noteInitials(comment({ reviewer: "John Doe" }), "Imani Moore")).toBe("JD");
    expect(noteInitials(comment({}), "Imani Moore")).toBe("IM");
    expect(noteInitials(comment({}))).toBe("Me");
  });
});
