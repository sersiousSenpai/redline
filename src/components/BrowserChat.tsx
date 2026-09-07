// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useMemo, memo, useEffect, useRef, useState } from "react";
import {
  Copy,
  Link2,
  MessageSquare,
  PenLine,
  Pin,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { captureSnapshotOrCached } from "../lib/domSnapshot";
import type { BrowseMessage } from "../types";
import { useAgentTurn } from "../hooks/useAgentTurn";
import { useStickToBottom } from "../hooks/useStickToBottom";
import { usePersistedState } from "../theme/usePersistedState";
import { MarkdownView } from "./MarkdownView";
import StreamingBubble from "./StreamingBubble";
import TurnFooter, { ThreadMeterStrip } from "./TurnFooter";
import { contextResets, type TurnMeter } from "../lib/turnMeter";
import { QueuedChip, UnsentNote } from "./QueuedChip";
import { WorkingIndicator } from "./WorkingIndicator";

interface BrowserChatProps {
  /** Stable per-tab id — keys the browse-agent backend + persisted thread. */
  browseId: string;
  /** Native webview label of this tab (`browser-<id>`) — used to snapshot the
   *  page for the agent's first-turn grounding. */
  label: string;
  /** Working dir for the agent (scopes Read/Grep/Glob); `$HOME` when null. */
  projectDir?: string | null;
  /** Close the discussion panel (the thread itself is kept). */
  onClose: () => void;
  /** Open an http(s) link the user clicked in a reply as a Redline browser tab,
   *  instead of letting it escape the app's webview. */
  onOpenLink?: (url: string) => void;
  /** Title of the tab this conversation is anchored to, when it differs from the
   *  foreground tab (the agent opened the visible tab on this conversation's
   *  behalf). Shown as a header hint so the strip/thread mismatch reads as
   *  intentional. Undefined when the discussion matches the visible tab. */
  anchoredFromTitle?: string;
  /** Ship an assistant reply (its markdown) into a fresh Redline plan session —
   *  spawns a terminal running `claude --permission-mode plan` seeded with it.
   *  Lets a plan/prompt drafted while browsing drop straight into Redline. */
  onSendToRedline?: (markdown: string) => void;
  /** Open an assistant reply in the Prompt Drafter (target repo pre-guessed) to
   *  shape before sending — the review-first alternative to `onSendToRedline`. */
  onSendToDrafter?: (markdown: string) => void;
  /** Pin an assistant reply to the active mission ("I like this part"). Present
   *  only when a mission is active; the parent attaches the source tab. */
  onAddToMission?: (markdown: string) => void | Promise<boolean>;
  /** Append an assistant reply to this tab's working list. The reverse of
   *  §1e's `💬`: the list feeds the conversation, the conversation feeds back.
   *  Present only once the tab HAS a list — `browse_list_add` refuses an
   *  orphan item, so offering the button without one would only ever fail. */
  onAddToList?: (markdown: string) => void | Promise<boolean>;
  /** Text to merge into the composer once, on mount or when the nonce changes
   *  — how `💬` on a list item, and a highlight in the page, arrive here with
   *  the passage already quoted. `autoSend` sends it instead (the one-tap
   *  highlight intents; see lib/browseSelection.ts).
   *
   *  A prop with a nonce, not a direct write to the persisted draft key: the
   *  draft lives in `usePersistedState`, and writing that localStorage key
   *  from outside would desync its in-memory copy whenever the panel is
   *  already mounted. Same shape as `openRequest`/`onOpenRequestConsumed` in
   *  BrowserPane and `consumeSeed` on the Front Door. */
  seed?: { text: string; nonce: number; autoSend?: boolean } | null;
  onSeedConsumed?: () => void;
  /** Continue THIS tab chat as the spanning Linked discussion — a fork, not a
   *  move: the tab chat stays intact, its context carries into the new linked
   *  chat. Present once there's a conversation worth carrying. */
  onContinueAsLinked?: () => void;
  /** A linked discussion already exists — the `▾` beside 🔗 offers the ones
   *  that do. The 🔗 itself always converts; see the header. */
  linkedExists?: boolean;
  onOpenExistingLinked?: () => void;
  /** Tandem agent mode is on. Sent to the agent so it opens the best page and
   *  surfaces a rateable sources block, and gates the per-source thumbs UI. */
  tandem?: boolean;
}

const ZOOM_KEY = "redline.browseZoom";
const clampZoom = (z: number) => Math.min(1.6, Math.max(0.8, z));

function loadZoom(): number {
  const raw = Number(localStorage.getItem(ZOOM_KEY));
  return Number.isFinite(raw) && raw > 0 ? clampZoom(raw) : 1;
}

/** One source the tandem agent surfaced: the page it opened (`primary`) plus the
 *  alternatives it offered. Parsed out of the reply's `rl-sources` fenced block. */
interface Source {
  url: string;
  title?: string;
  primary?: boolean;
}

const SOURCES_FENCE = "```rl-sources";
const SOURCES_FENCE_RE = /```rl-sources\s*([\s\S]*?)```/;

/** Split a settled reply into its visible prose and the structured sources the
 *  agent listed in a trailing ```rl-sources``` block. The block is stripped from
 *  the prose so the raw JSON never renders; a malformed block is simply dropped. */
function parseSources(body: string): { text: string; sources: Source[] } {
  const m = body.match(SOURCES_FENCE_RE);
  if (!m) return { text: body, sources: [] };
  let sources: Source[] = [];
  try {
    const arr = JSON.parse(m[1].trim());
    if (Array.isArray(arr)) {
      sources = arr
        .filter((s) => s && typeof s.url === "string")
        .map((s) => ({
          url: s.url as string,
          title: typeof s.title === "string" ? s.title : undefined,
          primary: !!s.primary,
        }));
    }
  } catch {
    // Malformed block — leave sources empty; keep the prose readable.
  }
  return { text: body.replace(SOURCES_FENCE_RE, "").trimEnd(), sources };
}

/** Hide the sources fence while it streams in — the block lands at the very end,
 *  so cut a complete fence and any partial marker being typed at the tail. */
function stripStreamingSources(text: string): string {
  const full = text.indexOf(SOURCES_FENCE);
  if (full !== -1) return text.slice(0, full).trimEnd();
  for (let n = Math.min(SOURCES_FENCE.length - 1, text.length); n >= 3; n--) {
    if (text.endsWith(SOURCES_FENCE.slice(0, n))) {
      return text.slice(0, text.length - n).trimEnd();
    }
  }
  return text;
}

/** Bare host for a source label, e.g. `https://www.wikipedia.org/DAG` → `wikipedia.org`. */
function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A discussion with a browse agent that can see and drive the active browser
 *  tab. Standalone analog of `CommentThread` (browse-* events, `--rl-discussion-zoom`,
 *  auto-grow composer), keyed by a per-tab `browseId` rather than a comment. */
export const BrowserChat = memo(function BrowserChat({
  browseId,
  label,
  projectDir,
  onClose,
  onOpenLink,
  anchoredFromTitle,
  onSendToRedline,
  onSendToDrafter,
  onAddToMission,
  onAddToList,
  seed,
  onSeedConsumed,
  onContinueAsLinked,
  linkedExists,
  onOpenExistingLinked,
  tandem,
}: BrowserChatProps) {
  // Composer draft survives tab switches and app restarts (the component is
  // keyed by browseId, so each tab's discussion keeps its own).
  const [draft, setDraft] = usePersistedState<string>(`rl.chatDraft.browse.${browseId}`, "");
  const [zoom, setZoom] = useState(loadZoom);
  // The `▾` beside 🔗: the pre-existing Linked discussions. 🔗 itself always
  // converts, so this holds the one remaining choice rather than the primary
  // action.
  const [linkedMenuOpen, setLinkedMenuOpen] = useState(false);
  // Per-source thumbs verdicts for this tab's thread (url → +1 / -1), restored
  // from the backend so ratings survive a reload. Only meaningful in tandem mode.
  const [feedback, setFeedback] = useState<Record<string, number>>({});
  // Whether to keep the newest content in view as it streams. True only while
  // the user is parked at (or near) the bottom — scroll up to read mid-stream
  // and we leave you where you are, like ChatGPT / Claude desktop.

  // The turn lifecycle — persisted thread, live stream, mid-turn remount
  // restore (partial text + spinner), self-heal — lives in the shared hook,
  // keyed by browseId: switching tabs rebinds it; a turn left streaming keeps
  // running backend-side and is picked up loss-free on return.
  const {
    messages,
    liveText,
    status,
    startedAt,
    loaded,
    send,
    cancel,
    unqueue,
    clear,
    meter,
    activity,
    meters,
  } = useAgentTurn<BrowseMessage>({
      surface: "browse",
      key: browseId,
      idField: "browseId",
      meterKind: "browse",
      historyCmd: "get_browse_thread",
      historyArgs: { browseId },
      sendFailPrefix: "Couldn't reach the browse agent",
      buildSendArgs: async (text): Promise<Record<string, unknown>> => {
        // The backend treats a turn as "first" until the agent session is
        // saved, which only happens on a *successful* reply — so keep sending
        // a snapshot until then (e.g. if the opening turn errored), matching
        // that contract.
        const firstTurn = !messages.some(
          (m: BrowseMessage) => m.role === "assistant" && m.status === "complete",
        );
        // First turn embeds a live DOM snapshot so the agent is grounded
        // without a mandatory round-trip; follow-ups rely on its /snapshot
        // tool. Live snapshot if the tab is up; otherwise the cached one (a
        // suspended discussion tab still grounds the first turn). A miss just
        // means a slower first answer. The hook drops the send if the tab
        // switched mid-capture.
        const snapshot = firstTurn ? await captureSnapshotOrCached(label) : undefined;
        return {
          browseId,
          text,
          snapshot,
          cwd: projectDir ?? null,
          tandem: tandem ?? false,
        };
      },
      makeMessage: ({ id, role, body, status }) => ({
        id,
        browseId,
        role,
        body,
        status,
        createdAt: Date.now(),
      }),
    });

  // A pressure drop is not a bug — it is auto-compaction or a fresh CLI
  // session. Unlabelled, a fall from 78% to 12% reads as a broken meter.
  const resets = useMemo(
    () => contextResets(messages.map((m) => m.id), meters),
    [messages, meters],
  );

  // Follow a streaming thread only while the reader is parked at the bottom.
  // The rule lives in `useStickToBottom` — the turn footer changes every
  // settled bubble's height, so five copies of it would need the same fix.
  const {
    ref: scrollRef,
    onScroll,
    stick,
  } = useStickToBottom<HTMLDivElement>([messages, liveText]);

  // Restore this tab's source thumbs on mount / tab switch.
  useEffect(() => {
    let cancelled = false;
    void invoke<Array<{ sourceUrl: string; verdict: number }>>(
      "get_source_feedback",
      { browseId },
    )
      .then((rows) => {
        if (cancelled) return;
        const map: Record<string, number> = {};
        for (const r of rows) map[r.sourceUrl] = r.verdict;
        setFeedback(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [browseId]);

  // Record a thumbs verdict for a source. Optimistic: update local state, then
  // persist. Clicking the active thumb again clears it back to neutral (0).
  function setVerdict(s: Source, verdict: number) {
    const next = feedback[s.url] === verdict ? 0 : verdict;
    setFeedback((f) => ({ ...f, [s.url]: next }));
    void invoke("set_source_feedback", {
      browseId,
      sourceUrl: s.url,
      sourceTitle: s.title ?? null,
      verdict: next,
    }).catch((e) => console.error("set_source_feedback failed", e));
  }

  function adjustZoom(delta: number) {
    setZoom((z) => {
      const next = clampZoom(z + delta);
      localStorage.setItem(ZOOM_KEY, String(next));
      return next;
    });
  }

  // Re-pin to the bottom when the active tab changes (fresh thread load).
  useEffect(() => {
    stick();
  }, [browseId]);

  // A seed (`💬` on a list item) MERGES into the draft rather than replacing
  // it: whatever the user had half-typed is theirs, and quoting an item is an
  // addition to the question, not a reason to lose it. Nonce-keyed so the same
  // item can be quoted twice, and consumed immediately so a re-render can't
  // paste it again.
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const lastSeedRef = useRef<number | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    if (!seed || seed.nonce === lastSeedRef.current) return;
    // An auto-send seed waits for the thread to finish restoring: sending into
    // a not-yet-loaded thread races the restore. Holding it costs nothing —
    // this effect re-runs the moment `loaded` flips, and the seed is untouched
    // until then (so a remount can't lose it either).
    if (seed.autoSend && !loaded) return;
    lastSeedRef.current = seed.nonce;
    if (seed.autoSend) {
      // The draft is deliberately untouched: whatever they were half-typing is
      // still theirs. `send` queues behind an in-flight reply on its own, so a
      // one-tap intent mid-answer needs nothing special here, and going through
      // it (rather than `browse_send`) keeps the optimistic bubble and the
      // stream wiring intact.
      stick();
      send(seed.text);
      onSeedConsumed?.();
      return;
    }
    const prev = draftRef.current;
    setDraft(prev.trim() ? `${prev.replace(/\s*$/, "")}\n\n${seed.text}` : seed.text);
    onSeedConsumed?.();
    // Land the caret at the end, below the quote, ready to type the question.
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, loaded]);

  // Follow streaming/new turns only while the user is parked at the bottom;
  // if they've scrolled up to read, leave their position untouched.

  // Recompute stickiness from the live scroll position. A small threshold keeps
  // "follow" engaged through sub-pixel rounding and the trailing cursor glyph.
  function discard() {
    void invoke("browse_discard", { browseId }).catch(() => {});
    clear();
    setDraft("");
  }

  return (
    <div
      className="flex flex-col h-full min-h-0"
      style={
        {
          background: "var(--color-paper)",
          borderLeft: "1px solid var(--color-rule)",
          "--rl-discussion-zoom": zoom,
        } as React.CSSProperties
      }
    >
      <div
        className="flex items-center gap-1.5 px-3 py-2 shrink-0"
        style={{ borderBottom: "1px solid var(--color-rule)" }}
      >
        <span
          style={{
            fontSize: "10px",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "var(--color-info)",
          }}
        >
          <span className="inline-flex items-center gap-1">
            <MessageSquare size={11} strokeWidth={2} /> Page discussion
          </span>
        </span>
        {status === "streaming" && (
          <span style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}>
            — streaming…
          </span>
        )}
        {anchoredFromTitle && (
          <span
            title={`This conversation started on “${anchoredFromTitle}”; it opened the tab you're viewing.`}
            style={{
              fontSize: "10px",
              color: "var(--color-ink-muted)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: "11rem",
            }}
          >
            · from {anchoredFromTitle}
          </span>
        )}
        <div className="flex items-center gap-1 ml-auto">
          {onContinueAsLinked && messages.length > 0 && (
            <div className="relative flex items-center">
              {/* The gesture means ONE thing, always: carry this conversation
                  across tabs. It used to open a menu once any linked
                  discussion existed, whose default reading was "go to the old
                  one" — so the second and every later use of 🔗 silently did
                  nothing. Converting is now unconditional; the pre-existing
                  discussions moved behind the ▾ beside it. */}
              <button
                type="button"
                onClick={() => {
                  setLinkedMenuOpen(false);
                  onContinueAsLinked();
                }}
                title="Continue this conversation across tabs — starts a new Linked discussion from this chat (this tab's chat is kept)"
                className="px-1 leading-none hover:opacity-100 opacity-60"
                style={{ color: "var(--color-ink-muted)" }}
              >
                <Link2 size={12} strokeWidth={2} />
              </button>
              {linkedExists && onOpenExistingLinked && (
                <button
                  type="button"
                  onClick={() => setLinkedMenuOpen((o) => !o)}
                  title="Other Linked discussions"
                  className="leading-none hover:opacity-100 opacity-60"
                  style={{
                    color: "var(--color-ink-muted)",
                    fontSize: "9px",
                    padding: "0 2px",
                  }}
                >
                  ▾
                </button>
              )}
              {linkedMenuOpen && (
                <div
                  className="absolute right-0 top-full mt-1 z-20 flex flex-col"
                  style={{
                    background: "var(--color-paper)",
                    border: "1px solid var(--color-rule)",
                    borderRadius: "6px",
                    boxShadow: "0 4px 14px rgba(0,0,0,0.18)",
                    minWidth: "13rem",
                    padding: "3px",
                  }}
                >
                  <button
                    type="button"
                    className="text-left rounded px-2 py-1.5 hover:opacity-80"
                    style={{ fontSize: "11px", color: "var(--color-ink)" }}
                    onClick={() => {
                      setLinkedMenuOpen(false);
                      onOpenExistingLinked?.();
                    }}
                  >
                    Open an existing Linked discussion
                  </button>
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={() => adjustZoom(-0.1)}
            title="Smaller text"
            className="px-1 leading-none hover:opacity-100 opacity-60"
            style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}
          >
            A−
          </button>
          <button
            type="button"
            onClick={() => adjustZoom(0.1)}
            title="Larger text"
            className="px-1 leading-none hover:opacity-100 opacity-60"
            style={{ fontSize: "12px", color: "var(--color-ink-muted)" }}
          >
            A+
          </button>
          {messages.length > 0 && (
            <button
              type="button"
              onClick={discard}
              title="Clear this page's discussion"
              className="px-1 leading-none hover:opacity-100 opacity-60"
              style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title="Close discussion"
            className="px-1 leading-none hover:opacity-100 opacity-60"
            style={{ color: "var(--color-ink-muted)" }}
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-y-auto rl-thin-scroll-y flex flex-col gap-2.5 px-3 py-3"
      >
        {!loaded ? null : messages.length === 0 && status === "idle" ? (
          <div
            style={{ fontSize: "12px", color: "var(--color-ink-muted)", lineHeight: 1.5 }}
          >
            Ask about the page you're viewing — the agent can read it, navigate,
            click, and pull structured data. Try “summarize this page” or “open
            the first link and compare it”.
          </div>
        ) : (
          messages.map((m) => (
            <MessageBubble
              key={m.id}
              msg={m}
              meter={meters[m.id]}
              contextReset={resets.has(m.id)}
              onOpenLink={onOpenLink}
              onSendToRedline={onSendToRedline}
              onSendToDrafter={onSendToDrafter}
              onAddToMission={onAddToMission}
              onAddToList={onAddToList}
              showSources={!!tandem}
              feedback={feedback}
              onVerdict={setVerdict}
              onUnqueue={() => {
                void unqueue(m.id).then((text) => {
                  if (text) setDraft((prev) => (prev.trim() ? `${text}\n\n${prev}` : text));
                });
              }}
              onResend={() => {
                stick();
                send(m.body);
              }}
            />
          ))
        )}
        {status === "streaming" && (
          <>
            {/* The bubble renders from the FIRST line of the stream, not the
                first token: the badge and the activity line are exactly what
                fills the wait a blank ticker used to. */}
            <StreamingBubble
              text={tandem ? stripStreamingSources(liveText) : liveText}
              agent="Claude"
              inspect={{ surface: "browse", key: browseId }}
              meter={meter}
              activity={activity}
              onOpenLink={onOpenLink}
            />
            {!(tandem ? stripStreamingSources(liveText) : liveText) && (
              <WorkingIndicator startedAt={startedAt ?? undefined} />
            )}
          </>
        )}
      </div>

      <div className="px-3 py-2 shrink-0" style={{ borderTop: "1px solid var(--color-rule)" }}>
        {/* Economics BY SUBPROCESS: a consult spawns a real child `claude`, so
            "by model" is the honest unit here, not "by message". */}
        <ThreadMeterStrip meters={meters} />
        <Composer
          taRef={composerRef}
          draft={draft}
          setDraft={setDraft}
          streaming={status === "streaming"}
          onSend={() => {
            // Sending a turn jumps you to the bottom to see your message + the
            // reply begin; from there the scroll listener takes over.
            stick();
            send(draft);
            setDraft("");
          }}
          onStop={cancel}
        />
      </div>
    </div>
  );
});

function MessageBubble({
  msg,
  onOpenLink,
  onSendToRedline,
  onSendToDrafter,
  onAddToMission,
  onAddToList,
  showSources,
  feedback,
  onVerdict,
  onUnqueue,
  onResend,
  meter,
  contextReset,
}: {
  msg: BrowseMessage;
  onOpenLink?: (url: string) => void;
  onSendToRedline?: (markdown: string) => void;
  onSendToDrafter?: (markdown: string) => void;
  onAddToMission?: (markdown: string) => void | Promise<boolean>;
  onAddToList?: (markdown: string) => void | Promise<boolean>;
  showSources?: boolean;
  feedback?: Record<string, number>;
  onVerdict?: (source: Source, verdict: number) => void;
  onUnqueue?: () => void;
  onResend?: () => void;
  /** This row's settled meter — the badge and footer that outlive the turn. */
  meter?: TurnMeter | null;
  /** This turn's context restarted (compaction or a fresh CLI session). */
  contextReset?: boolean;
}) {
  const isUser = msg.role === "user";
  const isError = msg.status === "error";
  const isQueued = isUser && msg.status === "queued";
  const isUnsent = isUser && msg.status === "unsent";
  // In tandem mode a reply may carry a trailing sources block; split it off so
  // the JSON never renders and the sources get their own rateable strip.
  const { text, sources } =
    showSources && !isUser && !isError
      ? parseSources(msg.body)
      : { text: msg.body, sources: [] as Source[] };
  const showActions = !isUser && !isError && text.trim().length > 0;
  return (
    <div
      className="flex flex-col gap-0.5 group/msg"
      style={isQueued || isUnsent ? { opacity: 0.65 } : undefined}
    >
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
            fontSize: "calc(12.5px * var(--rl-discussion-zoom, 1))",
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            color: "var(--color-warning)",
          }}
        >
          {msg.body}
        </div>
      ) : (
        <MarkdownView body={text} compact rich onLinkClick={onOpenLink} />
      )}
      {isQueued && <QueuedChip onUnqueue={onUnqueue} />}
      {isUnsent && <UnsentNote onResend={onResend} />}
      {sources.length > 0 && (
        <SourcesStrip
          sources={sources}
          feedback={feedback ?? {}}
          onOpenLink={onOpenLink}
          onVerdict={onVerdict}
        />
      )}
      {showActions && (
        <MessageActions
          body={text}
          onSendToRedline={onSendToRedline}
          onSendToDrafter={onSendToDrafter}
          onAddToMission={onAddToMission}
          onAddToList={onAddToList}
        />
      )}
      {!isUser && <TurnFooter meter={meter} contextReset={contextReset} />}
    </div>
  );
}

/** The rateable sources the tandem agent surfaced beneath a reply: the page it
 *  opened (marked "opened") plus its alternatives, each with a 👍/👎 the user can
 *  toggle. Verdicts persist and feed the agent's future source picks. */
function SourcesStrip({
  sources,
  feedback,
  onOpenLink,
  onVerdict,
}: {
  sources: Source[];
  feedback: Record<string, number>;
  onOpenLink?: (url: string) => void;
  onVerdict?: (source: Source, verdict: number) => void;
}) {
  const thumb = (active: boolean): React.CSSProperties => ({
    fontSize: "11px",
    lineHeight: 1,
    padding: "1px 4px",
    border: "1px solid var(--color-rule)",
    borderRadius: "5px",
    background: active ? "var(--color-info)" : "var(--color-paper)",
    filter: active ? undefined : "grayscale(1) opacity(0.6)",
    cursor: "pointer",
  });
  return (
    <div className="flex flex-col gap-1 mt-1">
      <span
        style={{
          fontSize: "9px",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          color: "var(--color-ink-muted)",
        }}
      >
        Sources
      </span>
      {sources.map((s) => {
        const v = feedback[s.url] ?? 0;
        return (
          <div key={s.url} className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onOpenLink?.(s.url)}
              title={s.url}
              style={{
                flex: 1,
                minWidth: 0,
                textAlign: "left",
                fontSize: "11.5px",
                lineHeight: 1.3,
                color: "var(--color-info)",
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {s.primary ? "→ " : ""}
              {s.title || domainOf(s.url)}
              <span style={{ color: "var(--color-ink-muted)" }}>
                {" "}· {domainOf(s.url)}
                {s.primary ? " · opened" : ""}
              </span>
            </button>
            <button
              type="button"
              onClick={() => onVerdict?.(s, 1)}
              title="Helpful"
              aria-pressed={v === 1}
              style={thumb(v === 1)}
            >
              <ThumbsUp size={11} strokeWidth={2} />
            </button>
            <button
              type="button"
              onClick={() => onVerdict?.(s, -1)}
              title="Not helpful"
              aria-pressed={v === -1}
              style={thumb(v === -1)}
            >
              <ThumbsDown size={11} strokeWidth={2} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Footer actions on a settled assistant reply: copy the whole message (covers
 *  prose, where per-block buttons don't reach), and — when wired — ship the
 *  reply into Redline, either straight to Claude Code (after confirming the
 *  target repo) or via the Prompt Drafter. Revealed on hover over the bubble. */
function MessageActions({
  body,
  onSendToRedline,
  onSendToDrafter,
  onAddToMission,
  onAddToList,
}: {
  body: string;
  onSendToRedline?: (markdown: string) => void;
  onSendToDrafter?: (markdown: string) => void;
  onAddToMission?: (markdown: string) => void | Promise<boolean>;
  onAddToList?: (markdown: string) => void | Promise<boolean>;
}) {
  const [copied, setCopied] = useState(false);
  const [pinned, setPinned] = useState<"idle" | "ok" | "failed">("idle");
  const [listed, setListed] = useState<"idle" | "ok" | "failed">("idle");
  const copy = () => {
    void navigator.clipboard?.writeText(body).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  const pin = () => {
    // Truthful feedback: a pin that didn't reach the DB must not flash
    // "Pinned ✓" — that silence is how a broken pin flow goes unnoticed.
    void Promise.resolve(onAddToMission?.(body)).then((ok) => {
      setPinned(ok === false ? "failed" : "ok");
      window.setTimeout(() => setPinned("idle"), 1400);
    });
  };
  const actionStyle: React.CSSProperties = {
    fontSize: "10px",
    lineHeight: 1,
    padding: "2px 6px",
    border: "1px solid var(--color-rule)",
    borderRadius: "5px",
    background: "var(--color-paper)",
    color: "var(--color-ink-muted)",
    cursor: "pointer",
  };
  return (
    <div className="flex items-center gap-1.5 mt-0.5 opacity-0 group-hover/msg:opacity-100 transition-opacity">
      <button type="button" onClick={copy} title="Copy this reply" style={actionStyle}>
        {copied ? (
          "Copied ✓"
        ) : (
          <span className="inline-flex items-center gap-1">
            <Copy size={10} strokeWidth={2} /> Copy
          </span>
        )}
      </button>
      {onAddToMission && (
        <button
          type="button"
          onClick={pin}
          title="Pin this reply to the active mission"
          style={{ ...actionStyle, color: "var(--color-info)" }}
        >
          {pinned === "ok" ? (
            "Pinned ✓"
          ) : pinned === "failed" ? (
            "Pin failed ✗"
          ) : (
            <span className="inline-flex items-center gap-1">
              <Pin size={10} strokeWidth={2} /> Add to mission
            </span>
          )}
        </button>
      )}
      {onAddToList && (
        <button
          type="button"
          onClick={() => {
            // Same truthfulness rule as the pin beside it: an add that never
            // reached the DB must not flash a tick.
            void Promise.resolve(onAddToList(body)).then((ok) => {
              setListed(ok === false ? "failed" : "ok");
              window.setTimeout(() => setListed("idle"), 1400);
            });
          }}
          title="Add this reply to this tab's working list"
          style={{ ...actionStyle, color: "var(--color-info)" }}
        >
          {listed === "ok"
            ? "Added ✓"
            : listed === "failed"
              ? "Add failed ✗"
              : "＋ Add as item"}
        </button>
      )}
      {onSendToDrafter && (
        <button
          type="button"
          onClick={() => onSendToDrafter(body)}
          title="Open this reply in the Prompt Drafter to shape before sending"
          style={{ ...actionStyle, color: "var(--color-info)" }}
        >
          <span className="inline-flex items-center gap-1">
            <PenLine size={10} strokeWidth={2} /> Open in Drafter
          </span>
        </button>
      )}
      {onSendToRedline && (
        <button
          type="button"
          onClick={() => onSendToRedline(body)}
          title="Send this reply to Claude Code — you'll confirm the target repo"
          style={{ ...actionStyle, color: "var(--color-info)" }}
        >
          Send to Claude Code ▶
        </button>
      )}
    </div>
  );
}

function Composer({
  taRef,
  draft,
  setDraft,
  streaming,
  onSend,
  onStop,
}: {
  /** Owned by the parent so a seed can focus and place the caret. */
  taRef: React.RefObject<HTMLTextAreaElement | null>;
  draft: string;
  setDraft: (s: string) => void;
  streaming: boolean;
  onSend: () => void;
  onStop: () => void;
}) {
  const autosize = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(autosize, [draft]);
  return (
    <div className="flex items-end gap-1.5">
      <textarea
        ref={taRef}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          autosize();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            // Sending mid-stream queues the message behind the reply.
            onSend();
          }
        }}
        placeholder={streaming ? "Type ahead — sends queue behind the reply…" : "Ask about this page…"}
        rows={2}
        className="flex-1 rounded px-2 py-1"
        style={{
          fontSize: "calc(12px * var(--rl-discussion-zoom, 1))",
          border: "1px solid var(--color-rule)",
          background: "var(--color-paper)",
          color: "var(--color-ink)",
          fontFamily: "inherit",
          resize: "none",
          overflow: "hidden",
        }}
      />
      {streaming && (
        <button
          type="button"
          onClick={onStop}
          title="Stop the current reply (queued messages still send)"
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
      )}
      <button
        type="button"
        onClick={onSend}
        disabled={!draft.trim()}
        title={streaming ? "Queue this message — it sends when the reply finishes" : undefined}
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
    </div>
  );
}
