// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type {
  DraftComment,
  ForkCancelledEvent,
  ForkDeltaEvent,
  ForkDoneEvent,
  ForkErrorEvent,
  ThreadMessage,
} from "../types";
import { MarkdownView } from "./MarkdownView";

interface DrafterSidecarProps {
  draftId: string;
  comments: DraftComment[];
  /** Focused comment (clicking a highlight in the doc scrolls its card). */
  focusedId: string | null;
  onSelect: (id: string | null) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

/** The Prompt Drafter's comment sidecar: selection-anchored comments, each
 *  with a "Discuss" thread — a fresh read-only claude fork scoped to propose
 *  edits against its own anchored block only (the daemon enforces the scope).
 *  Same `fork-*` wire shape as plan/review threads, keyed
 *  `(draftId, comment.id)`. */
export function DrafterSidecar({
  draftId,
  comments,
  focusedId,
  onSelect,
  onDelete,
  onClose,
}: DrafterSidecarProps) {
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      style={{
        width: "300px",
        flexShrink: 0,
        background: "var(--color-paper)",
        borderLeft: "1px solid var(--color-rule)",
      }}
      data-drafter-sidecar="true"
    >
      <div
        className="flex shrink-0 items-center gap-1.5 px-3 py-2"
        style={{ borderBottom: "1px solid var(--color-rule)" }}
      >
        <span style={{ fontSize: "13px" }}>🗨️</span>
        <span
          className="min-w-0 flex-1 truncate"
          style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-ink)" }}
        >
          Comments
        </span>
        <button
          type="button"
          onClick={onClose}
          title="Close"
          className="px-1 leading-none opacity-60 hover:opacity-100"
          style={{ fontSize: "13px", color: "var(--color-ink-muted)" }}
        >
          ✕
        </button>
      </div>
      <div className="rl-thin-scroll-y flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2.5 py-2.5">
        {comments.length === 0 ? (
          <div
            style={{
              fontSize: "11.5px",
              color: "var(--color-ink-muted)",
              lineHeight: 1.5,
            }}
          >
            Select text in the draft and click 🗨️ Comment to anchor a note here.
            Each comment can open its own discussion — a scoped agent that may
            propose edits to that block only.
          </div>
        ) : (
          comments.map((c) => (
            <DraftCommentCard
              key={c.id}
              draftId={draftId}
              comment={c}
              focused={focusedId === c.id}
              onSelect={() => onSelect(c.id)}
              onDelete={() => onDelete(c.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

type ThreadStatus = "idle" | "streaming" | "error";

let tmpSeq = 0;
const tmpId = () => `dtmp-${++tmpSeq}`;

function DraftCommentCard({
  draftId,
  comment,
  focused,
  onSelect,
  onDelete,
}: {
  draftId: string;
  comment: DraftComment;
  focused: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const commentId = comment.id;
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [liveText, setLiveText] = useState("");
  const [status, setStatus] = useState<ThreadStatus>("idle");
  const [draft, setDraft] = useState("");
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focused) {
      cardRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [focused]);

  // Load persisted turns + subscribe to this comment's fork events (only while
  // the thread is expanded — cards are cheap until opened).
  useEffect(() => {
    if (!expanded) return;
    let alive = true;
    void invoke<ThreadMessage[]>("get_thread", {
      sessionId: draftId,
      commentId,
    })
      .then((rows) => alive && setMessages(rows))
      .catch(() => {});

    const mine = (p: { sessionId: string; commentId: string }) =>
      p.sessionId === draftId && p.commentId === commentId;
    const deltaP = listen<ForkDeltaEvent>("fork-delta", (e) => {
      if (!alive || !mine(e.payload)) return;
      setStatus("streaming");
      setLiveText((t) => t + e.payload.text);
    });
    const doneP = listen<ForkDoneEvent>("fork-done", (e) => {
      if (!alive || !mine(e.payload)) return;
      setMessages((m) => [
        ...m,
        {
          id: e.payload.messageId,
          sessionId: draftId,
          commentId,
          role: "assistant",
          body: e.payload.body,
          status: "complete",
          createdAt: Date.now(),
        },
      ]);
      setLiveText("");
      setStatus("idle");
    });
    const errP = listen<ForkErrorEvent>("fork-error", (e) => {
      if (!alive || !mine(e.payload)) return;
      setMessages((m) => [
        ...m,
        {
          id: tmpId(),
          sessionId: draftId,
          commentId,
          role: "assistant",
          body: e.payload.error,
          status: "error",
          createdAt: Date.now(),
        },
      ]);
      setLiveText("");
      setStatus("error");
    });
    const cancelP = listen<ForkCancelledEvent>("fork-cancelled", (e) => {
      if (!alive || !mine(e.payload)) return;
      setLiveText("");
      setStatus("idle");
    });
    return () => {
      alive = false;
      void deltaP.then((un) => un());
      void doneP.then((un) => un());
      void errP.then((un) => un());
      void cancelP.then((un) => un());
    };
  }, [expanded, draftId, commentId]);

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || status === "streaming") return;
    setMessages((m) => [
      ...m,
      {
        id: tmpId(),
        sessionId: draftId,
        commentId,
        role: "user",
        body: trimmed,
        status: "complete",
        createdAt: Date.now(),
      },
    ]);
    setStatus("streaming");
    void invoke("draft_thread_send", {
      draftId,
      commentId,
      text: trimmed,
    }).catch((err) => {
      setStatus("error");
      setMessages((m) => [
        ...m,
        {
          id: tmpId(),
          sessionId: draftId,
          commentId,
          role: "assistant",
          body: `Couldn't reach the discussion agent: ${err}`,
          status: "error",
          createdAt: Date.now(),
        },
      ]);
    });
  }

  return (
    <div
      ref={cardRef}
      onClick={onSelect}
      className="flex flex-col gap-1 rounded px-2.5 py-2"
      style={{
        border: `1px solid ${focused ? "var(--color-info)" : "var(--color-rule)"}`,
        background: "var(--color-bg-elevated)",
        cursor: "pointer",
      }}
      data-comment-id={commentId}
    >
      {comment.selQuotedText && (
        <div
          className="truncate"
          style={{
            fontSize: "10.5px",
            color: "var(--color-ink-muted)",
            borderLeft: "2px solid var(--color-rule)",
            paddingLeft: "6px",
          }}
          title={comment.selQuotedText}
        >
          {comment.selQuotedText}
        </div>
      )}
      <div style={{ fontSize: "12px", color: "var(--color-ink)", lineHeight: 1.45 }}>
        {comment.body}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          style={{
            fontSize: "10.5px",
            color: "var(--color-info)",
            cursor: "pointer",
          }}
        >
          {expanded ? "Hide discussion" : "💬 Discuss"}
        </button>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Delete this comment and its discussion"
          style={{
            fontSize: "10.5px",
            color: "var(--color-ink-muted)",
            cursor: "pointer",
          }}
        >
          🗑
        </button>
      </div>
      {expanded && (
        <div
          className="flex flex-col gap-1.5 pt-1"
          style={{ borderTop: "1px solid var(--color-rule)" }}
          onClick={(e) => e.stopPropagation()}
        >
          {messages.map((m) => (
            <div key={m.id} className="flex flex-col gap-0.5">
              <span
                style={{
                  fontSize: "9px",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.07em",
                  color:
                    m.role === "user"
                      ? "var(--color-ink-muted)"
                      : "var(--color-info)",
                }}
              >
                {m.role === "user" ? "You" : "Agent"}
              </span>
              {m.status === "error" ? (
                <div
                  style={{
                    fontSize: "11.5px",
                    whiteSpace: "pre-wrap",
                    color: "var(--color-warning)",
                  }}
                >
                  {m.body}
                </div>
              ) : (
                <MarkdownView body={m.body} compact rich />
              )}
            </div>
          ))}
          {status === "streaming" && (
            <div style={{ fontSize: "11.5px", color: "var(--color-ink-muted)" }}>
              {liveText ? (
                <MarkdownView body={liveText} compact />
              ) : (
                "thinking…"
              )}
            </div>
          )}
          <div className="flex items-end gap-1">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(draft);
                  setDraft("");
                }
              }}
              placeholder="Ask about this part…"
              rows={1}
              disabled={status === "streaming"}
              className="flex-1 rounded px-1.5 py-1"
              style={{
                fontSize: "11.5px",
                border: "1px solid var(--color-rule)",
                background: "var(--color-paper)",
                color: "var(--color-ink)",
                fontFamily: "inherit",
                resize: "none",
              }}
            />
            <button
              type="button"
              onClick={() => {
                send(draft);
                setDraft("");
              }}
              disabled={!draft.trim() || status === "streaming"}
              className="rounded px-1.5 py-1"
              style={{
                fontSize: "10.5px",
                background: "var(--color-info)",
                color: "var(--color-on-accent)",
                opacity: draft.trim() && status !== "streaming" ? 1 : 0.5,
              }}
            >
              ↑
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
