// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Seed data for the full-App QA fixture (fixtures/app-qa), consumed by
//! scripts/app-visual-qa.mjs through `scenarioFor(board)`.
//!
//! Scenario ids. `workbench` is the one the workbench walk boots: the DIN
//! project with its two approved plans, the roadmap plan under review with
//! its terminal's finished conversation (so the Agent tab has a thread), a
//! companion chat, and NO held session, so boot lands on Home's door and the
//! walk reaches the plan by selecting its sidebar row. Every scene name of
//! the walk (`home`, `door-tab`, `plan`, `agent`, `browser`, `sidebar`)
//! aliases it (`SCENE_ALIASES`), so `?board=<scene>` always seeds the same
//! world. The original design-board ids `4a` … `5a` are kept as they were
//! (1 Start, 2 Claude plans, 3 You redline, Managing · Tools, Review) for
//! anyone still wanting those states; nothing in the walk uses them.
//!
//! The model catalog answers "Opus 4.5". The live app must read the model
//! name from the catalog; this catalog is a fake, so the chip reading it is
//! what a capture proves.
//!
//! Times are pinned: the page's clock is frozen at `NOW` (main.tsx), and the
//! capture runs in America/Los_Angeles, so "1m 12s", "2m 04s", "2h ago" and
//! the Oct 14 / Oct 15 version dates come out exactly.

import type { ConvoEvent } from "../../src/components/agent/convo/types";

/** 2026-10-17 16:20:00 in America/Los_Angeles (PDT, UTC−7). */
export const NOW = Date.UTC(2026, 9, 17, 23, 20, 0);
export const TIMEZONE = "America/Los_Angeles";
const MIN = 60_000;
const HOUR = 60 * MIN;
/** A local wall-clock time in October 2026 (PDT), as epoch ms. */
const oct = (day: number, hour: number, minute = 0, second = 0) =>
  Date.UTC(2026, 9, day, hour + 7, minute, second);

export const HOME = "/Users/imani";
export const DIN = `${HOME}/projects/din`;
export const DIALCROWN = `${HOME}/projects/dialcrown`;
export const MACHINE_OS = `${HOME}/projects/machine-os`;
export const REDLINE = `${HOME}/projects/redline`;

export type BoardId = "workbench" | "4a" | "4b" | "4c" | "4d" | "5a";

/** A comment as `get_session` returns it; `provenance` is an extra field the
 *  Comment type doesn't carry yet (5a's "🎙 voice note" tag). */
export interface SeedComment {
  id: string;
  type: "feedback" | "question" | "edit";
  /** The block the comment sits on, by its index among the plan's blocks
   *  (headings included); resolved to anchorId / blockId at install. */
  block: number;
  body: string;
  status: "draft" | "submitted" | "resolved" | "accepted";
  createdAt: number;
  /** A text range inside the block: the quote, and which occurrence. */
  quote?: string;
  /** `blk-….s3`: the sentence the quote is, when it is a whole sentence. */
  sentence?: number;
  resolution?: { body: string; appearedInVersion: number; acceptedAt: number | null };
  provenance?: "voice";
  /** Where the design draws this card's anchor, for a probe to compare. */
  boardAnchor?: string;
  /** An anchor that names a section the plan body doesn't have (5a's §4
   *  cards: the design shows the cards, not the sections). */
  anchorOverride?: string;
}

export interface SeedRevision {
  version: number;
  receivedAt: number;
  markdown: string;
  comments?: SeedComment[];
}

export interface SeedSession {
  sessionId: string;
  projectPath: string;
  createdAt: number;
  updatedAt: number;
  status: "in_review" | "approved" | "aborted";
  attachState?: "idle" | "held" | "detached";
  runState?: string | null;
  titleOverride?: string | null;
  revisions: SeedRevision[];
  model?: string | null;
  effort?: string | null;
  /** Fills a list the board only counts ("Show 9 more"); never on screen. */
  filler?: boolean;
}

export interface SeedChat {
  companionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Extra: which project the chat belongs to (4a groups it under DIN). */
  projectPath?: string;
}

/** A dock terminal that exists at boot: a live PTY the fake backend
 *  re-attaches, the attention its agent's hooks last reported, and the
 *  conversation mirror's tail for it. */
export interface SeedTerminal {
  id: string;
  cwd: string;
  /** Raw bytes the PTY replays on attach (xterm renders them). */
  screen: string;
  attention?: { kind: "working" } | { kind: "needs-you"; reason: string; message: string | null } | { kind: "your-turn"; excerpt: string | null } | { kind: "idle" };
  attentionAt?: number;
  sessionId?: string | null;
  convo?: ConvoEvent[];
}

/** What the fake answers for a terminal the App spawns itself (a launch):
 *  its screen, its conversation, and the session id it binds to. */
export interface SeedLaunch {
  sessionId: string;
  title: string;
  screen: string;
  convo: ConvoEvent[];
}

export interface Scenario {
  id: BoardId;
  title: string;
  viewport: { width: number; height: number };
  now: number;
  sessions: SeedSession[];
  chats: SeedChat[];
  terminals: SeedTerminal[];
  /** The next terminal the App spawns runs this. */
  launch?: SeedLaunch;
  heldSessionId?: string | null;
  /** JSON values written to localStorage before the App loads. */
  storage: Record<string, unknown>;
  /** sessionStorage values (the dock's live layout). */
  session: Record<string, unknown>;
  /** Memory's last librarian run, for the Tools menu's "Memory 2h ago". */
  memoryAt?: number;
  /** Which session the drive opens first, if any. */
  openSessionId?: string | null;
  /** The owner's initials the 4c margin note shows ("IM"). */
  ownerInitials: string;
  /** What the drive types into the start composer (4a, 4b). */
  prompt: string | null;
}

// ── The DIN project (4a–4d) ────────────────────────────────────────────────

/** The prompt typed on 4a and sent on 4b. */
export const DIN_PROMPT = "Read the obsidian build log and plan the next roadmap steps";
export const DIN_TITLE = "Din roadmap: next steps";

/** The 4c plan, verbatim. Its title, lede and both sections are the board's;
 *  the design's card says "3 sections · 11 steps" but draws only these. */
export const DIN_ROADMAP_PLAN = [
  `# ${DIN_TITLE}`,
  "",
  "Picks up from note 28 and the 2026-10-17 updates in the build log.",
  "",
  "## 1. Finish Track B",
  "",
  "1. Compile the build in Xcode on the Mac.",
  "2. Apply 0018_vault_revisions.sql before the next build runs.",
  "3. Deploy the Worker; D3 crash reports need both.",
  "",
  "## 2. Next by priority",
  "",
  "C1, D1, D3, D4, C6 are built. Start with D6: the pattern and experiment loop.",
  "",
].join("\n");

/** 4c's one drawn mark: the amber range and its margin note by "IM". The
 *  header says "2 marks"; the board draws one (see the REPORT). Block 3 is
 *  the step list (0 title, 1 lede, 2 "1. Finish Track B", 3 the list). */
export const DIN_MARK: SeedComment = {
  id: "c-001",
  type: "feedback",
  block: 3,
  quote: "0018_vault_revisions.sql before the next build",
  body: "Run this against staging first, not prod.",
  status: "draft",
  createdAt: NOW - 3 * MIN,
};

const DIN_BACKEND: SeedSession = {
  sessionId: "din-backend",
  projectPath: DIN,
  createdAt: oct(12, 14, 5),
  updatedAt: oct(16, 11, 30),
  status: "approved",
  revisions: [
    {
      version: 1,
      receivedAt: oct(12, 14, 5),
      markdown: "# Din backend: Hono + Fly\n\nMove the API to Hono on Fly.\n",
    },
  ],
};

const DIN_RETRIEVAL: SeedSession = {
  sessionId: "din-retrieval",
  projectPath: DIN,
  createdAt: oct(13, 9, 40),
  updatedAt: oct(15, 17, 2),
  status: "approved",
  revisions: [
    {
      version: 1,
      receivedAt: oct(13, 9, 40),
      markdown: "# Din retrieval plan\n\nIndex the vault for retrieval.\n",
    },
  ],
};

const REVIEW_STATUS_CHAT: SeedChat = {
  companionId: "chat-review-status",
  title: "Review status check",
  createdAt: oct(14, 10, 15),
  updatedAt: oct(14, 10, 22),
  projectPath: DIN,
};

/** The roadmap plan once it exists (4c, 4d): v1, two marks drawn as one. */
const DIN_ROADMAP: SeedSession = {
  sessionId: "din-roadmap",
  projectPath: DIN,
  createdAt: NOW - 6 * MIN,
  updatedAt: NOW - 3 * MIN,
  status: "in_review",
  attachState: "held",
  model: "opus",
  effort: "high",
  revisions: [{ version: 1, receivedAt: NOW - 4 * MIN, markdown: DIN_ROADMAP_PLAN, comments: [DIN_MARK] }],
};

/** The Read summaries are the tool input's `file_path`, as the run
 *  monitor's summarizer reports them; the stage shows them relative. */
const READS = [
  `${DIN}/docs/obsidian/build-log.md`,
  `${DIN}/docs/obsidian/28 Roadmap.md`,
  // Not on the board: the "2 more" behind "and 2 more" / "Read 4 files".
  `${DIN}/docs/obsidian/27 Track B.md`,
  `${DIN}/docs/obsidian/migrations.md`,
];

const DIN_PROSE =
  "The build log stops at Track B. Track A is built but hasn't been compiled in Xcode, and there are two pending migrations. I'll plan from there: finish Track B, then work through the priority list in note 28.";

/** One ConvoEvent with its identity and order filled in. */
function ev(n: number, ts: number, body: Record<string, unknown>): ConvoEvent {
  return { id: `qa-${n}`, epoch: 0, offset: n * 512, ts, ...body } as ConvoEvent;
}

/** The 4b turn, mid-flight: the prompt 1m 12s ago, four reads, the prose,
 *  and the model now thinking (writing the plan). No `turn_end`. */
export function dinTurnInFlight(terminalId: string, sessionId: string): ConvoEvent[] {
  const start = NOW - 72_000;
  const events: ConvoEvent[] = [
    ev(1, start - 4_000, { kind: "bound", harness: "claude", sessionId, transcriptPath: `${HOME}/.claude/projects/-Users-imani-projects-din/${sessionId}.jsonl`, source: "startup" }),
    ev(2, start - 3_000, { kind: "mode_change", mode: "plan" }),
    ev(3, start - 2_000, { kind: "model_seen", model: "opus", effort: "high" }),
    ev(4, start, { kind: "user_text", text: DIN_PROMPT, promptId: "p-1" }),
  ];
  let n = 5;
  READS.forEach((file, i) => {
    const at = start + 6_000 + i * 4_000;
    events.push(ev(n++, at, { kind: "tool_use", toolUseId: `read-${i + 1}`, name: "Read", summary: file }));
    events.push(ev(n++, at + 900, { kind: "tool_result", toolUseId: `read-${i + 1}`, isError: false, preview: "" }));
  });
  events.push(ev(n++, start + 31_000, { kind: "assistant_text", text: DIN_PROSE, model: "claude-opus-4-5" }));
  events.push(ev(n++, start + 33_000, { kind: "thinking" }));
  void terminalId;
  return events;
}

/** The 4c / 4d conversation: the planning turn finished in 2m 04s with a
 *  plan proposed, then the reviewer's question and Claude's answer. */
export function dinTurnDone(terminalId: string, sessionId: string): ConvoEvent[] {
  const events = dinTurnInFlight(terminalId, sessionId);
  const start = NOW - 6 * MIN;
  // Re-time the first turn so it ends four minutes ago, 2m 04s after it began.
  const shift = start - (NOW - 72_000);
  const shifted = events.map((e) => ({ ...e, ts: e.ts + shift }));
  let n = shifted.length + 1;
  const end = start + 124_000;
  shifted.push(
    ev(n++, end - 1_000, { kind: "plan_proposed", toolUseId: "exit-plan-1", sessionId, title: DIN_TITLE }),
    ev(n++, end, { kind: "turn_end", durationMs: 124_000 }),
    ev(n++, NOW - 2 * MIN, { kind: "user_text", text: "Why is Xcode compile first?", promptId: "p-2" }),
    ev(n++, NOW - 2 * MIN + 9_000, {
      kind: "assistant_text",
      text: "The two pending migrations ship with the next build. Compiling first catches Track A breakage before they run against staging.",
      model: "claude-opus-4-5",
    }),
    ev(n++, NOW - 2 * MIN + 11_000, { kind: "turn_end", durationMs: 11_000 }),
  );
  return shifted;
}

/** What the agent's TUI shows in the session's own PTY (the Terminal side
 *  of the Conversation | Terminal toggle). Plain ANSI, no real CLI. */
function claudeScreen(cwd: string, prompt: string, title: string): string {
  const esc = "\u001b";
  return [
    `${esc}]0;${title}\u0007`,
    `${esc}[2m${cwd.replace(HOME, "~")}${esc}[0m ❯ claude --permission-mode plan\r\n`,
    "\r\n",
    `${esc}[38;5;209m✻${esc}[0m Welcome to Claude Code\r\n`,
    "\r\n",
    `> ${prompt}\r\n`,
    "\r\n",
    `${esc}[32m⏺${esc}[0m Read(docs/obsidian/build-log.md)\r\n`,
    `${esc}[32m⏺${esc}[0m Read(docs/obsidian/28 Roadmap.md)\r\n`,
    "\r\n",
    `${esc}[38;5;209m✻${esc}[0m Writing the plan… ${esc}[2m(esc to interrupt)${esc}[0m\r\n`,
    "\r\n",
    `${esc}[2m⏸ plan mode on (shift+tab to cycle)${esc}[0m\r\n`,
  ].join("");
}

const shellScreen = (cwd: string) => `\u001b[2m${cwd.replace(HOME, "~")}\u001b[0m ❯ `;

/** A returning user: no tour, no setup nudges, the door set to Plan in DIN
 *  with Opus · High (the "last used" choice). */
function baseStorage(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "redline.onboardingDone": true,
    "redline.setupDismissed": true,
    "redline.planEverArrived": true,
    "redline.immersiveHintSeen": true,
    "redline.memory.corpusNoticeSeen": true,
    "redline.frontDoor.destination": "plan",
    "redline.frontDoor.project": { path: DIN },
    "redline.frontDoor.backend": { backend: "claude-code", model: "opus", effort: "high" },
    "redline.lastLaunchProject": DIN,
    // The sidebar shows sessions, not the folder of whichever terminal is
    // focused (classic's linked navigation).
    "redline.folders.linkNav": false,
    ...extra,
  };
}

const DIN_TERMINAL = "t-din-roadmap";

/** The dock's live layout, as a reload finds it in sessionStorage. */
function dock(ids: { id: string; cwd: string }[]): Record<string, unknown> {
  if (!ids.length) return {};
  return {
    "redline.terminalWorkspace.v1": { tabs: ids, tiles: [ids[0].id], focusedTile: 0, zoomedId: null },
  };
}

function dinScenario(id: BoardId, title: string, roadmap: boolean): Scenario {
  const sessions = [DIN_BACKEND, DIN_RETRIEVAL, ...(roadmap ? [DIN_ROADMAP] : [])];
  const terminals: SeedTerminal[] = roadmap
    ? [{
        id: DIN_TERMINAL,
        cwd: DIN,
        screen: claudeScreen(DIN, DIN_PROMPT, DIN_TITLE),
        sessionId: DIN_ROADMAP.sessionId,
        attention: { kind: "your-turn", excerpt: "Compiling first catches Track A breakage before they run against staging." },
        attentionAt: NOW - 2 * MIN + 11_000,
        convo: dinTurnDone(DIN_TERMINAL, DIN_ROADMAP.sessionId),
      }]
    : [];
  return {
    id,
    title,
    viewport: { width: 1280, height: 800 },
    now: NOW,
    sessions,
    chats: [REVIEW_STATUS_CHAT],
    terminals,
    launch: roadmap
      ? undefined
      : {
          sessionId: DIN_ROADMAP.sessionId,
          title: DIN_TITLE,
          screen: claudeScreen(DIN, DIN_PROMPT, DIN_TITLE),
          convo: dinTurnInFlight("", DIN_ROADMAP.sessionId),
        },
    // A proposed plan holds Claude's ExitPlanMode until it is reviewed, so
    // boot lands on it (App's held-session carve-out).
    heldSessionId: roadmap ? DIN_ROADMAP.sessionId : null,
    storage: baseStorage(),
    session: dock(terminals.map((t) => ({ id: t.id, cwd: t.cwd }))),
    memoryAt: NOW - 2 * HOUR,
    openSessionId: roadmap ? DIN_ROADMAP.sessionId : null,
    ownerInitials: "IM",
    prompt: DIN_PROMPT,
  };
}

// ── Dialcrown (5a) ─────────────────────────────────────────────────────────

const DIALCROWN_V1_TITLE = "Dialcrown: fastest credible launch, Quo parity, and the voice-agent decision";
/** v2 onward carry the shorter heading the top bar and sidebar show. */
export const DIALCROWN_TITLE = "Dialcrown: fastest credible launch";

const DIALCROWN_CONTEXT =
  "A launch-first plan. It benchmarks Dialcrown against Quo and RingCentral, evaluates Guava as the voice-agent platform, and designs one configuration that drives the record, the agent and the call flow. The test throughout: the smallest release a customer can use and pay for.";

/** The decisions table. Markdown needs a header row and the design draws
 *  none, so the first decision is the header row (no invented copy). */
function dialcrownPlan(title: string): string {
  return [
    `# ${title}`,
    "",
    "## Context",
    "",
    DIALCROWN_CONTEXT,
    "",
    "## Decisions you made",
    "",
    "| First pilot | **A law firm.** California PI intake. All-party consent and confidentiality matter more here than in home services. |",
    "|---|---|",
    "| Voice agent | **Fast-follow.** The pilot runs on human-answered calls. The after-hours agent is Release 2. |",
    "| Runtime | **Decide in §5.** Telnyx AI Assistants vs. Guava. |",
    "| Accounts | **Mostly ready.** Stripe and Resend verification are now on the critical path. |",
    "",
  ].join("\n");
}

const RESOLVED_IN_V2 = (body: string, acceptedAt: number | null) => ({ body, appearedInVersion: 2, acceptedAt });

/** 16 feedback items on v1, all resolved in v2: the open card, the three
 *  drawn resolved cards, and the twelve behind "12 more resolved". */
function dialcrownFeedback(): SeedComment[] {
  const at = oct(14, 22, 50);
  const open: SeedComment = {
    id: "c-001",
    type: "feedback",
    block: 2, // the Context paragraph (0 title, 1 "Context", 2 paragraph)
    quote: "The test throughout: the smallest release a customer can use and pay for.",
    sentence: 3,
    body: "The pilot firm is my own firm. Keep the vendor-terms and notice gates anyway, and get notice-text sign-off from someone other than me.",
    status: "resolved",
    createdAt: at,
    provenance: "voice",
    boardAnchor: "Context · ¶3",
    resolution: RESOLVED_IN_V2(
      "Done. §3 and §4 now treat R1 as internal dogfooding. Both gates stay. Notice-text sign-off goes to outside counsel in step 6.",
      null,
    ),
  };
  const drawn: SeedComment[] = [
    {
      id: "c-002",
      type: "feedback",
      block: 4,
      anchorOverride: "A.4.p4",
      boardAnchor: "§4 · step 4",
      body: "Use one shared type-coercion helper for extraction output and human corrections, validated against the call's pinned config.",
      status: "accepted",
      createdAt: at + MIN,
      resolution: RESOLVED_IN_V2("Added in §4 step 4.", oct(15, 9, 0)),
    },
    {
      id: "c-003",
      type: "feedback",
      block: 4,
      anchorOverride: "A.4.p2",
      boardAnchor: "§4 · releases",
      body: "Reframe the releases: R1 is internal dogfooding. Public launch is gated on full in-app calling with a proven E911 path.",
      status: "accepted",
      createdAt: at + 2 * MIN,
      resolution: RESOLVED_IN_V2("Releases reframed in §4.", oct(15, 9, 1)),
    },
    {
      id: "c-004",
      type: "feedback",
      block: 4,
      anchorOverride: "A.4",
      boardAnchor: "§4",
      body: "Add an iOS launch track with feature parity to web: softphone, VoIP push, texting inbox, call list.",
      status: "accepted",
      createdAt: at + 3 * MIN,
      resolution: RESOLVED_IN_V2("iOS track added to §4.", oct(15, 9, 2)),
    },
  ];
  // Behind "12 more resolved": never drawn, so their copy is filler.
  const more: SeedComment[] = Array.from({ length: 12 }, (_, i) => ({
    id: `c-${String(i + 5).padStart(3, "0")}`,
    type: "feedback" as const,
    block: 4,
    body: `Resolved feedback ${i + 5} (filler behind "12 more resolved").`,
    status: "accepted" as const,
    createdAt: at + (4 + i) * MIN,
    resolution: RESOLVED_IN_V2(`Addressed in v2 (${i + 5}).`, oct(15, 9, 3 + i)),
  }));
  return [open, ...drawn, ...more];
}

const DIALCROWN_SESSION: SeedSession = {
  sessionId: "dialcrown-launch",
  projectPath: DIALCROWN,
  createdAt: oct(14, 22, 37, 3),
  updatedAt: oct(15, 18, 40),
  status: "approved",
  runState: "building",
  model: "opus",
  effort: "high",
  revisions: [
    { version: 1, receivedAt: oct(14, 22, 37, 3), markdown: dialcrownPlan(DIALCROWN_V1_TITLE), comments: dialcrownFeedback() },
    { version: 2, receivedAt: oct(14, 23, 52), markdown: dialcrownPlan(DIALCROWN_TITLE) },
    { version: 3, receivedAt: oct(15, 9, 14), markdown: dialcrownPlan(DIALCROWN_TITLE) },
    { version: 4, receivedAt: oct(15, 18, 40), markdown: dialcrownPlan(DIALCROWN_TITLE) },
  ],
};

const VEHICLE_SESSION: SeedSession = {
  sessionId: "vehicle-3d",
  projectPath: `${HOME}/projects/garage`,
  createdAt: oct(17, 15, 2),
  updatedAt: oct(17, 16, 12),
  status: "in_review",
  revisions: [{ version: 1, receivedAt: oct(17, 15, 40), markdown: "# Every vehicle gets a 3D model\n\nGenerate a model per vehicle from its photos.\n" }],
};

const MACHINE_OS_SESSION: SeedSession = {
  sessionId: "machineos-full-bore",
  projectPath: MACHINE_OS,
  createdAt: oct(16, 9, 0),
  updatedAt: oct(17, 14, 30),
  status: "approved",
  runState: "building",
  revisions: [{ version: 1, receivedAt: oct(16, 9, 0), markdown: '# MachineOS "Full Bore" sprint\n\nEverything on the board, in one sprint.\n' }],
};

/** IN REVIEW, newest first: the five drawn rows, then the nine behind
 *  "Show 9 more". */
const IN_REVIEW_TITLES = [
  "Component meshes from a splat",
  "Foundation docs for gpu-harness",
  'Skip the "trust this folder" prompt',
  "Memory surface: kill the jank",
  "Theme cull + light theme",
];

function inReviewSessions(): SeedSession[] {
  const drawn = IN_REVIEW_TITLES.map((title, i) => ({
    sessionId: `review-${i + 1}`,
    projectPath: REDLINE,
    createdAt: oct(16, 12 - i, 0),
    updatedAt: oct(17, 12 - i, 0),
    status: "in_review" as const,
    revisions: [{ version: 1, receivedAt: oct(16, 12 - i, 0), markdown: `# ${title}\n\nIn review.\n` }],
  }));
  const hidden = Array.from({ length: 9 }, (_, i) => ({
    sessionId: `review-more-${i + 1}`,
    projectPath: REDLINE,
    createdAt: oct(10, 10, i),
    updatedAt: oct(11, 10, i),
    status: "in_review" as const,
    filler: true,
    revisions: [{ version: 1, receivedAt: oct(10, 10, i), markdown: `# Older plan ${i + 1} (filler behind "Show 9 more")\n\nIn review.\n` }],
  }));
  return [...drawn, ...hidden];
}

const BUILD_TERMINAL = "t-dialcrown-build";
const VEHICLE_TERMINAL = "t-vehicle-3d";
const MACHINE_TERMINAL = "t-machineos";

function reviewScenario(): Scenario {
  const terminals: SeedTerminal[] = [
    {
      id: BUILD_TERMINAL,
      cwd: DIALCROWN,
      screen: `\u001b]0;${DIALCROWN_TITLE}\u0007${shellScreen(DIALCROWN)}claude\r\n\r\n\u001b[38;5;209m✻\u001b[0m Building v4: step 3 of 11\r\n`,
      sessionId: DIALCROWN_SESSION.sessionId,
      attention: { kind: "working" },
      attentionAt: NOW - 4 * MIN,
      convo: [],
    },
    {
      id: VEHICLE_TERMINAL,
      cwd: VEHICLE_SESSION.projectPath,
      screen: shellScreen(VEHICLE_SESSION.projectPath),
      sessionId: VEHICLE_SESSION.sessionId,
      attention: { kind: "needs-you", reason: "permission_prompt", message: "Claude has a question for you" },
      attentionAt: NOW - 8 * MIN,
      convo: [],
    },
    {
      id: MACHINE_TERMINAL,
      cwd: MACHINE_OS,
      screen: shellScreen(MACHINE_OS),
      sessionId: MACHINE_OS_SESSION.sessionId,
      attention: { kind: "working" },
      attentionAt: NOW - 30 * MIN,
      convo: [],
    },
  ];
  return {
    id: "5a",
    title: "Review a plan",
    viewport: { width: 1600, height: 960 },
    now: NOW,
    sessions: [VEHICLE_SESSION, DIALCROWN_SESSION, MACHINE_OS_SESSION, ...inReviewSessions()],
    chats: [],
    terminals,
    heldSessionId: null,
    storage: baseStorage({ "redline.frontDoor.project": { path: DIALCROWN }, "redline.lastLaunchProject": DIALCROWN }),
    session: dock(terminals.map((t) => ({ id: t.id, cwd: t.cwd }))),
    memoryAt: NOW - 2 * HOUR,
    openSessionId: DIALCROWN_SESSION.sessionId,
    ownerInitials: "IM",
    prompt: null,
  };
}

/** The workbench walk's world: the DIN project with the roadmap plan and its
 *  terminal, nothing held, so boot lands on Home's door. */
function workbenchScenario(): Scenario {
  return { ...dinScenario("workbench", "Workbench walk", true), viewport: { width: 1440, height: 900 }, heldSessionId: null, openSessionId: null };
}

export const SCENARIOS: Record<BoardId, () => Scenario> = {
  workbench: workbenchScenario,
  "4a": () => dinScenario("4a", "1 · Start", false),
  "4b": () => dinScenario("4b", "2 · Claude plans", false),
  "4c": () => dinScenario("4c", "3 · You redline", true),
  "4d": () => dinScenario("4d", "Managing sessions · Tools", true),
  "5a": reviewScenario,
};

/** The walk's scene names (scripts/app-visual-qa.mjs) all seed `workbench`. */
export const SCENE_ALIASES: Record<string, BoardId> = {
  home: "workbench",
  "door-tab": "workbench",
  plan: "workbench",
  agent: "workbench",
  browser: "workbench",
  sidebar: "workbench",
};

/** The scenario for `?board=`: an id, a scene alias, else `workbench`. */
export function scenarioFor(id: string | null): Scenario {
  const key = (id && (SCENE_ALIASES[id] ?? id)) as BoardId | null;
  const make = (key && SCENARIOS[key]) || SCENARIOS.workbench;
  return make();
}
