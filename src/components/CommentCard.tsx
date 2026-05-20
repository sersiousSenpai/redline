// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { Comment, CommentStatus } from "../types";
import { AnchorPill } from "./AnchorPill";

interface CommentCardProps {
  comment: Comment;
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
  focused = false,
  onSelect,
  onDelete,
  onAccept,
  onReopen,
}: CommentCardProps) {
  const color = TYPE_COLORS[comment.type];
  const canDelete = comment.status === "draft";

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
          <span
            style={{
              fontSize: "10px",
              fontWeight: 600,
              color,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            {TYPE_LABELS[comment.type]}
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

      {comment.edit && (
        <div className="mb-2 font-serif" style={{ fontSize: "13px" }}>
          <div
            className="line-through"
            style={{ color: "var(--color-ink-muted)" }}
          >
            {comment.edit.original}
          </div>
          <div style={{ color: "var(--color-info)" }}>
            {comment.edit.revised}
          </div>
        </div>
      )}

      {comment.body && comment.body.trim() !== "(edit)" && (
        <div
          style={{
            fontSize: "13px",
            lineHeight: 1.45,
            color: "var(--color-ink)",
            whiteSpace: "pre-wrap",
          }}
        >
          {comment.body}
        </div>
      )}

      {comment.resolution && (
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
          <div
            style={{
              fontSize: "13px",
              lineHeight: 1.45,
              color: "var(--color-ink)",
              whiteSpace: "pre-wrap",
            }}
          >
            {comment.resolution.body}
          </div>
          {comment.status === "resolved" && (
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={onAccept}
                className="rounded px-2 py-0.5 font-medium"
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
                className="rounded px-2 py-0.5 font-medium"
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
