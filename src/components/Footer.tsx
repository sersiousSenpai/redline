// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The window's status bar (W6, the design's RLFooter): one quiet 28px row.
// Left, Memory — a dot and the word, its "organized N ago · N ready" in the
// tooltip, a click its status popover — and a review an agent is waiting
// on. Right, the live session, where an editor puts presence (idle, live,
// joined), and the bridge the hooks reach (:7676).
//
// It carries no status text (D27): the plan's state in a word and the
// "Working" line went, and so did the Plan a build pill that sat in its
// centre. What the agent is doing is said where the agent is (its Agent
// tab, the session's row), the sessions waiting on you are the top bar's
// "N need you" (⌘⇧J), and the door is ⌘T, ⇧⏎, the palette and the
// sidebar's New tab.
//
// It holds NO plan verbs (D13): Send, Approve & build, Build and Reopen live
// in the Plan pane's own footer, where the plan is.

import type { DaemonState } from "../types";
import { LiveSessionMenu, type LiveSessionMenuProps } from "./LiveSessionMenu";
import { MemoryStatusPill } from "./MemoryStatusPill";

export interface FooterProps {
  /** Memory's chip (left), when the manifest has Memory. */
  memory?: { onOpenMemory: () => void; onOpenInspector: () => void } | null;
  /** The live session's control (right), when the manifest has collab. */
  live?: LiveSessionMenuProps | null;
  /** An agent's review request, waiting for you ("Review ready"), or null. */
  reviewNews?: string | null;
  onOpenReviewNews?: () => void;
  /** How far this window's daemon got binding its port. */
  bridge?: DaemonState;
}

/** The daemon's port: the hooks, the skills' curl bridge and MCP reach it. */
export const BRIDGE_PORT = 7676;

export function Footer({
  memory = null,
  live = null,
  reviewNews = null,
  onOpenReviewNews,
  bridge = "ready",
}: FooterProps) {
  return (
    <footer className="rl-app-footer rl-statusbar" aria-label="Status">
      <span className="rl-footer-status">
        {memory && <MemoryStatusPill onOpenMemory={memory.onOpenMemory} onOpenInspector={memory.onOpenInspector} />}
        {/* The way to a review an agent asked for, instead of being taken
            there: present only while it waits. */}
        {memory && reviewNews && onOpenReviewNews && <span className="rl-statusbar-sep" aria-hidden>·</span>}
        {reviewNews && onOpenReviewNews && (
          <button type="button" className="rl-statusbar-chip" data-tone="info" onClick={onOpenReviewNews} title="Open the review surface">
            {reviewNews} → Open
          </button>
        )}
      </span>
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
