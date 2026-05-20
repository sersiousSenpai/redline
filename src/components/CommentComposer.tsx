// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";
import type {
  CommentScope,
  CommentType,
  NewCommentRequest,
} from "../types";
import { AnchorPill } from "./AnchorPill";

interface CommentComposerProps {
  type: CommentType;
  anchorId: string;
  selectedText: string;
  /** Block-relative character range of the selection at the moment compose
   *  began. Persisted with the comment so the editor can paint a persistent
   *  highlight and click-bridge it with the card. */
  charStart: number;
  charEnd: number;
  onCancel: () => void;
  onSubmit: (request: NewCommentRequest) => Promise<void>;
}

const TYPE_LABELS: Record<CommentType, string> = {
  edit: "Edit",
  feedback: "Feedback",
  question: "Question",
  "block-insert": "Block inserted",
  "block-delete": "Block deleted",
  "block-move": "Block moved",
};

const TYPE_COLORS: Record<CommentType, string> = {
  edit: "var(--color-info)",
  feedback: "var(--color-warning)",
  question: "var(--color-success)",
  "block-insert": "var(--color-success)",
  "block-delete": "var(--color-ink-muted)",
  "block-move": "var(--color-info)",
};

export function CommentComposer({
  type,
  anchorId,
  selectedText,
  charStart,
  charEnd,
  onCancel,
  onSubmit,
}: CommentComposerProps) {
  const [body, setBody] = useState("");
  const [scope, setScope] = useState<CommentScope>("local");
  const [revised, setRevised] = useState(selectedText);
  const [saving, setSaving] = useState(false);
  const firstFieldRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  const canSubmit =
    type === "edit"
      ? revised.trim().length > 0 && revised !== selectedText
      : body.trim().length > 0;

  const submit = async () => {
    if (!canSubmit || saving) return;
    setSaving(true);
    try {
      // Every selection-originated comment carries its block-relative range
      // — paints the persistent highlight and powers card↔doc focus
      // bridging. `charEnd > charStart` is a sanity gate so a zero-width
      // selection (shouldn't happen here, but defensively) doesn't request
      // an empty highlight.
      const selection =
        charEnd > charStart
          ? { charStart, charEnd, quotedText: selectedText }
          : undefined;
      const req: NewCommentRequest =
        type === "edit"
          ? {
              type,
              anchorId,
              body: body.trim() || "(edit)",
              edit: { original: selectedText, revised: revised.trim() },
              selection,
            }
          : type === "feedback"
            ? { type, anchorId, scope, body: body.trim(), selection }
            : { type, anchorId, body: body.trim(), selection };
      await onSubmit(req);
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div
      className="rounded-md border p-3"
      style={{
        borderColor: TYPE_COLORS[type],
        background: "var(--color-bg-elevated)",
      }}
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span
            style={{
              fontSize: "11px",
              fontWeight: 600,
              color: TYPE_COLORS[type],
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            {TYPE_LABELS[type]}
          </span>
          <AnchorPill anchorId={anchorId} />
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs opacity-60 hover:opacity-100"
          style={{ color: "var(--color-ink-muted)" }}
        >
          ✕
        </button>
      </div>

      {type === "edit" && (
        <div className="mb-2">
          <Label>Original</Label>
          <div
            className="font-serif rounded-sm border px-2 py-1 mb-2"
            style={{
              borderColor: "var(--color-rule)",
              background: "var(--color-paper)",
              color: "var(--color-ink-muted)",
              fontSize: "13px",
              lineHeight: 1.4,
            }}
          >
            {selectedText}
          </div>
          <Label>Revised</Label>
          <textarea
            ref={firstFieldRef}
            value={revised}
            onChange={(e) => setRevised(e.target.value)}
            rows={3}
            className="w-full font-serif rounded-sm border px-2 py-1"
            style={{
              borderColor: "var(--color-rule)",
              fontSize: "13px",
              lineHeight: 1.4,
              resize: "vertical",
            }}
          />
          <Label className="mt-2">Note (optional)</Label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={2}
            placeholder="Optional context for the editor"
            className="w-full rounded-sm border px-2 py-1"
            style={{
              borderColor: "var(--color-rule)",
              fontSize: "12px",
              resize: "vertical",
            }}
          />
        </div>
      )}

      {type === "feedback" && (
        <div className="mb-2">
          <div className="flex items-center gap-1 mb-2">
            <ScopeToggle
              active={scope === "local"}
              onClick={() => setScope("local")}
              label="local"
              hint="contained to this section"
            />
            <ScopeToggle
              active={scope === "structural"}
              onClick={() => setScope("structural")}
              label="structural"
              hint="may affect other sections"
            />
          </div>
          <textarea
            ref={firstFieldRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            placeholder="What's the feedback?"
            className="w-full rounded-sm border px-2 py-1"
            style={{
              borderColor: "var(--color-rule)",
              fontSize: "13px",
              lineHeight: 1.4,
              resize: "vertical",
            }}
          />
        </div>
      )}

      {type === "question" && (
        <div className="mb-2">
          <textarea
            ref={firstFieldRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            placeholder="What do you want to ask?"
            className="w-full rounded-sm border px-2 py-1"
            style={{
              borderColor: "var(--color-rule)",
              fontSize: "13px",
              lineHeight: 1.4,
              resize: "vertical",
            }}
          />
        </div>
      )}

      <div
        className="flex items-center justify-between mt-2"
        style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}
      >
        <span>⌘+Enter to save · Esc to cancel</span>
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit || saving}
          className="rounded px-3 py-1 font-medium disabled:opacity-40"
          style={{
            background: TYPE_COLORS[type],
            color: "var(--color-on-accent)",
            fontSize: "12px",
          }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function Label({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`${className}`}
      style={{
        fontSize: "10px",
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "var(--color-ink-muted)",
        marginBottom: "2px",
      }}
    >
      {children}
    </div>
  );
}

function ScopeToggle({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      className="px-2 py-0.5 rounded-sm font-mono"
      style={{
        fontSize: "11px",
        background: active ? "var(--color-anchor-bg)" : "transparent",
        color: active ? "var(--color-ink)" : "var(--color-ink-muted)",
        border: active
          ? "1px solid var(--color-rule)"
          : "1px solid transparent",
      }}
    >
      {label}
    </button>
  );
}
