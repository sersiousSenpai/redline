// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useState } from "react";

import { useAgentTurn } from "../hooks/useAgentTurn";
import { priorUserBody } from "../lib/agentTurn";
import { RetryNote } from "./QueuedChip";
import { useAutoGrow } from "../hooks/useAutoGrow";

import type { ThreadMessage } from "../types";
import { MarkdownView } from "./MarkdownView";
import { WorkingIndicator } from "./WorkingIndicator";

// Per-annotation discussion thread for the Code Review surface. The compact
// sibling of CommentThread: same `fork-*` streaming contract and
// `thread_messages` persistence, but keyed on (reviewId, annotationId) and
// driven by `review_thread_send` — a fresh read-only agent grounded on the
// diff range (there is no plan session to fork in a code review).
//
// Streaming runs on the shared `useAgentTurn` lifecycle (T3.4), so switching
// panes mid-turn and coming back restores the partial reply instead of
// resuming blank.

interface ReviewThreadProps {
  reviewId: string;
  /** The annotation's id, or an `ask-NNN` question id (kind "question"). */
  annotationId: string;
  /** Which backend send path owns this thread. Storage, events, and cancel
   *  are shared — only the first-turn grounding differs. */
  kind?: "annotation" | "question";
}

export function ReviewThread({ reviewId, annotationId, kind = "annotation" }: ReviewThreadProps) {
  const [input, setInput] = useState("");
  const inputRef = useAutoGrow<HTMLTextAreaElement>(input);

  const turn = useAgentTurn<ThreadMessage>({
    surface: "fork",
    key: `${reviewId}:${annotationId}`,
    idField: null,
    // The fork events name the scope `sessionId` for every family; here that
    // scope is the review, and the item is the annotation or question.
    idFields: { sessionId: reviewId, commentId: annotationId },
    historyCmd: "get_thread",
    historyArgs: { sessionId: reviewId, commentId: annotationId },
    commands: {
      // Storage, events and cancel are shared across the fork families; only
      // the first-turn grounding — and so the send command — differs by kind.
      send: kind === "question" ? "review_question_send" : "review_thread_send",
      status: "fork_thread_status",
      cancel: "fork_thread_cancel",
    },
    statusArgs: { scopeId: reviewId, itemId: annotationId },
    cancelArgs: { sessionId: reviewId, commentId: annotationId },
    // `Turns::begin` rejects-when-busy: no queue to type ahead into.
    queueing: false,
    sendFailPrefix: "Couldn't reach the review agent",
    buildSendArgs: (text) =>
      kind === "question"
        ? { reviewId, questionId: annotationId, text }
        : { reviewId, annotationId, text },
    makeMessage: ({ id, role, body, status }) => ({
      id,
      sessionId: reviewId,
      commentId: annotationId,
      role,
      body,
      status,
      createdAt: Date.now(),
    }),
  });
  const { messages, liveText } = turn;
  const streaming = turn.status === "streaming";

  const send = () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    turn.send(text);
  };

  const cancel = turn.cancel;

  /** Re-send the question an error row is the failed answer to. Last row only
   *  — an error further up has already been answered by what followed it. */
  const retryAt = (i: number): (() => void) | undefined => {
    const body = priorUserBody(messages, i);
    return body
      ? () => {
          if (!streaming) turn.send(body);
        }
      : undefined;
  };

  return (
    <div className="rl-review-thread">
      {messages.map((m, i) => (
        <div key={m.id} className="rl-review-thread-msg" data-role={m.role}>
          {m.role === "assistant" ? (
            m.status === "error" ? (
              // Redline wrote this sentence, not the model.
              <div className="flex flex-col">
                <div className="rl-review-thread-error">{m.body}</div>
                {i === messages.length - 1 &&
                  (() => {
                    const onRetry = retryAt(i);
                    return onRetry ? <RetryNote onRetry={onRetry} /> : null;
                  })()}
              </div>
            ) : (
              <MarkdownView body={m.body} compact rich />
            )
          ) : (
            <div className="rl-review-thread-user">{m.body}</div>
          )}
        </div>
      ))}
      {streaming && (
        <div className="rl-review-thread-msg" data-role="assistant">
          {turn.retrying ? (
            <div style={{ fontSize: "11.5px", color: "var(--color-ink-muted)" }}>
              ⟳ Temporary model error — retrying…
            </div>
          ) : liveText ? (
            <MarkdownView body={liveText} compact />
          ) : (
            // Backend clock, so a pane switch mid-turn comes back showing the
            // true elapsed wait rather than restarting the counter.
            <WorkingIndicator startedAt={turn.startedAt ?? undefined} />
          )}
        </div>
      )}
      <div className="rl-review-thread-composer">
        <textarea
          ref={inputRef}
          className="rl-review-card-input"
          rows={1}
          value={input}
          placeholder="Discuss with the agent…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        {streaming ? (
          <button type="button" className="rl-review-btn" onClick={cancel}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="rl-review-btn rl-review-btn-primary"
            onClick={send}
            disabled={!input.trim()}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
