// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { Comment } from "../types";

interface FooterProps {
  comments: Comment[];
  canSubmit: boolean;
  canApprove: boolean;
  waiting: boolean;
  onSubmit: () => void;
  onApprove: () => void;
  /** Terminal dock collapsed (and not fullscreen) — show a peek segment. */
  termCollapsed: boolean;
  termTabCount: number;
  termHasUnseen: boolean;
  onExpandTerminal: () => void;
}

export function Footer({
  comments,
  canSubmit,
  canApprove,
  waiting,
  onSubmit,
  onApprove,
  termCollapsed,
  termTabCount,
  termHasUnseen,
  onExpandTerminal,
}: FooterProps) {
  const pending = comments.filter(
    (c) => c.status === "draft" || c.status === "reopened",
  );
  const counts = countByType(pending);
  const total = pending.length;
  // "All resolutions handled" surfaces once the reviewer has dispatched every
  // Claude resolution in the current revision: nothing pending, nothing still
  // sitting at resolved (i.e. awaiting accept/reopen), and at least one comment
  // has reached a terminal state. The line is a nudge, not a state machine —
  // the buttons below already drive everything.
  const hasUnreviewedResolution = comments.some(
    (c) => c.status === "resolved",
  );
  const hasTerminalComment = comments.some(
    (c) => c.status === "accepted" || c.status === "withdrawn",
  );
  const allResolutionsHandled =
    total === 0 &&
    !hasUnreviewedResolution &&
    hasTerminalComment &&
    !waiting;
  // Ask-mode whenever the tray is non-empty and every pending comment is a
  // question — the backend infers the same way, this is purely for UI
  // labelling. Mixed batches stay in "Continue revising".
  const askMode = total > 0 && pending.every((c) => c.type === "question");
  const submitLabel = askMode ? "Ask Claude" : "Continue revising";
  const waitingCopy = askMode
    ? "Waiting for Claude's answer…"
    : "Waiting for Claude's revision…";

  // Semantic status dot for the footer: amber while you have pending work,
  // info-blue while Claude is in-flight, success-green when the tray is clear.
  const dotColor = waiting
    ? "var(--color-info)"
    : total > 0
      ? "var(--color-warning)"
      : "var(--color-success)";

  return (
    <footer
      className="flex items-center justify-between gap-4 px-6 py-2 border-t"
      style={{
        borderColor: "var(--color-rule)",
        color: "var(--color-ink-muted)",
        fontSize: "12px",
      }}
    >
      <span className="flex items-center gap-2">
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: 9999,
            background: dotColor,
            display: "inline-block",
          }}
        />
        {waiting ? (
          <span className="italic">{waitingCopy}</span>
        ) : allResolutionsHandled ? (
          <span style={{ color: "var(--color-success)" }}>
            All resolutions handled — Approve plan, or add another round of
            comments.
          </span>
        ) : total === 0 ? (
          "no pending comments"
        ) : (
          <>
            {total} pending ·{" "}
            <Badge n={counts.edit} label="edit" color="var(--color-info)" />
            {" · "}
            <Badge
              n={counts.feedback}
              label="feedback"
              color="var(--color-warning)"
            />
            {" · "}
            <Badge
              n={counts.question}
              label="question"
              color="var(--color-success)"
            />
          </>
        )}
        {termCollapsed && (
          <>
            <span style={{ color: "var(--color-rule)" }}>·</span>
            <button
              type="button"
              onClick={onExpandTerminal}
              title="Show terminal"
              className="flex items-center gap-1"
              style={{
                color: "var(--color-ink-muted)",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              {termHasUnseen && (
                <span
                  aria-label="new terminal output"
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 9999,
                    background: "var(--color-info)",
                    display: "inline-block",
                  }}
                />
              )}
              {termTabCount} terminal{termTabCount === 1 ? "" : "s"}
            </button>
          </>
        )}
      </span>
      <span className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit || waiting}
          className="rounded px-3 py-1 font-medium disabled:opacity-40"
          style={{
            background: "var(--color-bg-elevated)",
            border: "1px solid var(--color-rule)",
            color: "var(--color-ink)",
            fontSize: "12px",
          }}
        >
          {submitLabel}
        </button>
        <button
          type="button"
          onClick={onApprove}
          disabled={!canApprove || waiting}
          className="rounded px-3 py-1 font-medium disabled:opacity-40"
          style={{
            background: "var(--color-success)",
            color: "var(--color-on-accent)",
            fontSize: "12px",
          }}
        >
          Approve plan
        </button>
      </span>
    </footer>
  );
}

function Badge({
  n,
  label,
  color,
}: {
  n: number;
  label: string;
  color: string;
}) {
  // Tracked microtype on the label keeps the chrome reading as an IDE/editor
  // surface. The count stays in the normal type for legibility.
  return (
    <span style={{ color }}>
      {n}{" "}
      <span
        style={{
          textTransform: "uppercase",
          letterSpacing: "0.12em",
          fontSize: "11px",
          fontWeight: 600,
        }}
      >
        {label}
      </span>
    </span>
  );
}

function countByType(comments: Comment[]): Record<Comment["type"], number> {
  const out: Record<Comment["type"], number> = {
    edit: 0,
    feedback: 0,
    question: 0,
    "block-insert": 0,
    "block-delete": 0,
    "block-move": 0,
  };
  for (const c of comments) {
    out[c.type] += 1;
  }
  return out;
}
