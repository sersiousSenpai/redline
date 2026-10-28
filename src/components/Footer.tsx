// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The window's status bar (W6, the design's RLFooter): one 28px row of
// status around the Plan a build pill. Left, what is happening — the plan's
// state in a word, the author working (a press shows its terminal), a review
// an agent is waiting on, the terminals that need you. Centre, the pill's
// place: MonochatIsland's pill (hover → the compact composer, click → a door
// tab, an outside tap dismisses, the caret never moves on a hover) sits over
// it, centred on this row. Right, the bridge the hooks reach (:7676).
//
// Two chips came down from the top bar when it became the design's (D26):
// Memory, first on the left — a dot and the word, its "organized N ago · N
// ready" in the tooltip, a click its status popover — and the live session
// on the right, where an editor puts presence (idle, live, joined). Each is
// 20 px inside the row and present only when App hands it in; neither moves
// the pill, whose place is the row's fixed centre. The sessions waiting on
// you went up instead: the top bar's "N need you" is ⌘⇧J's.
//
// It holds NO plan verbs (D13): Send, Approve & build, Build and Reopen live
// in the Plan pane's own footer, where the plan is. A status bar that also
// approved would offer "Approve & build" over Home's door.

import type { Comment, DaemonState } from "../types";
import { agentLabelFor } from "../lib/backendChoice";
import { ridesSubmit } from "../lib/planSearch";
import { LiveSessionMenu, type LiveSessionMenuProps } from "./LiveSessionMenu";
import { MemoryStatusPill } from "./MemoryStatusPill";
import { Spinner } from "./Spinner";

/** The open plan, once approved. `runState` NULL is "approved · not built". */
export interface FooterApproval {
  version: number;
  runState: string | null;
}

export interface FooterProps {
  /** The open plan's thread: what the next Send carries is counted. */
  comments: Comment[];
  /** A session is open — false when the app sits on the door. */
  sessionReady: boolean;
  /** The plan's latest version, when one is open. */
  version?: number | null;
  /** The author is answering a Send. */
  waiting: boolean;
  /** The in-flight submit was an Ask batch — the author is answering. */
  waitingAsk: boolean;
  /** Present once the open plan is approved. */
  approval?: FooterApproval | null;
  /** The working line's press: show the terminal the agent works in. */
  onShowTerminal?: () => void;
  /** Memory's chip (left), when the manifest has Memory. */
  memory?: { onOpenMemory: () => void; onOpenInspector: () => void } | null;
  /** The live session's control (right), when the manifest has collab. */
  live?: LiveSessionMenuProps | null;
  /** An agent's review request, waiting for you ("Review ready"), or null. */
  reviewNews?: string | null;
  onOpenReviewNews?: () => void;
  /** Which provider authored this plan; absent reads as Claude. */
  backend?: string | null;
  /** How far this window's daemon got binding its port. */
  bridge?: DaemonState;
}

/** The daemon's port: the hooks, the skills' curl bridge and MCP reach it. */
export const BRIDGE_PORT = 7676;

/** The status line, in a word or two. Exported for the tests. */
export function footerStatus(p: Pick<FooterProps, "comments" | "sessionReady" | "version" | "waiting" | "waitingAsk" | "approval" | "backend">): { text: string; tone: "working" | "needs" | "done" | "idle" } {
  const author = agentLabelFor(p.backend);
  const v = p.version ? ` v${p.version}` : "";
  if (p.waiting) return { text: p.waitingAsk ? `${author} is answering${v ? ` on${v}` : ""}` : `${author} is revising${v}`, tone: "working" };
  if (p.approval) {
    const run = p.approval.runState;
    return { text: `Approved · v${p.approval.version} · ${run === null ? "not built" : run.replace(/_/g, " ")}`, tone: "done" };
  }
  if (!p.sessionReady) return { text: "No plan open", tone: "idle" };
  const pending = p.comments.filter(ridesSubmit).length;
  const waitingOnYou = p.comments.filter((c) => c.status === "resolved").length;
  if (waitingOnYou > 0) return { text: `In review${v} · ${waitingOnYou} ${waitingOnYou === 1 ? "answer" : "answers"} to read`, tone: "needs" };
  if (pending > 0) return { text: `In review${v} · ${pending} ${pending === 1 ? "mark" : "marks"} to send`, tone: "needs" };
  return { text: `In review${v}`, tone: "idle" };
}

export function Footer({
  comments,
  sessionReady,
  version = null,
  waiting,
  waitingAsk,
  approval = null,
  onShowTerminal,
  memory = null,
  live = null,
  reviewNews = null,
  onOpenReviewNews,
  backend,
  bridge = "ready",
}: FooterProps) {
  const status = footerStatus({ comments, sessionReady, version, waiting, waitingAsk, approval, backend });
  const dot = status.tone === "needs" ? "var(--color-warning)" : status.tone === "done" ? "var(--color-success)" : "var(--color-ink-muted)";
  return (
    <footer className="rl-app-footer rl-statusbar" aria-label="Status">
      <span className="rl-footer-status">
        {memory && (
          <>
            <MemoryStatusPill onOpenMemory={memory.onOpenMemory} onOpenInspector={memory.onOpenInspector} />
            <span className="rl-statusbar-sep" aria-hidden>·</span>
          </>
        )}
        {/* The way to a review an agent asked for, instead of being taken
            there: present only while it waits. Ahead of the status (only
            Memory's short chip comes before it), because a long status is
            cut off short of the pill, and this must never be out of sight. */}
        {reviewNews && onOpenReviewNews && (
          <>
            <button type="button" className="rl-statusbar-chip" data-tone="info" onClick={onOpenReviewNews} title="Open the review surface">
              {reviewNews} → Open
            </button>
            <span className="rl-statusbar-sep" aria-hidden>·</span>
          </>
        )}
        {status.tone === "working" ? (
          <button type="button" className="rl-statusbar-item rl-statusbar-press" onClick={onShowTerminal} title="Show terminal">
            <Spinner size={10} />
            <span>{status.text}</span>
          </button>
        ) : (
          <span className="rl-statusbar-item">
            <span aria-hidden className="rl-statusbar-dot" style={{ background: dot }} />
            <span>{status.text}</span>
          </span>
        )}
      </span>
      {/* The pill's place: MonochatIsland centres its pill on this row. */}
      <span className="rl-statusbar-pill" data-tour="pill" aria-hidden />
      <span className="rl-footer-meta">
        {live && <LiveSessionMenu {...live} />}
        <span className="rl-statusbar-item" title={bridge === "failed" ? `Another process holds port ${BRIDGE_PORT}: this window receives no plans` : `Plans reach Redline on port ${BRIDGE_PORT}`}>
          <span aria-hidden className="rl-statusbar-dot" style={{ background: bridge === "ready" ? "var(--color-success)" : bridge === "failed" ? "var(--color-warning)" : "var(--color-ink-muted)" }} />
          <span>{bridge === "failed" ? "Bridge offline" : `Bridge ${BRIDGE_PORT}`}</span>
        </span>
      </span>
    </footer>
  );
}
