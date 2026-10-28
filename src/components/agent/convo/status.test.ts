// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import type { ConvoAsk } from "./types";
import { convoView, type Turn, type TurnItem } from "./reducer";
import { loadConvoFixture, replay } from "./__fixtures__/loadFixtures";
import {
  displayPath,
  displayUrl,
  effortLabel,
  formatElapsed,
  modeLabel,
  modelChipLabel,
  modelDisplayName,
  planStats,
  planStatsLabel,
  stepsSummary,
  toolPhrase,
  toolRows,
  turnSegments,
  workingStatus,
} from "./status";

const ROOT = "/Users/me/projects/din";
const tool = (id: string, name: string, summary: string, status: "running" | "done" | "error" = "done", at = 0): TurnItem => ({
  kind: "tool",
  id,
  at,
  toolUseId: `tu-${id}`,
  name,
  summary,
  status,
  preview: null,
});
const prose = (id: string, text = "words"): TurnItem => ({ kind: "prose", id, at: 0, text });
const thinking = (id: string): TurnItem => ({ kind: "thinking", id, at: 0 });
const plan = (id: string, at: number, outcome: "approved" | "denied" | "feedback" | null = null): TurnItem => ({
  kind: "plan",
  id,
  at,
  plan: { toolUseId: `tu-${id}`, sessionId: "s1", title: "Din roadmap", outcome, feedback: null },
});
const ask: ConvoAsk = { askId: "a1", kind: "permission", toolName: "Bash", summary: "npm test", openedAt: 0 };
function turn(items: TurnItem[], over: Partial<Turn> = {}): Turn {
  return { id: "turn:u", epoch: 0, user: null, items, startedAt: 1_000, endedAt: null, durationMs: null, ended: false, interrupted: false, ...over };
}

describe("the working row: first match wins", () => {
  const view = (activeTurn: Turn | null, over: Partial<Parameters<typeof workingStatus>[0]> = {}) => ({
    openAsks: [] as ConvoAsk[],
    activeTurn,
    lastTurn: activeTurn,
    mode: "plan" as const,
    ...over,
  });

  it.each<[string, Parameters<typeof workingStatus>[0], Parameters<typeof workingStatus>[1], string | null, string | null]>([
    ["an open ask needs you, over a running tool", view(turn([tool("t", "Read", `${ROOT}/a.md`, "running")]), { openAsks: [ask] }), {}, "needs-you", "Needs you"],
    ["the terminal's own needs-you counts too", view(null, { mode: null }), { term: "needs-you" }, "needs-you", "Needs you"],
    ["a running read is its verb", view(turn([tool("t", "Read", `${ROOT}/docs/x.md`, "running")])), { projectPath: ROOT }, "tool", "Reading docs/x.md"],
    ["a running command", view(turn([tool("t", "Bash", "npm test\n--watch=false", "running")])), {}, "tool", "Running npm test"],
    ["an MCP tool by server and name", view(turn([tool("t", "mcp__github__get_issue", "42", "running")])), {}, "tool", "Using github · get_issue 42"],
    ["a todo update has no target", view(turn([tool("t", "TodoWrite", "{}", "running")])), {}, "tool", "Updating the todo list"],
    ["parallel tools: the newest still running", view(turn([tool("a", "Read", "/x/a.md", "running"), tool("b", "Grep", "fooBar", "running")])), {}, "tool", "Searching fooBar"],
    ["a finished tool is not running", view(turn([tool("t", "Read", "/x/a.md", "done")])), {}, "writing-plan", "Writing the plan"],
    ["thinking, newest", view(turn([tool("t", "Read", "/x/a.md"), thinking("k")])), {}, "thinking", "Thinking"],
    ["prose after a tool, in plan mode", view(turn([tool("t", "Read", "/x/a.md"), prose("p")])), {}, "writing-plan", "Writing the plan"],
    ["a thought after the turn said what it will do, in plan mode (4b)", view(turn([tool("t", "Read", "/x/a.md"), prose("p"), thinking("k")])), {}, "writing-plan", "Writing the plan"],
    ["a thought after prose, not in plan mode", view(turn([prose("p"), thinking("k")]), { mode: "default" }), {}, "thinking", "Thinking"],
    ["prose, not in plan mode", view(turn([prose("p")]), { mode: "default" }), {}, "working", "Working"],
    ["the plan tool is the plan card, not a verb", view(turn([tool("t", "ExitPlanMode", "# Plan", "running"), plan("p", 5)])), {}, "plan-ready", "Plan ready"],
    ["a plan held for review, turn still open", view(turn([prose("p"), plan("p", 5)])), {}, "plan-ready", "Plan ready"],
    ["a plan in the last, ended turn", view(null, { lastTurn: turn([plan("p", 5)], { ended: true }) }), {}, "plan-ready", "Plan ready"],
    ["an answered plan is not ready", view(null, { lastTurn: turn([plan("p", 5, "approved")], { ended: true }) }), {}, null, null],
    ["building after approval: the verb again", view(turn([plan("p", 5, "approved"), tool("e", "Edit", `${ROOT}/src/a.ts`, "running")])), { projectPath: ROOT }, "tool", "Editing src/a.ts"],
    ["nothing running", view(null), {}, null, null],
    ["the terminal working before any event", view(null, { mode: null }), { term: "working" }, "working", "Working"],
  ])("%s", (_label, input, options, kind, label) => {
    const status = workingStatus(input, options);
    expect(status?.kind ?? null).toBe(kind);
    expect(status?.label ?? null).toBe(label);
  });

  it("times from the running turn's start, and a held plan has no timer", () => {
    expect(workingStatus({ openAsks: [], activeTurn: turn([prose("p")]), lastTurn: null, mode: "plan" })?.since).toBe(1_000);
    expect(workingStatus({ openAsks: [], activeTurn: null, lastTurn: turn([plan("p", 5)], { ended: true }), mode: "plan" })?.since).toBeNull();
  });

  it("4b, from the live fixture: writing the plan", () => {
    const view = convoView(replay(loadConvoFixture("plan-live").actions));
    expect(workingStatus(view)).toEqual({ kind: "writing-plan", label: "Writing the plan", since: 1760774401000 });
  });
});

describe("timers", () => {
  it.each([
    [0, "0s"],
    [999, "0s"],
    [12_400, "12s"],
    [59_999, "59s"],
    [72_000, "1m 12s"],
    [124_000, "2m 04s"],
    [3_599_000, "59m 59s"],
    [3_840_000, "1h 04m"],
    [-5, "0s"],
  ])("%i ms reads %s", (ms, text) => {
    expect(formatElapsed(ms)).toBe(text);
  });
});

describe("tools in words", () => {
  it.each([
    ["Read", `${ROOT}/docs/obsidian/build-log.md`, "past", ["Read", "docs/obsidian/build-log.md"]],
    ["Read", "/Users/me/elsewhere/notes.md", "past", ["Read", "~/elsewhere/notes.md"]],
    ["Read", "/etc/hosts", "present", ["Reading", "/etc/hosts"]],
    ["Write", `${ROOT}/a.ts`, "past", ["Wrote", "a.ts"]],
    ["WebFetch", "https://www.example.com/docs/", "present", ["Fetching", "example.com/docs"]],
    ["WebSearch", "tauri channels", "past", ["Searched the web for", "tauri channels"]],
    ["Task", "Explore the parser", "present", ["Running an agent:", "Explore the parser"]],
    ["TodoWrite", "{\"todos\":[]}", "past", ["Updated the todo list", ""]],
    ["shell", "cargo test", "past", ["Ran", "cargo test"]],
    ["Frobnicate", "x", "past", ["Used Frobnicate", "x"]],
  ] as const)("%s %s (%s)", (name, summary, tense, [verb, target]) => {
    expect(toolPhrase(name, summary, tense, ROOT)).toEqual({ verb, target });
  });

  it.each([
    [`${ROOT}`, "."],
    [`${ROOT}/`, "."],
    ["/home/ana/x", "~/x"],
    [`${ROOT}-other/x`, "~/projects/din-other/x"],
  ])("displayPath(%s)", (path, out) => {
    expect(displayPath(path, ROOT)).toBe(out);
  });

  it("displayUrl keeps the path, drops the scheme", () => {
    expect(displayUrl("http://localhost:5173/")).toBe("localhost:5173");
  });
});

describe("tool rows (4b)", () => {
  it("four reads: the first, then the newest and 2 more", () => {
    const rows = toolRows(
      [
        tool("1", "Read", `${ROOT}/docs/obsidian/build-log.md`),
        tool("2", "Read", `${ROOT}/docs/obsidian/27 Retrieval.md`),
        tool("3", "Read", `${ROOT}/docs/obsidian/26 Backend.md`),
        tool("4", "Read", `${ROOT}/docs/obsidian/28 Roadmap.md`),
      ],
      { projectPath: ROOT },
    );
    expect(rows.map((r) => [r.verb, r.target, r.more])).toEqual([
      ["Read", "docs/obsidian/build-log.md", 0],
      ["Read", "docs/obsidian/28 Roadmap.md", 2],
    ]);
    expect(rows[1].steps).toHaveLength(3);
  });

  it.each<[string, TurnItem[], string[]]>([
    ["two reads stay two rows", [tool("1", "Read", "/a"), tool("2", "Read", "/b")], ["Read /a", "Read /b"]],
    ["an edit breaks a run of looking", [tool("1", "Read", "/a"), tool("2", "Grep", "x"), tool("3", "Read", "/b"), tool("4", "Edit", "/c"), tool("5", "Read", "/d")], ["Read /a", "Read /b +1", "Edited /c", "Read /d"]],
    ["a failed read keeps its run unfolded", [tool("1", "Read", "/a"), tool("2", "Read", "/b", "error"), tool("3", "Read", "/c")], ["Read /a", "Read /b", "Read /c"]],
    ["a running tool is the working row's, not a row", [tool("1", "Read", "/a"), tool("2", "Bash", "ls", "running")], ["Read /a"]],
    ["card tools draw cards, not rows", [tool("1", "ExitPlanMode", "# Plan"), tool("2", "AskUserQuestion", "?")], []],
    ["prose between steps is not a step", [tool("1", "Read", "/a"), prose("p"), tool("2", "Read", "/b")], ["Read /a", "Read /b"]],
  ])("%s", (_label, items, out) => {
    expect(toolRows(items).map((r) => `${r.verb} ${r.target}${r.more ? ` +${r.more}` : ""}`)).toEqual(out);
  });

  it("in an ended turn, a step with no result reads as stopped", () => {
    expect(toolRows([tool("1", "Bash", "sleep 9", "running")], { ended: true })[0].status).toBe("stopped");
  });
});

describe("settled turns fold (4c)", () => {
  it.each<[string, TurnItem[], string | null]>([
    ["four reads", [tool("1", "Read", "/a"), tool("2", "Read", "/b"), tool("3", "Read", "/c"), tool("4", "Read", "/d")], "Read 4 files"],
    ["a file read twice counts once", [tool("1", "Read", "/a"), tool("2", "Read", "/a")], "Read 1 file"],
    ["mixed, in first-seen order", [tool("1", "Grep", "x"), tool("2", "Read", "/a"), tool("3", "Bash", "ls"), tool("4", "Bash", "pwd")], "Ran 1 search, read 1 file, ran 2 commands"],
    ["past three kinds", [tool("1", "Read", "/a"), tool("2", "Edit", "/b"), tool("3", "Bash", "ls"), tool("4", "WebFetch", "u"), tool("5", "WebFetch", "v")], "Read 1 file, edited 1 file, ran 1 command, and 2 more steps"],
    ["the web", [tool("1", "WebSearch", "q"), tool("2", "WebSearch", "r")], "Searched the web 2 times"],
    ["only card tools", [tool("1", "ExitPlanMode", "")], null],
    ["nothing", [prose("p")], null],
  ])("%s", (_label, items, text) => {
    expect(stepsSummary(items)).toBe(text);
  });

  it("the plan turn from the fixture: one summary, the plan card, nothing else drawn", () => {
    const view = convoView(replay(loadConvoFixture("plan-turn").actions));
    const first = view.blocks.find((b) => b.kind === "turn");
    if (first?.kind !== "turn") throw new Error("no turn");
    const segments = turnSegments(first.turn);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ settled: true, summary: "Read 4 files · planned in 2m 04s", shown: [] });
    expect(segments[0].plan?.plan.title).toBe("Din roadmap: next steps");
    expect(segments[0].folded.map((item) => item.kind)).toEqual(["thinking", "tool", "tool", "tool", "tool", "prose", "tool"]);
  });

  it("the question turn: its answer stays, with no summary (no steps)", () => {
    const segments = turnSegments(convoView(replay(loadConvoFixture("plan-turn").actions)).lastTurn!);
    expect(segments).toEqual([expect.objectContaining({ settled: true, summary: null, plan: null })]);
    expect(segments[0].shown.map((item) => item.kind)).toEqual(["prose"]);
  });

  it("while it runs, nothing folds", () => {
    const [segment] = turnSegments(turn([tool("1", "Read", "/a"), prose("p")]));
    expect(segment).toMatchObject({ settled: false, summary: null, folded: [] });
    expect(segment.shown).toHaveLength(2);
  });

  it("an ended answer folds its steps and keeps its prose", () => {
    const [segment] = turnSegments(turn([tool("1", "Read", "/a"), prose("p"), tool("2", "Bash", "ls")], { ended: true, endedAt: 13_400, durationMs: 12_400 }));
    expect(segment.summary).toBe("Read 1 file, ran 1 command · 12.4s");
    expect(segment.shown.map((item) => item.id)).toEqual(["p"]);
  });

  it("a stopped turn says so", () => {
    const [segment] = turnSegments(turn([tool("1", "Bash", "sleep 9", "running")], { ended: true, interrupted: true, endedAt: 9_000, durationMs: 8_000 }));
    expect(segment.summary).toBe("Ran 1 command · stopped after 8s");
  });

  it("a plan, then building in the same turn: two stretches", () => {
    const items = [tool("1", "Read", "/a"), plan("p", 61_000, "approved"), tool("2", "Edit", "/b", "done", 70_000)];
    const running = turnSegments(turn(items));
    expect(running.map((s) => [s.settled, s.summary])).toEqual([
      [true, "Read 1 file · planned in 1m 00s"],
      [false, null],
    ]);
    const done = turnSegments(turn(items, { ended: true, endedAt: 181_000, durationMs: 180_000 }));
    expect(done[1].summary).toBe("Edited 1 file · 2m 00s");
  });

  it("an open ask stays drawn even in a settled stretch; an answered one folds", () => {
    const openAsk: TurnItem = { kind: "ask", id: "k", at: 0, ask, outcome: null };
    const answered: TurnItem = { kind: "ask", id: "j", at: 0, ask, outcome: "allow" };
    const [segment] = turnSegments(turn([answered, openAsk, plan("p", 2_000)]));
    expect(segment.shown.map((item) => item.id)).toEqual(["k"]);
    expect(segment.summary).toBe("Planned in 1s");
  });
});

describe("the plan card's counts", () => {
  it.each<[string, string, string | null]>([
    ["the board's plan", "# Din roadmap\n\nLede.\n\n## 1. Finish Track B\n\n1. Compile\n2. Apply\n3. Deploy\n\n## 2. Next\n\n- D6\n- D7\n\n## 3. Later\n\n1. a\n2. b\n3. c\n4. d\n5. e\n6. f\n", "3 sections · 11 steps"],
    ["nested items aren't steps", "## A\n\n1. one\n    - sub\n    - sub\n2. two\n", "1 section · 2 steps"],
    ["### when there's no ##", "# T\n### a\n### b\n- x\n", "2 sections · 1 step"],
    ["fenced code is skipped", "## A\n```\n## not a heading\n1. not a step\n```\n- real\n", "1 section · 1 step"],
    ["no structure", "Just a paragraph.", null],
    ["no plan", "", null],
  ])("%s", (_label, markdown, label) => {
    expect(planStatsLabel(planStats(markdown))).toBe(label);
  });
});

describe("chips", () => {
  it.each([
    ["claude-opus-4-5-20251101", "Opus 4.5"],
    ["claude-sonnet-4-5", "Sonnet 4.5"],
    ["claude-opus-4-1-20250805[1m]", "Opus 4.1"],
    ["claude-3-5-haiku-20241022", "Haiku 3.5"],
    ["claude-fable", "Fable"],
    ["gpt-5.1-codex-max", "GPT-5.1-Codex-Max"],
    ["o3", "o3"],
  ])("%s reads %s", (model, name) => {
    expect(modelDisplayName(model)).toBe(name);
  });

  it("the live catalog's name wins for its exact id", () => {
    expect(modelDisplayName("gpt-5.6-sol", [{ slug: "gpt-5.6-sol", displayName: "GPT-5.6-Sol" }])).toBe("GPT-5.6-Sol");
  });

  it.each<[string, Parameters<typeof modelChipLabel>[0], Parameters<typeof modelChipLabel>[1], string]>([
    ["the board", { model: "claude-opus-4-5-20251101", effort: "high" }, { harness: "claude", showHarness: false }, "Opus 4.5 · High"],
    ["two harnesses installed", { model: "gpt-5.1-codex", effort: "medium" }, { harness: "codex", showHarness: true }, "Codex · GPT-5.1-Codex · Medium"],
    ["no effort", { model: "claude-sonnet-4-5", effort: null }, { harness: "claude", showHarness: false }, "Sonnet 4.5"],
    ["extra high", { model: "claude-opus-4-5", effort: "xhigh" }, { harness: "claude", showHarness: false }, "Opus 4.5 · Extra high"],
    ["before the model is known", null, { harness: "codex", showHarness: false }, "Codex"],
  ])("%s", (_label, fact, options, label) => {
    expect(modelChipLabel(fact, options)).toBe(label);
  });

  it.each([
    ["plan", "Plan"],
    ["default", "Default"],
    ["acceptEdits", "Accept edits"],
    ["bypassPermissions", "Bypass permissions"],
    ["somethingNew", "somethingNew"],
    [null, "Mode"],
  ] as const)("mode %s reads %s", (mode, label) => {
    expect(modeLabel(mode)).toBe(label);
  });

  it("effort words", () => {
    expect(effortLabel("low")).toBe("Low");
  });
});

describe("tool rows that name a file (W4)", () => {
  it("carry the file's absolute path for a read or an edit, and nothing for a command", () => {
    const rows = toolRows([tool("1", "Read", "src/a.ts"), tool("2", "Edit", "/repo/b.ts"), tool("3", "Bash", "ls src")], { projectPath: "/repo" });
    expect(rows.map((r) => r.path ?? null)).toEqual(["/repo/src/a.ts", "/repo/b.ts", null]);
    // A relative path with no project to resolve it against is no link.
    expect(toolRows([tool("1", "Read", "src/a.ts")])[0].path).toBeUndefined();
  });
});
