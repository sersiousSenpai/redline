// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { memo, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAdjustDiscussionZoom } from "./DiscussionViewContext";
import type { Comment, CommentAttachment, ThreadMessage } from "../types";
import { useAgentTurn } from "../hooks/useAgentTurn";
import { priorUserBody } from "../lib/agentTurn";
import { RetryNote, UnsentNote } from "./QueuedChip";
import { useAttachmentCapture } from "../hooks/useAttachmentCapture";
// The rider note a transcript produces — also used to detect that an attached
// rider is stale (the discussion continued after attaching).
import { transcriptNote } from "../lib/attachmentNote";
import { agentLabelFor } from "../lib/backendChoice";
import { AttachmentChips } from "./AttachmentChips";
import { MarkdownView } from "./MarkdownView";
import StreamingBubble from "./StreamingBubble";
import TurnFooter from "./TurnFooter";
import type { TurnMeter } from "../lib/turnMeter";
import { WorkingIndicator } from "./WorkingIndicator";

interface CommentThreadProps {
  /** The review session id — keys the fork backend with the comment id. */
  sessionId: string;
  comment: Comment;
  /** Which harness authored this plan (`sessions.backend`). Claude/Codex
   *  fork natively; Cursor/Antigravity use a separate read-only Claude sidecar.
   *  `null` on every pre-backend session and reads as Claude. Only the naming
   *  lives here; `fork.rs` picks the actual binary from the same value. */
  backend?: string | null;
  /** True once, when a voice-authored comment was just created: expand the
   *  thread so the captured feedback is visible without a click. */
  autoOpen?: boolean;
  /** Called after `autoOpen` is honored, so the parent clears it. */
  onAutoOpenConsumed?: () => void;
}

type ThreadStatus = "idle" | "streaming" | "error";

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

/** A per-comment discussion with a fork of the plan session, running on the
 *  harness that authored the plan (Claude Code or Codex — `backend`).
 *  Rendered inside `CommentCard`; collapses to a one-line summary. Mirrors
 *  Streaming runs on the shared `useAgentTurn` lifecycle (T3.2), so a
 *  mid-turn remount restores the partial reply instead of resuming blank. */
// Memoized: receives only `sessionId` + `comment`, both identity-stable from
// the parent card, so it sits out the comment pane's frequent re-renders (focus
// flips, divider drags, zoom changes). It only re-renders when *its* comment
// changes or its own stream state advances.
export const CommentThread = memo(function CommentThread({
  sessionId,
  comment,
  backend = null,
  autoOpen = false,
  onAutoOpenConsumed,
}: CommentThreadProps) {
  const commentId = comment.id;
  // Derived ONCE and threaded through every label below: the entry button, the
  // bubbles, the collapsed summary, the sidecar status copy and the escalated
  // transcript must all name the same agent, because they describe one process.
  const author = agentLabelFor(backend);
  const sidecar = ["cursor", "antigravity"].includes((backend ?? "").trim().toLowerCase());
  const agent = sidecar ? "Claude sidecar" : author;
  // The shared text size is applied via the `--rl-discussion-zoom` CSS var set
  // once on the discussion pane; here we only need the stable adjuster for A−/A+.
  const adjustZoom = useAdjustDiscussionZoom();
  const [expanded, setExpanded] = useState(false);
  // Per-discussion focus: lifts the 320px message-list cap so the full reply
  // renders in place. Independent of collapse; defaults on so a discussion opens
  // at full height (structured replies + diagrams are meant to be read in full).
  // The reviewer can still collapse to compact via the ⤡ button.
  const [enlarged, setEnlarged] = useState(true);
  const [draft, setDraft] = useState("");
  // Attachments ride the optimistic user row. `makeMessage` reads this the
  // instant `turn.send` mints that row — synchronously — and `send` clears it
  // immediately after, so it can never leak into a later turn.
  const pendingAttachments = useRef<CommentAttachment[] | undefined>(undefined);

  // The shared streaming lifecycle (T3.2). Everything this thread used to
  // hand-roll is now the machine the five chat surfaces already use — and it
  // brings three things the hand-rolled version never had: seq-guarded deltas
  // (a delta the probe already folded in is dropped instead of doubled), a
  // mid-turn remount restored from `fork_thread_status.partial` instead of
  // resuming blank, and a 10s self-heal for a lost terminal event.
  //
  // The fork family joins through the config extensions rather than by being
  // renamed: its registry key is the PAIR `(sessionId, commentId)`, its
  // commands are `fork_thread_*` with `get_thread` for history, and
  // `Turns::begin` rejects-when-busy so there is no queue to type ahead into.
  const turn = useAgentTurn<ThreadMessage>({
    surface: "fork",
    key: `${sessionId}:${commentId}`,
    idField: null,
    idFields: { sessionId, commentId },
    meterKind: "fork",
    meterThreadId: sessionId,
    historyCmd: "get_thread",
    historyArgs: { sessionId, commentId },
    commands: {
      send: "fork_thread_send",
      status: "fork_thread_status",
      cancel: "fork_thread_cancel",
    },
    statusArgs: { scopeId: sessionId, itemId: commentId },
    cancelArgs: { sessionId, commentId },
    queueing: false,
    sendFailPrefix: "Couldn't reach the discussion fork",
    buildSendArgs: (text, extra) => {
      const attachments = (extra as CommentAttachment[] | undefined) ?? [];
      return {
        sessionId,
        commentId,
        text,
        // The fork has `Read`, so naming the paths is all it needs to look at
        // what the reviewer just dropped in.
        attachments: attachments.length > 0 ? attachments : null,
      };
    },
    makeMessage: ({ id, role, body, status }) => ({
      id,
      sessionId,
      commentId,
      role,
      body,
      status,
      createdAt: Date.now(),
      attachments: role === "user" ? pendingAttachments.current : undefined,
    }),
  });
  const { messages, liveText, loaded, retrying } = turn;
  const status: ThreadStatus = turn.status;
  // When the current wait began — drives the WorkingIndicator's elapsed
  // counter through the dead air before the first delta. Backend clock now,
  // so a remount mid-turn shows the true elapsed time instead of restarting.
  const workStartedAt = turn.startedAt;
  // When the reviewer manually collapses an expanded thread, suppress the
  // streaming auto-expand until the next send — otherwise a long streamed reply
  // keeps re-opening a thread they're deliberately trying to set aside.
  const userCollapsedRef = useRef(false);

  // A just-captured voice comment: open the discussion sidecar once, then let
  // the parent clear the flag so a later manual collapse isn't fought.
  useEffect(() => {
    if (!autoOpen) return;
    userCollapsedRef.current = false;
    setExpanded(true);
    onAutoOpenConsumed?.();
  }, [autoOpen, onAutoOpenConsumed]);

  // Auto-expand as the reply streams in — unless the reviewer just folded
  // this thread away on purpose. (Previously done inside the delta listener;
  // watching `liveText` also catches a stream restored from the probe on a
  // mid-turn remount, which the listener never saw.)
  useEffect(() => {
    if (liveText && !userCollapsedRef.current) setExpanded(true);
  }, [liveText]);

  function send(text: string, attachments: CommentAttachment[] = []) {
    const trimmed = text.trim();
    // The fork registry rejects-when-busy; the hook drops a mid-turn send too,
    // but bail here so the auto-expand below doesn't fire for a no-op.
    if (!trimmed || status === "streaming") return;
    // A fresh send re-grants the auto-expand-on-delta behavior — the user
    // just asked something, so they want to see the reply unfold.
    userCollapsedRef.current = false;
    setExpanded(true);
    pendingAttachments.current = attachments.length > 0 ? attachments : undefined;
    turn.send(trimmed, { extra: attachments });
    pendingAttachments.current = undefined;
  }

  const cancel = turn.cancel;

  /** Re-send the question an error row is the failed answer to. Offered on the
   *  thread's LAST row only: an error further up has already been answered by
   *  whatever came after it, and re-asking would duplicate the exchange. */
  const retryAt = (list: ThreadMessage[], i: number): (() => void) | undefined => {
    const body = priorUserBody(list, i);
    return body ? () => send(body) : undefined;
  };

  // Route a read-only discussion into the main revise loop: attach the
  // transcript to the comment as its rider note, so the next Submit carries
  // the original feedback + everything we just worked out. Works on drafts
  // (rider rides pre-submit, no wasted round-trip) and on resolved comments
  // (reopens with the transcript as follow-up). The card updates via the
  // comments-changed reload the backend emits.
  function attachTranscript(transcript: ThreadMessage[]) {
    // A discussed question that's escalated has become a decision — promote it
    // so the next Revise actually changes the plan, not just answers again.
    const asChange = comment.type === "question";
    void invoke("attach_discussion", {
      sessionId,
      commentId,
      note: transcriptNote(transcript, agent),
      asChange,
    }).catch((err) => console.error("attach discussion failed", err));
  }

  function detachTranscript() {
    void invoke("attach_discussion", {
      sessionId,
      commentId,
      note: null,
      asChange: false,
    }).catch((err) => console.error("detach discussion failed", err));
  }

  // Discarding a draft's thread discards the whole aside — comment included:
  // the user is abandoning the question/note they spun the discussion off
  // from, and a leftover draft card would silently ride into the next submit.
  // Submitted/resolved comments are part of the review contract (their ids
  // are resolution keys), so for those only the discussion is removed — same
  // rule as the card's ✕, which is also draft-only.
  const discardRemovesComment = comment.status === "draft";
  // The turn is over — successfully or not. A failed turn used to lock the
  // reviewer out of attaching (and then detaching) the transcript, which is
  // exactly when they most want to route the exchange back into the plan.
  const settled = status === "idle" || status === "error";

  function discard() {
    const threadGone = invoke("fork_thread_discard", {
      sessionId,
      commentId,
    }).catch(() => {});
    if (discardRemovesComment) {
      void threadGone.then(() =>
        invoke("delete_comment", { sessionId, commentId }).catch((err) =>
          console.error("delete comment with thread failed", err),
        ),
      );
    }
    turn.clear();
    setExpanded(false);
    setDraft("");
  }

  // Avoid a flash of the "Discuss" button before get_thread resolves.
  if (!loaded) return null;

  // The opening user turn is the comment's own text (see `discussSeed`), which
  // the CommentCard already renders as the comment body — so don't echo it as a
  // visible bubble. We still send it to the fork (the agent needs the question);
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
  // (batch in flight — nothing to attach to until the plan agent responds) and
  // accepted/withdrawn (closed; CommentCard's Reopen is the deliberate way
  // back in).
  const canEscalate =
    comment.status !== "submitted" &&
    comment.status !== "accepted" &&
    comment.status !== "withdrawn";
  // A draft rider can only come from "Add to plan" / "Attach to next submit"
  // on this very thread, so the attached state is flagged HERE, on the
  // discussion itself — no duplicate copy of the transcript on the card.
  const riderAttached =
    comment.status === "draft" && !comment.resolution && !!comment.reopenNote;
  // The batch went out with the rider aboard — show the in-flight cue.
  const riderSent =
    comment.status === "submitted" &&
    !comment.resolution &&
    !!comment.reopenNote;
  // Discussion continued after attaching: the rider no longer matches the
  // transcript — offer a one-click refresh instead of silently sending the
  // stale snapshot.
  const riderStale =
    riderAttached && transcriptNote(visible, agent) !== comment.reopenNote;

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
          💬 Discuss with {agent}
        </button>
        {sidecar && <p style={{ color: "var(--color-ink-muted)", fontSize: "10px", marginTop: 5 }}>A separate read-only discussion seeded with this {author} plan.</p>}
      </div>
    );
  }

  const last = visible[visible.length - 1];
  const summary = last
    ? `${last.role === "user" ? "You" : agent}: ${last.body
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
      <div className="flex items-center gap-1.5">
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
          {/* Collapsed only — an expanded thread shows the body spinner
              (with the elapsed counter) instead, never both at once. */}
          {status === "streaming" && !expanded && (
            <span className="normal-case" style={{ fontWeight: 400 }}>
              <WorkingIndicator
                compact
                label={liveText ? "Streaming" : "Thinking"}
              />
            </span>
          )}
          {/* The attached/sent flag lives on the discussion itself — the rider
              IS this transcript, so there's nothing else to show. The flag
              stays visible collapsed or expanded. */}
          {riderAttached && (
            <span style={{ color: "var(--color-warning)" }}>
              {comment.actionable
                ? "· added to plan — rides with next submit"
                : "· attached — rides with next submit"}
            </span>
          )}
          {riderSent && (
            <span className="rl-pulse" style={{ color: "var(--color-warning)" }}>
              {comment.actionable
                ? `· decision sent · ${author} is applying…`
                : "· sent · riding with this submit…"}
            </span>
          )}
        </button>

        {/* Focus + text-size controls — only meaningful while the thread is
            open. Siblings of the collapse button (buttons can't nest); each
            stops propagation so it never toggles collapse. */}
        {expanded && (
          <div className="flex items-center gap-1 ml-auto">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                adjustZoom(-0.1);
              }}
              title="Smaller discussion text"
              className="px-1 leading-none hover:opacity-100 opacity-60"
              style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}
            >
              A−
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                adjustZoom(0.1);
              }}
              title="Larger discussion text"
              className="px-1 leading-none hover:opacity-100 opacity-60"
              style={{ fontSize: "12px", color: "var(--color-ink-muted)" }}
            >
              A+
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setEnlarged((x) => !x);
              }}
              title={enlarged ? "Collapse to compact" : "Expand to full height"}
              aria-pressed={enlarged}
              className="px-1 leading-none hover:opacity-100 opacity-60"
              style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}
            >
              {enlarged ? "⤡" : "⤢"}
            </button>
          </div>
        )}
      </div>

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
          <div
            className={`flex flex-col gap-2.5 rl-thin-scroll-y ${
              enlarged ? "rl-thread-scroll-tall" : "rl-thread-scroll"
            }`}
          >
            {visible.map((m, i) => (
              <MessageBubble
                key={m.id}
                msg={m}
                meter={turn.meters[m.id]}
                agent={agent}
                onRetry={
                  m.status === "error" && i === visible.length - 1
                    ? retryAt(visible, i)
                    : undefined
                }
                onResend={
                  m.status === "unsent" ? () => send(m.body) : undefined
                }
              />
            ))}
            {status === "streaming" && (
              <>
                {/* The badge and the activity line fill the wait the blank
                    ticker used to — so the bubble renders from the first line
                    of the stream, not the first token. */}
                <StreamingBubble
                  text={liveText}
                  agent={agent}
                  inspect={{ surface: "fork", key: commentId }}
                  retrying={retrying}
                  meter={turn.meter}
                  activity={turn.activity}
                />
                {!liveText && !retrying && (
                  <WorkingIndicator startedAt={workStartedAt ?? undefined} />
                )}
              </>
            )}
          </div>

          <Composer
            sessionId={sessionId}
            draft={draft}
            setDraft={setDraft}
            streaming={status === "streaming"}
            onSend={(attachments) => {
              send(draft, attachments);
              setDraft("");
            }}
            onStop={cancel}
          />

          {/* Once the exchange has settled, let the reviewer route what they
              just worked out back into the revise loop — the fork itself
              can't change the plan. Available pre-submit (the rider bundles
              into the next submit) and post-resolution (reopens
              with the transcript as follow-up). Once attached, the button
              gives way to detach (and a refresh when the discussion has
              continued past the attached snapshot). */}
          {canEscalate && settled && !riderAttached && (
            <button
              type="button"
              onClick={() => attachTranscript(visible)}
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
          {riderAttached && settled && (
            <div className="flex items-center gap-2">
              {riderStale && (
                <button
                  type="button"
                  onClick={() => attachTranscript(visible)}
                  title="The discussion continued after attaching — refresh the attached snapshot to include the new turns"
                  className="rounded px-2 py-1 font-medium"
                  style={{
                    background: "var(--color-warning)",
                    color: "var(--color-on-accent)",
                    fontSize: "11px",
                  }}
                >
                  Update attachment →
                </button>
              )}
              <button
                type="button"
                onClick={detachTranscript}
                title={
                  comment.actionable
                    ? "Remove from the next submit (also un-promotes the decision)"
                    : "Remove this discussion from the next submit"
                }
                className="self-start hover:opacity-100 opacity-60"
                style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}
              >
                ✕ detach from next submit
              </button>
            </div>
          )}
          {comment.status === "submitted" && status === "idle" && !riderSent && (
            <span
              className="self-start italic"
              style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}
            >
              Sent — escalate after {agent} responds.
            </span>
          )}

          <button
            type="button"
            onClick={discard}
            title={
              discardRemovesComment
                ? "Remove this discussion and its draft comment"
                : "Remove this discussion (the comment stays — it's part of the review)"
            }
            className="self-start hover:opacity-100 opacity-60"
            style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}
          >
            {discardRemovesComment
              ? "Discard thread & comment"
              : "Discard thread"}
          </button>
        </>
      )}
    </div>
  );
});

function MessageBubble({
  msg,
  agent,
  onRetry,
  onResend,
  meter,
}: {
  msg: ThreadMessage;
  agent: string;
  /** Present only on the thread's last row when it failed. */
  onRetry?: () => void;
  /** Present only on a user row whose send never became a turn. */
  onResend?: () => void;
  /** This row's settled meter — the badge and footer that outlive the turn. */
  meter?: TurnMeter | null;
}) {
  const isUser = msg.role === "user";
  const isError = msg.status === "error";
  const isUnsent = msg.status === "unsent";
  return (
    <div className="flex flex-col gap-0.5">
      <span
        style={{
          fontSize: "9px",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          color: isUser
            ? "var(--color-ink-muted)"
            : isError
              ? "var(--color-warning)"
              : "var(--color-info)",
        }}
      >
        {/* Redline wrote the error sentence, not the model. Bylining it
            `agent` is what made a raw machine token read as something Claude
            had said. */}
        {isUser ? "You" : isError ? "Redline" : agent}
      </span>
      {isError ? (
        <div
          style={{
            fontSize: "calc(12.5px * var(--rl-discussion-zoom, 1))",
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            color: "var(--color-warning)",
          }}
        >
          {msg.body}
        </div>
      ) : (
        <MarkdownView body={msg.body} compact rich />
      )}
      {isError && onRetry && <RetryNote onRetry={onRetry} />}
      {isUnsent && <UnsentNote onResend={onResend} />}
      {!isUser && <TurnFooter meter={meter} />}
      {/* What the reviewer attached to this turn — read-only in the
          transcript; the fork was given the paths to read. */}
      {msg.attachments && msg.attachments.length > 0 && (
        <AttachmentChips attachments={msg.attachments} />
      )}
    </div>
  );
}

function Composer({
  sessionId,
  draft,
  setDraft,
  streaming,
  onSend,
  onStop,
}: {
  /** Scopes where a dropped/pasted file is copied. */
  sessionId: string;
  draft: string;
  setDraft: (s: string) => void;
  streaming: boolean;
  /** Receives whatever files were captured for this turn; the parent clears
   *  the draft and this clears its own chips. */
  onSend: (attachments: CommentAttachment[]) => void;
  onStop: () => void;
}) {
  const files = useAttachmentCapture(sessionId);
  const submit = () => {
    onSend(files.attachments);
    files.clear();
  };
  // Auto-grow to fit content — no cap, no scrollbar. Recomputed on input and
  // whenever `draft` changes — the latter catches the parent's clear-on-send so
  // the box snaps back to its 2-row baseline.
  const taRef = useRef<HTMLTextAreaElement>(null);
  const autosize = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(autosize, [draft]);
  return (
    <div ref={files.hostRef}>
      {/* Same capture as the main composer: Tauri swallows HTML5 drops, so the
          webview-level event does the work and each host hit-tests itself. */}
      <AttachmentChips attachments={files.attachments} onRemove={files.remove} />
      {files.error && (
        <div
          className="mb-1"
          style={{ fontSize: "11px", color: "var(--color-warning)" }}
        >
          {files.error}
        </div>
      )}
      <div className="flex items-end gap-1.5">
      <textarea
        ref={taRef}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          autosize();
        }}
        onPaste={files.onPaste}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (!streaming) submit();
          }
        }}
        placeholder={files.dragOver ? "Drop to attach…" : "Ask a follow-up…"}
        rows={2}
        disabled={streaming}
        className="flex-1 rounded px-2 py-1"
        style={{
          fontSize: "calc(12px * var(--rl-discussion-zoom, 1))",
          border: "1px solid var(--color-rule)",
          background: "var(--color-paper)",
          color: "var(--color-ink)",
          fontFamily: "inherit",
          // Grows to fit its content — no inner scroll, no manual resize handle.
          resize: "none",
          overflow: "hidden",
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
          onClick={submit}
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
    </div>
  );
}
