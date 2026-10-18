// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../types";
import {
  buildSidebar,
  itemKey,
  SECTION_LIMIT,
  sidebarItems,
  versionRows,
  type FlowChat,
  type FlowLaunch,
  type SidebarInput,
} from "./sessionGroups";
import { isBuildingRunState, sessionMode } from "./sessionMode";

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

describe("sessionMode (the placeholder's truth table)", () => {
  it.each([
    [{ kind: "chat" } as const, "chat"],
    [{ kind: "launch" } as const, "plan"],
    [{ kind: "plan", status: "in_review" } as const, "redline"],
    [{ kind: "plan", status: "in_review", working: true } as const, "plan"],
    [{ kind: "plan", status: "approved", runState: "building" } as const, "build"],
    [{ kind: "plan", status: "approved", runState: "running", working: true } as const, "build"],
    [{ kind: "plan", status: "approved", runState: "in_code_review" } as const, "plan"],
    [{ kind: "plan", status: "approved" } as const, "plan"],
    [{ kind: "plan", status: "aborted" } as const, "plan"],
  ])("%j → %s", (input, mode) => {
    expect(sessionMode(input)).toBe(mode);
  });

  it("building is one agent or a run that has not landed", () => {
    expect(["building", "orchestrating", "running"].every(isBuildingRunState)).toBe(true);
    expect(["in_code_review", "awaiting_review", "landed", "stalled", "abandoned", null].some(isBuildingRunState)).toBe(false);
  });
});

describe("which section a row sorts into", () => {
  // One live row turns the sections on; the table is what each row becomes.
  const live = plan("live", { status: "approved", runState: "building", projectPath: "/code/other", projectName: "other", updatedAt: 1 });
  it.each([
    ["a held plan awaiting review", plan("x", { status: "in_review", held: true, awaitingReview: true }), "Needs you", "Review"],
    ["a run waiting on its code review", plan("x", { runState: "in_code_review" }), "Needs you", "Review"],
    ["an overnight run parked for review", plan("x", { runState: "awaiting_review" }), "Needs you", "Review"],
    ["a stalled run", plan("x", { runState: "stalled" }), "Needs you", "Stalled"],
    ["a building plan", plan("x", { runState: "building" }), "Building", null],
    ["an orchestrated run", plan("x", { runState: "running" }), "Building", null],
    ["a plan in review, nothing held", plan("x", { status: "in_review" }), "In review", null],
    ["a detached plan in review", plan("x", { status: "in_review", attachState: "detached" }), "In review", null],
    ["an approved plan", plan("x"), "din", null],
    ["a landed run", plan("x", { runState: "landed" }), "din", null],
    ["an aborted plan", plan("x", { status: "aborted" }), "din", null],
  ] as const)("%s → %s", (_, session, label, need) => {
    const model = buildSidebar({ sessions: [session, live] });
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

  it("an engine ask outranks a plan's own review", () => {
    const [item] = sidebarItems({ sessions: [plan("p", { held: true, awaitingReview: true })], needs: { "plan:p": "Permission" } });
    expect(item.need).toBe("Permission");
  });
});

describe("the live sections appear only while something needs you or is building", () => {
  it("nothing live: project groups only, a plan in review stays in its project (4a–4d)", () => {
    expect(
      shape({
        sessions: [plan("roadmap", { status: "in_review", updatedAt: 40 }), plan("backend", { updatedAt: 30 }), plan("retrieval", { updatedAt: 20 })],
        chats: [chat("status", { updatedAt: 10 })],
      }),
    ).toEqual([["din", ["plan:roadmap", "plan:backend", "plan:retrieval", "chat:status"], 0]]);
  });

  it("a working launch is not live: it leads its project with a spinner (4b)", () => {
    const model = buildSidebar({ sessions: [plan("backend", { updatedAt: 30 })], launches: [launch("t", { startedAt: 50 })] });
    expect(model.live).toBe(false);
    expect(model.sections.map((s) => s.rows.map((r) => [r.key, r.working, r.mode]))).toEqual([
      [["launch:t", true, "plan"], ["plan:backend", false, "plan"]],
    ]);
  });

  it("live: Needs you → Building → In review → by project (5a)", () => {
    const sessions = [
      plan("vehicle", { held: true, awaitingReview: true, status: "in_review", projectPath: "/code/dial", updatedAt: 90 }),
      plan("dial", { runState: "building", projectPath: "/code/dial", updatedAt: 80 }),
      plan("sprint", { runState: "orchestrating", projectPath: "/code/mos", projectName: "machineos", updatedAt: 85 }),
      ...Array.from({ length: 14 }, (_, i) => plan(`r${i}`, { status: "in_review", updatedAt: 70 - i })),
      plan("old", { updatedAt: 5, projectPath: "/code/mos", projectName: "machineos" }),
    ];
    expect(shape({ sessions })).toEqual([
      ["Needs you", ["plan:vehicle"], 0],
      ["Building", ["plan:sprint", "plan:dial"], 0],
      ["In review", ["plan:r0", "plan:r1", "plan:r2", "plan:r3", "plan:r4"], 9],
      ["machineos", ["plan:old"], 0],
    ]);
  });
});

describe("Show N more", () => {
  const sessions = Array.from({ length: 8 }, (_, i) => plan(`p${i}`, { updatedAt: 100 - i }));
  it("folds a project at its limit and counts the rest", () => {
    expect(SECTION_LIMIT.project).toBe(5);
    expect(shape({ sessions })).toEqual([["din", ["plan:p0", "plan:p1", "plan:p2", "plan:p3", "plan:p4"], 3]]);
  });

  it("keeps the open row visible wherever it sits, in its own place", () => {
    expect(shape({ sessions, activeKey: "plan:p6" })).toEqual([["din", ["plan:p0", "plan:p1", "plan:p2", "plan:p3", "plan:p4", "plan:p6"], 2]]);
  });

  it("an expanded section shows everything, and can fold back only while it has more than its limit", () => {
    const [open] = buildSidebar({ sessions, expanded: new Set(["project:/code/din"]) }).sections;
    expect([open.rows.length, open.hidden, open.foldable]).toEqual([8, 0, true]);
    const [few] = buildSidebar({ sessions: sessions.slice(0, 5), expanded: new Set(["project:/code/din"]) }).sections;
    expect(few.foldable).toBe(false);
  });

  it("never folds Needs you or Building", () => {
    const many = Array.from({ length: 9 }, (_, i) => plan(`b${i}`, { runState: "building", updatedAt: 50 - i }));
    const asks = Array.from({ length: 9 }, (_, i) => plan(`n${i}`, { runState: "stalled", updatedAt: 90 - i }));
    const model = buildSidebar({ sessions: [...many, ...asks] });
    expect(model.sections.map((s) => [s.label, s.rows.length, s.hidden])).toEqual([
      ["Needs you", 9, 0],
      ["Building", 9, 0],
    ]);
  });
});

describe("project groups", () => {
  it("the most recently active folder leads; a trailing slash is the same folder", () => {
    const model = buildSidebar({
      sessions: [plan("a", { projectPath: "/code/din/", updatedAt: 10 }), plan("b", { projectPath: "/code/mos", projectName: "machineos", updatedAt: 20 })],
      chats: [chat("c", { projectPath: "/code/din", updatedAt: 30 })],
    });
    expect(model.sections.map((s) => [s.label, s.projectPath, s.rows.map((r) => r.key)])).toEqual([
      ["din", "/code/din", ["chat:c", "plan:a"]],
      ["machineos", "/code/mos", ["plan:b"]],
    ]);
  });

  it("a folder no plan names is called by its last segment", () => {
    const model = buildSidebar({ sessions: [], chats: [chat("c", { projectPath: "/Users/me/projects/research" })] });
    expect(model.sections[0].label).toBe("research");
  });

  it("rows without a folder close the list: Chats when all chats, Other otherwise", () => {
    const chatsOnly = buildSidebar({ sessions: [plan("a", { updatedAt: 1 })], chats: [chat("c", { projectPath: null, updatedAt: 99 })] });
    expect(chatsOnly.sections.map((s) => [s.label, s.projectPath])).toEqual([["din", "/code/din"], ["Chats", null]]);
    const mixed = buildSidebar({ sessions: [], chats: [chat("c", { projectPath: null })], launches: [launch("t", { projectPath: null })] });
    expect(mixed.sections.map((s) => s.label)).toEqual(["Other"]);
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
