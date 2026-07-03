// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";

import type {
  ReviewAnnotation,
  ReviewAnnotationKind,
  ReviewBlocking,
  ReviewLabel,
} from "../types";
import { useAutoGrow } from "../hooks/useAutoGrow";
import { ReviewThread } from "./ReviewThread";

// Floating annotation card for the review diff — both the composer (new /
// draft) and the read view of an existing annotation. Anchored under its line
// range by DiffView; kept fixed-position-free so it scrolls with the content.
// Write-through discipline: every composer edit debounces into
// `onChange` (the crash-persistence path draft comments use).

const KIND_LABEL: Record<ReviewAnnotationKind, string> = {
  comment: "Comment",
  deletion: "Mark for deletion",
  suggestion: "Suggestion",
};

/** Conventional-comment labels, in picker order (serializer-whitelisted). */
const LABELS: ReviewLabel[] = [
  "praise",
  "nitpick",
  "suggestion",
  "issue",
  "todo",
  "question",
  "thought",
  "chore",
  "note",
  "typo",
  "polish",
];

const BLOCKING: ReviewBlocking[] = ["blocking", "non-blocking", "if-minor"];

/** Where the annotation anchors, as the card header shows it. */
export function anchorLabel(a: ReviewAnnotation): string {
  if (a.scope === "general") return "review-wide";
  if (a.scope === "file") return `${a.filePath} (whole file)`;
  return `${a.filePath}:${a.side === "old" ? "old" : "new"} L${a.startLine}${
    a.endLine !== a.startLine ? `–${a.endLine}` : ""
  }`;
}

/** The `{label, decoration}` chip text, or null. */
export function labelChip(a: ReviewAnnotation): string | null {
  if (!a.label) return null;
  return a.blocking ? `${a.label} · ${a.blocking}` : a.label;
}

const WRITE_THROUGH_MS = 350;

interface ComposerProps {
  annotation: ReviewAnnotation;
  /** Persist the edited annotation (debounced write-through + on Done). */
  onChange: (a: ReviewAnnotation) => void;
  /** Close the composer, keeping the annotation. */
  onDone: () => void;
  /** Discard the annotation entirely. */
  onDiscard: () => void;
}

export function ReviewAnnotationComposer({
  annotation,
  onChange,
  onDone,
  onDiscard,
}: ComposerProps) {
  const [body, setBody] = useState(annotation.body);
  const [replacement, setReplacement] = useState(
    annotation.suggestionReplacement ?? annotation.quotedText,
  );
  const [label, setLabel] = useState<ReviewLabel | undefined>(annotation.label);
  const [blocking, setBlocking] = useState<ReviewBlocking | undefined>(annotation.blocking);
  const timer = useRef<number | null>(null);
  const bodyRef = useAutoGrow<HTMLTextAreaElement>(body);
  const replacementRef = useAutoGrow<HTMLTextAreaElement>(replacement);

  useEffect(() => {
    bodyRef.current?.focus();
  }, [bodyRef]);

  const withEdits = (
    nextBody: string,
    nextReplacement: string,
    nextLabel: ReviewLabel | undefined,
    nextBlocking: ReviewBlocking | undefined,
  ): ReviewAnnotation => ({
    ...annotation,
    body: nextBody,
    suggestionReplacement:
      annotation.kind === "suggestion" ? nextReplacement : undefined,
    label: nextLabel,
    blocking: nextLabel ? nextBlocking : undefined,
  });

  // Debounced write-through of the current edit state.
  const scheduleWrite = (nextBody: string, nextReplacement: string) => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      onChange(withEdits(nextBody, nextReplacement, label, blocking));
    }, WRITE_THROUGH_MS);
  };
  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    },
    [],
  );

  // Label edits are discrete clicks — write through immediately.
  const pickLabel = (l: ReviewLabel) => {
    const next = label === l ? undefined : l;
    setLabel(next);
    if (!next) setBlocking(undefined);
    onChange(withEdits(body, replacement, next, next ? blocking : undefined));
  };
  const pickBlocking = (b: ReviewBlocking) => {
    const next = blocking === b ? undefined : b;
    setBlocking(next);
    onChange(withEdits(body, replacement, label, next));
  };

  const finish = () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    onChange(withEdits(body, replacement, label, blocking));
    onDone();
  };

  return (
    <div className="rl-review-card" role="dialog" aria-label={KIND_LABEL[annotation.kind]}>
      <div className="rl-review-card-head">
        <span style={{ fontWeight: 600 }}>{KIND_LABEL[annotation.kind]}</span>
        <span style={{ color: "var(--color-ink-muted)" }}>{anchorLabel(annotation)}</span>
      </div>

      {annotation.kind === "suggestion" && (
        <>
          <pre className="rl-review-card-quote rl-diff-del">{annotation.quotedText}</pre>
          <textarea
            ref={replacementRef}
            className="rl-review-card-input"
            style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)" }}
            rows={Math.min(8, Math.max(2, replacement.split("\n").length))}
            value={replacement}
            onChange={(e) => {
              setReplacement(e.target.value);
              scheduleWrite(body, e.target.value);
            }}
            aria-label="Suggested replacement"
            spellCheck={false}
          />
        </>
      )}

      {annotation.kind === "deletion" && (
        <pre className="rl-review-card-quote rl-diff-del">{annotation.quotedText}</pre>
      )}

      <textarea
        ref={bodyRef}
        className="rl-review-card-input"
        rows={2}
        value={body}
        placeholder={
          annotation.kind === "deletion"
            ? "Why these lines should go (optional)…"
            : annotation.kind === "suggestion"
              ? "Why this change…"
              : "Your comment…"
        }
        onChange={(e) => {
          setBody(e.target.value);
          scheduleWrite(e.target.value, replacement);
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") finish();
          if (e.key === "Escape") onDiscard();
        }}
      />

      <div className="rl-review-labels" role="group" aria-label="Label">
        {LABELS.map((l) => (
          <button
            key={l}
            type="button"
            className="rl-review-label-chip"
            data-active={label === l ? "" : undefined}
            onClick={() => pickLabel(l)}
          >
            {l}
          </button>
        ))}
      </div>
      {label && (
        <div className="rl-review-labels" role="group" aria-label="Blocking">
          {BLOCKING.map((b) => (
            <button
              key={b}
              type="button"
              className="rl-review-label-chip"
              data-tone={b === "blocking" ? "danger" : undefined}
              data-active={blocking === b ? "" : undefined}
              onClick={() => pickBlocking(b)}
            >
              {b}
            </button>
          ))}
        </div>
      )}

      <div className="rl-review-card-actions">
        <button type="button" className="rl-review-btn" onClick={onDiscard}>
          Discard
        </button>
        <button type="button" className="rl-review-btn rl-review-btn-primary" onClick={finish}>
          Done
        </button>
      </div>
    </div>
  );
}

interface CardProps {
  annotations: ReviewAnnotation[];
  onEdit: (a: ReviewAnnotation) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

/** Read view of the annotations anchored to one range (usually one). Each
 *  entry can open a per-annotation discussion thread with a read-only agent
 *  grounded on the diff range (agent parity with plan review's Discuss). */
export function ReviewAnnotationCard({ annotations, onEdit, onDelete, onClose }: CardProps) {
  const [discussing, setDiscussing] = useState<string | null>(null);
  return (
    <div className="rl-review-card" role="dialog" aria-label="Annotations">
      {annotations.map((a) => (
        <div key={a.id} className="rl-review-card-entry">
          <div className="rl-review-card-head">
            <span style={{ fontWeight: 600 }}>
              {KIND_LABEL[a.kind]}
              {labelChip(a) && (
                <span className="rl-review-label-chip" data-active="" style={{ marginLeft: 6 }}>
                  {labelChip(a)}
                </span>
              )}
              {a.source !== "user" && (
                <span className="rl-review-source-chip" style={{ marginLeft: 6 }}>
                  ✦ {a.source}
                </span>
              )}
            </span>
            <span style={{ color: "var(--color-ink-muted)" }}>
              {a.id}
              {a.status !== "draft" ? ` · ${a.status}` : ""}
            </span>
          </div>
          {a.kind !== "comment" && a.quotedText && (
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
              aria-expanded={discussing === a.id}
              onClick={() => setDiscussing((d) => (d === a.id ? null : a.id))}
            >
              {discussing === a.id ? "Hide discussion" : "Discuss"}
            </button>
            <button type="button" className="rl-review-btn" onClick={() => onDelete(a.id)}>
              Delete
            </button>
            <button type="button" className="rl-review-btn" onClick={() => onEdit(a)}>
              Edit
            </button>
          </div>
          {discussing === a.id && (
            <ReviewThread reviewId={a.reviewId} annotationId={a.id} />
          )}
        </div>
      ))}
      <div className="rl-review-card-actions">
        <button type="button" className="rl-review-btn" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
