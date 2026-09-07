// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";

import type { DraftComment, ThreadMessage } from "../types";
import { useAgentTurn } from "../hooks/useAgentTurn";
import { priorUserBody } from "../lib/agentTurn";
import { RetryNote } from "./QueuedChip";
import { MarkdownView } from "./MarkdownView";
import StreamingBubble from "./StreamingBubble";
import TurnFooter from "./TurnFooter";
import { WorkingIndicator } from "./WorkingIndicator";

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
 *  `(draftId, comment.id)`, and running on the same shared `useAgentTurn`
 *  lifecycle (T3.3). */
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
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focused) {
      cardRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [focused]);

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
      {expanded && <DraftThread draftId={draftId} commentId={commentId} />}
    </div>
  );
}


/** One comment's discussion, mounted only while the card is expanded — the
 *  cards themselves stay cheap, which is why this is its own component rather
 *  than a conditional hook in the card.
 *
 *  The streaming lifecycle is the shared one (T3.3): seq-guarded deltas, a
 *  mid-turn remount restored from `fork_thread_status.partial` — which matters
 *  more here than anywhere, because collapsing and re-opening a card IS a
 *  remount — and the 10s self-heal for a lost terminal event. */
function DraftThread({ draftId, commentId }: { draftId: string; commentId: string }) {
  const [draft, setDraft] = useState("");

  const turn = useAgentTurn<ThreadMessage>({
    surface: "fork",
    key: `${draftId}:${commentId}`,
    idField: null,
    // The fork events spell the scope `sessionId` for every family; for a
    // drafter thread that scope IS the draft id.
    idFields: { sessionId: draftId, commentId },
    meterKind: "fork",
    meterThreadId: draftId,
    historyCmd: "get_thread",
    historyArgs: { sessionId: draftId, commentId },
    commands: {
      send: "draft_thread_send",
      status: "fork_thread_status",
      cancel: "fork_thread_cancel",
    },
    statusArgs: { scopeId: draftId, itemId: commentId },
    cancelArgs: { sessionId: draftId, commentId },
    // `Turns::begin` rejects-when-busy: no queue to type ahead into.
    queueing: false,
    sendFailPrefix: "Couldn't reach the discussion agent",
    // …but `draft_thread_send` names the scope `draftId`, not `sessionId`.
    buildSendArgs: (text) => ({ draftId, commentId, text }),
    makeMessage: ({ id, role, body, status }) => ({
      id,
      sessionId: draftId,
      commentId,
      role,
      body,
      status,
      createdAt: Date.now(),
    }),
  });
  const { messages, liveText, status } = turn;
  const streaming = status === "streaming";

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || streaming) return;
    turn.send(trimmed);
  };

  /** Re-send the question an error row is the failed answer to. Last row only
   *  — an error further up has already been answered by what followed it. */
  const retryAt = (i: number): (() => void) | undefined => {
    const body = priorUserBody(messages, i);
    return body ? () => send(body) : undefined;
  };

  return (
    <div
      className="flex flex-col gap-1.5 pt-1"
      style={{ borderTop: "1px solid var(--color-rule)" }}
      onClick={(e) => e.stopPropagation()}
    >
      {messages.map((m, i) => (
        <div key={m.id} className="flex flex-col gap-0.5">
          <span
            style={{
              fontSize: "9px",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.07em",
              color:
                m.status === "error"
                  ? "var(--color-warning)"
                  : m.role === "user"
                    ? "var(--color-ink-muted)"
                    : "var(--color-info)",
            }}
          >
            {/* Redline wrote the error sentence, not the model. */}
            {m.role === "user" ? "You" : m.status === "error" ? "Redline" : "Agent"}
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
          {m.role !== "user" && <TurnFooter meter={turn.meters[m.id]} />}
          {m.status === "error" &&
            i === messages.length - 1 &&
            (() => {
              const onRetry = retryAt(i);
              return onRetry ? <RetryNote onRetry={onRetry} /> : null;
            })()}
        </div>
      ))}
      {streaming && (
        <div style={{ fontSize: "11.5px", color: "var(--color-ink-muted)" }}>
          <StreamingBubble
            text={liveText}
            agent="Drafter"
            inspect={{ surface: "drafter", key: draftId }}
            retrying={turn.retrying}
            meter={turn.meter}
            activity={turn.activity}
          />
          {!liveText && !turn.retrying && (
            <WorkingIndicator compact startedAt={turn.startedAt ?? undefined} />
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
          disabled={streaming}
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
          disabled={!draft.trim() || streaming}
          className="rounded px-1.5 py-1"
          style={{
            fontSize: "10.5px",
            background: "var(--color-info)",
            color: "var(--color-on-accent)",
            opacity: draft.trim() && !streaming ? 1 : 0.5,
          }}
        >
          ↑
        </button>
      </div>
    </div>
  );
}
