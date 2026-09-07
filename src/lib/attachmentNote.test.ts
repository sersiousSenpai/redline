// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import {
  attachmentLines,
  formatBytes,
  transcriptNote,
} from "./attachmentNote";
import type { CommentAttachment, ThreadMessage } from "../types";

const msg = (
  role: string,
  body: string,
  attachments?: CommentAttachment[],
): ThreadMessage => ({
  id: `m-${role}-${body}`,
  sessionId: "s1",
  commentId: "c-001",
  role,
  body,
  status: "complete",
  createdAt: 0,
  attachments,
});

const shot: CommentAttachment = {
  path: "/data/attachments/s1/ui-mock.png",
  name: "ui-mock.png",
  mime: "image/png",
  bytes: 4096,
};

describe("attachmentLines", () => {
  it("is empty for a turn that carried no files", () => {
    expect(attachmentLines(undefined)).toBe("");
    expect(attachmentLines([])).toBe("");
  });

  it("names each file with an absolute path and its type", () => {
    const out = attachmentLines([shot]);
    expect(out).toContain("/data/attachments/s1/ui-mock.png");
    expect(out).toContain("(image/png)");
    expect(out).toContain("read it");
  });
});

describe("transcriptNote", () => {
  it("keeps the pre-attachment rider byte-identical", () => {
    // The overwhelmingly common case: no files anywhere in the discussion.
    // Its rider must not change shape, or every existing thread's payload
    // would churn.
    const note = transcriptNote([
      msg("user", "Why this order?"),
      msg("assistant", "Because of the dependency."),
    ]);
    expect(note).toBe(
      "Following a discussion with Claude:\n\n" +
        "Reviewer: Why this order?\n\n" +
        "Claude: Because of the dependency.",
    );
  });

  it("names a file dropped into a follow-up so it reaches the payload", () => {
    // The rider is plain text folded into the comment's note, so this line is
    // the ONLY way the path travels into the next Revise.
    const note = transcriptNote([
      msg("user", "Make it look like this.", [shot]),
      msg("assistant", "Understood."),
    ]);
    expect(note).toContain("Reviewer: Make it look like this.");
    expect(note).toContain("/data/attachments/s1/ui-mock.png");
    expect(note).toContain("Claude: Understood.");
  });

  it("attributes each turn and trims its body", () => {
    const note = transcriptNote([msg("user", "  padded  ")]);
    expect(note).toContain("Reviewer: padded");
    expect(note).not.toContain("  padded");
  });

  it("names the agent that actually answered", () => {
    // A Codex-authored plan's discussions run on Codex, and this rider is
    // read back BY that agent on the next revise — attributing its own words
    // to Claude is the one place the lie would be believed.
    const note = transcriptNote(
      [msg("user", "Why this order?"), msg("assistant", "Dependency order.")],
      "Codex",
    );
    expect(note).toBe(
      "Following a discussion with Codex:\n\n" +
        "Reviewer: Why this order?\n\n" +
        "Codex: Dependency order.",
    );
    expect(note).not.toContain("Claude");
  });
});

describe("formatBytes", () => {
  it("scales the unit to the size", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(3.5 * 1024 * 1024)).toBe("3.5 MB");
  });
});
