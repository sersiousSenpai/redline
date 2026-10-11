// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";

import type { DraftComment, ThreadMessage } from "../types";
import { useAgentTurn } from "../hooks/useAgentTurn";
import { priorUserBody } from "../lib/agentTurn";
import { backendLabel } from "../lib/backendChoice";
import { RetryNote } from "./TurnNotes";
import { ReplyBlock, UserTurn } from "./ReplyBlock";
import { SendStopButton, sendState } from "./SendStopButton";
import { useMonochat } from "./MonochatContext";
import { useSharedDraft } from "../hooks/useSharedDraft";

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
            color: "var(--color-info-text)",
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
export function DraftThread({ draftId, commentId }: { draftId: string; commentId: string }) {
  const monochat = useMonochat();
  const [draft, setDraft] = useSharedDraft(`rl.draftThread.${draftId}.${commentId}`);

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
    onSendFailed: text => setDraft(current => current.trim() ? `${current}\n\n${text}` : text),
    // …but `draft_thread_send` names the scope `draftId`, not `sessionId`.
    buildSendArgs: (text) => ({ draftId, commentId, text, harness: monochat?.harness, conversationId: monochat?.conversationId }),
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
  // The provider the thread runs on signs its replies (BC-26), streaming and
  // settled alike; Redline signs the error rows it wrote.
  const provider = backendLabel(monochat?.harness.backend ?? "claude-code");
  const seat = monochat?.harness.model ?? null;
  useEffect(() => { if (turn.loaded) monochat?.reportActivity?.(`${draftId}:${commentId}`, streaming); }, [turn.loaded, draftId, commentId, streaming, monochat?.reportActivity]);

  /** Whether it went: the agent can't queue, so a send while it replies
   *  keeps the text in the box. */
  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || streaming) return false;
    turn.send(trimmed);
    return true;
  };

  /** Re-send the question an error row is the failed answer to. Last row only
   *  — an error further up has already been answered by what followed it. */
  const retryAt = (i: number): (() => void) | undefined => {
    const body = priorUserBody(messages, i);
    return body ? () => void send(body) : undefined;
  };

  return (
    <div
      className="flex flex-col gap-1.5 pt-1"
      style={{ borderTop: "1px solid var(--color-rule)" }}
      onClick={(e) => e.stopPropagation()}
    >
      {messages.map((m, i) =>
        m.role === "user" ? (
          <UserTurn key={m.id} body={m.body} />
        ) : (
          <ReplyBlock
            key={m.id}
            phase="settled"
            byline={m.status === "error" ? "Redline" : provider}
            seat={seat}
            text={m.body}
            error={m.status === "error"}
            meter={turn.meters[m.id]}
            inspect={{ surface: "drafter", key: draftId }}
          >
            {m.status === "error" &&
              i === messages.length - 1 &&
              (() => {
                const onRetry = retryAt(i);
                return onRetry ? <RetryNote onRetry={onRetry} /> : null;
              })()}
          </ReplyBlock>
        ),
      )}
      {streaming && (
        <ReplyBlock
          phase="live"
          inspect={{ surface: "drafter", key: draftId }}
          byline={provider}
          seat={seat}
          text={liveText}
          meter={turn.meter}
          activity={turn.activity}
          startedAt={turn.startedAt}
          retrying={turn.retrying}
        />
      )}
      <div className="flex items-end gap-1">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (send(draft)) setDraft("");
            }
          }}
          placeholder="Ask about this part…"
          rows={1}
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
        {/* The agent can't queue: while it replies, the one button is Stop,
            and the box stays open for the next question. */}
        <SendStopButton
          state={sendState(streaming, !!draft.trim(), false)}
          onSend={() => {
            if (send(draft)) setDraft("");
          }}
          onStop={turn.cancel}
          disabled={!draft.trim()}
        />
      </div>
    </div>
  );
}
