// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";
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
import { MarkdownView } from "./MarkdownView";

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
  // When the reviewer manually collapses an expanded thread, suppress the
  // streaming auto-expand until the next send — otherwise a long Claude reply
  // keeps re-opening a thread they're deliberately trying to set aside.
  const userCollapsedRef = useRef(false);

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

    // StrictMode runs setup→cleanup→setup; the cleanup's unlisten resolves
    // async, so between the second setup and that resolve there are briefly
    // two live handlers. The `alive` closure capture lets the stale generation
    // no-op, preventing a duplicate message append.
    const deltaP = listen<ForkDeltaEvent>("fork-delta", (e) => {
      if (!alive) return;
      if (!mine(e.payload)) return;
      setStatus("streaming");
      if (!userCollapsedRef.current) setExpanded(true);
      setLiveText((t) => t + e.payload.text);
    });
    const doneP = listen<ForkDoneEvent>("fork-done", (e) => {
      if (!alive) return;
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
      if (!alive) return;
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
      if (!alive) return;
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
    // A fresh send re-grants the auto-expand-on-delta behavior — the user
    // just asked something, so they want to see the reply unfold.
    userCollapsedRef.current = false;
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

  // Route a read-only discussion into the main revise loop: attach the
  // transcript to the comment as its rider note, so the next Submit carries
  // the original feedback + everything we just worked out. Works on drafts
  // (rider rides pre-submit, no wasted round-trip) and on resolved comments
  // (reopens with the transcript as follow-up). The card updates via the
  // comments-changed reload the backend emits.
  function sendToClaude(transcript: ThreadMessage[]) {
    const body = transcript
      .map((m) => `${m.role === "user" ? "Reviewer" : "Claude"}: ${m.body.trim()}`)
      .join("\n\n");
    const note = `Following a discussion with Claude:\n\n${body}`;
    // A discussed question that's escalated has become a decision — promote it
    // so the next Revise actually changes the plan, not just answers again.
    const asChange = comment.type === "question";
    void invoke("attach_discussion", {
      sessionId,
      commentId,
      note,
      asChange,
    }).catch((err) => console.error("attach discussion failed", err));
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

  // The opening user turn is the comment's own text (see `discussSeed`), which
  // the CommentCard already renders as the comment body — so don't echo it as a
  // visible bubble. We still send it to the fork (Claude needs the question);
  // we just hide the redundant first "You:" turn here. Covers both the
  // optimistic path (seed is messages[0]) and the persisted reload (get_thread
  // returns it as rows[0]).
  const seed = discussSeed(comment);
  const visible = messages.filter(
    (m, i) => !(i === 0 && m.role === "user" && m.body.trim() === seed),
  );
  // Escalation is available the moment the discussion has substance — before
  // any round-trip (a draft's rider rides with the next submit) and after a
  // resolution (reopen with the transcript as follow-up). Excluded: submitted
  // (batch in flight — nothing to attach to until Claude responds) and
  // accepted/withdrawn (closed; CommentCard's Reopen is the deliberate way
  // back in).
  const canEscalate =
    comment.status !== "submitted" &&
    comment.status !== "accepted" &&
    comment.status !== "withdrawn";

  // No thread yet (or only the suppressed seed) — the entry point.
  if (visible.length === 0 && status === "idle") {
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

  const last = visible[visible.length - 1];
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
        onClick={() =>
          setExpanded((x) => {
            // Track manual collapse so a streaming reply doesn't immediately
            // re-open what the user just folded away.
            userCollapsedRef.current = x;
            return !x;
          })
        }
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
          · {visible.length}
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
          <div className="flex flex-col gap-2.5 rl-thread-scroll">
            {visible.map((m) => (
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

          {/* Once the exchange has settled, let the reviewer route what they
              just worked out back into the revise loop — the fork itself
              can't change the plan. Available pre-submit (the rider bundles
              into the next Send to Claude Code) and post-resolution (reopens
              with the transcript as follow-up). */}
          {canEscalate && status === "idle" && (
            <button
              type="button"
              onClick={() => sendToClaude(visible)}
              className="self-start rounded px-2 py-1 font-medium"
              style={{
                background: "var(--color-warning)",
                color: "var(--color-on-accent)",
                fontSize: "11px",
              }}
              title={
                comment.type === "question"
                  ? "Bundle this discussion into the next submit as a plan change"
                  : "Bundle this discussion into the next submit as context"
              }
            >
              {comment.type === "question"
                ? "Add to plan →"
                : "Attach to next submit →"}
            </button>
          )}
          {comment.status === "submitted" && status === "idle" && (
            <span
              className="self-start italic"
              style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}
            >
              Sent — escalate after Claude responds.
            </span>
          )}

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
      {isError ? (
        <div
          style={{
            fontSize: "12.5px",
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            color: "var(--color-warning)",
          }}
        >
          {msg.body}
        </div>
      ) : (
        <MarkdownView body={msg.body} compact />
      )}
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
      {text ? (
        <div>
          <MarkdownView body={text} compact />
          <span style={{ color: "var(--color-ink-muted)" }}>▌</span>
        </div>
      ) : (
        <div
          style={{
            fontSize: "12.5px",
            lineHeight: 1.5,
            color: "var(--color-ink-muted)",
          }}
        >
          thinking…
        </div>
      )}
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
        className="flex-1 rounded px-2 py-1"
        style={{
          fontSize: "12px",
          border: "1px solid var(--color-rule)",
          background: "var(--color-paper)",
          color: "var(--color-ink)",
          fontFamily: "inherit",
          // Big pastes scroll inside the composer instead of blowing out the
          // card; reviewer can still drag-grow the textarea vertically.
          resize: "vertical",
          maxHeight: "200px",
          overflowY: "auto",
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
