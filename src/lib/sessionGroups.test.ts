// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../types";
import {
  buildSidebar,
  itemKey,
  planRowMode,
  rowAge,
  rowStatus,
  SECTION_LIMIT,
  sidebarItems,
  versionRows,
  type FlowChat,
  type FlowLaunch,
  type SidebarInput,
  type SidebarItem,
} from "./sessionGroups";
import { isBuildingRunState } from "./sessionMode";

const plan = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId: id,
  projectName: "din",
  projectPath: "/code/din",
  planTitle: `Plan ${id}`,
  latestVersion: 1,
  revisions: [{ versionNumber: 1, receivedAt: 1, threadStart: true, restored: false }],
  createdAt: 1,
  updatedAt: 10,
  status: "approved",
  pendingCount: 0,
  awaitingReview: false,
  held: false,
  attachState: "idle",
  ...over,
});
const chat = (id: string, over: Partial<FlowChat> = {}): FlowChat => ({ companionId: id, title: `Chat ${id}`, updatedAt: 10, projectPath: "/code/din", ...over });
const launch = (id: string, over: Partial<FlowLaunch> = {}): FlowLaunch => ({ terminalId: id, title: `Launch ${id}`, startedAt: 10, projectPath: "/code/din", working: true, ...over });

const shape = (input: SidebarInput) =>
  buildSidebar(input).sections.map((s) => [s.label, s.rows.map((r) => r.key), s.hidden] as const);

describe("a plan row's mode, in the top bar's words", () => {
  it.each([
    [{ status: "in_review" as const, held: true }, false, "redline"],
    [{ status: "in_review" as const }, false, "redline"],
    [{ status: "in_review" as const }, true, "plan"],
    [{ status: "approved" as const, runState: "building" }, false, "build"],
    [{ status: "approved" as const, runState: "running" }, true, "build"],
    [{ status: "approved" as const }, false, "build"],
    [{ status: "aborted" as const }, false, "plan"],
  ])("%j, mid-turn %s → %s", (over, busy, mode) => {
    expect(planRowMode(plan("p", over), busy)).toBe(mode);
  });

  it("building is one agent at work in its terminal", () => {
    expect(isBuildingRunState("building")).toBe(true);
    // The cut run feature's states, and the done ones, are not building.
    expect(["orchestrating", "running", "in_code_review", "awaiting_review", "landed", "stalled", "abandoned", null].some(isBuildingRunState)).toBe(false);
  });
});

describe("which section a row sorts into", () => {
  it.each([
    ["a held plan awaiting review (redlining)", plan("x", { status: "in_review", held: true, awaitingReview: true }), "din", null],
    // A stored state from the cut run feature needs nothing of you.
    ["a stale run state", plan("x", { runState: "in_code_review" }), "din", null],
    ["a stale stalled run", plan("x", { runState: "stalled" }), "din", null],
    // Where a plan is in its life is its status line, not a section: a stale
    // "building" (nothing moves a plan out of it) must not pin it to the top.
    ["a plan handed to an agent to build", plan("x", { runState: "building" }), "din", null],
    ["a plan in review, nothing held", plan("x", { status: "in_review" }), "din", null],
    ["an approved plan", plan("x"), "din", null],
    ["a landed run", plan("x", { runState: "landed" }), "din", null],
    ["an aborted plan", plan("x", { status: "aborted" }), "din", null],
  ] as const)("%s → %s", (_, session, label, need) => {
    const model = buildSidebar({ sessions: [session] });
    const section = model.sections.find((s) => s.rows.some((r) => r.key === "plan:x"))!;
    expect(section.label).toBe(label);
    expect(section.rows.find((r) => r.key === "plan:x")!.need).toBe(need);
  });

  it("an engine ask puts any row in Needs you, and names why", () => {
    const model = buildSidebar({
      sessions: [plan("p", { status: "in_review" })],
      chats: [chat("c")],
      launches: [launch("t")],
      needs: { "plan:p": "Question", "launch:t": "Permission" },
    });
    expect(model.sections[0].label).toBe("Needs you");
    expect(model.sections[0].rows.map((r) => [r.key, r.need])).toEqual([
      ["launch:t", "Permission"],
      ["plan:p", "Question"],
    ]);
  });

  it("an engine ask is a plan's need", () => {
    const [item] = sidebarItems({ sessions: [plan("p")], needs: { "plan:p": "Permission" } });
    expect(item.need).toBe("Permission");
  });
});

describe("sections: Needs you while anything does, then projects", () => {
  it("nothing needs you: project groups only (4a–4d)", () => {
    const model = buildSidebar({
      sessions: [plan("roadmap", { status: "in_review", updatedAt: 40 }), plan("backend", { updatedAt: 30 }), plan("retrieval", { runState: "building", updatedAt: 20 })],
      chats: [chat("status", { updatedAt: 10 })],
    });
    expect(model.live).toBe(false);
    expect(shape({
      sessions: [plan("roadmap", { status: "in_review", updatedAt: 40 }), plan("backend", { updatedAt: 30 }), plan("retrieval", { runState: "building", updatedAt: 20 })],
      chats: [chat("status", { updatedAt: 10 })],
    })).toEqual([["din", ["plan:roadmap", "plan:backend", "plan:retrieval", "chat:status"], 0]]);
  });

  it("a working launch leads its project with a spinner (4b)", () => {
    const model = buildSidebar({ sessions: [plan("backend", { updatedAt: 30 })], launches: [launch("t", { startedAt: 50 })] });
    expect(model.sections.map((s) => s.rows.map((r) => [r.key, r.working, rowStatus(r).icon]))).toEqual([
      [["launch:t", true, "spin"], ["plan:backend", false, "check"]],
    ]);
  });

  it("Needs you leads; everything else keeps its project (5a)", () => {
    const sessions = [
      plan("vehicle", { status: "in_review", held: true, projectPath: "/code/dial", updatedAt: 90 }),
      plan("dial", { runState: "building", projectPath: "/code/dial", updatedAt: 80 }),
      plan("sprint", { projectPath: "/code/mos", projectName: "machineos", updatedAt: 85 }),
      plan("old", { updatedAt: 5, projectPath: "/code/mos", projectName: "machineos" }),
    ];
    expect(shape({ sessions, needs: { "plan:vehicle": "Question" } })).toEqual([
      ["Needs you", ["plan:vehicle"], 0],
      ["machineos", ["plan:sprint", "plan:old"], 0],
      // Named by the plan's recorded project name (the helper's "din").
      ["din", ["plan:dial"], 0],
    ]);
  });
});

describe("a row's status line", () => {
  const item = (over: Partial<SessionSummary>, extra: Partial<SidebarItem> = {}): SidebarItem =>
    ({ ...sidebarItems({ sessions: [plan("x", over)] })[0], ...extra });
  it.each([
    ["held for review", item({ status: "in_review", held: true }), "In review", "redline", "pen"],
    ["in review, detached", item({ status: "in_review", attachState: "detached" }), "In review", "redline", "pen"],
    ["Claude revising after feedback", item({ status: "in_review" }, { working: true }), "Revising", "plan", "spin"],
    ["approved, nothing built", item({}), "Approved · not built", "build", "check"],
    // A build handed to an agent never spins on its own: nothing says when it ends.
    ["handed to an agent", item({ runState: "building" }), "Approved", "build", "hammer"],
    ["that agent mid-turn", item({ runState: "building" }, { working: true }), "Building", "build", "spin"],
    ["built", item({ runState: "landed" }), "Built", "build", "built"],
    // A state the cut run feature left behind reads as not built.
    ["a stale run state", item({ runState: "running" }), "Approved · not built", "build", "check"],
    ["aborted", item({ status: "aborted" }), "Aborted", "quiet", "file"],
  ] as const)("%s → %s", (_, row, word, tone, icon) => {
    expect(rowStatus(row)).toMatchObject({ word, tone, icon });
  });

  it("chats and launches", () => {
    const [c, l] = sidebarItems({ sessions: [], chats: [chat("c")], launches: [launch("t", { working: false })] });
    expect(rowStatus(c)).toMatchObject({ word: "Chat", icon: "chat" });
    expect(rowStatus({ ...c, working: true })).toMatchObject({ word: "Replying", icon: "spin" });
    expect(rowStatus(l)).toMatchObject({ word: "Waiting", icon: "file" });
    expect(rowStatus({ ...l, working: true })).toMatchObject({ word: "Planning", icon: "spin" });
  });

  it("how long ago, briefly", () => {
    const now = Date.UTC(2026, 9, 18, 12);
    expect([30_000, 5 * 60_000, 3 * 3_600_000, 2 * 86_400_000].map((ago) => rowAge(now - ago, now))).toEqual(["now", "5m", "3h", "2d"]);
  });
});

describe("Show N more", () => {
  const sessions = Array.from({ length: 9 }, (_, i) => plan(`p${i}`, { updatedAt: 100 - i }));
  const first = Array.from({ length: SECTION_LIMIT.project }, (_, i) => `plan:p${i}`);
  it("folds a project at its limit and counts the rest", () => {
    expect(SECTION_LIMIT.project).toBe(6);
    expect(shape({ sessions })).toEqual([["din", first, 3]]);
  });

  it("keeps the open row visible wherever it sits, in its own place", () => {
    expect(shape({ sessions, activeKey: "plan:p7" })).toEqual([["din", [...first, "plan:p7"], 2]]);
  });

  it("never folds away a row with terminals under it", () => {
    expect(shape({ sessions, pinned: new Set(["plan:p8"]) })).toEqual([["din", [...first, "plan:p8"], 2]]);
  });

  it("an expanded group shows everything, and can fold back only while it has more than its limit", () => {
    const [open] = buildSidebar({ sessions, expanded: new Set(["project:/code/din|plans"]) }).sections;
    expect([open.rows.length, open.hidden, open.foldable]).toEqual([9, 0, true]);
    const [few] = buildSidebar({ sessions: sessions.slice(0, 6), expanded: new Set(["project:/code/din|plans"]) }).sections;
    expect(few.foldable).toBe(false);
  });

  it("never folds Needs you", () => {
    const asks = Array.from({ length: 9 }, (_, i) => plan(`n${i}`, { updatedAt: 90 - i }));
    const needs = Object.fromEntries(asks.map((p) => [`plan:${p.sessionId}`, "Question" as const]));
    const model = buildSidebar({ sessions: asks, needs });
    expect(model.sections.map((s) => [s.label, s.rows.length, s.hidden])).toEqual([["Needs you", 9, 0]]);
  });
});

describe("project groups", () => {
  it("the most recently active folder leads; a trailing slash is the same folder", () => {
    const model = buildSidebar({
      sessions: [plan("a", { projectPath: "/code/din/", updatedAt: 10 }), plan("b", { projectPath: "/code/mos", projectName: "machineos", updatedAt: 20 })],
      chats: [chat("c", { projectPath: "/code/din", updatedAt: 30 })],
    });
    // The newest row leads its folder (the chat), and its Plans come
    // before its Chats (D31).
    expect(model.sections.map((s) => [s.label, s.projectPath, s.rows.map((r) => r.key)])).toEqual([
      ["din", "/code/din", ["plan:a", "chat:c"]],
      ["machineos", "/code/mos", ["plan:b"]],
    ]);
  });

  it("a folder no plan names is called by its last segment", () => {
    const model = buildSidebar({ sessions: [], chats: [chat("c", { projectPath: "/Users/me/projects/research" })] });
    expect(model.sections[0].label).toBe("research");
  });

  it("plans and launches without a folder close the list as No project; chats without one lead the projects as their own Chats group", () => {
    const chatsOnly = buildSidebar({ sessions: [plan("a", { updatedAt: 1 })], chats: [chat("c", { projectPath: null, updatedAt: 99 })] });
    expect(chatsOnly.sections.map((s) => [s.label, s.projectPath, s.groups.map((g) => g.label)])).toEqual([["Chats", null, ["Chats"]], ["din", "/code/din", ["Plans"]]]);
    const mixed = buildSidebar({ sessions: [], chats: [chat("c", { projectPath: null })], launches: [launch("t", { projectPath: null })] });
    expect(mixed.sections.map((s) => [s.label, s.groups.map((g) => g.label)])).toEqual([["Chats", ["Chats"]], ["No project", ["Plans"]]]);
  });
});

// D31: chats and plans are separate groups under each project.
describe("a project's Plans and Chats", () => {
  const input: SidebarInput = {
    sessions: [plan("p1", { updatedAt: 50 }), plan("p2", { updatedAt: 20 })],
    chats: [chat("c1", { updatedAt: 60 }), chat("c2", { updatedAt: 10 })],
    launches: [launch("t1", { startedAt: 40 })],
    working: new Set(["chat:c1"]),
  };
  const groups = (over: Partial<SidebarInput> = {}) => buildSidebar({ ...input, ...over }).sections[0].groups;

  it("puts plans and launches in Plans, chats in Chats, each newest first, with its count and working state", () => {
    expect(groups().map((g) => [g.id, g.label, g.rows.map((r) => r.key), g.count, g.working])).toEqual([
      ["project:/code/din|plans", "Plans", ["plan:p1", "launch:t1", "plan:p2"], 3, 1],
      ["project:/code/din|chats", "Chats", ["chat:c1", "chat:c2"], 2, 1],
    ]);
    // The section's rows are its groups', Plans first.
    expect(buildSidebar(input).sections[0].rows.map((r) => r.key)).toEqual(["plan:p1", "launch:t1", "plan:p2", "chat:c1", "chat:c2"]);
  });

  it("a collapsed group keeps its count and shows no rows; the other is untouched", () => {
    const [plans, chats] = groups({ collapsed: new Set(["project:/code/din|chats"]) });
    expect([chats.collapsed, chats.rows, chats.count, chats.hidden]).toEqual([true, [], 2, 0]);
    expect([plans.collapsed, plans.rows.length]).toEqual([false, 3]);
  });

  it("each group folds at its own limit", () => {
    const many = { sessions: Array.from({ length: 8 }, (_, i) => plan(`p${i}`, { updatedAt: 90 - i })), chats: Array.from({ length: 7 }, (_, i) => chat(`c${i}`, { updatedAt: 50 - i })) };
    const [plans, chats] = buildSidebar(many).sections[0].groups;
    expect([plans.rows.length, plans.hidden, chats.rows.length, chats.hidden]).toEqual([6, 2, 6, 1]);
    expect(buildSidebar(many).sections[0].hidden).toBe(3);
  });

  it("a row that needs you leaves its group for Needs you; Needs you stays one list", () => {
    const model = buildSidebar({ ...input, needs: { "chat:c2": "Question" } });
    expect(model.sections[0]).toMatchObject({ label: "Needs you", groups: [] });
    expect(model.sections[1].groups.find((g) => g.kind === "chats")!.rows.map((r) => r.key)).toEqual(["chat:c1"]);
  });
});

describe("rows", () => {
  it("a plan is named by the user's title, then its heading, then its project", () => {
    const [renamed, headed, bare] = sidebarItems({
      sessions: [plan("a", { titleOverride: "Mine", planTitle: "Heading" }), plan("b", { planTitle: "Heading" }), plan("c", { planTitle: null })],
    });
    expect([renamed.title, headed.title, bare.title]).toEqual(["Mine", "Heading", "din"]);
  });

  it("a launch is titled by its prompt's first line", () => {
    const [item] = sidebarItems({ sessions: [], launches: [launch("t", { title: "  Read the build log\nand then plan  " })] });
    expect(item.title).toBe("Read the build log");
  });

  it("a launch gives way to the plan intercepted from its terminal", () => {
    const items = sidebarItems({ sessions: [plan("p", { heldTerminalId: "t1", held: true })], launches: [launch("t1"), launch("t2")] });
    expect(items.map((i) => i.key)).toEqual(["plan:p", "launch:t2"]);
  });

  it("working comes from the engine for plans and chats, and from the launch itself", () => {
    const items = sidebarItems({
      sessions: [plan("p", { status: "in_review" })],
      chats: [chat("c")],
      launches: [launch("t", { working: false })],
      working: new Set([itemKey("plan", "p"), itemKey("chat", "c")]),
    });
    expect(items.map((i) => [i.key, i.working, i.mode])).toEqual([
      ["plan:p", true, "plan"],
      ["chat:c", true, "chat"],
      ["launch:t", false, "plan"],
    ]);
  });
});

describe("archived", () => {
  it("leaves every section and closes the list, newest archive first", () => {
    const model = buildSidebar({
      sessions: [plan("a", { archivedAt: 5 }), plan("b"), plan("c", { archivedAt: 9, runState: "building" })],
      chats: [chat("x", { archivedAt: 7 })],
    });
    expect(model.live).toBe(false);
    expect(model.sections.map((s) => s.rows.map((r) => r.key))).toEqual([["plan:b"]]);
    expect(model.archived.map((r) => r.key)).toEqual(["plan:c", "chat:x", "plan:a"]);
  });
});

describe("versionRows", () => {
  const day = (d: number, h = 9) => new Date(2026, 9, d, h, 30).getTime();
  const session = {
    revisions: [
      { versionNumber: 1, receivedAt: day(14), threadStart: true, restored: false },
      { versionNumber: 2, receivedAt: day(14, 15), threadStart: false, restored: false },
      { versionNumber: 3, receivedAt: day(15), threadStart: false, restored: true },
      { versionNumber: 4, receivedAt: day(15, 16), threadStart: false, restored: false },
    ],
  };
  const now = day(18);
  const dateOf = (ms: number) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });

  it("numbers by substance, marks the latest and dates each one (5a)", () => {
    expect(versionRows(session, null, now).map((r) => [r.label, r.date, r.latest, r.viewed])).toEqual([
      ["v1", dateOf(day(14)), false, false],
      ["v2", dateOf(day(14)), false, false],
      ["v2 · restored", dateOf(day(15)), false, false],
      ["v3 · latest", dateOf(day(15)), true, true],
    ]);
  });

  it("the viewed revision is the one on screen", () => {
    expect(versionRows(session, 1, now).map((r) => r.viewed)).toEqual([true, false, false, false]);
  });

  it("today's revision reads as its time", () => {
    const [row] = versionRows({ revisions: [{ versionNumber: 1, receivedAt: day(18, 14), threadStart: true, restored: false }] }, null, now);
    expect(row.date).toBe(new Date(day(18, 14)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  });
});

// The last walk never saw a Chats group. The shapes below are what the
// daemon returns: `companion_list` rows (state.rs `Companion`, camelCase,
// `projectPath` canonical and OMITTED when the chat has none — 26 of the
// user's 37), and `/v1/sessions` summaries whose `projectPath` is the
// agent's cwd.
describe("Chats from the daemon's own payloads", () => {
  const companion = (id: string, title: string, updatedAt: number, projectPath?: string) =>
    ({ companionId: id, title, status: "active", createdAt: updatedAt - 5, updatedAt, titleIsUserSet: false, ...(projectPath ? { projectPath } : {}) }) as FlowChat;
  const qwallah = "/Users/me/qwallah";
  const scratch = "/private/tmp/claude-501/x/scratchpad/wb-final-repo";
  const sessions = [
    ...Array.from({ length: 64 }, (_, i) => plan(`q${i}`, { projectName: "qwallah", projectPath: qwallah, updatedAt: 500 - i })),
    plan("w1", { projectName: "wb-final-repo", projectPath: scratch, updatedAt: 900 }),
  ];
  const chats = [
    companion("joey", "Joey Multi-Tenant Status", 800, qwallah),
    companion("greet", "Greeting Exchange Check", 950, scratch),
    companion("ts", "Why is there a bunch of typescript in the app?", 300),
  ];

  it("a chat with a folder is in its project's Chats group, after a folded Plans group", () => {
    const model = buildSidebar({ sessions, chats });
    const q = model.sections.find((s) => s.projectPath === qwallah)!;
    expect(q.groups.map((g) => [g.label, g.count, g.rows.length])).toEqual([["Plans", 64, 6], ["Chats", 1, 1]]);
    expect(q.groups[1].rows[0].title).toBe("Joey Multi-Tenant Status");
    const w = model.sections.find((s) => s.projectPath === scratch)!;
    expect(w.groups.map((g) => g.label)).toEqual(["Plans", "Chats"]);
  });

  it("a chat the daemon gives no folder leads the projects, never below them all", () => {
    const model = buildSidebar({ sessions, chats });
    expect(model.sections[0].label).toBe("Chats");
    expect(model.sections[0].groups.map((g) => [g.label, g.rows.map((r) => r.title)])).toEqual([["Chats", ["Why is there a bunch of typescript in the app?"]]]);
    expect(model.sections.some((s) => s.label === "No project")).toBe(false);
  });
});
