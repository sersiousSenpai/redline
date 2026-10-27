// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The session stage (PLAN C3): one session's conversation and, once it
//! exists, its plan, in the pose the rules in lib/flowPose.ts pick.
//!
//! - **closed** (4b, 4d): the conversation has the whole stage.
//! - **split** (4c): the companion column on the left (Chat | Feedback), the
//!   plan panel on the paper beside it — header, the plan, footer.
//! - **full** (5a): the plan in the centre, and the same companion column on
//!   the right.
//!
//! The companion column is one thing in both poses: its Chat tab is the
//! conversation and its Feedback tab is the review (components/plan/FeedbackPanel),
//! which comes forward by itself when there is something to decide: a mark
//! being written, a highlight or margin note clicked, a new version arriving
//! with answers waiting on you.
//!
//! Two things here must never remount, and neither is rendered by this file:
//!
//! - **The conversation** is App's: a portal into a bounded host element
//!   that this file only *places* — into the stage, the column or the Chat
//!   tab — moving the node, so its subscription, its state and (restored
//!   here) its scroll survive every pose change. With the Feedback tab
//!   showing it has no slot and waits, detached and still live.
//! - **The plan** is App's existing document plate (the Tiptap editor with
//!   its track changes, comments and marks), handed in as `planBody` and kept
//!   at one position in this tree in every pose — hidden, not unmounted,
//!   while the plan is closed, so Show plan is instant.
//!
//! The terminal view (⌘J) is App's too: the dock is positioned over this
//! element and shows the session's PTY alone. Only "no terminal" is drawn
//! here.

import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { TerminalSquare } from "lucide-react";

import type { StageTarget } from "../lib/flowSessions";
import { useStageDock } from "../lib/stageDock";
import {
  effectivePose,
  NARROW_STAGE_PX,
  planColumnVars,
  closePlan,
  toggleFull,
  noteRevision,
} from "../lib/flowPose";
import { setPanelTab, setStage, useFlow, type PlanPose } from "./flowState";
import { feedbackSummary } from "../lib/feedbackThreads";
import { latestDisplayVersion } from "../lib/revisionVersions";
import type { Comment, ReviewSession } from "../types";
import { PlanPanelHeader, type PlanMenuItem } from "../components/plan/PlanPanelHeader";
import { footerTally, PlanPanelFooter, type PlanPanelFooterProps } from "../components/plan/PlanPanelFooter";
import { PlanNotices, type PlanNoticesProps } from "../components/plan/PlanNotices";
import { DiscussionZoomContext } from "../components/DiscussionViewContext";
import { useOrchestration } from "../hooks/useOrchestration";
import { buildProgress } from "../lib/flowPose";
import type { VersionPillProps } from "../components/plan/VersionPill";
// The Feedback tab, its header row and its composer are the feedback lane's;
// they ride this chunk (as does feedback.css, the margin note's look).
import FeedbackPanel, {
  FeedbackComposer,
  FeedbackTabs,
  type FeedbackActions,
  type FeedbackComposerProps,
} from "../components/plan/FeedbackPanel";
import "./stage.css";

export type ConversationLayout = "stage" | "column" | "panel";

export interface FlowStageProps {
  target: Exclude<StageTarget, { kind: "start" }>;
  harness: "claude" | "codex";
  /** App's bounded portal host holding the session's conversation. */
  conversationHost: HTMLElement;
  /** The painted pose, for the conversation's `layout` and App's plate. */
  onPose: (pose: PlanPose, layout: ConversationLayout) => void;
  /** The plan exists and its document is on the plate. */
  hasPlan: boolean;
  /** App's plan document (scroller, article, editor), placed as-is. */
  planBody: ReactNode;
  /** The latest version, for the header and the revision rule. */
  latestVersion: number | null;
  /** The plan thread's comments (App's `threadComments`): the marks the
   *  next Send carries are read off them. */
  comments: readonly Comment[];
  viewing: VersionPillProps | null;
  contents: { open: boolean; onToggle: (() => void) | null };
  width: { wide: boolean; measure: number };
  footer: Omit<PlanPanelFooterProps, "pose" | "comments" | "detached">;
  /** Classic's plan-pane notices; the stage works out the clean-slate
   *  pointer and the terminal itself. */
  notices: Omit<PlanNoticesProps, "prior" | "onShowTerminal">;
  /** The plan's own actions, for the header's ⋯ (classic's Download and
   *  Live Session menus): each runs on this session and the version shown. */
  planMenu: {
    onExport: (sessionId: string, version: number) => void;
    onExportDocx: (sessionId: string, version: number) => void;
    onSaveObsidian: (sessionId: string, version: number) => void;
    onShare: () => void;
    /** Null when the workspace has live collaboration off. */
    onInvite: (() => void) | null;
    onMove: (sessionId: string) => void;
  };
  /** The Feedback tab's data (FeedbackPanel's props, App's sources); null
   *  before the session has loaded. */
  feedback: {
    session: ReviewSession;
    viewingVersion: number;
    onJumpToAnchor: (anchorId: string, commentId?: string) => void;
    focusedCommentId?: string | null;
    submitInFlight?: boolean;
    actions?: Partial<FeedbackActions>;
    onViewResearch?: (comment: Comment) => void;
    /** The tab's resting composer: a note on a selection, or on the plan. */
    composer: Omit<FeedbackComposerProps, "session">;
    /** Put another version on screen (App's viewed version). */
    onOpenVersion?: (version: number) => void;
    /** The composer's Send: that mark's discussion starts once. A voice
     *  note: its thread opens once. */
    autoDiscussId?: string | null;
    onAutoDiscussConsumed?: () => void;
    autoOpenId?: string | null;
    onAutoOpenConsumed?: () => void;
  } | null;
  /** The comment composer while a mark is being written, else null. */
  composer: ReactNode;
  /** Classic's discussion text size (its threads' A−/A+), for the
   *  Feedback tab's discussions. */
  discussionZoom: { value: number; adjust: (delta: number) => void };
  /** ⌘J: the stage shows the session's terminal. */
  terminalView: boolean;
  /** App's terminal dock, laid over this stage while it shows the PTY. */
  terminalDock: RefObject<HTMLElement | null>;
}

export default function FlowStage(p: FlowStageProps) {
  const sessionId = p.target.kind === "plan" ? p.target.sessionId : null;
  // "Building v4: step 3 of 11": an orchestrated build's own count, read
  // here (off the boot path) while its run is live.
  const run = useOrchestration(sessionId, !!p.footer.approval?.runLive);
  const runProgress = buildProgress(run);
  const stored = useFlow((s) => (sessionId && s.planPose[sessionId]) || "closed");
  const tab = useFlow((s) => s.panelTab);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setNarrow(el.getBoundingClientRect().width < NARROW_STAGE_PX);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pose = effectivePose({ stored, hasPlan: p.hasPlan, narrow });
  // What the marks are, read off the comments (classic's footer and pane
  // read the same): the latest's unsent ones for the header, the version on
  // screen's open ones for "entering full opens Feedback".
  const marks = footerTally(p.comments, p.footer.waiting).marks;
  const session = p.feedback?.session ?? null;
  const shownVersion = p.viewing ? p.viewing.viewing : p.latestVersion;
  const shown = session?.revisions.find((r) => r.versionNumber === shownVersion)?.comments ?? [];
  const summary = p.feedback ? feedbackSummary(p.feedback.session, p.feedback.viewingVersion) : null;
  // Rule 4's "anything to read in Feedback": decisions waiting on you and
  // your own marks, across the thread (a new version's slate is clean).
  const unresolved = (summary?.waiting ?? 0) + (summary?.marks ?? 0);
  // Classic's notice points at last round's version; the Feedback tab now
  // reads that round's answers itself, so the pointer is only for the rest.
  const prior = session && !p.viewing && shown.length === 0 && !summary?.waiting ? priorWithComments(session, p.latestVersion) : null;
  const displayVersion = session && p.latestVersion !== null ? latestDisplayVersion(session.revisions, p.latestVersion) : p.latestVersion;
  const showTerminal = p.target.terminalId ? () => setStage("terminal") : null;
  const notices = <PlanNotices {...p.notices} prior={prior} onShowTerminal={showTerminal} />;
  const menu: PlanMenuItem[] =
    // A live room you joined has no session of its own to export or move.
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
  // ⌘J: the dock over this stage's box, showing the session's PTY alone.
  useStageDock(p.terminalDock, rootRef, p.terminalView && !!p.target.terminalId);
  const layout: ConversationLayout = pose === "full" ? "panel" : pose === "split" ? "column" : "stage";

  const onPose = p.onPose;
  useLayoutEffect(() => {
    onPose(pose, layout);
  }, [pose, layout, onPose]);

  // Rule 3: a new revision opens the plan beside the conversation, once.
  useLayoutEffect(() => {
    if (sessionId && p.hasPlan && p.latestVersion !== null) noteRevision(sessionId, p.latestVersion);
  }, [sessionId, p.hasPlan, p.latestVersion]);

  // The Feedback tab comes forward by itself when there is something to
  // decide: a mark being written (it is written there), a highlight or
  // margin note clicked in the plan, a new version with answers waiting.
  const composing = p.composer != null && p.composer !== false;
  useLayoutEffect(() => {
    if (composing && pose !== "closed") setPanelTab("feedback");
  }, [composing, pose]);
  const focused = p.feedback?.focusedCommentId ?? null;
  useLayoutEffect(() => {
    if (focused && pose !== "closed") setPanelTab("feedback");
  }, [focused, pose]);
  const waiting = summary?.waiting ?? 0;
  const announced = useRef<string | null>(null);
  useLayoutEffect(() => {
    const key = `${sessionId}:${p.latestVersion}`;
    if (!sessionId || p.latestVersion === null || pose === "closed" || announced.current === key) return;
    announced.current = key;
    if (waiting > 0) setPanelTab("feedback");
  }, [sessionId, p.latestVersion, pose, waiting]);

  // Where the conversation goes: the stage or the column, else the Chat tab.
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  useConversationPlacement(p.conversationHost, slot);

  const full = pose === "full";
  const headerPose = full ? "full" : "split";
  const toggleContents = p.contents.onToggle;
  // The companion column: Chat | Feedback, left of the plan in split and
  // right of it in full; one component, so the two poses read the same.
  const companion = (
    <aside className="rl-flow-panel" data-side={full ? "right" : "left"} aria-label="Chat and feedback" data-flow-right-panel={full ? "" : undefined}>
      <FeedbackTabs
        tab={tab}
        onTab={setPanelTab}
        count={summary?.count ?? 0}
        allResolved={summary?.allResolved ?? false}
        waiting={waiting}
      />
      <div
        className="rl-flow-panel-body"
        role="tabpanel"
        style={{ "--rl-discussion-zoom": p.discussionZoom.value } as CSSProperties}
      >
        <DiscussionZoomContext.Provider value={p.discussionZoom.adjust}>
        {tab === "chat" ? (
          <div ref={setSlot} className="rl-flow-convo" data-layout={layout} />
        ) : p.feedback ? (
          <FeedbackPanel
            session={p.feedback.session}
            viewingVersion={p.feedback.viewingVersion}
            onJumpToAnchor={p.feedback.onJumpToAnchor}
            focusedCommentId={p.feedback.focusedCommentId}
            submitInFlight={p.feedback.submitInFlight}
            actions={p.feedback.actions}
            onViewResearch={p.feedback.onViewResearch}
            onOpenVersion={p.feedback.onOpenVersion}
            autoDiscussId={p.feedback.autoDiscussId}
            onAutoDiscussConsumed={p.feedback.onAutoDiscussConsumed}
            autoOpenId={p.feedback.autoOpenId}
            onAutoOpenConsumed={p.feedback.onAutoOpenConsumed}
            composer={p.composer || <FeedbackComposer session={p.feedback.session} {...p.feedback.composer} />}
          />
        ) : null}
        </DiscussionZoomContext.Provider>
      </div>
    </aside>
  );
  return (
    <div
      ref={rootRef}
      className="rl-flow-stage"
      data-pose={pose}
      data-target={p.target.kind}
      data-terminal-view={p.terminalView ? "" : undefined}
      style={planColumnVars(pose, p.width.wide, p.width.measure)}
    >
      {pose === "closed" && (
        <div className="rl-flow-convo-col" data-layout={layout}>
          {/* With the plan closed its notices head the conversation. */}
          {p.hasPlan && notices}
          <div ref={setSlot} className="rl-flow-convo" data-layout={layout} />
        </div>
      )}
      {pose === "split" && companion}
      {p.hasPlan && (
        <section className="rl-flow-plan" data-pose={pose} hidden={pose === "closed"} aria-label="Plan">
          <PlanPanelHeader
            pose={headerPose}
            version={displayVersion}
            marks={marks}
            viewing={p.viewing}
            onToggleContents={toggleContents}
            contentsOpen={p.contents.open}
            onToggleFull={() => sessionId && toggleFull(sessionId, unresolved)}
            menu={menu}
            onClose={() => sessionId && closePlan(sessionId)}
          />
          <div className="rl-flow-plan-body">
            {pose !== "closed" && notices}
            {p.planBody}
          </div>
          <PlanPanelFooter
            pose={headerPose}
            {...p.footer}
            comments={p.comments}
            detached={p.notices.detached ? (p.notices.detached.restoring ? "restoring" : "ended") : null}
            progress={p.footer.progress ?? runProgress}
          />
        </section>
      )}
      {full && companion}
      {p.terminalView && !p.target.terminalId && (
        <div className="rl-flow-noterm" role="status">
          <TerminalSquare aria-hidden size={18} strokeWidth={1.75} />
          <span>This session isn't running in one of Redline's terminals.</span>
        </div>
      )}
    </div>
  );
}

/** Keep the conversation's host in `slot`, carrying every scroller's place
 *  across the move: a node laid out afresh starts at its top, so a thread
 *  moved into the Chat tab would open on its first message. One that sat at
 *  its end stays at its end. */
function useConversationPlacement(host: HTMLElement, slot: HTMLElement | null) {
  const kept = useRef<{ el: HTMLElement; top: number; end: boolean }[]>([]);
  useLayoutEffect(() => {
    if (!slot) {
      host.remove();
      return;
    }
    slot.appendChild(host);
    for (const { el, top, end } of kept.current) {
      if (el.isConnected) el.scrollTop = end ? el.scrollHeight : top;
    }
    kept.current = [];
    return () => {
      if (host.parentElement !== slot) return;
      kept.current = [...host.querySelectorAll<HTMLElement>("*")]
        .filter((el) => el.scrollHeight > el.clientHeight && el.scrollTop > 0)
        .map((el) => ({
          el,
          top: el.scrollTop,
          end: el.scrollHeight - el.scrollTop - el.clientHeight < 4,
        }));
      host.remove();
    };
  }, [host, slot]);
}

/** The clean slate: the latest version arrives with no comments, and the
 *  last round's live on an earlier version of the same thread. */
function priorWithComments(session: ReviewSession, latest: number | null): number | null {
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
