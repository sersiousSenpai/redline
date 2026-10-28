// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The Plan tab's chrome (RLPanePlan): the 28px header — Contents, the
//! version and marks, the version pill while an older version is on screen,
//! the ⋯ with the plan's own actions — the notices strip, the plan body
//! (App's one editor, through its singleton slot), and the 44px footer with
//! the review's verbs. The same header, notices and footer the flow stage
//! drew, in the pane pose; the sources are App's bundles, handed in whole.
//!
//! Doc controls never hide: Contents lives here, and the floating zoom +
//! width pill stands above the footer (styles.css seats it).

import type { ReactNode } from "react";

import { feedbackSummary } from "../../lib/feedbackThreads";
import { latestDisplayVersion } from "../../lib/revisionVersions";
import type { Comment, ReviewSession } from "../../types";
import { PlanNotices, hasNotices, type PlanNoticesProps } from "./PlanNotices";
import { PlanPanelFooter, footerTally, type PlanPanelFooterProps } from "./PlanPanelFooter";
import { PlanPanelHeader, type PlanMenuItem } from "./PlanPanelHeader";
import type { VersionPillProps } from "./VersionPill";
import "./plan.css";

/** The plan's own actions, each run on this session and the version shown. */
export interface PlanMenuActions {
  onExport: (sessionId: string, version: number) => void;
  onExportDocx: (sessionId: string, version: number) => void;
  onSaveObsidian: (sessionId: string, version: number) => void;
  onShare: () => void;
  /** Null when the workspace has live collaboration off. */
  onInvite: (() => void) | null;
  onMove: (sessionId: string) => void;
}

export interface PlanPaneProps {
  sessionId: string | null;
  /** The loaded session, for the clean-slate pointer and the menu. */
  session: ReviewSession | null;
  latestVersion: number | null;
  /** The plan thread's comments: the marks the next Send carries. */
  comments: readonly Comment[];
  viewing: VersionPillProps | null;
  contents: { open: boolean; onToggle: (() => void) | null };
  footer: Omit<PlanPanelFooterProps, "pose" | "comments" | "detached">;
  notices: Omit<PlanNoticesProps, "prior" | "onShowTerminal">;
  planMenu: PlanMenuActions;
  /** Show the session's terminal, when it has one. */
  onShowTerminal: (() => void) | null;
  /** The plan body: App's singleton slot. */
  children: ReactNode;
}

export default function PlanPane(p: PlanPaneProps) {
  const { sessionId, session, latestVersion } = p;
  const marks = footerTally(p.comments, p.footer.waiting).marks;
  const shownVersion = p.viewing ? p.viewing.viewing : latestVersion;
  const shown = session?.revisions.find((r) => r.versionNumber === shownVersion)?.comments ?? [];
  const summary = session ? feedbackSummary(session, shownVersion ?? latestVersion ?? 1) : null;
  // Classic's pointer at last round's version, when the latest is a clean
  // slate and nothing waits on you.
  const prior = session && !p.viewing && shown.length === 0 && !summary?.waiting ? priorWithComments(session, latestVersion) : null;
  const displayVersion = session && latestVersion !== null ? latestDisplayVersion(session.revisions, latestVersion) : latestVersion;
  const menu: PlanMenuItem[] =
    sessionId && session && shownVersion !== null
      ? [
          { id: "md", label: "Download as Markdown", detail: `v${shownVersion} as a .md file`, onPick: () => p.planMenu.onExport(sessionId, shownVersion) },
          { id: "docx", label: "Download as Word", detail: `v${shownVersion} as a .docx file`, onPick: () => p.planMenu.onExportDocx(sessionId, shownVersion) },
          { id: "obsidian", label: "Save to Obsidian", detail: "A note in your vault", onPick: () => p.planMenu.onSaveObsidian(sessionId, shownVersion) },
          { id: "share", label: "Share a snapshot…", detail: "Someone reviews it and sends comments back", onPick: p.planMenu.onShare },
          ...(p.planMenu.onInvite ? [{ id: "invite", label: "Invite to a live session…", detail: "Review it together, live", onPick: p.planMenu.onInvite }] : []),
          { id: "move", label: "Move to repo…", detail: "The project it belongs to", onPick: () => p.planMenu.onMove(sessionId) },
        ]
      : [];
  const notices: PlanNoticesProps = { ...p.notices, prior, onShowTerminal: p.onShowTerminal };
  return (
    <section className="rl-plan-pane" aria-label="Plan" data-plan-pane>
      <PlanPanelHeader
        pose="pane"
        version={displayVersion}
        marks={marks}
        viewing={p.viewing}
        onToggleContents={p.contents.onToggle}
        contentsOpen={p.contents.open}
        menu={menu}
      />
      {hasNotices(notices) && <PlanNotices {...notices} />}
      <div className="rl-plan-pane-body">{p.children}</div>
      <PlanPanelFooter
        pose="pane"
        {...p.footer}
        comments={p.comments}
        detached={p.notices.detached ? (p.notices.detached.restoring ? "restoring" : "ended") : null}
      />
    </section>
  );
}

/** The clean slate: the latest version arrives with no comments, and the
 *  last round's live on an earlier version of the same thread. */
export function priorWithComments(session: ReviewSession, latest: number | null): number | null {
  const revisions = session.revisions;
  let start = 0;
  revisions.forEach((r, i) => {
    if (r.threadStart) start = i;
  });
  for (let i = revisions.length - 1; i >= start; i--) {
    const r = revisions[i];
    if (r.versionNumber !== latest && r.comments.length > 0) return r.versionNumber;
  }
  return null;
}
