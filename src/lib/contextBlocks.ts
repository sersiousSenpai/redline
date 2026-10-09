// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// One block per pressed context chip: what the card attaches, in words an
// agent can act on. Loaded when something is sent, never at boot — see
// surfaceContext.ts for which chips exist and how blocks join a prompt.

import { renderContextBlocks, type BrowserIslandPage, type ContextBlock, type SentContext } from "./surfaceContext";
import { fnv1a32Hex } from "./thumbs";
import type {
  DiffFile,
  DiffSource,
  ReviewAnnotation,
  ReviewQuestion,
} from "../types";

/** Quoted page data — never the DOM, and a selection bounded to 4,000 chars. */
export function pageBlock(page: BrowserIslandPage): ContextBlock {
  const sections = [`Browser page context (quoted data):\nTitle: ${page.title}\nURL: ${page.url}`];
  const selection = page.selection?.trim();
  if (selection)
    sections.push(`Selected passage:\n${selection.slice(0, 4000).split("\n").map((line) => `> ${line}`).join("\n")}`);
  return { id: "page", heading: `This page (${page.title || page.url})`, body: sections.join("\n\n") };
}

export function taskListBlock(markdown: string): ContextBlock {
  return { id: "tasks", heading: "Task list", body: markdown };
}

export function planBlock(plan: { sessionId: string; version: number; title: string | null; markdown: string }): ContextBlock {
  return {
    id: "plan",
    heading: `This plan (v${plan.version}${plan.title ? `, ${plan.title}` : ""})`,
    body: `Plan session: ${plan.sessionId}\n\n${plan.markdown}`,
  };
}

/** A reference, not the contents: the agent can read the file itself, and an
 *  inlined copy would go stale the moment the user saves. */
export function fileBlock(path: string): ContextBlock {
  return {
    id: "file",
    heading: `This file (${basename(path)})`,
    body: `Path: ${path}\n\nThe user has this file open. Read it from disk; its contents are not inlined here.`,
  };
}

export function draftBlock(markdown: string): ContextBlock {
  return { id: "draft", heading: "This draft", body: markdown };
}

const SOURCE_LABEL: Record<DiffSource, string> = {
  uncommitted: "Uncommitted changes",
  staged: "Staged changes",
  unstagedPlusUntracked: "Unstaged and untracked changes",
  lastCommit: "The last commit",
  vsBase: "Changes against the base branch",
  commitSha: "One commit",
  runBranch: "A run branch's changes",
};

/** The review's shape — which files, how much, and what the user said about
 *  them — but not the raw diff, which the agent can read with `git diff`. */
export function diffBlock(review: {
  repo: string;
  source: DiffSource;
  base: string | null;
  sha: string | null;
  files: DiffFile[];
  annotations: ReviewAnnotation[];
  questions: ReviewQuestion[];
}): ContextBlock {
  const source =
    review.source === "vsBase" && review.base
      ? `Changes against \`${review.base}\``
      : review.source === "commitSha" && review.sha
        ? `Commit \`${review.sha.slice(0, 12)}\``
        : SOURCE_LABEL[review.source];
  const lines = [`Repository: ${review.repo}`, `Showing: ${source}`];
  lines.push("", `Changed files (${review.files.length}):`);
  for (const f of review.files) {
    const path = f.status === "renamed" && f.oldPath !== f.newPath ? `${f.oldPath} → ${f.newPath}` : f.status === "deleted" ? f.oldPath : f.newPath;
    if (f.binary) {
      lines.push(`- ${path} (binary)`);
      continue;
    }
    let add = 0;
    let del = 0;
    for (const h of f.hunks) for (const l of h.lines) {
      if (l.kind === "add") add++;
      else if (l.kind === "del") del++;
    }
    lines.push(`- ${path} (+${add} −${del})`);
  }
  const notes = review.annotations.filter((a) => a.status !== "orphaned");
  if (notes.length) {
    lines.push("", `The user's review comments (${notes.length}):`);
    for (const a of notes) {
      const what = a.label ? `${a.kind}, ${a.label}` : a.kind;
      lines.push(`- ${where(a)} [${what}] ${a.body.trim()}`);
      if (a.kind === "suggestion" && a.suggestionReplacement)
        lines.push(`  Suggested replacement:\n  \`\`\`\n${a.suggestionReplacement.split("\n").map((l) => `  ${l}`).join("\n")}\n  \`\`\``);
    }
  }
  if (review.questions.length) {
    lines.push("", "Selections the user asked about:");
    for (const q of review.questions)
      lines.push(`- ${where({ ...q, scope: "line" })}: "${q.quotedText.trim().split("\n")[0].slice(0, 160)}"`);
  }
  lines.push("", "The raw diff is not attached. Run `git diff` in the repository to read it.");
  return { id: "diff", heading: `This diff (${basename(review.repo)})`, body: lines.join("\n") };
}

/** What a chat hasn't been handed yet, as one attachment, remembered as
 *  handed. Keyed per chat on each block's content: an unchanged plan rides one
 *  turn rather than every turn, and a revised one goes again. Null when there
 *  is nothing new. Call it for every send, blocks or not: each one decides
 *  whether `handedAll` is still true. */
export function unsentAttachment(sent: Map<string, SentContext>, chatId: string, provider: string, blocks: ContextBlock[]): string | null {
  const previous = sent.get(chatId);
  const record: SentContext = previous?.provider === provider
    ? { ...previous, handedAll: false }
    : { provider, keys: new Set<string>(), handedAll: true };
  sent.set(chatId, record);
  const fresh = blocks.filter((b) => !record.keys.has(blockKey(b)));
  for (const b of fresh) record.keys.add(blockKey(b));
  return renderContextBlocks(fresh) || null;
}

/** The chip, the length, and a hash of what it says. */
function blockKey(b: ContextBlock): string {
  return `${b.id}:${b.body.length}:${fnv1a32Hex(`${b.heading}\n${b.body}`)}`;
}

function where(a: { scope: ReviewAnnotation["scope"]; filePath: string; startLine: number; endLine: number }): string {
  if (a.scope === "general" || !a.filePath) return "Whole change";
  if (a.scope === "file") return a.filePath;
  return `${a.filePath}:${a.startLine}${a.endLine > a.startLine ? `–${a.endLine}` : ""}`;
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || path;
}
