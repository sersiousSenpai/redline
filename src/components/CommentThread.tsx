// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  Comment,
  ForkCancelledEvent,
  ForkDeltaEvent,
  ForkDoneEvent,
  ForkErrorEvent,
  ThreadMessage,
} from "../types";

interface CommentThreadProps {
  /** The review session id — keys the fork backend with the comment id. */
  sessionId: string;
  comment: Comment;
}

type ThreadStatus = "idle" | "streaming" | "error";

// Monotonic ids for optimistic / synthetic messages — never collide with the
// backend's UUIDs.
let tmpSeq = 0;
const tmpId = () => `tmp-${++tmpSeq}`;

/** The opening message when the reviewer clicks "Discuss" — the comment's own
 *  text, or a sensible stand-in for comments whose body isn't prose. */
function discussSeed(c: Comment): string {
  const body = (c.body ?? "").trim();
  if (body && body !== "(edit)") return body;
  if (c.edit) {
    return `Why change "${c.edit.original}" to "${c.edit.revised}"?`;
  }
  return "Let's talk through this part of the plan.";
}

/** A per-comment discussion with a Claude Code fork of the main session.
 *  Rendered inside `CommentCard`; collapses to a one-line summary. Mirrors
 *  `TerminalView`'s listen()/unlisten streaming pattern for `fork-*` events. */
export function CommentThread({ sessionId, comment }: CommentThreadProps) {
  const commentId = comment.id;
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [liveText, setLiveText] = useState("");
  const [status, setStatus] = useState<ThreadStatus>("idle");
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState("");

  // Load persisted turns + subscribe to this comment's fork events. Re-runs if
  // the card is reused for another (session, comment) — App.tsx keys by both.
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setMessages([]);
    setLiveText("");
    setStatus("idle");

    void invoke<ThreadMessage[]>("get_thread", { sessionId, commentId })
      .then((rows) => {
        if (!alive) return;
        setMessages(rows);
        setLoaded(true);
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });

    const mine = (p: { sessionId: string; commentId: string }) =>
      p.sessionId === sessionId && p.commentId === commentId;

    const deltaP = listen<ForkDeltaEvent>("fork-delta", (e) => {
      if (!mine(e.payload)) return;
      setStatus("streaming");
      setExpanded(true);
      setLiveText((t) => t + e.payload.text);
    });
    const doneP = listen<ForkDoneEvent>("fork-done", (e) => {
      if (!mine(e.payload)) return;
      setMessages((m) => [
        ...m,
        {
          id: e.payload.messageId,
          sessionId,
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
    const errorP = listen<ForkErrorEvent>("fork-error", (e) => {
      if (!mine(e.payload)) return;
      setMessages((m) => [
        ...m,
        {
          id: tmpId(),
          sessionId,
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
      if (!mine(e.payload)) return;
      setLiveText("");
      setStatus("idle");
    });

    return () => {
      alive = false;
      void deltaP.then((un) => un());
      void doneP.then((un) => un());
      void errorP.then((un) => un());
      void cancelP.then((un) => un());
    };
  }, [sessionId, commentId]);

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || status === "streaming") return;
    // Optimistic user turn — the backend also persists it.
    setMessages((m) => [
      ...m,
      {
        id: tmpId(),
        sessionId,
        commentId,
        role: "user",
        body: trimmed,
        status: "complete",
        createdAt: Date.now(),
      },
    ]);
    setLiveText("");
    setStatus("streaming");
    setExpanded(true);
    void invoke("fork_thread_send", {
      sessionId,
      commentId,
      text: trimmed,
    }).catch((err) => {
      setStatus("error");
      setMessages((m) => [
        ...m,
        {
          id: tmpId(),
          sessionId,
          commentId,
          role: "assistant",
          body: `Couldn't reach the discussion fork: ${err}`,
          status: "error",
          createdAt: Date.now(),
        },
      ]);
    });
  }

  function cancel() {
    void invoke("fork_thread_cancel", { sessionId, commentId }).catch(() => {});
  }

  function discard() {
    void invoke("fork_thread_discard", { sessionId, commentId }).catch(
      () => {},
    );
    setMessages([]);
    setLiveText("");
    setStatus("idle");
    setExpanded(false);
    setDraft("");
  }

  // Avoid a flash of the "Discuss" button before get_thread resolves.
  if (!loaded) return null;

  // No thread yet — the entry point.
  if (messages.length === 0 && status === "idle") {
    return (
      <div
        className="mt-3 pt-3 border-t"
        style={{ borderColor: "var(--color-rule)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => send(discussSeed(comment))}
          className="rounded px-2 py-1 font-medium"
          style={{
            background: "var(--color-bg-elevated)",
            border: "1px solid var(--color-rule)",
            color: "var(--color-info)",
            fontSize: "11px",
          }}
        >
          💬 Discuss with Claude
        </button>
      </div>
    );
  }

  const last = messages[messages.length - 1];
  const summary = last
    ? `${last.role === "user" ? "You" : "Claude"}: ${last.body
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 90)}`
    : "";

  return (
    <div
      className="mt-3 pt-3 border-t flex flex-col gap-2"
      style={{ borderColor: "var(--color-rule)" }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => setExpanded((x) => !x)}
        className="flex items-center gap-1.5 text-left"
        style={{
          fontSize: "10px",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--color-info)",
        }}
      >
        <span aria-hidden>{expanded ? "▾" : "▸"}</span>
        <span>Discussion</span>
        <span
          className="font-mono normal-case"
          style={{ color: "var(--color-ink-muted)" }}
        >
          · {messages.length}
        </span>
        {status === "streaming" && (
          <span
            className="normal-case"
            style={{ color: "var(--color-ink-muted)", fontWeight: 400 }}
          >
            — streaming…
          </span>
        )}
      </button>

      {!expanded && (
        <div
          className="truncate"
          style={{ fontSize: "12px", color: "var(--color-ink-muted)" }}
        >
          {summary}
        </div>
      )}

      {expanded && (
        <>
          <div className="flex flex-col gap-2.5">
            {messages.map((m) => (
              <MessageBubble key={m.id} msg={m} />
            ))}
            {status === "streaming" && <StreamingBubble text={liveText} />}
          </div>

          <Composer
            draft={draft}
            setDraft={setDraft}
            streaming={status === "streaming"}
            onSend={() => {
              send(draft);
              setDraft("");
            }}
            onStop={cancel}
          />

          <button
            type="button"
            onClick={discard}
            className="self-start hover:opacity-100 opacity-60"
            style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}
          >
            Discard thread
          </button>
        </>
      )}
    </div>
  );
}

function MessageBubble({ msg }: { msg: ThreadMessage }) {
  const isUser = msg.role === "user";
  const isError = msg.status === "error";
  return (
    <div className="flex flex-col gap-0.5">
      <span
        style={{
          fontSize: "9px",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          color: isUser ? "var(--color-ink-muted)" : "var(--color-info)",
        }}
      >
        {isUser ? "You" : "Claude"}
      </span>
      <div
        style={{
          fontSize: "12.5px",
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          color: isError ? "var(--color-warning)" : "var(--color-ink)",
        }}
      >
        {msg.body}
      </div>
    </div>
  );
}

function StreamingBubble({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span
        style={{
          fontSize: "9px",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          color: "var(--color-info)",
        }}
      >
        Claude
      </span>
      <div
        style={{
          fontSize: "12.5px",
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          color: "var(--color-ink)",
        }}
      >
        {text || (
          <span style={{ color: "var(--color-ink-muted)" }}>thinking…</span>
        )}
        {text && <span style={{ color: "var(--color-ink-muted)" }}>▌</span>}
      </div>
    </div>
  );
}

function Composer({
  draft,
  setDraft,
  streaming,
  onSend,
  onStop,
}: {
  draft: string;
  setDraft: (s: string) => void;
  streaming: boolean;
  onSend: () => void;
  onStop: () => void;
}) {
  return (
    <div className="flex items-end gap-1.5">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (!streaming) onSend();
          }
        }}
        placeholder="Ask a follow-up…"
        rows={2}
        disabled={streaming}
        className="flex-1 rounded px-2 py-1 resize-none"
        style={{
          fontSize: "12px",
          border: "1px solid var(--color-rule)",
          background: "var(--color-paper)",
          color: "var(--color-ink)",
          fontFamily: "inherit",
        }}
      />
      {streaming ? (
        <button
          type="button"
          onClick={onStop}
          className="rounded px-2 py-1 font-medium"
          style={{
            background: "var(--color-bg-elevated)",
            border: "1px solid var(--color-rule)",
            color: "var(--color-ink)",
            fontSize: "11px",
          }}
        >
          Stop
        </button>
      ) : (
        <button
          type="button"
          onClick={onSend}
          disabled={!draft.trim()}
          className="rounded px-2 py-1 font-medium"
          style={{
            background: "var(--color-info)",
            color: "var(--color-on-accent)",
            fontSize: "11px",
            opacity: draft.trim() ? 1 : 0.5,
          }}
        >
          Send
        </button>
      )}
    </div>
  );
}
