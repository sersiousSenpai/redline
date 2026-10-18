// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The full pose's right-panel **Feedback** tab (board 5a): the plan's
//! comments read as threads — your note, Claude's reply behind a rule, then
//! ✓ Accept · Reopen … 💬 Discuss — with human anchors ("§4 · step 4") in
//! place of the positional ids, and resolved threads collapsed to two lines.
//!
//! Three pieces, because the stage owns where they sit:
//!
//! - `FeedbackPanel` (default export, lazy): the list, with the bottom
//!   composer slot.
//! - `FeedbackTabs`: the 48px header row — "Chat" / "Feedback 16" … "All
//!   resolved". The stage renders it above whichever tab is showing.
//! - `FeedbackComposer`: "Select text in the plan, or type feedback…", which
//!   the stage hands the panel as `composer` (or places itself).
//!
//! Nothing here invents a resolution model. Accept, Reopen (with a note),
//! "Make it a change", Edit and Delete are the existing commands the classic
//! comment pane calls — `accept_resolution`, `reopen_resolution`,
//! `update_comment`, `delete_comment` — and Discuss opens the same per-comment
//! discussion fork (`CommentThread`). Every change comes back the usual way:
//! the backend emits `comments-changed`, App reloads the session, and the new
//! `session` prop re-renders the threads.

import "./feedback.css";

import { invoke } from "@tauri-apps/api/core";
import { ArrowUp, Check, MessageCircle, Mic } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";

import { AttachmentChips } from "../components/AttachmentChips";
import { CommentThread } from "../components/CommentThread";
import { MarkdownView } from "../components/MarkdownView";
import { compactEditPreview } from "../editor/wordDiff";
import { blockIdByAnchorId } from "../editor/sectionMaps";
import type { SelectionState } from "../hooks/useTextSelection";
import { createAnchorDisplay } from "../lib/anchorDisplay";
import { agentLabelFor } from "../lib/backendChoice";
import { useDictationComposer } from "../lib/dictationComposer";
import { buildDraftCommentUpdate } from "../lib/draftCommentUpdate";
import {
  commentTarget,
  isSettled,
  isUndecidedSuggestion,
  isVoiceNote,
  noteText,
  orderFeedback,
  RESOLVED_PREVIEW,
  revisionAt,
  statusNote,
} from "../lib/feedbackThreads";
import { shortModel } from "../lib/modelInfo";
import { researchStatus } from "../lib/planSearch";
import type { PanelTab } from "./flowState";
import type { Comment, NewCommentRequest, ReviewSession, UpdateCommentRequest } from "../types";

/** The comment actions a thread offers. By default each is the Tauri command
 *  App's own handlers call; the stage may pass App's handlers instead. */
export interface FeedbackActions {
  accept: (commentId: string) => unknown;
  reopen: (commentId: string, note?: string) => unknown;
  /** A question resolved into a decision Claude must apply. */
  promote: (commentId: string, directive: string) => unknown;
  remove: (commentId: string) => unknown;
  /** Resolves false when the update did not land. */
  update: (commentId: string, update: UpdateCommentRequest) => boolean | Promise<boolean> | void;
  /** An agent's suggested edit, kept in place. It settles marks in the
   *  editor, which only App can reach — without it the thread offers Reject
   *  alone and the suggestion is accepted in the plan. */
  acceptSuggestion?: (comment: Comment) => unknown;
}

export interface FeedbackPanelProps {
  /** The plan session (App's `session`). */
  session: ReviewSession;
  /** The version the plan panel shows: its comments are the threads. */
  viewingVersion: number;
  /** A thread was clicked: bring its anchor into view. `commentId` lets the
   *  stage also light the comment's highlight (App's `focusComment`). */
  onJumpToAnchor: (anchorId: string, commentId?: string) => void;
  /** The bottom composer, from the stage. Absent: a `FeedbackComposer` for
   *  this session; `null`: none. */
  composer?: ReactNode;
  /** The comment focused from the plan (a highlight click): its thread is
   *  the current one, shown and scrolled to. */
  focusedCommentId?: string | null;
  /** A Send / Approve is mid-flight: Accept and Reopen wait (App's `busy`). */
  submitInFlight?: boolean;
  /** Replace any of the default actions. */
  actions?: Partial<FeedbackActions>;
  /** A research comment's "View result →" (App's `viewResearch`). */
  onViewResearch?: (comment: Comment) => void;
}

/** The default actions: the same commands, with the same arguments, App's
 *  comment handlers send. */
function commandActions(sessionId: string): FeedbackActions {
  const run = (label: string, command: string, args: Record<string, unknown>) =>
    invoke(command, { sessionId, ...args }).catch((err) => console.error(`${label} failed`, err));
  return {
    accept: (commentId) => run("accept_resolution", "accept_resolution", { commentId }),
    reopen: (commentId, note) => run("reopen_resolution", "reopen_resolution", { commentId, note: note ?? null }),
    promote: (commentId, directive) =>
      run("promote-to-change", "reopen_resolution", { commentId, note: directive, asChange: true }),
    remove: (commentId) => run("delete comment", "delete_comment", { commentId }),
    update: (commentId, update) =>
      invoke("update_comment", { sessionId, commentId, update }).then(
        () => true,
        (err) => {
          console.error("failed to update comment", err);
          return false;
        },
      ),
  };
}

export default function FeedbackPanel({
  session,
  viewingVersion,
  onJumpToAnchor,
  composer,
  focusedCommentId = null,
  submitInFlight = false,
  actions,
  onViewResearch,
}: FeedbackPanelProps) {
  const revision = revisionAt(session, viewingVersion);
  // Labels are read against the revision the comments were made on — the one
  // being shown — so a thread keeps the words it was written against.
  const display = useMemo(() => createAnchorDisplay(revision?.sections ?? []), [revision]);
  const { open, settled } = useMemo(() => orderFeedback(revision?.comments ?? []), [revision]);
  // The stage's handlers where it gives them; an absent one keeps the command.
  const act = useMemo<FeedbackActions>(
    () => ({
      ...commandActions(session.sessionId),
      ...Object.fromEntries(Object.entries(actions ?? {}).filter(([, handler]) => !!handler)),
    }),
    [session.sessionId, actions],
  );
  const [showAll, setShowAll] = useState(false);
  // A highlight clicked in the plan whose thread sits behind "N more
  // resolved" brings the rest out, so the thread it names is on screen.
  useEffect(() => {
    if (!focusedCommentId) return;
    const at = settled.findIndex((c) => c.id === focusedCommentId);
    if (at >= RESOLVED_PREVIEW) setShowAll(true);
  }, [focusedCommentId, settled]);
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!focusedCommentId) return;
    const cards = listRef.current?.querySelectorAll<HTMLElement>("[data-comment-id]") ?? [];
    [...cards].find((el) => el.dataset.commentId === focusedCommentId)?.scrollIntoView?.({ block: "nearest" });
  }, [focusedCommentId, showAll]);

  // The thread you're on: the one focused from the plan, else the first that
  // still needs something — the board's one card with the focus rim.
  const current =
    focusedCommentId && open.some((c) => c.id === focusedCommentId) ? focusedCommentId : open[0]?.id ?? null;
  const shown = showAll ? settled : settled.slice(0, RESOLVED_PREVIEW);
  const more = settled.length - shown.length;
  const jump = useCallback((c: Comment) => onJumpToAnchor(c.anchorId, c.id), [onJumpToAnchor]);

  return (
    <div className="rl-fb-panel" data-flow-feedback>
      <div ref={listRef} className="rl-fb-list rl-thin-scroll-y">
        {open.length === 0 && settled.length === 0 && (
          <p className="rl-fb-empty">Select text in the plan to mark it, or type feedback below.</p>
        )}
        {open.map((c) => (
          <FeedbackCard
            key={c.id}
            comment={c}
            label={display.label(commentTarget(c))}
            current={c.id === current}
            focused={c.id === focusedCommentId}
            sessionId={session.sessionId}
            backend={session.backend ?? null}
            act={act}
            busy={submitInFlight}
            onJump={jump}
            onViewResearch={onViewResearch}
          />
        ))}
        {shown.map((c) => (
          <FeedbackCard
            key={c.id}
            comment={c}
            label={display.label(commentTarget(c))}
            current={false}
            focused={c.id === focusedCommentId}
            sessionId={session.sessionId}
            backend={session.backend ?? null}
            act={act}
            busy={submitInFlight}
            onJump={jump}
            onViewResearch={onViewResearch}
          />
        ))}
        {more > 0 && (
          <button type="button" className="rl-fb-more" onClick={() => setShowAll(true)}>
            {more} more resolved
          </button>
        )}
        {showAll && settled.length > RESOLVED_PREVIEW && (
          <button type="button" className="rl-fb-more" onClick={() => setShowAll(false)}>
            Show fewer
          </button>
        )}
      </div>
      {composer === undefined ? (
        <div className="rl-fb-composer-wrap">
          <FeedbackComposer session={session} />
        </div>
      ) : composer === null ? null : (
        <div className="rl-fb-composer-wrap">{composer}</div>
      )}
    </div>
  );
}

interface FeedbackCardProps {
  comment: Comment;
  label: string;
  /** The board's focus rim: the thread you're on. */
  current: boolean;
  /** Focused from the plan: a resolved thread opens. */
  focused: boolean;
  sessionId: string;
  backend: string | null;
  act: FeedbackActions;
  busy: boolean;
  onJump: (c: Comment) => void;
  onViewResearch?: (c: Comment) => void;
}

type Form = "reopen" | "promote" | "edit" | null;

/** Interactive pieces inside a card: a click there is theirs, not a jump. */
const OWN_CLICK = "button, a, textarea, input, select, label, [data-no-jump]";

function FeedbackCard({
  comment: c,
  label,
  current,
  focused,
  sessionId,
  backend,
  act,
  busy,
  onJump,
  onViewResearch,
}: FeedbackCardProps) {
  const settled = isSettled(c);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (focused && settled) setExpanded(true);
  }, [focused, settled]);
  const collapsed = settled && !expanded;
  const status = statusNote(c, backend);
  const agent = agentLabelFor(backend);
  const suggestion = isUndecidedSuggestion(c);
  // A reopened follow-up rides back on the next Send, which flips it to
  // submitted with the note kept: show it through that wait too.
  const pendingReopen = c.status === "submitted" && !!c.reopenNote;
  const reopenedView = c.status === "reopened" || pendingReopen;

  const [form, setForm] = useState<Form>(null);
  const [draft, setDraft] = useState("");
  const [revised, setRevised] = useState("");
  const openForm = (next: Exclude<Form, null>) => {
    setDraft(next === "edit" ? (c.body === "(edit)" ? "" : c.body) : c.reopenNote ?? "");
    setRevised(c.edit?.revised ?? "");
    setForm(next);
  };
  const confirm = () => {
    const text = draft.trim();
    if (form === "reopen") act.reopen(c.id, text || undefined);
    else if (form === "promote") {
      if (!text) return;
      act.promote(c.id, text);
    } else if (form === "edit") {
      act.update(c.id, buildDraftCommentUpdate(c, draft, c.edit ? revised : undefined));
    }
    setForm(null);
  };
  // Reopen and the change wait out a Send in flight; an edit's text is the
  // payload, so it needs some.
  const confirmDisabled =
    form === "promote"
      ? busy || !draft.trim()
      : form === "edit"
        ? !(c.edit ? revised : draft).trim()
        : busy;

  // Discuss: the host's way into the comment's discussion fork. Each press
  // opens the thread, starting it when there is none yet.
  const [discussNonce, setDiscussNonce] = useState(0);
  const [hasDiscussion, setHasDiscussion] = useState(false);

  const onCardClick = (e: MouseEvent) => {
    if ((e.target as Element).closest(OWN_CLICK)) return;
    if (settled) setExpanded((x) => !x);
    onJump(c);
  };

  const className = [
    "rl-fb-card",
    collapsed ? "is-settled" : "rl-glass rl-glass-sheet",
    current && !collapsed ? "is-current" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article data-comment-id={c.id} className={className} onClick={onCardClick}>
      <div className="rl-fb-meta">
        <button
          type="button"
          className="rl-fb-anchor"
          title="Show in the plan"
          onClick={() => {
            if (settled) setExpanded(true);
            onJump(c);
          }}
        >
          {label}
        </button>
        {isVoiceNote(c) && (
          <>
            <span aria-hidden>·</span>
            <span className="rl-fb-voice">
              <Mic size={11} aria-hidden />
              voice note
            </span>
          </>
        )}
        {c.reviewer && (
          <>
            <span aria-hidden>·</span>
            <span className="rl-fb-voice">{c.reviewer}</span>
          </>
        )}
        <span className="rl-fb-status" data-tone={status.tone}>
          {status.text}
        </span>
      </div>

      {collapsed ? (
        <div className="rl-fb-note">{noteText(c)}</div>
      ) : (
        <>
          {form === "edit" ? null : <Note comment={c} />}
          {c.attachments && c.attachments.length > 0 && <AttachmentChips attachments={c.attachments} />}
          {c.research && (
            <div className="rl-fb-meta" data-no-jump>
              <span>{researchStatus(c.research)}</span>
              {onViewResearch && (
                <button type="button" className="rl-fb-anchor" onClick={() => onViewResearch(c)}>
                  View result →
                </button>
              )}
            </div>
          )}
          {c.resolution && (
            <div className={reopenedView ? "rl-fb-reply is-superseded" : "rl-fb-reply"}>
              <span className="rl-fb-reply-rule" aria-hidden />
              <div className="rl-fb-reply-body">
                <MarkdownView body={c.resolution.body} />
              </div>
            </div>
          )}
          {reopenedView && c.reopenNote && form === null && (
            <div className="rl-fb-followup">
              <span className="rl-fb-followup-label">
                {pendingReopen
                  ? `${c.actionable ? "Decision" : "Follow-up"} sent · ${agent} is responding…`
                  : c.actionable
                    ? "Your decision · sent with the next Send"
                    : "Your follow-up · sent with the next Send"}
              </span>
              <MarkdownView body={c.reopenNote} />
            </div>
          )}

          {form !== null ? (
            <div className="rl-fb-form" data-no-jump>
              {form === "promote" && <span className="rl-fb-form-label">Turn into a plan change</span>}
              {form === "edit" && c.edit && (
                <>
                  <span className="rl-fb-form-label">
                    Replacing “{c.edit.original}” with
                  </span>
                  <textarea
                    aria-label="Revised text"
                    value={revised}
                    autoFocus
                    onChange={(e) => setRevised(e.target.value)}
                  />
                </>
              )}
              <textarea
                aria-label={form === "edit" ? "Note" : form === "promote" ? "The change" : "Follow-up note"}
                value={draft}
                autoFocus={!(form === "edit" && c.edit)}
                placeholder={
                  form === "reopen"
                    ? `What's still off, or extra context for ${agent}? (optional)`
                    : form === "promote"
                      ? "What should change? e.g. “Use a modern style instead.”"
                      : c.edit
                        ? `Optional note for ${agent}…`
                        : "Your note…"
                }
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="rl-fb-actions">
                <button type="button" className="rl-fb-action is-primary" disabled={confirmDisabled} onClick={confirm}>
                  {form === "reopen"
                    ? c.status === "reopened"
                      ? "Update note"
                      : "Reopen"
                    : form === "promote"
                      ? c.actionable
                        ? "Update change"
                        : "Make it a change"
                      : "Save"}
                </button>
                <button type="button" className="rl-fb-action" onClick={() => setForm(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="rl-fb-actions">
              {c.status === "resolved" && (
                <button type="button" className="rl-fb-action is-accept" disabled={busy} onClick={() => act.accept(c.id)}>
                  <Check size={12} aria-hidden />
                  Accept
                </button>
              )}
              {(c.status === "resolved" || c.status === "accepted") && (
                <button type="button" className="rl-fb-action" disabled={busy} onClick={() => openForm("reopen")}>
                  Reopen
                </button>
              )}
              {c.status === "reopened" && (
                <button
                  type="button"
                  className="rl-fb-action"
                  disabled={busy}
                  onClick={() => openForm(c.actionable ? "promote" : "reopen")}
                >
                  {c.actionable ? "Edit decision" : c.reopenNote ? "Edit note" : "Add note"}
                </button>
              )}
              {c.type === "question" &&
                !c.actionable &&
                !hasDiscussion &&
                (c.status === "resolved" || c.status === "accepted" || c.status === "reopened") && (
                  <button type="button" className="rl-fb-action" disabled={busy} onClick={() => openForm("promote")}>
                    Make it a change
                  </button>
                )}
              {suggestion && act.acceptSuggestion && (
                <button type="button" className="rl-fb-action is-accept" onClick={() => act.acceptSuggestion?.(c)}>
                  <Check size={12} aria-hidden />
                  Accept
                </button>
              )}
              {suggestion && (
                <button type="button" className="rl-fb-action" onClick={() => act.remove(c.id)}>
                  Reject
                </button>
              )}
              {c.status === "draft" && !c.author && (
                <button type="button" className="rl-fb-action" onClick={() => openForm("edit")}>
                  Edit
                </button>
              )}
              {c.status === "draft" && !suggestion && (
                <button type="button" className="rl-fb-action" onClick={() => act.remove(c.id)}>
                  Delete
                </button>
              )}
              <button
                type="button"
                className="rl-fb-action is-discuss"
                title={`Talk this through with ${agent} — the plan stays as it is`}
                onClick={() => setDiscussNonce((n) => n + 1)}
              >
                <MessageCircle size={12} aria-hidden />
                Discuss
              </button>
            </div>
          )}

          <div className="rl-fb-thread" data-no-jump>
            <CommentThread
              sessionId={sessionId}
              comment={c}
              backend={backend}
              hideEntry
              discussNonce={discussNonce}
              onHasDiscussion={setHasDiscussion}
            />
          </div>
        </>
      )}
    </article>
  );
}

/** The note itself: the body as markdown, or an edit's word-level change. */
function Note({ comment: c }: { comment: Comment }) {
  const body = (c.body ?? "").trim();
  return (
    <div className="rl-fb-note">
      {c.edit && (
        <div className="rl-fb-edit-preview">
          {compactEditPreview(c.edit.original, c.edit.revised).map((part, i) =>
            part.kind === "delete" ? (
              <del key={i}>{part.text}</del>
            ) : part.kind === "insert" ? (
              <ins key={i}>{part.text}</ins>
            ) : (
              <span key={i}>{part.text}</span>
            ),
          )}
        </div>
      )}
      {body && body !== "(edit)" ? <MarkdownView body={body} /> : !c.edit && noteText(c)}
    </div>
  );
}

// ── The header row ──────────────────────────────────────────────────────────

export interface FeedbackTabsProps {
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  /** Threads on the shown revision (`feedbackSummary(...).count`). */
  count: number;
  /** Every thread has its answer (`feedbackSummary(...).allResolved`). */
  allResolved: boolean;
}

/** The right panel's 48px header: "Chat" / "Feedback 16" … "All resolved".
 *  The stage renders it once above both tabs. */
export function FeedbackTabs({ tab, onTab, count, allResolved }: FeedbackTabsProps) {
  return (
    <div className="rl-fb-tabs" role="tablist" aria-label="Plan panel">
      <button
        type="button"
        role="tab"
        className="rl-fb-tab"
        aria-selected={tab === "chat"}
        onClick={() => onTab("chat")}
      >
        Chat
      </button>
      <button
        type="button"
        role="tab"
        className="rl-fb-tab"
        aria-selected={tab === "feedback"}
        onClick={() => onTab("feedback")}
      >
        Feedback
        {count > 0 && <span className="rl-fb-tab-count">{count}</span>}
      </button>
      {allResolved && <span className="rl-fb-tabs-status">All resolved</span>}
    </div>
  );
}

// ── The composer ────────────────────────────────────────────────────────────

/** What the composer anchors to when text is selected in the plan (App's
 *  `selection`). */
export type FeedbackSelection = Pick<SelectionState, "anchorId" | "text" | "charStart" | "charEnd" | "subBlockId">;

export interface FeedbackComposerProps {
  session: ReviewSession;
  /** A selection in the plan: the note anchors there. Without one it is a
   *  note on the plan as a whole (its first section). */
  selection?: FeedbackSelection | null;
  /** Called once a selection's note is saved, so the stage can drop it. */
  onClearSelection?: () => void;
  /** The model chip's words, from the live catalog the conversation's
   *  composer reads ("Opus 4.7 · High"). Absent: read off the session. */
  modelLabel?: string | null;
  /** Save the note. Absent: `add_comment`, as App's `submitComment` sends it
   *  — the stage can pass `submitComment` itself. */
  onSubmit?: (request: NewCommentRequest) => unknown;
}

/** "Select text in the plan, or type feedback…" — a note that rides the next
 *  Send like any mark. Notes land on the latest revision (where the backend
 *  adds every comment), whichever version the panel shows. */
export function FeedbackComposer({ session, selection = null, onClearSelection, modelLabel, onSubmit }: FeedbackComposerProps) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [focused, setFocused] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  // Dictated into like every composer (deviation 2): "send it" sends, as
  // Enter does, and words said as it closes are kept in its draft.
  const dictation = useDictationComposer(frame, { send: true, polish: true, keep: (add) => setDraft(add) }, field);
  const latest = session.revisions[session.revisions.length - 1] ?? null;
  const sections = latest?.sections ?? [];
  const anchorLabel = useMemo(
    () =>
      selection
        ? createAnchorDisplay(sections).label({
            anchorId: selection.anchorId,
            selection: { quotedText: selection.text, subBlockId: selection.subBlockId },
          })
        : null,
    [selection, sections],
  );
  const chip = modelLabel ?? sessionModelLabel(session);

  // Grow with what is typed; back to one line once it is sent.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  const submit = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    const anchorId = selection?.anchorId || sections[0]?.anchorId || "A";
    const request: NewCommentRequest = {
      type: "feedback",
      anchorId,
      blockId: blockIdByAnchorId(sections).get(anchorId),
      body,
      selection:
        selection && selection.charEnd > selection.charStart
          ? {
              charStart: selection.charStart,
              charEnd: selection.charEnd,
              quotedText: selection.text,
              subBlockId: selection.subBlockId,
            }
          : undefined,
    };
    setSending(true);
    try {
      await (onSubmit ? onSubmit(request) : invoke("add_comment", { sessionId: session.sessionId, request }));
      setDraft("");
      onClearSelection?.();
    } catch (err) {
      console.error("failed to add feedback", err);
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      ref={frame}
      className={focused ? "rl-fb-composer rl-glass rl-glass-sheet is-focused" : "rl-fb-composer rl-glass rl-glass-sheet"}
      onMouseDown={(e) => {
        // The whole box is the field: a press on its padding puts the caret in.
        if (e.target === e.currentTarget) {
          e.preventDefault();
          field.current?.focus();
        }
      }}
    >
      {anchorLabel && (
        <span className="rl-fb-composer-anchor" title={`On “${selection?.text ?? ""}”`}>
          {anchorLabel}
        </span>
      )}
      <div className="rl-fb-composer-field">
        {!draft && (
          <span className="rl-fb-composer-hint" aria-hidden>
            {selection ? "Type feedback on the selection…" : "Select text in the plan, or type feedback…"}
          </span>
        )}
        <textarea
          ref={field}
          rows={1}
          value={draft}
          aria-label="Feedback"
          placeholder={selection ? "Type feedback on the selection…" : "Select text in the plan, or type feedback…"}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
      </div>
      {chip && <span className="rl-fb-composer-model">{chip}</span>}
      {draft.trim() ? (
        <button
          type="button"
          className="rl-fb-composer-button is-send"
          aria-label="Add feedback"
          title="Add feedback (↵)"
          disabled={sending}
          onClick={() => void submit()}
        >
          <ArrowUp size={15} aria-hidden />
        </button>
      ) : (
        <button
          type="button"
          className={dictation.listening ? "rl-fb-composer-button is-listening" : "rl-fb-composer-button"}
          aria-label={dictation.listening ? "Stop dictating" : "Dictate feedback"}
          aria-pressed={dictation.listening}
          title={dictation.listening ? "Stop dictating" : "Dictate feedback"}
          onClick={dictation.toggle}
        >
          <Mic size={15} aria-hidden />
        </button>
      )}
    </div>
  );
}

/** "Opus 4.5 · High" from what the session recorded: the model id made
 *  readable ("claude-opus-4-5" → "Opus 4.5") and the effort, or just the
 *  harness when neither was recorded. The stage's `modelLabel` (the live
 *  catalog's display name) is preferred over this. */
export function sessionModelLabel(session: Pick<ReviewSession, "model" | "effort" | "backend">): string {
  const parts: string[] = [];
  const model = (session.model ?? "").trim();
  if (model) parts.push(readableModel(model));
  else parts.push(agentLabelFor(session.backend));
  const effort = (session.effort ?? "").trim();
  if (effort) parts.push(effort.charAt(0).toUpperCase() + effort.slice(1));
  return parts.join(" · ");
}

function readableModel(id: string): string {
  const short = shortModel(id).replace(/\[1m\]$/i, "");
  // "opus-4-5" → "Opus 4.5"; anything else ("GPT-5.6-Sol", an alias) as is.
  const m = /^([a-z]+)-(\d+(?:-\d+)*)$/i.exec(short);
  if (!m) return short.charAt(0).toUpperCase() + short.slice(1);
  return `${m[1].charAt(0).toUpperCase()}${m[1].slice(1)} ${m[2].replace(/-/g, ".")}`;
}
