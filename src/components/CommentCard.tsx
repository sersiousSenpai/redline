import type { Comment, CommentStatus } from "../types";
import { AnchorPill } from "./AnchorPill";

interface CommentCardProps {
  comment: Comment;
  onDelete: () => void;
  onAccept: () => void;
  onReopen: () => void;
}

const TYPE_COLORS: Record<Comment["type"], string> = {
  edit: "var(--color-info)",
  feedback: "var(--color-warning)",
  question: "var(--color-success)",
};

const TYPE_LABELS: Record<Comment["type"], string> = {
  edit: "Edit",
  feedback: "Feedback",
  question: "Question",
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
  onDelete,
  onAccept,
  onReopen,
}: CommentCardProps) {
  const color = TYPE_COLORS[comment.type];
  const canDelete = comment.status === "draft";

  return (
    <div
      className="font-sans rounded-md border p-3"
      style={{ borderColor: "var(--color-rule)", background: "white" }}
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
          className="font-sans"
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
            className="font-sans"
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
                  color: "white",
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
                  background: "white",
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
