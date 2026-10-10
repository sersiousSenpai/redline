// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import type { SurfaceInfo } from "./activeSurface";
import type { DiffFile, ReviewAnnotation, ReviewQuestion } from "../types";
import {
  CONTEXT_BLOCK_MAX,
  capBlock,
  forgetSent,
  isChipPressed,
  renderContextBlocks,
  surfaceChips,
  surfaceContextLabel,
  toggleChip,
  visibleChips,
  withContext,
  type ChipSources,
  type ContextBlock,
  type ContextChip,
  type SentContext,
} from "./surfaceContext";
import { diffBlock, draftBlock, fileBlock, pageBlock, planBlock, taskListBlock, unsentAttachment } from "./contextBlocks";

const surface = (kind: SurfaceInfo["kind"], over: Partial<SurfaceInfo> = {}): SurfaceInfo => ({
  kind, id: null, label: null, detail: null, projectPath: null, updatedAt: 0, ...over,
});
const everything: ChipSources = {
  page: { title: "LiDAR-GS", url: "https://github.com/x/lidar-gs" },
  tasks: true,
  plan: { version: 3, title: "Auth rewrite" },
  file: "/repo/src/main.rs",
  draft: true,
  diff: { repo: "/repo" },
};
const chipSet = (kind: SurfaceInfo["kind"], sources = everything) =>
  surfaceChips(surface(kind), sources).map((c) => [c.id, c.label, c.defaultOn]);

describe("surfaceChips — one 'this thing' chip per surface", () => {
  it("the browser keeps This page (on) and Task list (off)", () => {
    expect(chipSet("browser")).toEqual([["page", "This page", true], ["tasks", "Task list", false]]);
    expect(surfaceChips(surface("browser"), everything)[0].title).toBe("https://github.com/x/lidar-gs");
  });

  it("each document-like surface offers its own, pressed by default", () => {
    expect(chipSet("plan")).toEqual([["plan", "This plan · v3", true]]);
    expect(chipSet("terminal")).toEqual([["file", "This file", true]]);
    expect(chipSet("drafter")).toEqual([["draft", "This draft", true]]);
    expect(chipSet("review")).toEqual([["diff", "This diff", true]]);
  });

  it("surfaces with no on-screen selection offer nothing", () => {
    for (const kind of ["servers", "memory", "runs", "chat", "welcome"] as const)
      expect(chipSet(kind)).toEqual([]);
  });

  it("never offers a chip with nothing behind it", () => {
    expect(chipSet("browser", { page: { title: "", url: "" } })).toEqual([]);
    expect(chipSet("plan", {})).toEqual([]);
    expect(chipSet("terminal", { file: null })).toEqual([]);
    expect(chipSet("drafter", { draft: false })).toEqual([]);
    expect(chipSet("review", { diff: null })).toEqual([]);
  });

  it("hides This draft when the destination is the Drafter itself", () => {
    const draft = surfaceChips(surface("drafter"), everything);
    expect(visibleChips(draft, "drafter")).toEqual([]);
    expect(visibleChips(draft, "plan")).toEqual(draft);
    const page = surfaceChips(surface("browser"), everything);
    expect(visibleChips(page, "drafter")).toEqual(page);
  });
});

describe("chip presses", () => {
  const plan: ContextChip = { id: "plan", label: "This plan · v3", title: "", defaultOn: true };
  const tasks: ContextChip = { id: "tasks", label: "Task list", title: "", defaultOn: false };
  const none = { surfaceKey: "", on: {} };

  it("start from each chip's default", () => {
    expect(isChipPressed(plan, none, "document:a")).toBe(true);
    expect(isChipPressed(tasks, none, "browser::")).toBe(false);
  });

  it("toggle for the surface they were pressed on", () => {
    const off = toggleChip(none, "document:a", plan);
    expect(isChipPressed(plan, off, "document:a")).toBe(false);
    expect(isChipPressed(plan, toggleChip(off, "document:a", plan), "document:a")).toBe(true);
  });

  it("reset to the defaults when the surface changes", () => {
    const off = toggleChip(none, "document:a", plan);
    expect(isChipPressed(plan, off, "document:b")).toBe(true);
    // A toggle on the new surface starts from ITS defaults, not the old map.
    const on = toggleChip(off, "browser::", tasks);
    expect(on).toEqual({ surfaceKey: "browser::", on: { tasks: true } });
  });
});

describe("surfaceContextLabel", () => {
  it("names where the card is", () => {
    expect(surfaceContextLabel(surface("plan", { label: "Auth rewrite" }))).toBe("Auth rewrite");
    expect(surfaceContextLabel(surface("plan"))).toBe("Plan");
    expect(surfaceContextLabel(surface("browser"), "LiDAR-GS")).toBe("LiDAR-GS");
    expect(surfaceContextLabel(surface("browser"))).toBe("Browser");
    expect(surfaceContextLabel(surface("review", { label: "/Users/me/repo/" }))).toBe("Review · repo");
    expect(surfaceContextLabel(surface("terminal", { detail: "/repo/src/main.rs" }))).toBe("main.rs");
    expect(surfaceContextLabel(surface("servers"))).toBe("Localhost");
    expect(surfaceContextLabel(surface("welcome"))).toBeNull();
  });
});

describe("withContext — the generalised browser island prompt", () => {
  const page = { label: "browser-a", title: "A", url: "https://a.test", selection: "One\nTwo" };

  it("is the bare trimmed prompt when nothing is attached", () => {
    expect(withContext(" Build this ", [])).toBe("Build this");
    // An empty block is not a block.
    expect(withContext("Build this", [taskListBlock("  ")])).toBe("Build this");
  });

  it("attaches only opted-in page/task context and quotes bounded selections", () => {
    const prompt = withContext("Build this", [pageBlock(page), taskListBlock("# Task list\n- [ ] Fix nav")]);
    expect(prompt.startsWith("Build this\n\n## Context — This page (A)\n\n")).toBe(true);
    expect(prompt).toContain("URL: https://a.test");
    expect(prompt).toContain("> One\n> Two");
    expect(prompt).toContain("## Context — Task list\n\n# Task list\n- [ ] Fix nav");
    expect(pageBlock({ ...page, selection: "x".repeat(5000) }).body).toContain(`> ${"x".repeat(4000)}`);
    expect(pageBlock({ ...page, selection: "x".repeat(5000) }).body).not.toContain("x".repeat(4001));
    expect(pageBlock({ ...page, selection: "  " }).body).not.toContain("Selected passage");
  });

  it("sets the context apart with a rule for the Drafter", () => {
    expect(withContext("Draft this", [draftBlock("Body")], { rule: true })).toBe(
      "Draft this\n\n---\n\n## Context — This draft\n\nBody",
    );
  });

  it("renders one section per block, in order", () => {
    const text = renderContextBlocks([
      planBlock({ sessionId: "s1", version: 3, title: "Auth rewrite", markdown: "# Plan\nSteps" }),
      fileBlock("/repo/src/main.rs"),
    ]);
    expect(text).toBe(
      "## Context — This plan (v3, Auth rewrite)\n\nPlan session: s1\n\n# Plan\nSteps\n\n" +
        "## Context — This file (main.rs)\n\nPath: /repo/src/main.rs\n\nThe user has this file open. Read it from disk; its contents are not inlined here.",
    );
  });
});

describe("truncation", () => {
  it("caps each block at 40k characters with a note", () => {
    expect(capBlock("short")).toBe("short");
    const long = "a".repeat(CONTEXT_BLOCK_MAX + 123);
    const capped = capBlock(long);
    expect(capped.startsWith("a".repeat(CONTEXT_BLOCK_MAX))).toBe(true);
    expect(capped).toContain("[Truncated: 123 more characters were not attached.]");
    expect(capped.length).toBeLessThan(CONTEXT_BLOCK_MAX + 100);
  });

  it("applies per block, so one huge plan doesn't crowd out the rest", () => {
    const text = renderContextBlocks([draftBlock("d".repeat(CONTEXT_BLOCK_MAX * 2)), taskListBlock("- [ ] keep me")]);
    expect(text).toContain("[Truncated:");
    expect(text).toContain("- [ ] keep me");
  });
});

describe("diffBlock — the review's shape, not its bytes", () => {
  const file = (newPath: string, add: number, del: number, over: Partial<DiffFile> = {}): DiffFile => ({
    oldPath: newPath, newPath, status: "modified", binary: false,
    hunks: [{ oldStart: 1, oldLines: del, newStart: 1, newLines: add, header: "", lines: [
      ...Array.from({ length: add }, () => ({ kind: "add" as const, oldLine: null, newLine: 1, text: "+" })),
      ...Array.from({ length: del }, () => ({ kind: "del" as const, oldLine: 1, newLine: null, text: "-" })),
      { kind: "context" as const, oldLine: 2, newLine: 2, text: "" },
    ] }],
    ...over,
  });
  const note = (over: Partial<ReviewAnnotation>): ReviewAnnotation => ({
    id: "n", reviewId: "r", round: 1, filePath: "src/a.ts", side: "new", startLine: 10, endLine: 12,
    kind: "comment", body: "Why a second cache?", quotedText: "", status: "draft", createdAt: 0, scope: "line", source: "user", ...over,
  });
  const question: ReviewQuestion = { id: "q", reviewId: "r", filePath: "src/b.ts", side: "new", startLine: 5, endLine: 5, quotedText: "const x = y();\nmore", createdAt: 0 };

  it("lists files with +/− counts, the user's notes and questions, and points at git diff", () => {
    const block = diffBlock({
      repo: "/Users/me/repo", source: "vsBase", base: "main", sha: null,
      files: [file("src/a.ts", 12, 3), file("img.png", 0, 0, { binary: true, hunks: [] }), file("new.ts", 1, 0, { status: "renamed", oldPath: "old.ts" })],
      annotations: [note({}), note({ id: "o", status: "orphaned", body: "stale" }), note({ id: "g", scope: "general", filePath: "", body: "Ship it", label: "praise" })],
      questions: [question],
    });
    expect(block.heading).toBe("This diff (repo)");
    expect(block.body).toContain("Showing: Changes against `main`");
    expect(block.body).toContain("- src/a.ts (+12 −3)");
    expect(block.body).toContain("- img.png (binary)");
    expect(block.body).toContain("- old.ts → new.ts (+1 −0)");
    expect(block.body).toContain("- src/a.ts:10–12 [comment] Why a second cache?");
    expect(block.body).toContain("- Whole change [comment, praise] Ship it");
    expect(block.body).not.toContain("stale");
    expect(block.body).toContain('- src/b.ts:5: "const x = y();"');
    expect(block.body).toContain("git diff");
    // Never the diff text itself.
    expect(block.body).not.toContain("@@");
  });

  it("names the source it was looking at", () => {
    const base = { repo: "/r", base: null, sha: null, files: [], annotations: [], questions: [] };
    expect(diffBlock({ ...base, source: "uncommitted" }).body).toContain("Showing: Uncommitted changes");
    expect(diffBlock({ ...base, source: "commitSha", sha: "0123456789abcdef" }).body).toContain("Showing: Commit `0123456789ab`");
  });
});

describe("unsentAttachment — a chat's attachments, once per version", () => {
  const plan = (version: number, markdown = "# Auth rewrite\n- step one") =>
    planBlock({ sessionId: "s-1", version, title: "Auth rewrite", markdown });
  const page = pageBlock({ label: "browser-1", title: "Docs", url: "https://docs.test" });
  const attach = (sent: Map<string, SentContext>, chatId: string, provider: string, blocks: ContextBlock[]) =>
    unsentAttachment(sent, chatId, provider, blocks).context;

  it("hands a chat each block once, and nothing when nothing changed", () => {
    const sent = new Map<string, SentContext>();
    const first = attach(sent, "chat-1", "claude-code", [plan(3), page]);
    expect(first).toBe(renderContextBlocks([plan(3), page]));
    expect(attach(sent, "chat-1", "claude-code", [plan(3), page])).toBeNull();
  });

  it("sends only the block that changed — a revision, or an edit at the same version", () => {
    const sent = new Map<string, SentContext>();
    attach(sent, "chat-1", "claude-code", [plan(3), page]);
    expect(attach(sent, "chat-1", "claude-code", [plan(4), page])).toBe(renderContextBlocks([plan(4)]));
    const edited = plan(4, "# Auth rewrite\n- step one\n- step two");
    expect(attach(sent, "chat-1", "claude-code", [edited, page])).toBe(renderContextBlocks([edited]));
  });

  it("carries every pressed block alongside, for a send that starts a fresh session", () => {
    const sent = new Map<string, SentContext>();
    // Everything is new: `context` already says it all.
    expect(unsentAttachment(sent, "chat-1", "claude-code", [plan(3)])).toEqual({ context: renderContextBlocks([plan(3)]), contextAll: null });
    // The plan went out already; the page is new.
    expect(unsentAttachment(sent, "chat-1", "claude-code", [plan(3), page])).toEqual({
      context: renderContextBlocks([page]),
      contextAll: renderContextBlocks([plan(3), page]),
    });
    // Nothing new, still pressed.
    expect(unsentAttachment(sent, "chat-1", "claude-code", [plan(3)])).toEqual({ context: null, contextAll: renderContextBlocks([plan(3)]) });
    expect(unsentAttachment(sent, "chat-1", "claude-code", [])).toEqual({ context: null, contextAll: null });
  });

  it("remembers per chat, and forgets a chat whose attachment was lost", () => {
    const sent = new Map<string, SentContext>();
    attach(sent, "chat-1", "claude-code", [plan(3)]);
    // Another conversation has never seen it.
    expect(attach(sent, "chat-2", "claude-code", [plan(3)])).toBe(renderContextBlocks([plan(3)]));
    // A send that never arrived: the next one carries everything again.
    forgetSent(sent, "chat-1", "unsent");
    expect(attach(sent, "chat-1", "claude-code", [plan(3)])).toBe(renderContextBlocks([plan(3)]));
  });

  it("starts over when the chat moves to another provider, and again when it moves back", () => {
    // A provider switch is a fresh CLI session either way (companion.rs's
    // handoff), so the first turn on the new provider carries everything.
    const sent = new Map<string, SentContext>();
    attach(sent, "chat-1", "claude-code", [plan(3), page]);
    expect(attach(sent, "chat-1", "codex", [plan(3), page])).toBe(renderContextBlocks([plan(3), page]));
    expect(attach(sent, "chat-1", "codex", [plan(3), page])).toBeNull();
    expect(attach(sent, "chat-1", "claude-code", [plan(3)])).toBe(renderContextBlocks([plan(3)]));
  });

  it("a fresh session holds exactly what was pressed when it started", () => {
    const sent = new Map<string, SentContext>();
    attach(sent, "chat-1", "claude-code", [plan(3), page]);
    // A rotation: the backend hands the new session `contextAll`, every
    // pressed block, on the turn that starts it — nothing is lost, and
    // nothing goes twice.
    expect(attach(sent, "chat-1", "claude-code", [plan(3), page])).toBeNull();
    forgetSent(sent, "chat-1", "fresh-session");
    expect(attach(sent, "chat-1", "claude-code", [plan(3), page])).toBeNull();
    // A block handed to the old session but not pressed when the new one
    // started never reached the new one, so it goes again when pressed.
    attach(sent, "chat-1", "claude-code", [plan(3)]);
    forgetSent(sent, "chat-1", "fresh-session");
    expect(attach(sent, "chat-1", "claude-code", [plan(3), page])).toBe(renderContextBlocks([page]));
  });

  it("a turn with nothing pressed still counts, and a send that never arrived is always forgotten", () => {
    const sent = new Map<string, SentContext>();
    attach(sent, "chat-1", "claude-code", [plan(3)]);
    expect(attach(sent, "chat-1", "claude-code", [])).toBeNull();
    forgetSent(sent, "chat-1", "fresh-session");
    expect(attach(sent, "chat-1", "claude-code", [plan(3)])).toBe(renderContextBlocks([plan(3)]));
    forgetSent(sent, "chat-1", "unsent");
    expect(attach(sent, "chat-1", "claude-code", [plan(3)])).toBe(renderContextBlocks([plan(3)]));
    // Forgetting a chat that was never handed anything is harmless.
    forgetSent(sent, "chat-9", "fresh-session");
    expect(sent.has("chat-9")).toBe(false);
  });

  it("attaches nothing for no blocks or only empty ones", () => {
    const sent = new Map<string, SentContext>();
    expect(attach(sent, "chat-1", "claude-code", [])).toBeNull();
    expect(attach(sent, "chat-1", "claude-code", [draftBlock("   ")])).toBeNull();
  });
});
