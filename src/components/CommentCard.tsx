// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Comment, CommentStatus } from "../types";
import { compactEditPreview } from "../editor/wordDiff";
import { AnchorPill } from "./AnchorPill";
import { CommentThread } from "./CommentThread";
import { MarkdownView } from "./MarkdownView";

interface CommentCardProps {
  comment: Comment;
  /** The review session id — passed through to the comment's fork thread. */
  sessionId: string;
  /** True when this card is the currently focused one (driven by the in-doc
   *  highlight click bridge or a direct click on the card). Surfaces a
   *  focused outline. */
  focused?: boolean;
  /** Click anywhere on the card to mirror focus over to the editor's
   *  matching highlight or block. Behaves as a toggle in the parent. Always
   *  active — PlanEditor's focus effect falls back to scrolling the comment's
   *  block when no in-doc highlight exists (orphaned blockId, non-selection
   *  comment types). */
  onSelect?: () => void;
  onDelete: () => void;
  onAccept: () => void;
  /** M4: accept a still-draft agent suggestion in place — the editor settles
   *  the marks, the backend records agentState. Reject reuses onDelete. */
  onAcceptSuggestion?: () => void;
  /** Reopen this resolution, optionally attaching a follow-up note that rides
   *  back to Claude (as continuity) on the next Submit. */
  onReopen: (note?: string) => void;
  /** Promote a question into a plan-driving directive — the reviewer resolved
   *  their question into a decision Claude must apply. */
  onPromote: (directive: string) => void;
  /** True while a submit_review / approve_plan invoke is mid-flight. The only
   *  state that should disable Accept/Reopen — outside of this brief window,
   *  including the entire "Claude is revising" wait, resolution is always
   *  available. */
  submitInFlight?: boolean;
}

const TYPE_COLORS: Record<Comment["type"], string> = {
  edit: "var(--color-info)",
  feedback: "var(--color-warning)",
  question: "var(--color-success)",
  "block-insert": "var(--color-success)",
  "block-delete": "var(--color-ink-muted)",
  "block-move": "var(--color-info)",
};

const TYPE_LABELS: Record<Comment["type"], string> = {
  edit: "Edit",
  feedback: "Feedback",
  question: "Question",
  "block-insert": "Block inserted",
  "block-delete": "Block deleted",
  "block-move": "Block moved",
};

const STATUS_LABELS: Record<CommentStatus, string> = {
  draft: "draft",
  submitted: "submitted",
  resolved: "resolved",
  accepted: "accepted",
  reopened: "reopened",
  withdrawn: "withdrawn",
};

const STATUS_COLORS: Record<CommentStatus, string> = {
  draft: "var(--color-ink-muted)",
  submitted: "var(--color-warning)",
  resolved: "var(--color-info)",
  accepted: "var(--color-success)",
  reopened: "var(--color-warning)",
  withdrawn: "var(--color-ink-muted)",
};

export function CommentCard({
  comment,
  sessionId,
  focused = false,
  onSelect,
  onDelete,
  onAccept,
  onAcceptSuggestion,
  onReopen,
  onPromote,
  submitInFlight = false,
}: CommentCardProps) {
  // M4: an agent-authored suggestion. While draft + undecided it shows
  // Accept/Reject; once accepted in place it carries the settled chip (the
  // comment stays draft and rides the next submit as a normal edit).
  const agentUndecided =
    !!comment.author &&
    comment.type === "edit" &&
    comment.status === "draft" &&
    !comment.agentState;
  // A promoted question reads as a change request: relabel + recolor so it's
  // visibly a plan driver, not an answer-only question.
  const isPromoted = comment.type === "question" && !!comment.actionable;
  const color = isPromoted ? "var(--color-warning)" : TYPE_COLORS[comment.type];
  const typeLabel = isPromoted ? "Change request" : TYPE_LABELS[comment.type];
  // A point-anchored sticky-note from the HTML redline surface: a feedback
  // comment whose selection is a zero-width caret point. Demarcated in the pane
  // so it reads as a pinned note rather than a span-anchored feedback.
  const isPinnedNote =
    comment.type === "feedback" &&
    !!comment.selection &&
    comment.selection.charEnd === comment.selection.charStart;
  const canDelete = comment.status === "draft";
  // Session-local collapse state — gives the reviewer an escape hatch when a
  // huge pasted body or a long discussion thread overruns the pane. Accepted
  // cards start collapsed (the reviewer is done with them — keep the pane
  // focused on what's still open); everything else starts expanded so nothing
  // is hidden by surprise.
  const [collapsed, setCollapsed] = useState(comment.status === "accepted");
  // Auto-collapse the moment a resolution is accepted. Guarded on the status
  // *transition* into "accepted" so a reviewer who manually re-expands an
  // accepted card isn't fought on the next revision reload (status stays
  // "accepted", so the effect never re-fires).
  const prevStatusRef = useRef(comment.status);
  useEffect(() => {
    if (prevStatusRef.current !== "accepted" && comment.status === "accepted") {
      setCollapsed(true);
    }
    prevStatusRef.current = comment.status;
  }, [comment.status]);

  // Inline "reopen with a follow-up note" composer. Seeded from any pending
  // note so reopening an already-reopened card edits the same note.
  const [reopenOpen, setReopenOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState(comment.reopenNote ?? "");
  // Collapsed-by-default trail of earlier reopen rounds.
  const [historyOpen, setHistoryOpen] = useState(false);
  const openReopen = () => {
    setNoteDraft(comment.reopenNote ?? "");
    setCollapsed(false);
    setReopenOpen(true);
  };
  const confirmReopen = () => {
    onReopen(noteDraft.trim() || undefined);
    setReopenOpen(false);
  };

  // "Make this a change" — promote a question into a directive. Seeded from any
  // pending note (e.g. a decision escalated from the Discuss thread) so the
  // reviewer just confirms. Unlike a reopen note, the directive is required.
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [directiveDraft, setDirectiveDraft] = useState(comment.reopenNote ?? "");
  const openPromote = () => {
    setDirectiveDraft(comment.reopenNote ?? "");
    setCollapsed(false);
    setPromoteOpen(true);
  };
  const confirmPromote = () => {
    const directive = directiveDraft.trim();
    if (!directive) return;
    onPromote(directive);
    setPromoteOpen(false);
  };
  // Edit comments default to a compact one-line word-diff; the full
  // before/after is one click away. Keeps a flurry of small edits from
  // flooding the pane.
  const [showFullEdit, setShowFullEdit] = useState(false);
  const bodyPreview = (() => {
    const text = (comment.body ?? "").replace(/\s+/g, " ").trim();
    if (text && text !== "(edit)") return text.slice(0, 90);
    if (comment.edit) {
      return `"${comment.edit.original}" → "${comment.edit.revised}"`.slice(0, 90);
    }
    return "";
  })();

  // A reopened follow-up rides back to Claude on Submit, which flips the comment
  // reopened→submitted — but the note is preserved. Keep showing it (pulsing)
  // through that wait so the continuation never vanishes the instant the
  // reviewer hits Continue Revising, and so there's a visible "awaiting Claude"
  // cue per item.
  const pendingReopen =
    comment.status === "submitted" && !!comment.reopenNote;
  const reopenedView = comment.status === "reopened" || pendingReopen;
  const latestHistory =
    comment.reopenHistory && comment.reopenHistory.length > 0
      ? comment.reopenHistory[comment.reopenHistory.length - 1]
      : null;
  const historyPreview = latestHistory
    ? (latestHistory.reopenNote || latestHistory.resolutionBody || "")
        .replace(/\s+/g, " ")
        .trim()
    : "";

  return (
    <div
      data-comment-id={comment.id}
      className="rounded-md border p-3"
      onClick={onSelect ? () => onSelect() : undefined}
      style={{
        borderColor: focused ? color : "var(--color-rule)",
        background: "var(--color-bg-elevated)",
        // Mirror the prominence of `.rl-comment-highlight--focused`: a 2px
        // accent ring on the type-color so both sides of the bridge feel like
        // one motion.
        boxShadow: focused ? `inset 0 0 0 2px ${color}` : undefined,
        cursor: onSelect ? "pointer" : undefined,
        transition: "border-color 120ms ease, box-shadow 120ms ease",
      }}
    >
      <div className="flex items-center justify-between mb-2 gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            aria-label={collapsed ? "Expand comment" : "Collapse comment"}
            title={collapsed ? "Expand comment" : "Collapse comment"}
            onClick={(e) => {
              e.stopPropagation();
              setCollapsed((c) => !c);
            }}
            style={{
              fontSize: "10px",
              lineHeight: 1,
              color: "var(--color-ink-muted)",
              cursor: "pointer",
              padding: "0 2px",
            }}
          >
            {collapsed ? "▸" : "▾"}
          </button>
          <span
            style={{
              fontSize: "10px",
              fontWeight: 600,
              color,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            {isPinnedNote ? "💬 Note" : typeLabel}
            {comment.scope && (
              <span
                className="ml-1 font-mono normal-case"
                style={{ color: "var(--color-ink-muted)" }}
              >
                · {comment.scope}
              </span>
            )}
          </span>
          <AnchorPill anchorId={comment.anchorId} />
          <StatusChip status={comment.status} />
          {comment.author && (
            <span
              className="rounded px-1 font-mono"
              title={`Suggested by ${comment.author}`}
              style={{
                fontSize: "10px",
                color: "var(--color-info)",
                background: "var(--color-anchor-bg)",
              }}
            >
              ✦ {comment.author}
            </span>
          )}
          {comment.agentState === "accepted" && (
            <span
              className="rounded px-1 font-mono"
              title="You accepted this suggestion — it rides the next submit as a normal edit"
              style={{
                fontSize: "10px",
                color: "var(--color-success)",
                background: "var(--color-anchor-bg)",
              }}
            >
              accepted
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span
            className="font-mono"
            style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}
          >
            {comment.id}
          </span>
          {canDelete && (
            <button
              type="button"
              onClick={onDelete}
              title="Delete comment"
              className="opacity-50 hover:opacity-100"
              style={{
                fontSize: "12px",
                color: "var(--color-ink-muted)",
              }}
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {collapsed && bodyPreview && (
        <div
          className="truncate"
          style={{ fontSize: "12px", color: "var(--color-ink-muted)" }}
        >
          {bodyPreview}
        </div>
      )}

      {!collapsed && comment.edit && (
        <div className="mb-2 font-serif" style={{ fontSize: "13px" }}>
          {showFullEdit ? (
            <>
              <div
                className="line-through"
                style={{ color: "var(--color-ink-muted)" }}
              >
                {comment.edit.original}
              </div>
              <div style={{ color: "var(--color-info)" }}>
                {comment.edit.revised}
              </div>
            </>
          ) : (
            <div style={{ lineHeight: 1.5 }}>
              <span
                style={{
                  fontWeight: 600,
                  fontSize: "10px",
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: "var(--color-ink-muted)",
                  marginRight: "6px",
                }}
              >
                Edited
              </span>
              {compactEditPreview(
                comment.edit.original,
                comment.edit.revised,
              ).map((part, i) =>
                part.kind === "delete" ? (
                  <span
                    key={i}
                    className="line-through"
                    style={{ color: "var(--color-ink-muted)" }}
                  >
                    {part.text}
                  </span>
                ) : part.kind === "insert" ? (
                  <span key={i} style={{ color: "var(--color-info)" }}>
                    {part.text}
                  </span>
                ) : (
                  <span key={i} style={{ color: "var(--color-ink-muted)" }}>
                    {part.text}
                  </span>
                ),
              )}
            </div>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setShowFullEdit((s) => !s);
            }}
            style={{
              fontSize: "10px",
              color: "var(--color-ink-muted)",
              marginTop: "2px",
              cursor: "pointer",
            }}
          >
            {showFullEdit ? "show less" : "show full"}
          </button>
        </div>
      )}

      {!collapsed && comment.body && comment.body.trim() !== "(edit)" && (
        <div className="rl-comment-body-scroll">
          <MarkdownView body={comment.body} />
        </div>
      )}

      {/* Pre-round-trip rider: a Discuss-thread outcome attached to a draft
          ("Add to plan" / "Attach to next submit"). Without a resolution the
          rider would otherwise be invisible — the resolution block below only
          renders post-round-trip. Pulses through the submitted wait, same as
          the reopen continuity chip. */}
      {!collapsed &&
        !comment.resolution &&
        comment.reopenNote &&
        (comment.status === "draft" || comment.status === "submitted") && (
          <div
            className={`mt-3 rounded px-2 py-1${
              comment.status === "submitted" ? " rl-pulse" : ""
            }`}
            style={{
              background: "var(--color-anchor-bg)",
              border: "1px solid var(--color-rule)",
            }}
          >
            <div
              className="flex items-center justify-between gap-2"
              style={{
                fontSize: "10px",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "var(--color-warning)",
                marginBottom: "2px",
              }}
            >
              <span>
                {comment.status === "submitted"
                  ? isPromoted
                    ? "Decision sent · Claude is applying…"
                    : "Discussion sent · riding with this submit…"
                  : isPromoted
                    ? "Your decision — applied on next submit"
                    : "Discussion attached — rides with next submit"}
              </span>
              {comment.status === "draft" && (
                <button
                  type="button"
                  title="Detach this discussion from the next submit"
                  onClick={(e) => {
                    e.stopPropagation();
                    void invoke("attach_discussion", {
                      sessionId,
                      commentId: comment.id,
                      note: null,
                      asChange: false,
                    }).catch((err) =>
                      console.error("detach discussion failed", err),
                    );
                  }}
                  className="normal-case"
                  style={{
                    fontWeight: 400,
                    color: "var(--color-ink-muted)",
                    cursor: "pointer",
                  }}
                >
                  ✕ detach
                </button>
              )}
            </div>
            <MarkdownView body={comment.reopenNote} compact />
          </div>
        )}

      {!collapsed && comment.resolution && (
        <div
          className="mt-3 pt-3 border-t"
          style={{ borderColor: "var(--color-rule)" }}
        >
          <div
            style={{
              fontSize: "10px",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: reopenedView
                ? "var(--color-ink-muted)"
                : "var(--color-info)",
              marginBottom: "4px",
            }}
          >
            {reopenedView ? "Previous resolution" : "Claude's resolution"}
            <span
              className="ml-2 font-mono normal-case"
              style={{ color: "var(--color-ink-muted)" }}
            >
              · v{comment.resolution.appearedInVersion}
            </span>
          </div>
          {/* When reopened, the prior resolution is superseded context — mute
              it so the eye lands on the pending follow-up instead. */}
          <div style={{ opacity: reopenedView ? 0.55 : 1 }}>
            <MarkdownView body={comment.resolution.body} />
          </div>

          {/* Earlier reopen rounds — collapsed by default, one click to the
              full trail. Keeps the card focused while never hiding history. */}
          {comment.reopenHistory && comment.reopenHistory.length > 0 && (
            <div className="mt-2">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setHistoryOpen((h) => !h);
                }}
                style={{
                  fontSize: "10px",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: "var(--color-ink-muted)",
                  cursor: "pointer",
                }}
              >
                ⟲ {comment.reopenHistory.length} earlier round
                {comment.reopenHistory.length === 1 ? "" : "s"}
                {historyPreview && !historyOpen && (
                  <span
                    className="normal-case"
                    style={{
                      fontWeight: 400,
                      color: "var(--color-ink-muted)",
                    }}
                  >
                    {" "}· “{historyPreview.slice(0, 60)}
                    {historyPreview.length > 60 ? "…" : ""}”
                  </span>
                )}{" "}
                {historyOpen ? "▾" : "▸"}
              </button>
              {historyOpen && (
                <div className="mt-1 flex flex-col gap-2">
                  {comment.reopenHistory.map((h, i) => (
                    <div
                      key={i}
                      className="rounded px-2 py-1"
                      style={{
                        background: "var(--color-paper)",
                        border: "1px solid var(--color-rule)",
                        opacity: 0.7,
                      }}
                    >
                      <div
                        className="font-mono"
                        style={{
                          fontSize: "9px",
                          color: "var(--color-ink-muted)",
                          marginBottom: "2px",
                        }}
                      >
                        v{h.version} resolution
                      </div>
                      <MarkdownView body={h.resolutionBody} compact />
                      {h.reopenNote && (
                        <div className="mt-1">
                          <span
                            style={{
                              fontSize: "9px",
                              fontWeight: 600,
                              textTransform: "uppercase",
                              letterSpacing: "0.06em",
                              color: "var(--color-ink-muted)",
                            }}
                          >
                            Your note
                          </span>
                          <MarkdownView body={h.reopenNote} compact />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Pending follow-up / decision. Shown while reopened AND through the
              submitted wait (pulsing) so the continuation Claude is responding
              to stays visible instead of vanishing on Continue Revising. */}
          {reopenedView &&
            comment.reopenNote &&
            !reopenOpen &&
            !promoteOpen && (
              <div
                className={`mt-2 rounded px-2 py-1${
                  pendingReopen ? " rl-pulse" : ""
                }`}
                style={{
                  background: "var(--color-anchor-bg)",
                  border: "1px solid var(--color-rule)",
                }}
              >
                <div
                  style={{
                    fontSize: "10px",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    color: "var(--color-warning)",
                    marginBottom: "2px",
                  }}
                >
                  {pendingReopen
                    ? isPromoted
                      ? "Decision sent · Claude is applying…"
                      : "Follow-up sent · Claude is responding…"
                    : isPromoted
                      ? "Your decision"
                      : "Pending follow-up"}
                </div>
                <MarkdownView body={comment.reopenNote} compact />
              </div>
            )}

          {/* For an answered question that hasn't been promoted, make the
              answer-only nature explicit — and offer the escape hatch. */}
          {comment.type === "question" &&
            !comment.actionable &&
            (comment.status === "resolved" ||
              comment.status === "accepted") &&
            !reopenOpen &&
            !promoteOpen && (
              <div
                className="mt-2 italic"
                style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}
              >
                Asking only — this won't change the plan unless you make it a
                change.
              </div>
            )}

          {/* Action buttons (hidden while a composer is open). */}
          {!reopenOpen && !promoteOpen && (
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              {/* M4: in-place resolution of an undecided agent suggestion. */}
              {agentUndecided && onAcceptSuggestion && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAcceptSuggestion();
                  }}
                  title="Keep this suggestion — the text settles in place"
                  className="rounded px-2 py-0.5 font-medium"
                  style={{
                    background: "var(--color-success)",
                    color: "var(--color-on-accent)",
                    fontSize: "11px",
                  }}
                >
                  Accept suggestion
                </button>
              )}
              {agentUndecided && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete();
                  }}
                  title="Reject this suggestion — the block reverts in place"
                  className="rounded px-2 py-0.5 font-medium"
                  style={{
                    background: "var(--color-bg-elevated)",
                    border: "1px solid var(--color-rule)",
                    color: "var(--color-ink)",
                    fontSize: "11px",
                  }}
                >
                  Reject
                </button>
              )}
              {comment.status === "resolved" && (
                <button
                  type="button"
                  onClick={onAccept}
                  disabled={submitInFlight}
                  title={
                    submitInFlight
                      ? "A submit is in flight — wait a moment."
                      : "Accept this resolution"
                  }
                  className="rounded px-2 py-0.5 font-medium disabled:opacity-40"
                  style={{
                    background: "var(--color-success)",
                    color: "var(--color-on-accent)",
                    fontSize: "11px",
                  }}
                >
                  Accept
                </button>
              )}
              {(comment.status === "resolved" ||
                comment.status === "accepted") && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    openReopen();
                  }}
                  disabled={submitInFlight}
                  title={
                    submitInFlight
                      ? "A submit is in flight — wait a moment."
                      : "Reopen with a follow-up for Claude"
                  }
                  className="rounded px-2 py-0.5 font-medium disabled:opacity-40"
                  style={{
                    background: "var(--color-bg-elevated)",
                    border: "1px solid var(--color-rule)",
                    color: "var(--color-ink)",
                    fontSize: "11px",
                  }}
                >
                  Reopen
                </button>
              )}
              {/* Promote a question into a plan-driving change. */}
              {comment.type === "question" &&
                !comment.actionable &&
                (comment.status === "resolved" ||
                  comment.status === "accepted" ||
                  comment.status === "reopened") && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      openPromote();
                    }}
                    disabled={submitInFlight}
                    title={
                      submitInFlight
                        ? "A submit is in flight — wait a moment."
                        : "Turn your decision into a plan change for Claude"
                    }
                    className="rounded px-2 py-0.5 font-medium disabled:opacity-40"
                    style={{
                      background: "var(--color-warning)",
                      color: "var(--color-on-accent)",
                      fontSize: "11px",
                    }}
                  >
                    Make this a change
                  </button>
                )}
              {comment.status === "reopened" && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    comment.actionable ? openPromote() : openReopen();
                  }}
                  disabled={submitInFlight}
                  className="rounded px-2 py-0.5 font-medium disabled:opacity-40"
                  style={{
                    background: "var(--color-bg-elevated)",
                    border: "1px solid var(--color-rule)",
                    color: "var(--color-ink)",
                    fontSize: "11px",
                  }}
                >
                  {comment.actionable
                    ? "Edit decision"
                    : comment.reopenNote
                      ? "Edit note"
                      : "Add note"}
                </button>
              )}
            </div>
          )}

          {/* Inline reopen composer. */}
          {reopenOpen && (
            <div
              className="mt-2 flex flex-col gap-1.5"
              onClick={(e) => e.stopPropagation()}
            >
              <textarea
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                autoFocus
                placeholder="What's still off, or extra context for Claude? (optional)"
                rows={3}
                className="rounded px-2 py-1"
                style={{
                  fontSize: "12px",
                  border: "1px solid var(--color-rule)",
                  background: "var(--color-paper)",
                  color: "var(--color-ink)",
                  fontFamily: "inherit",
                  resize: "vertical",
                  maxHeight: "200px",
                }}
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={confirmReopen}
                  disabled={submitInFlight}
                  className="rounded px-2 py-0.5 font-medium disabled:opacity-40"
                  style={{
                    background: "var(--color-warning)",
                    color: "var(--color-on-accent)",
                    fontSize: "11px",
                  }}
                >
                  {comment.status === "reopened" ? "Update note" : "Reopen"}
                </button>
                <button
                  type="button"
                  onClick={() => setReopenOpen(false)}
                  className="rounded px-2 py-0.5"
                  style={{
                    color: "var(--color-ink-muted)",
                    fontSize: "11px",
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Inline "make this a change" composer — directive is required. */}
          {promoteOpen && (
            <div
              className="mt-2 flex flex-col gap-1.5"
              onClick={(e) => e.stopPropagation()}
            >
              <div
                style={{
                  fontSize: "10px",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: "var(--color-warning)",
                }}
              >
                Turn into a plan change
              </div>
              <textarea
                value={directiveDraft}
                onChange={(e) => setDirectiveDraft(e.target.value)}
                autoFocus
                placeholder="What should change? e.g. “Use a modern style instead.”"
                rows={3}
                className="rounded px-2 py-1"
                style={{
                  fontSize: "12px",
                  border: "1px solid var(--color-rule)",
                  background: "var(--color-paper)",
                  color: "var(--color-ink)",
                  fontFamily: "inherit",
                  resize: "vertical",
                  maxHeight: "200px",
                }}
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={confirmPromote}
                  disabled={submitInFlight || !directiveDraft.trim()}
                  className="rounded px-2 py-0.5 font-medium disabled:opacity-40"
                  style={{
                    background: "var(--color-warning)",
                    color: "var(--color-on-accent)",
                    fontSize: "11px",
                  }}
                >
                  {comment.actionable ? "Update change" : "Make this a change"}
                </button>
                <button
                  type="button"
                  onClick={() => setPromoteOpen(false)}
                  className="rounded px-2 py-0.5"
                  style={{
                    color: "var(--color-ink-muted)",
                    fontSize: "11px",
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {comment.status === "reopened" && !reopenOpen && !promoteOpen && (
            <div
              className="mt-2 italic"
              style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}
            >
              {isPromoted
                ? "Applied as a plan change on your next Submit."
                : "Re-sent to Claude with your next Submit."}
            </div>
          )}
        </div>
      )}

      {!collapsed && <CommentThread sessionId={sessionId} comment={comment} />}
    </div>
  );
}

function StatusChip({ status }: { status: CommentStatus }) {
  if (status === "draft") return null;
  return (
    <span
      className="font-mono rounded-sm px-1.5 py-0.5"
      style={{
        background: "var(--color-anchor-bg)",
        color: STATUS_COLORS[status],
        fontSize: "10px",
      }}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}
