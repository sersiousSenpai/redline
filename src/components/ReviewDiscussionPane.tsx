// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useMemo, useState } from "react";

import type { ReviewAnnotation, ReviewQuestion } from "../types";
import type { UseReview } from "../hooks/useReview";
import { nextAnnotationId } from "../lib/reviewSelection";
import {
  anchorLabel,
  labelChip,
  ReviewAnnotationComposer,
} from "./ReviewAnnotationCard";
import { ReviewThread } from "./ReviewThread";

// The Discussion sidecar's CODE REVIEW context: the same pane slot (and the
// same fullscreen ⤢ / zoom machinery on the aside) that hosts plan comments,
// re-grounded on the active review. Cards deliberately wear the review
// overlay's chrome (`rl-review-card`) so the sidecar reads as the code-review
// discussion, not the plan one. Threads reuse ReviewThread verbatim — a
// full-screen sidecar conversation is just paneFullscreen + an open thread.

const KIND_LABEL: Record<ReviewAnnotation["kind"], string> = {
  comment: "Comment",
  deletion: "Mark for deletion",
  suggestion: "Suggestion",
};

interface ReviewDiscussionPaneProps {
  review: UseReview;
}

export default function ReviewDiscussionPane({ review }: ReviewDiscussionPaneProps) {
  const {
    activeReviewId,
    review: session,
    repo,
    annotations,
    questions,
    addAnnotation,
    updateAnnotation,
    deleteAnnotation,
    deleteQuestion,
  } = review;

  const live = useMemo(
    () => annotations.filter((a) => a.status !== "orphaned"),
    [annotations],
  );
  const orphanCount = annotations.length - live.length;
  // General notes first (review-wide), then file/line notes in file order —
  // mirrors the payload's reading order.
  const ordered = useMemo(() => {
    const rank = (a: ReviewAnnotation) => (a.scope === "general" ? 0 : a.scope === "file" ? 1 : 2);
    return [...live].sort(
      (x, y) =>
        rank(x) - rank(y) ||
        x.filePath.localeCompare(y.filePath) ||
        x.startLine - y.startLine ||
        x.createdAt - y.createdAt,
    );
  }, [live]);

  const [editingId, setEditingId] = useState<string | null>(null);

  const addGeneralNote = () => {
    if (!activeReviewId) return;
    const annotation: ReviewAnnotation = {
      id: nextAnnotationId(annotations),
      reviewId: activeReviewId,
      round: session?.round ?? 1,
      filePath: "",
      side: "new",
      startLine: 0,
      endLine: 0,
      kind: "comment",
      body: "",
      quotedText: "",
      status: "draft",
      createdAt: Date.now(),
      scope: "general",
      source: "user",
    };
    void addAnnotation(annotation);
    setEditingId(annotation.id);
  };

  if (!activeReviewId) {
    return (
      <div
        className="italic"
        style={{ fontSize: "12px", color: "var(--color-ink-muted)", lineHeight: 1.5 }}
      >
        No review session yet — open the Code Review pane and pick a project to
        start one.
      </div>
    );
  }

  const repoName = repo?.split("/").filter(Boolean).pop() ?? "";
  return (
    <>
      <div className="rl-review-pane-meta">
        <span className="rl-review-source-chip">⌗ {repoName || "code review"}</span>
        <span style={{ color: "var(--color-ink-muted)" }}>
          round {session?.round ?? 1}
          {orphanCount > 0 ? ` · ${orphanCount} unmatched (see the review pane)` : ""}
        </span>
        <button
          type="button"
          className="rl-review-btn"
          style={{ marginLeft: "auto", fontSize: "11px" }}
          title="Comment on the whole change"
          onClick={addGeneralNote}
        >
          ＋ General note
        </button>
      </div>

      {ordered.length === 0 && questions.length === 0 && (
        <div
          className="italic"
          style={{ fontSize: "12px", color: "var(--color-ink-muted)", lineHeight: 1.5 }}
        >
          Nothing here yet. Select lines in the diff to comment, mark for
          deletion, suggest a change, or ✦ ask the AI — everything lands in
          this sidecar too.
        </div>
      )}

      {ordered.map((a) =>
        editingId === a.id ? (
          <ReviewAnnotationComposer
            key={a.id}
            annotation={a}
            onChange={(x) => void updateAnnotation(x)}
            onDone={() => setEditingId(null)}
            onDiscard={() => {
              void deleteAnnotation(a.id);
              setEditingId(null);
            }}
          />
        ) : (
          <PaneAnnotationCard
            key={a.id}
            reviewId={activeReviewId}
            annotation={a}
            onEdit={() => setEditingId(a.id)}
            onDelete={() => void deleteAnnotation(a.id)}
          />
        ),
      )}

      {questions.length > 0 && (
        <div className="rl-review-pane-section">Ask AI</div>
      )}
      {questions.map((q) => (
        <PaneQuestionCard
          key={q.id}
          reviewId={activeReviewId}
          question={q}
          onDelete={() => void deleteQuestion(q.id)}
        />
      ))}
    </>
  );
}

function PaneAnnotationCard({
  reviewId,
  annotation: a,
  onEdit,
  onDelete,
}: {
  reviewId: string;
  annotation: ReviewAnnotation;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [discussing, setDiscussing] = useState(false);
  const chip = labelChip(a);
  return (
    <div className="rl-review-card rl-review-pane-card">
      <div className="rl-review-card-head">
        <span style={{ fontWeight: 600 }}>
          {KIND_LABEL[a.kind]}
          {chip && (
            <span className="rl-review-label-chip" data-active="" style={{ marginLeft: 6 }}>
              {chip}
            </span>
          )}
          {a.source !== "user" && (
            <span className="rl-review-source-chip" style={{ marginLeft: 6 }}>
              ✦ {a.source}
            </span>
          )}
        </span>
        <span style={{ color: "var(--color-ink-muted)" }}>
          {a.status !== "draft" ? `${a.status}` : a.id}
        </span>
      </div>
      <div
        className="font-mono"
        style={{ fontSize: "10.5px", color: "var(--color-ink-muted)" }}
      >
        {anchorLabel(a)}
      </div>
      {a.quotedText && (
        <pre className="rl-review-card-quote rl-diff-del">{a.quotedText}</pre>
      )}
      {a.kind === "suggestion" && a.suggestionReplacement != null && (
        <pre className="rl-review-card-quote rl-diff-add">{a.suggestionReplacement}</pre>
      )}
      {a.body && <div className="rl-review-card-body">{a.body}</div>}
      {a.resolution && (
        <div className="rl-review-card-resolution">↳ {a.resolution}</div>
      )}
      <div className="rl-review-card-actions">
        <button
          type="button"
          className="rl-review-btn"
          aria-expanded={discussing}
          onClick={() => setDiscussing((v) => !v)}
        >
          {discussing ? "Hide discussion" : "Discuss"}
        </button>
        <button type="button" className="rl-review-btn" onClick={onEdit}>
          Edit
        </button>
        <button type="button" className="rl-review-btn" onClick={onDelete}>
          Delete
        </button>
      </div>
      {discussing && <ReviewThread reviewId={reviewId} annotationId={a.id} />}
    </div>
  );
}

function PaneQuestionCard({
  reviewId,
  question: q,
  onDelete,
}: {
  reviewId: string;
  question: ReviewQuestion;
  onDelete: () => void;
}) {
  // A question IS its conversation — the thread opens with the card.
  const [open, setOpen] = useState(true);
  return (
    <div className="rl-review-card rl-review-pane-card">
      <div className="rl-review-card-head">
        <span style={{ fontWeight: 600 }}>✦ Ask AI</span>
        <span
          className="font-mono"
          style={{ fontSize: "10.5px", color: "var(--color-ink-muted)" }}
        >
          {q.filePath}:{q.side} L{q.startLine}
          {q.endLine !== q.startLine ? `–${q.endLine}` : ""}
        </span>
      </div>
      {q.quotedText && <pre className="rl-review-card-quote">{q.quotedText}</pre>}
      <div className="rl-review-card-actions">
        <button
          type="button"
          className="rl-review-btn"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide thread" : "Show thread"}
        </button>
        <button type="button" className="rl-review-btn" onClick={onDelete}>
          Delete
        </button>
      </div>
      {open && <ReviewThread reviewId={reviewId} annotationId={q.id} kind="question" />}
    </div>
  );
}
