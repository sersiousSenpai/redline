// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
// Board 5a's plan session: "Dialcrown", viewed at v1 while v4 builds. Its
// sixteen comments are the right panel's — one voice note awaiting Accept,
// the three resolved threads the board shows, and twelve more resolved.
// The section tree is shaped the way parser.rs mints it, so the panel's
// anchors ("Context · ¶3", "§4 · step 4", "§4 · releases", "§4") come out
// of the real labeller, not of the fixture.
import type { Comment, Paragraph, ReviewSession, Revision, Section } from "../../../types";

const p = (anchorId: string, blockId: string, markdown: string): Paragraph => ({ anchorId, blockId, markdown, text: markdown });
const s = (anchorId: string, blockId: string, level: number, title: string, paragraphs: Paragraph[] = [], children: Section[] = []): Section => ({
  anchorId,
  blockId,
  level,
  title,
  bodyMarkdown: paragraphs.map((x) => x.markdown).join("\n\n"),
  paragraphs,
  children,
});

export const boardSections: Section[] = [
  s("A", "blk-title", 1, "Dialcrown: fastest credible launch, Quo parity, and the voice-agent decision", [], [
    s("A.1", "blk-context", 2, "Context", [
      p("A.1.p1", "blk-ctx1", "A launch-first plan. It benchmarks Dialcrown against Quo and RingCentral, evaluates Guava as the voice-agent platform, and designs one configuration that drives the record, the agent and the call flow."),
      p("A.1.p2", "blk-ctx2", "The test throughout: the smallest release a customer can use and pay for."),
      p("A.1.p3", "blk-ctx3", "The pilot is a California PI intake desk. All-party consent and confidentiality matter more here than in home services."),
    ]),
    s("A.2", "blk-decisions", 2, "Decisions you made", [
      p("A.2.p1", "blk-dec-table", "| Decision | Choice |\n|---|---|\n| First pilot | **A law firm.** California PI intake. |\n| Voice agent | **Fast-follow.** The pilot runs on human-answered calls. |\n| Runtime | **Decide in §5.** Telnyx AI Assistants vs. Guava. |\n| Accounts | **Mostly ready.** Stripe and Resend verification are now on the critical path. |"),
    ]),
    s("A.3", "blk-gates", 2, "3. Compliance gates", [
      p("A.3.p1", "blk-gates1", "Vendor terms and the notice text both gate the pilot."),
    ]),
    s("A.4", "blk-build", 2, "4. Build and release", [
      p("A.4.p1", "blk-steps", "1. Stand up the intake record.\n2. Wire softphone calling.\n3. Add the texting inbox.\n4. Use one shared type-coercion helper for extraction output and human corrections.\n5. Prove the E911 path.\n6. Get notice-text sign-off from outside counsel."),
      p("A.4.p2", "blk-releases", "**Releases.** R1 is internal dogfooding. Public launch is gated on full in-app calling with a proven E911 path."),
    ]),
    s("A.5", "blk-runtime", 2, "5. Runtime", [
      p("A.5.p1", "blk-runtime1", "Telnyx AI Assistants vs. Guava, decided on latency and consent handling."),
      p("A.5.p2", "blk-runtime2", "- Latency under 800 ms\n- Consent prompt before recording\n- Per-call config pinned"),
    ]),
  ]),
];

const resolved = (v: number, body: string) => ({ body, appearedInVersion: v, acceptedAt: v === 2 ? 1_760_400_000_000 : null });

let n = 0;
const at = (over: Partial<Comment> & Pick<Comment, "anchorId" | "body" | "status">): Comment => {
  n += 1;
  return { id: `c-${String(n).padStart(3, "0")}`, type: "feedback", createdAt: 1_760_300_000_000 + n * 60_000, ...over };
};

/** The board's comments, in the order they were written. */
export const boardComments: Comment[] = [
  at({
    anchorId: "A.1.p3",
    blockId: "blk-ctx3",
    author: "voice",
    status: "resolved",
    body: "The pilot firm is my own firm. Keep the vendor-terms and notice gates anyway, and get notice-text sign-off from someone other than me.",
    resolution: resolved(2, "Done. §3 and §4 now treat R1 as internal dogfooding. Both gates stay. Notice-text sign-off goes to outside counsel in step 6."),
  }),
  at({
    anchorId: "A.4.p1",
    blockId: "blk-steps",
    status: "accepted",
    selection: { charStart: 90, charEnd: 125, quotedText: "Use one shared type-coercion helper", subBlockId: "blk-steps.l4.w1-w5" },
    body: "Use one shared type-coercion helper for extraction output and human corrections, validated against the call's pinned config.",
    resolution: resolved(2, "Step 4 now names one helper for both paths."),
  }),
  at({
    anchorId: "A.4.p2",
    blockId: "blk-releases",
    status: "accepted",
    body: "Reframe the releases: R1 is internal dogfooding. Public launch is gated on full in-app calling with a proven E911 path.",
    resolution: resolved(2, "Releases reframed."),
  }),
  at({
    anchorId: "A.4",
    blockId: "blk-build",
    status: "accepted",
    body: "Add an iOS launch track with feature parity to web: softphone, VoIP push, texting inbox, call list.",
    resolution: resolved(2, "Added an iOS track to §4."),
  }),
  ...[
    ["A.1.p1", "blk-ctx1", "Name Quo and RingCentral as the parity bar, not every softphone on the market."],
    ["A.1.p2", "blk-ctx2", "Say what \"pay for\" means: the first invoice, not a signed LOI."],
    ["A.2.p1", "blk-dec-table", "Keep the law-firm pilot, but say why home services waits."],
    ["A.3", "blk-gates", "Split vendor terms from the notice text: they have different owners."],
    ["A.3.p1", "blk-gates1", "Both gates need a named owner and a date."],
    ["A.4.p1", "blk-steps", "Step 2 should say which carrier the softphone uses."],
    ["A.4.p1", "blk-steps", "Move the E911 proof ahead of the texting inbox."],
    ["A.4.p2", "blk-releases", "R2 needs its own exit criteria."],
    ["A.5", "blk-runtime", "Decide the runtime before the voice-agent fast-follow, not after."],
    ["A.5.p1", "blk-runtime1", "Measure latency on the pilot's real trunk."],
    ["A.5.p2", "blk-runtime2", "Pin the per-call config in the record, not the agent."],
    ["A.5.p2", "blk-runtime2", "Consent prompt copy goes to counsel with the notice text."],
  ].map(([anchorId, blockId, body]) =>
    at({ anchorId, blockId, body, status: "accepted", resolution: resolved(2, "Done.") }),
  ),
];

const revision = (versionNumber: number, comments: Comment[]): Revision => ({
  versionNumber,
  receivedAt: 1_760_300_000_000 + versionNumber * 86_400_000,
  rawPlanMarkdown: "",
  sections: boardSections,
  comments,
  threadStart: versionNumber === 1,
  restored: false,
});

export const boardSession: ReviewSession = {
  sessionId: "qa-dialcrown",
  projectPath: "/code/dialcrown",
  projectName: "dialcrown",
  createdAt: 1_760_300_000_000,
  revisions: [revision(1, boardComments), revision(2, []), revision(3, []), revision(4, [])],
  status: "approved",
  attachState: "idle",
  backend: "claude-code",
  model: "claude-opus-4-5",
  effort: "high",
};

/** The 4c margin note: Imani's, under step 2 of "1. Finish Track B". */
export const marginNote = { initials: "IM", text: "Run this against staging first, not prod." };

/** Every other state a thread can be in, for the contrast sweep and the
 *  integrator's eye: a draft, one with Claude, a reopened one with its
 *  follow-up, an answered question, an agent's suggested edit, and one
 *  from an outside reviewer. */
export const statesSession: ReviewSession = {
  ...boardSession,
  sessionId: "qa-states",
  revisions: [
    {
      ...revision(1, [
        { id: "s-001", type: "feedback", anchorId: "A.4.p1", blockId: "blk-steps", createdAt: 1, status: "draft", body: "Step 5 should name the carrier.", selection: { charStart: 0, charEnd: 10, quotedText: "Prove the E911 path", subBlockId: "blk-steps.l5" } },
        { id: "s-002", type: "question", anchorId: "A.5.p1", blockId: "blk-runtime1", createdAt: 2, status: "submitted", body: "Why not decide the runtime now?" },
        {
          id: "s-003", type: "feedback", anchorId: "A.3", blockId: "blk-gates", createdAt: 3, status: "reopened", body: "Both gates need owners.",
          reopenNote: "Name counsel as the notice-text owner.", resolution: resolved(2, "Owners added to §3."),
        },
        { id: "s-004", type: "question", anchorId: "A.2.p1", blockId: "blk-dec-table", createdAt: 4, status: "resolved", body: "Why a law firm first?", selection: { charStart: 0, charEnd: 5, quotedText: "First pilot", subBlockId: "blk-dec-table.l3" }, resolution: resolved(2, "Consent and confidentiality are the hardest case; if intake works there it works anywhere.") },
        { id: "s-005", type: "edit", anchorId: "A.1.p2", blockId: "blk-ctx2", createdAt: 5, status: "draft", author: "agent-1", body: "(edit)", edit: { original: "the smallest release a customer can use", revised: "the smallest release a paying customer can use" } },
        { id: "s-006", type: "feedback", anchorId: "A.4.p2", blockId: "blk-releases", createdAt: 6, status: "submitted", body: "R2 needs exit criteria.", reviewer: "Imani Moore", reopenNote: "Still missing." },
      ]),
    },
  ],
};
