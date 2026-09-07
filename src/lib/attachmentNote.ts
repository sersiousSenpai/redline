// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { CommentAttachment, ThreadMessage } from "../types";

/** The rider note a sidecar transcript produces.
 *
 *  Routing a discussion back into the revise loop works by folding the
 *  transcript into the comment's note (`attach_discussion`), which is plain
 *  text. So a file dropped into a follow-up has to be *named* here — that one
 *  line is how its path reaches the Revise payload without any new plumbing.
 *
 *  `agent` names who actually answered — a Codex-authored plan's discussions
 *  run on Codex (`fork.rs`), and the rider is read back BY that agent on the
 *  next revise, so attributing its own words to Claude is a small lie in the
 *  one place it would be believed. Defaulted so every existing caller, and
 *  every note already stored, stays byte-identical. It is also compared
 *  against the stored note to detect a stale rider, which is the other reason
 *  the default cannot drift.
 */
export function transcriptNote(
  transcript: ThreadMessage[],
  agent: string = "Claude",
): string {
  const body = transcript
    .map((m) => {
      const who = m.role === "user" ? "Reviewer" : agent;
      const files = attachmentLines(m.attachments);
      return `${who}: ${m.body.trim()}${files}`;
    })
    .join("\n\n");
  return `Following a discussion with ${agent}:\n\n${body}`;
}

/** The per-turn attachment lines appended inside a rider note. Empty string
 *  when a turn carried no files, so an ordinary discussion's rider is
 *  byte-identical to what it was before attachments existed. */
export function attachmentLines(
  attachments: CommentAttachment[] | undefined,
): string {
  return (attachments ?? [])
    .map((a) => `\n  [attached file — read it: ${a.path} (${a.mime})]`)
    .join("");
}

/** Human-readable size for an attachment chip. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
