// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useState } from "react";
import type {
  CommentScope,
  CommentType,
  NewCommentRequest,
} from "../types";
import { useAutoGrow } from "../hooks/useAutoGrow";
import { useAttachmentCapture } from "../hooks/useAttachmentCapture";
import { AnchorPill } from "./AnchorPill";
import { AttachmentChips } from "./AttachmentChips";

interface CommentComposerProps {
  type: CommentType;
  /** The session this comment belongs to — scopes where attachments are
   *  copied (`<app_data_dir>/attachments/<session_id>/`). */
  sessionId: string;
  anchorId: string;
  selectedText: string;
  /** Block-relative character range of the selection at the moment compose
   *  began. Persisted with the comment so the editor can paint a persistent
   *  highlight and click-bridge it with the card. */
  charStart: number;
  charEnd: number;
  /** Sub-block sidecar id (`blk-X.s3.w2-w4` style) when the selection
   *  landed on whole-unit boundaries. Stored on the comment as the
   *  primary, reflow-stable anchor; char offsets stay as the fallback. */
  subBlockId?: string;
  /** Initial value for the "Revised" field of an edit. Empty string = a
   *  cross-out (delete the span); the composer opens ready to save it.
   *  Undefined defaults the field to the selected text (a normal edit). */
  presetRevised?: string;
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

// Shared sizing for the auto-grown composer textareas: no manual resize handle
// or inner scrollbar (the hook owns height), a `minEm`-line floor for breathing
// room, and a viewport-relative cap past which the box finally scrolls.
function growStyle(minEm: number): React.CSSProperties {
  return {
    resize: "none",
    overflowY: "auto",
    minHeight: `${minEm}em`,
    maxHeight: "50vh",
  };
}

export function CommentComposer({
  type,
  sessionId,
  anchorId,
  selectedText,
  charStart,
  charEnd,
  subBlockId,
  presetRevised,
  onCancel,
  onSubmit,
}: CommentComposerProps) {
  const [body, setBody] = useState("");
  const [scope, setScope] = useState<CommentScope>("local");
  const [revised, setRevised] = useState(presetRevised ?? selectedText);
  const [saving, setSaving] = useState(false);
  // Auto-grow the composer fields so a multi-line selection opens fully sized —
  // no cramped inner scroll. `revisedRef` fits the "Revised" edit field to the
  // highlighted text on mount; `bodyRef` grows whichever body/note field the
  // active `type` renders. A `minHeight` floor gives short edits breathing room
  // and a `maxHeight` cap keeps a huge selection from swallowing the pane.
  const revisedRef = useAutoGrow<HTMLTextAreaElement>(revised);
  const bodyRef = useAutoGrow<HTMLTextAreaElement>(body);
  // Drag a screenshot onto the composer, or ⌘V one in: "make it look like
  // this" is the feedback this unlocks.
  const files = useAttachmentCapture(sessionId);
  // A cross-out: the composer was opened pre-set to delete the span.
  const isCrossOut = presetRevised === "";

  useEffect(() => {
    // The edit card focuses "Revised" (the highlighted text); the others focus
    // their single body field.
    (type === "edit" ? revisedRef.current : bodyRef.current)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // An edit submits when the revised text differs from the original — including
  // an empty revised (a deletion / cross-out).
  const canSubmit =
    type === "edit" ? revised !== selectedText : body.trim().length > 0;

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
          ? { charStart, charEnd, quotedText: selectedText, subBlockId }
          : undefined;
      // Omitted entirely when empty, so a comment without files serializes
      // exactly as it did before attachments existed.
      const attachments =
        files.attachments.length > 0 ? files.attachments : undefined;
      const req: NewCommentRequest =
        type === "edit"
          ? {
              type,
              anchorId,
              body: body.trim() || "(edit)",
              edit: { original: selectedText, revised: revised.trim() },
              selection,
              attachments,
            }
          : type === "feedback"
            ? {
                type,
                anchorId,
                scope,
                body: body.trim(),
                selection,
                attachments,
              }
            : { type, anchorId, body: body.trim(), selection, attachments };
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
      // The drop hit-test measures against this element: Tauri's drag event is
      // webview-global, so every composer must decide for itself whether a drop
      // landed on it (see useAttachmentCapture).
      ref={files.hostRef}
      className="rounded-md border p-3"
      style={{
        borderColor: TYPE_COLORS[type],
        background: "var(--color-bg-elevated)",
        outline: files.dragOver ? "2px dashed var(--color-info)" : undefined,
        outlineOffset: "2px",
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
          <Label>{isCrossOut ? "Revised (empty = delete)" : "Revised"}</Label>
          <textarea
            ref={revisedRef}
            value={revised}
            onChange={(e) => setRevised(e.target.value)}
            className="w-full font-serif rounded-sm border px-2 py-1"
            style={{
              borderColor: "var(--color-rule)",
              fontSize: "13px",
              lineHeight: 1.4,
              ...growStyle(4.5),
            }}
          />
          <Label className="mt-2">Note (optional)</Label>
          <textarea
            ref={bodyRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onPaste={files.onPaste}
            placeholder="Optional context for the editor"
            className="w-full rounded-sm border px-2 py-1"
            style={{
              borderColor: "var(--color-rule)",
              fontSize: "12px",
              ...growStyle(2.4),
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
            ref={bodyRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onPaste={files.onPaste}
            placeholder="What's the feedback?"
            className="w-full rounded-sm border px-2 py-1"
            style={{
              borderColor: "var(--color-rule)",
              fontSize: "13px",
              lineHeight: 1.4,
              ...growStyle(4.5),
            }}
          />
        </div>
      )}

      {type === "question" && (
        <div className="mb-2">
          <textarea
            ref={bodyRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onPaste={files.onPaste}
            placeholder="What do you want to ask?"
            className="w-full rounded-sm border px-2 py-1"
            style={{
              borderColor: "var(--color-rule)",
              fontSize: "13px",
              lineHeight: 1.4,
              ...growStyle(3.6),
            }}
          />
        </div>
      )}

      {/* Attachments. The chips only appear once something is captured, so an
          ordinary text comment looks exactly as it always did; the hint line
          replaces them while empty so the affordance is still discoverable. */}
      {files.attachments.length > 0 ? (
        <AttachmentChips attachments={files.attachments} onRemove={files.remove} />
      ) : (
        files.dragOver && (
          <div
            className="rounded-sm border border-dashed mt-2 px-2 py-3 text-center"
            style={{
              borderColor: "var(--color-info)",
              color: "var(--color-info)",
              fontSize: "11px",
            }}
          >
            Drop to attach
          </div>
        )
      )}
      {files.busy && (
        <div
          className="mt-1"
          style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}
        >
          Attaching…
        </div>
      )}
      {files.error && (
        <div
          className="mt-1 flex items-start gap-2"
          style={{ fontSize: "11px", color: "var(--color-warning)" }}
        >
          <span className="flex-1">{files.error}</span>
          <button
            type="button"
            onClick={files.dismissError}
            style={{ cursor: "pointer" }}
            aria-label="Dismiss attachment error"
          >
            ✕
          </button>
        </div>
      )}

      <div
        className="flex items-center justify-between mt-2"
        style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}
      >
        <span>⌘+Enter to save · Esc to cancel · drop or ⌘V a file</span>
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
