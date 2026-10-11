// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useMonochat } from "./MonochatContext";
import { useEffect } from "react";
import { useSharedDraft } from "../hooks/useSharedDraft";

import { useAgentTurn } from "../hooks/useAgentTurn";
import { priorUserBody } from "../lib/agentTurn";
import { backendLabel } from "../lib/backendChoice";
import { RetryNote } from "./TurnNotes";
import { useAutoGrow } from "../hooks/useAutoGrow";

import type { ThreadMessage } from "../types";
import { ReplyBlock, UserTurn } from "./ReplyBlock";
import { SendStopButton, sendState } from "./SendStopButton";

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
  const monochat = useMonochat();
  const [input, setInput] = useSharedDraft(`rl.reviewThread.${reviewId}.${annotationId}`);
  const inputRef = useAutoGrow<HTMLTextAreaElement>(input);

  const turn = useAgentTurn<ThreadMessage>({
    surface: "fork",
    key: `${reviewId}:${annotationId}`,
    idField: null,
    // The fork events name the scope `sessionId` for every family; here that
    // scope is the review, and the item is the annotation or question.
    idFields: { sessionId: reviewId, commentId: annotationId },
    // Rows are stored under the review, so their meters are too: a reload
    // keeps each reply's steps line and tail.
    meterKind: "fork",
    meterThreadId: reviewId,
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
    onSendFailed: text => setInput(current => current.trim() ? `${current}\n\n${text}` : text),
    buildSendArgs: (text) =>
      kind === "question"
        ? { reviewId, questionId: annotationId, text, harness: monochat?.harness, conversationId: monochat?.conversationId }
        : { reviewId, annotationId, text, harness: monochat?.harness, conversationId: monochat?.conversationId },
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
  // The provider the thread runs on signs its replies (BC-26), streaming and
  // settled alike; Redline signs the error rows it wrote.
  const provider = backendLabel(monochat?.harness.backend ?? "claude-code");
  const seat = monochat?.harness.model ?? null;
  useEffect(() => { if (turn.loaded) monochat?.reportActivity?.(`${reviewId}:${annotationId}`, streaming); }, [turn.loaded, reviewId, annotationId, streaming, monochat?.reportActivity]);

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
      {messages.map((m, i) =>
        m.role === "assistant" ? (
          <ReplyBlock
            key={m.id}
            phase="settled"
            byline={m.status === "error" ? "Redline" : provider}
            seat={seat}
            text={m.body}
            error={m.status === "error"}
            meter={turn.meters[m.id]}
            inspect={{ surface: "fork", key: annotationId }}
          >
            {m.status === "error" &&
              i === messages.length - 1 &&
              (() => {
                const onRetry = retryAt(i);
                return onRetry ? <RetryNote onRetry={onRetry} /> : null;
              })()}
          </ReplyBlock>
        ) : (
          <UserTurn key={m.id} body={m.body} />
        ),
      )}
      {streaming && (
        // The backend's clock, so a pane switch mid-turn comes back showing
        // the true elapsed wait rather than restarting it.
        <ReplyBlock
          phase="live"
          inspect={{ surface: "fork", key: annotationId }}
          byline={provider}
          seat={seat}
          text={liveText}
          meter={turn.meter}
          activity={turn.activity}
          startedAt={turn.startedAt}
          retrying={turn.retrying}
        />
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
        {/* The review agent can't queue: while it replies, the one button is
            Stop, and what is typed waits in the box. */}
        <SendStopButton state={sendState(streaming, !!input.trim(), false)} onSend={send} onStop={cancel} disabled={!input.trim()} />
      </div>
    </div>
  );
}
