// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/**
 * The Review Request browser viewer — how someone who never installs
 * Redline reviews a plan.
 *
 * The encrypted snapshot arrives in the URL #fragment (it never reaches the
 * server hosting this page) or is pasted as a bare code. The plan renders
 * through the SAME TipTap schema/markdown parser the app uses, so `rl:blk-`
 * block identity survives; annotations are comment/suggest-only (this is a
 * fork the owner reconciles, not a live CRDT peer) and anchor by blockId +
 * character range. "Send back" signs the annotation set with the
 * per-request HMAC key embedded in the snapshot — the owner verifies it and
 * re-anchors onto their CURRENT revision.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";

import { planExtensions } from "../src/editor/extensions/planExtensions";
import {
  CommentHighlights,
  type CommentHighlightRange,
} from "../src/editor/extensions/CommentHighlights";
import { planMarkdownToDoc } from "../src/editor/markdown";
import { decodeSnapshot, type SnapshotPayload } from "../src/collab/snapshot";
import {
  signReturn,
  type ReturnComment,
  type ReturnPayload,
} from "../src/collab/returnBlob";
import type { CommentSelection } from "../src/types";

type ViewerPhase =
  | { kind: "paste"; error?: string }
  | { kind: "invalid" }
  | { kind: "ready"; payload: SnapshotPayload; expired: boolean };

interface Annotation {
  id: string;
  type: "feedback" | "question" | "edit";
  blockId: string;
  body: string;
  revised?: string;
  selection: CommentSelection;
}

interface Capture {
  blockId: string;
  selection: CommentSelection;
  /** Viewport rect of the selection, for the floating menu. */
  rect: { top: number; left: number; bottom: number };
}

function storageKey(requestId: string): string {
  return `rl-viewer.${requestId}`;
}

function loadAnnotations(requestId: string): Annotation[] {
  try {
    const raw = localStorage.getItem(storageKey(requestId));
    const parsed = raw ? (JSON.parse(raw) as Annotation[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveAnnotations(requestId: string, annotations: Annotation[]): void {
  try {
    localStorage.setItem(storageKey(requestId), JSON.stringify(annotations));
  } catch {
    // Private-mode browsers — annotations survive the tab, not a reload.
  }
}

/** Resolve the current editor selection to a single block + char range.
 *  Multi-block selections return null (annotate one block at a time). */
function captureSelection(editor: Editor): Capture | null {
  const { state } = editor;
  const { from, to, empty } = state.selection;
  if (empty) return null;
  const $from = state.doc.resolve(from);
  for (let depth = $from.depth; depth >= 1; depth--) {
    const node = $from.node(depth);
    const blockId = node.attrs?.blockId as string | undefined;
    if (!blockId) continue;
    const start = $from.start(depth);
    const end = start + node.content.size;
    if (to > end) return null;
    const charStart = state.doc.textBetween(start, from).length;
    const quotedText = state.doc.textBetween(from, to);
    if (!quotedText.trim()) return null;
    const domSel = window.getSelection();
    let rect = { top: 0, left: 0, bottom: 0 };
    if (domSel && domSel.rangeCount > 0) {
      const r = domSel.getRangeAt(0).getBoundingClientRect();
      rect = { top: r.top, left: r.left + r.width / 2, bottom: r.bottom };
    }
    return {
      blockId,
      selection: {
        charStart,
        charEnd: charStart + quotedText.length,
        quotedText,
      },
      rect,
    };
  }
  return null;
}

export function Viewer() {
  const [phase, setPhase] = useState<ViewerPhase>({ kind: "paste" });

  // Decode from the URL fragment on load (and on hash change).
  useEffect(() => {
    const fromHash = async () => {
      const token = window.location.hash.slice(1);
      if (!token) {
        setPhase({ kind: "paste" });
        return;
      }
      const payload = await decodeSnapshot(decodeURIComponent(token));
      if (!payload) {
        setPhase({ kind: "invalid" });
        return;
      }
      setPhase({
        kind: "ready",
        payload,
        expired: !!payload.expiresAt && Date.now() > payload.expiresAt,
      });
    };
    void fromHash();
    window.addEventListener("hashchange", () => void fromHash());
  }, []);

  const pasteToken = async (raw: string) => {
    const token = raw.trim().replace(/^.*#/, "");
    const payload = await decodeSnapshot(token);
    if (!payload) {
      setPhase({ kind: "paste", error: "That code didn’t decode — check the paste and try again." });
      return;
    }
    setPhase({
      kind: "ready",
      payload,
      expired: !!payload.expiresAt && Date.now() > payload.expiresAt,
    });
  };

  if (phase.kind === "paste") {
    return <PasteScreen error={phase.error} onSubmit={pasteToken} />;
  }
  if (phase.kind === "invalid") {
    return (
      <div className="rlv-shell rlv-center">
        <div className="rlv-card">
          <h1>Invalid or corrupted link</h1>
          <p>
            This review link couldn’t be decrypted. Ask the sender for a fresh
            one — links are single-purpose and may have been regenerated.
          </p>
        </div>
      </div>
    );
  }
  return <ReviewScreen payload={phase.payload} expired={phase.expired} />;
}

function PasteScreen({
  error,
  onSubmit,
}: {
  error?: string;
  onSubmit: (raw: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <div className="rlv-shell rlv-center">
      <div className="rlv-card">
        <h1>Redline plan review</h1>
        <p>
          Paste the review link or snapshot code you were sent. Everything
          decrypts locally in your browser — the plan never touches a server.
        </p>
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={4}
          placeholder="RLS1.…"
          className="rlv-mono"
        />
        {error && <p className="rlv-error">{error}</p>}
        <div className="rlv-row rlv-end">
          <button
            className="rlv-btn rlv-primary"
            disabled={!value.trim()}
            onClick={() => onSubmit(value)}
          >
            Open review
          </button>
        </div>
      </div>
    </div>
  );
}

function ReviewScreen({
  payload,
  expired,
}: {
  payload: SnapshotPayload;
  expired: boolean;
}) {
  const [annotations, setAnnotations] = useState<Annotation[]>(() =>
    loadAnnotations(payload.requestId),
  );
  const [capture, setCapture] = useState<Capture | null>(null);
  const [composing, setComposing] = useState<{
    capture: Capture;
    type: Annotation["type"];
  } | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const seq = useRef(annotations.length);

  const docJson = useMemo(
    () => planMarkdownToDoc(payload.markdown).toJSON() as object,
    [payload.markdown],
  );

  const extensions = useMemo(
    () => [...planExtensions(), CommentHighlights],
    [],
  );

  const editor = useEditor({
    extensions,
    content: docJson,
    editable: false,
    editorProps: {
      attributes: { class: "rl-prose rlv-doc", "aria-label": "Plan document" },
    },
    onSelectionUpdate: ({ editor }) => {
      if (expired) return;
      setCapture(captureSelection(editor as Editor));
    },
  });

  // Project annotations as in-document highlights.
  useEffect(() => {
    if (!editor) return;
    const ranges: CommentHighlightRange[] = annotations.map((a) => ({
      commentId: a.id,
      blockId: a.blockId,
      charStart: a.selection.charStart,
      charEnd: a.selection.charEnd,
      quotedText: a.selection.quotedText,
      muted: false,
    }));
    editor.commands.setCommentHighlights(ranges);
  }, [editor, annotations]);

  const persist = useCallback(
    (next: Annotation[]) => {
      setAnnotations(next);
      saveAnnotations(payload.requestId, next);
    },
    [payload.requestId],
  );

  const addAnnotation = (
    type: Annotation["type"],
    body: string,
    revised?: string,
  ) => {
    if (!composing) return;
    const { capture } = composing;
    persist([
      ...annotations,
      {
        id: `v-${Date.now()}-${seq.current++}`,
        type,
        blockId: capture.blockId,
        body,
        ...(type === "edit" && revised !== undefined ? { revised } : {}),
        selection: capture.selection,
      },
    ]);
    setComposing(null);
    setCapture(null);
  };

  return (
    <div className="rlv-shell">
      <header className="rlv-header">
        <div>
          <div className="rlv-title">
            {payload.planTitle || payload.projectName || "Plan review"}
          </div>
          <div className="rlv-sub">
            {payload.ownerName ? `Shared by ${payload.ownerName} · ` : ""}
            {payload.projectName ? `${payload.projectName} · ` : ""}v
            {payload.baseVersion} · for {payload.reviewerName}
          </div>
          {payload.note && <div className="rlv-note">“{payload.note}”</div>}
        </div>
        <button
          className="rlv-btn rlv-primary"
          disabled={annotations.length === 0}
          onClick={() => setSendOpen(true)}
        >
          Send back ({annotations.length})
        </button>
      </header>
      {expired && (
        <div className="rlv-banner">
          This review link has expired — you can read the plan, but returns
          will be rejected. Ask for a fresh link.
        </div>
      )}
      <div className="rlv-body">
        <main className="rlv-doc-pane">
          <EditorContent editor={editor} />
        </main>
        <aside className="rlv-rail">
          <div className="rlv-rail-title">
            Your annotations
            <span className="rlv-hint">
              {expired
                ? ""
                : " — select text in the plan to comment or suggest an edit"}
            </span>
          </div>
          {annotations.length === 0 ? (
            <p className="rlv-hint">Nothing yet.</p>
          ) : (
            <ul className="rlv-list">
              {annotations.map((a) => (
                <li key={a.id} className="rlv-item">
                  <div className="rlv-item-head">
                    <span className={`rlv-chip rlv-chip-${a.type}`}>
                      {a.type === "edit" ? "suggestion" : a.type}
                    </span>
                    <button
                      className="rlv-x"
                      title="Delete annotation"
                      onClick={() =>
                        persist(annotations.filter((x) => x.id !== a.id))
                      }
                    >
                      ✕
                    </button>
                  </div>
                  <div className="rlv-quote">“{a.selection.quotedText}”</div>
                  {a.type === "edit" ? (
                    <div className="rlv-item-body">
                      <span className="rlv-strike">
                        {a.selection.quotedText}
                      </span>{" "}
                      → <strong>{a.revised || "(delete)"}</strong>
                      {a.body && <div>{a.body}</div>}
                    </div>
                  ) : (
                    <div className="rlv-item-body">{a.body}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
      {capture && !composing && !expired && (
        <div
          className="rlv-menu"
          style={{
            top: Math.max(8, capture.rect.top - 44),
            left: capture.rect.left,
          }}
        >
          <button onClick={() => setComposing({ capture, type: "feedback" })}>
            Comment
          </button>
          <button onClick={() => setComposing({ capture, type: "edit" })}>
            Suggest edit
          </button>
          <button onClick={() => setComposing({ capture, type: "question" })}>
            Question
          </button>
        </div>
      )}
      {composing && (
        <Composer
          type={composing.type}
          quotedText={composing.capture.selection.quotedText}
          onSave={addAnnotation}
          onCancel={() => setComposing(null)}
        />
      )}
      {sendOpen && (
        <SendBack
          payload={payload}
          annotations={annotations}
          onClose={() => setSendOpen(false)}
        />
      )}
    </div>
  );
}

function Composer({
  type,
  quotedText,
  onSave,
  onCancel,
}: {
  type: Annotation["type"];
  quotedText: string;
  onSave: (type: Annotation["type"], body: string, revised?: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const [revised, setRevised] = useState(quotedText);
  const isEdit = type === "edit";
  const ready = isEdit ? revised !== quotedText || body.trim() : !!body.trim();
  return (
    <div className="rlv-overlay" onClick={onCancel}>
      <div className="rlv-card" onClick={(e) => e.stopPropagation()}>
        <h2>
          {isEdit
            ? "Suggest an edit"
            : type === "question"
              ? "Ask a question"
              : "Add a comment"}
        </h2>
        <div className="rlv-quote">“{quotedText}”</div>
        {isEdit && (
          <label>
            Revised text (clear it to suggest deletion)
            <textarea
              value={revised}
              onChange={(e) => setRevised(e.target.value)}
              rows={3}
            />
          </label>
        )}
        <label>
          {isEdit ? "Why (optional)" : "Your note"}
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            autoFocus={!isEdit}
          />
        </label>
        <div className="rlv-row rlv-end">
          <button className="rlv-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="rlv-btn rlv-primary"
            disabled={!ready}
            onClick={() =>
              onSave(type, body.trim(), isEdit ? revised : undefined)
            }
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function SendBack({
  payload,
  annotations,
  onClose,
}: {
  payload: SnapshotPayload;
  annotations: Annotation[];
  onClose: () => void;
}) {
  const [blob, setBlob] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const comments: ReturnComment[] = annotations.map((a) => ({
      type: a.type,
      blockId: a.blockId,
      body: a.body || (a.type === "edit" ? "(edit)" : ""),
      ...(a.type === "edit"
        ? {
            edit: {
              original: a.selection.quotedText,
              revised: a.revised ?? "",
            },
          }
        : {}),
      selection: a.selection,
    }));
    const returnPayload: ReturnPayload = {
      v: 1,
      requestId: payload.requestId,
      baseVersion: payload.baseVersion,
      reviewerName: payload.reviewerName,
      createdAt: Date.now(),
      comments,
    };
    void signReturn(returnPayload, payload.signingKey).then((signed) => {
      if (!cancelled) setBlob(signed);
    });
    return () => {
      cancelled = true;
    };
  }, [payload, annotations]);

  const mailto = blob
    ? `mailto:?subject=${encodeURIComponent(
        `Review return — ${payload.planTitle || payload.projectName || "plan"}`,
      )}&body=${encodeURIComponent(
        `Here's my signed review return — paste it into Redline's Collaboration Center:\n\n${blob}\n`,
      )}`
    : undefined;

  return (
    <div className="rlv-overlay" onClick={onClose}>
      <div className="rlv-card" onClick={(e) => e.stopPropagation()}>
        <h2>Send your review back</h2>
        <p>
          This return code carries your {annotations.length} annotation
          {annotations.length === 1 ? "" : "s"}, signed so{" "}
          {payload.ownerName || "the owner"} can verify it came from this
          review link untampered. Send it back any way you like — email, chat,
          a paste.
        </p>
        <textarea
          readOnly
          value={blob ?? "Signing…"}
          rows={5}
          className="rlv-mono"
          onFocus={(e) => e.currentTarget.select()}
        />
        <div className="rlv-row rlv-end">
          {mailto && (
            <a className="rlv-btn" href={mailto}>
              Email it…
            </a>
          )}
          <button
            className="rlv-btn rlv-primary"
            disabled={!blob}
            onClick={() => {
              if (!blob) return;
              void navigator.clipboard.writeText(blob);
              setCopied(true);
            }}
          >
            {copied ? "Copied ✓" : "Copy return code"}
          </button>
          <button className="rlv-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
