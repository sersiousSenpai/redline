// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { useAutoGrow } from "../hooks/useAutoGrow";

import type {
  ForkCancelledEvent,
  ForkDeltaEvent,
  ForkDoneEvent,
  ForkErrorEvent,
  ThreadMessage,
} from "../types";
import { MarkdownView } from "./MarkdownView";
import { WorkingIndicator } from "./WorkingIndicator";

// Per-annotation discussion thread for the Code Review surface. The compact
// sibling of CommentThread: same `fork-*` streaming contract and
// `thread_messages` persistence, but keyed on (reviewId, annotationId) and
// driven by `review_thread_send` — a fresh read-only agent grounded on the
// diff range (there is no plan session to fork in a code review).

interface ReviewThreadProps {
  reviewId: string;
  /** The annotation's id, or an `ask-NNN` question id (kind "question"). */
  annotationId: string;
  /** Which backend send path owns this thread. Storage, events, and cancel
   *  are shared — only the first-turn grounding differs. */
  kind?: "annotation" | "question";
}

export function ReviewThread({ reviewId, annotationId, kind = "annotation" }: ReviewThreadProps) {
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [streamText, setStreamText] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const streaming = streamText !== null;

  const inputRef = useAutoGrow<HTMLTextAreaElement>(input);

  const idsRef = useRef({ reviewId, annotationId });
  idsRef.current = { reviewId, annotationId };

  // Persisted turns (survive relaunch — the fork session id rides the
  // annotation row, so follow-ups resume the same conversation).
  useEffect(() => {
    let alive = true;
    void invoke<ThreadMessage[]>("get_thread", {
      sessionId: reviewId,
      commentId: annotationId,
    })
      .then((rows) => {
        if (alive) setMessages(rows);
      })
      .catch(() => {});
    // Seed streaming state from the fork registry: an in-flight turn survives
    // this component unmounting (pane switches), and here streaming is just
    // `streamText !== null` — start it as an empty stream so the indicator
    // shows; deltas append from there.
    void invoke<{ streaming: boolean; startedAt: number | null }>(
      "fork_thread_status",
      { scopeId: reviewId, itemId: annotationId },
    )
      .then((s) => {
        if (alive && s.streaming) setStreamText((t) => t ?? "");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [reviewId, annotationId]);

  useEffect(() => {
    let alive = true;
    const mine = (p: { sessionId: string; commentId: string }) =>
      p.sessionId === idsRef.current.reviewId &&
      p.commentId === idsRef.current.annotationId;

    const deltaP = listen<ForkDeltaEvent>("fork-delta", (e) => {
      if (!alive || !mine(e.payload)) return;
      setStreamText((t) => (t ?? "") + e.payload.text);
    });
    const doneP = listen<ForkDoneEvent>("fork-done", (e) => {
      if (!alive || !mine(e.payload)) return;
      setStreamText(null);
      setMessages((m) => [
        ...m,
        {
          id: e.payload.messageId,
          sessionId: e.payload.sessionId,
          commentId: e.payload.commentId,
          role: "assistant",
          body: e.payload.body,
          status: "complete",
          createdAt: Date.now(),
        },
      ]);
    });
    const errP = listen<ForkErrorEvent>("fork-error", (e) => {
      if (!alive || !mine(e.payload)) return;
      setStreamText(null);
      setError(e.payload.error);
    });
    const cancelP = listen<ForkCancelledEvent>("fork-cancelled", (e) => {
      if (!alive || !mine(e.payload)) return;
      setStreamText(null);
    });
    return () => {
      alive = false;
      void deltaP.then((un) => un());
      void doneP.then((un) => un());
      void errP.then((un) => un());
      void cancelP.then((un) => un());
    };
  }, []);

  const send = () => {
    const text = input.trim();
    if (!text || streaming) return;
    setError(null);
    setInput("");
    setMessages((m) => [
      ...m,
      {
        id: `local-${Date.now()}`,
        sessionId: reviewId,
        commentId: annotationId,
        role: "user",
        body: text,
        status: "complete",
        createdAt: Date.now(),
      },
    ]);
    setStreamText("");
    const call =
      kind === "question"
        ? invoke("review_question_send", { reviewId, questionId: annotationId, text })
        : invoke("review_thread_send", { reviewId, annotationId, text });
    void call.catch((err) => {
      setStreamText(null);
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  const cancel = () => {
    void invoke("fork_thread_cancel", {
      sessionId: reviewId,
      commentId: annotationId,
    }).catch(() => {});
  };

  return (
    <div className="rl-review-thread">
      {messages.map((m) => (
        <div key={m.id} className="rl-review-thread-msg" data-role={m.role}>
          {m.role === "assistant" ? (
            m.status === "error" ? (
              <div className="rl-review-thread-error">{m.body}</div>
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
          {streamText ? (
            <MarkdownView body={streamText} compact />
          ) : (
            <WorkingIndicator />
          )}
        </div>
      )}
      {error && <div className="rl-review-thread-error">{error}</div>}
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
