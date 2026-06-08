// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useState } from "react";
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
  onReopen: () => void;
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
  onReopen,
  submitInFlight = false,
}: CommentCardProps) {
  const color = TYPE_COLORS[comment.type];
  // A point-anchored sticky-note from the HTML redline surface: a feedback
  // comment whose selection is a zero-width caret point. Demarcated in the pane
  // so it reads as a pinned note rather than a span-anchored feedback.
  const isPinnedNote =
    comment.type === "feedback" &&
    !!comment.selection &&
    comment.selection.charEnd === comment.selection.charStart;
  const canDelete = comment.status === "draft";
  // Session-local collapse state — gives the reviewer an escape hatch when a
  // huge pasted body or a long discussion thread overruns the pane. Not
  // persisted: a freshly loaded session always starts expanded so nothing is
  // hidden by surprise.
  const [collapsed, setCollapsed] = useState(false);
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
            {isPinnedNote ? "💬 Note" : TYPE_LABELS[comment.type]}
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
              color: "var(--color-info)",
              marginBottom: "4px",
            }}
          >
            Claude's resolution
            <span
              className="ml-2 font-mono normal-case"
              style={{ color: "var(--color-ink-muted)" }}
            >
              · v{comment.resolution.appearedInVersion}
            </span>
          </div>
          <MarkdownView body={comment.resolution.body} />
          {comment.status === "resolved" && (
            <div className="mt-2 flex items-center gap-2">
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
              <button
                type="button"
                onClick={onReopen}
                disabled={submitInFlight}
                title={
                  submitInFlight
                    ? "A submit is in flight — wait a moment."
                    : "Reopen this resolution for another round of feedback"
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
