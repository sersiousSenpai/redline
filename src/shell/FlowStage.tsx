// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The session stage (PLAN C3): one session's conversation and, once it
//! exists, its plan, in the pose the rules in lib/flowPose.ts pick.
//!
//! - **closed** (4b, 4d): the conversation has the whole stage.
//! - **split** (4c): the conversation as a 440px column, the plan panel on
//!   the paper beside it — header, the plan, footer.
//! - **full** (5a): the plan in the centre, and a 400px right panel whose
//!   Chat tab is the conversation and whose Feedback tab is the threads.
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
  type ReactNode,
} from "react";
import { TerminalSquare } from "lucide-react";

import type { StageTarget } from "../lib/flowSessions";
import {
  effectivePose,
  NARROW_STAGE_PX,
  planColumnVars,
  closePlan,
  toggleFull,
  noteRevision,
} from "../lib/flowPose";
import { setPanelTab, useFlow, type PlanPose } from "./flowState";
import { feedbackSummary } from "../lib/feedbackThreads";
import type { Comment, ReviewSession } from "../types";
import { PlanPanelHeader } from "./PlanPanelHeader";
import { PlanPanelFooter, type PlanPanelFooterProps } from "./PlanPanelFooter";
import type { VersionPillProps } from "./VersionPill";
// The Feedback tab, its header row and its composer are the feedback lane's;
// they ride this chunk (as does feedback.css, the margin note's look).
import FeedbackPanel, {
  FeedbackComposer,
  FeedbackTabs,
  type FeedbackActions,
  type FeedbackComposerProps,
} from "./FeedbackPanel";
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
  /** Unsent marks on the latest version. */
  marks: number;
  /** Marks waiting on an answer, for "entering full opens Feedback". */
  unresolved: number;
  viewing: VersionPillProps | null;
  contents: { open: boolean; onToggle: (() => void) | null };
  width: { wide: boolean; measure: number };
  footer: Omit<PlanPanelFooterProps, "pose">;
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
  } | null;
  /** The comment composer while a mark is being written, else null. */
  composer: ReactNode;
  /** ⌘J: the stage shows the session's terminal. */
  terminalView: boolean;
}

export default function FlowStage(p: FlowStageProps) {
  const sessionId = p.target.kind === "plan" ? p.target.sessionId : null;
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
  const layout: ConversationLayout = pose === "full" ? "panel" : pose === "split" ? "column" : "stage";

  const onPose = p.onPose;
  useLayoutEffect(() => {
    onPose(pose, layout);
  }, [pose, layout, onPose]);

  // Rule 3: a new revision opens the plan beside the conversation, once.
  useLayoutEffect(() => {
    if (sessionId && p.hasPlan && p.latestVersion !== null) noteRevision(sessionId, p.latestVersion);
  }, [sessionId, p.hasPlan, p.latestVersion]);

  // A mark being written in the full pose is written in Feedback.
  const composing = p.composer != null && p.composer !== false;
  useLayoutEffect(() => {
    if (composing && pose === "full") setPanelTab("feedback");
  }, [composing, pose]);

  // Where the conversation goes: the stage or the column, else the Chat tab.
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  useConversationPlacement(p.conversationHost, slot);

  const full = pose === "full";
  const headerPose = full ? "full" : "split";
  const summary = p.feedback ? feedbackSummary(p.feedback.session, p.feedback.viewingVersion) : null;
  const toggleContents = p.contents.onToggle;
  return (
    <div
      ref={rootRef}
      className="rl-flow-stage"
      data-pose={pose}
      data-target={p.target.kind}
      data-terminal-view={p.terminalView ? "" : undefined}
      style={planColumnVars(pose, p.width.wide, p.width.measure)}
    >
      {!full && <div ref={setSlot} className="rl-flow-convo" data-layout={layout} />}
      {p.hasPlan && (
        <section className="rl-flow-plan" data-pose={pose} hidden={pose === "closed"} aria-label="Plan">
          <PlanPanelHeader
            pose={headerPose}
            version={p.latestVersion}
            marks={p.marks}
            viewing={p.viewing}
            onToggleContents={toggleContents}
            contentsOpen={p.contents.open}
            onToggleFull={() => sessionId && toggleFull(sessionId, p.unresolved)}
            onClose={() => sessionId && closePlan(sessionId)}
          />
          <div className="rl-flow-plan-body">
            {p.planBody}
            {!full && composing && <div className="rl-flow-compose-sheet rl-glass rl-glass-sheet">{p.composer}</div>}
          </div>
          <PlanPanelFooter pose={headerPose} {...p.footer} />
        </section>
      )}
      {full && (
        <aside className="rl-flow-panel" aria-label="Chat and feedback" data-flow-right-panel>
          <FeedbackTabs
            tab={tab}
            onTab={setPanelTab}
            count={summary?.count ?? 0}
            allResolved={summary?.allResolved ?? false}
          />
          <div className="rl-flow-panel-body" role="tabpanel">
            {tab === "chat" ? (
              <div ref={setSlot} className="rl-flow-convo" data-layout="panel" />
            ) : p.feedback ? (
              <FeedbackPanel
                session={p.feedback.session}
                viewingVersion={p.feedback.viewingVersion}
                onJumpToAnchor={p.feedback.onJumpToAnchor}
                focusedCommentId={p.feedback.focusedCommentId}
                submitInFlight={p.feedback.submitInFlight}
                actions={p.feedback.actions}
                onViewResearch={p.feedback.onViewResearch}
                composer={p.composer || <FeedbackComposer session={p.feedback.session} {...p.feedback.composer} />}
              />
            ) : null}
          </div>
        </aside>
      )}
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
