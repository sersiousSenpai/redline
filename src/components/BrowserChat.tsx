// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { memo, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { captureSnapshotOrCached } from "../lib/domSnapshot";
import type {
  BrowseCancelledEvent,
  BrowseDeltaEvent,
  BrowseDoneEvent,
  BrowseErrorEvent,
  BrowseMessage,
} from "../types";
import { MarkdownView } from "./MarkdownView";
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
  onAddToMission?: (markdown: string) => void;
  /** Tandem agent mode is on. Sent to the agent so it opens the best page and
   *  surfaces a rateable sources block, and gates the per-source thumbs UI. */
  tandem?: boolean;
}

type ChatStatus = "idle" | "streaming" | "error";

let tmpSeq = 0;
const tmpId = () => `btmp-${++tmpSeq}`;

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
  tandem,
}: BrowserChatProps) {
  const [messages, setMessages] = useState<BrowseMessage[]>([]);
  const [liveText, setLiveText] = useState("");
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [zoom, setZoom] = useState(loadZoom);
  // Per-source thumbs verdicts for this tab's thread (url → +1 / -1), restored
  // from the backend so ratings survive a reload. Only meaningful in tandem mode.
  const [feedback, setFeedback] = useState<Record<string, number>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether to keep the newest content in view as it streams. True only while
  // the user is parked at (or near) the bottom — scroll up to read mid-stream
  // and we leave you where you are, like ChatGPT / Claude desktop.
  const stickRef = useRef(true);
  // Snapshot capture is async; guard it against being sent for the wrong tab if
  // the user switches mid-capture.
  const browseIdRef = useRef(browseId);
  browseIdRef.current = browseId;

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

  // Load persisted turns + subscribe to this tab's browse events. Re-runs when
  // the active tab changes (the parent keys this component by browseId).
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setMessages([]);
    setLiveText("");
    setStatus("idle");

    void invoke<BrowseMessage[]>("get_browse_thread", { browseId })
      .then((rows) => {
        if (!alive) return;
        setMessages(rows);
        setLoaded(true);
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });

    const mine = (p: { browseId: string }) => p.browseId === browseId;

    const deltaP = listen<BrowseDeltaEvent>("browse-delta", (e) => {
      if (!alive || !mine(e.payload)) return;
      setStatus("streaming");
      setLiveText((t) => t + e.payload.text);
    });
    const doneP = listen<BrowseDoneEvent>("browse-done", (e) => {
      if (!alive || !mine(e.payload)) return;
      setMessages((m) => [
        ...m,
        {
          id: e.payload.messageId,
          browseId,
          role: "assistant",
          body: e.payload.body,
          status: "complete",
          createdAt: Date.now(),
        },
      ]);
      setLiveText("");
      setStatus("idle");
    });
    const errorP = listen<BrowseErrorEvent>("browse-error", (e) => {
      if (!alive || !mine(e.payload)) return;
      setMessages((m) => [
        ...m,
        {
          id: tmpId(),
          browseId,
          role: "assistant",
          body: e.payload.error,
          status: "error",
          createdAt: Date.now(),
        },
      ]);
      setLiveText("");
      setStatus("error");
    });
    const cancelP = listen<BrowseCancelledEvent>("browse-cancelled", (e) => {
      if (!alive || !mine(e.payload)) return;
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
  }, [browseId]);

  // Re-pin to the bottom when the active tab changes (fresh thread load).
  useEffect(() => {
    stickRef.current = true;
  }, [browseId]);

  // Follow streaming/new turns only while the user is parked at the bottom;
  // if they've scrolled up to read, leave their position untouched.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, liveText]);

  // Recompute stickiness from the live scroll position. A small threshold keeps
  // "follow" engaged through sub-pixel rounding and the trailing cursor glyph.
  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || status === "streaming") return;
    // The backend treats a turn as "first" until the agent session is saved,
    // which only happens on a *successful* reply — so keep sending a snapshot
    // until then (e.g. if the opening turn errored), matching that contract.
    const firstTurn = !messages.some(
      (m) => m.role === "assistant" && m.status === "complete",
    );
    // Sending a turn jumps you to the bottom to see your message + the reply
    // begin; from there the scroll listener takes over if you scroll up.
    stickRef.current = true;
    setMessages((m) => [
      ...m,
      {
        id: tmpId(),
        browseId,
        role: "user",
        body: trimmed,
        status: "complete",
        createdAt: Date.now(),
      },
    ]);
    setLiveText("");
    setStatus("streaming");

    // First turn embeds a live DOM snapshot so the agent is grounded without a
    // mandatory round-trip; follow-ups rely on its /snapshot tool.
    let snapshot: string | undefined;
    if (firstTurn) {
      // Live snapshot if the tab is up; otherwise the cached one (a suspended
      // discussion tab still grounds the first turn). A miss just means a
      // slower first answer.
      snapshot = await captureSnapshotOrCached(label);
      if (browseIdRef.current !== browseId) return; // tab switched mid-capture
    }

    void invoke("browse_send", {
      browseId,
      text: trimmed,
      snapshot,
      cwd: projectDir ?? null,
      tandem: tandem ?? false,
    }).catch((err) => {
      setStatus("error");
      setMessages((m) => [
        ...m,
        {
          id: tmpId(),
          browseId,
          role: "assistant",
          body: `Couldn't reach the browse agent: ${err}`,
          status: "error",
          createdAt: Date.now(),
        },
      ]);
    });
  }

  function cancel() {
    void invoke("browse_cancel", { browseId }).catch(() => {});
  }

  function discard() {
    void invoke("browse_discard", { browseId }).catch(() => {});
    setMessages([]);
    setLiveText("");
    setStatus("idle");
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
          💬 Page discussion
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
            style={{ fontSize: "13px", color: "var(--color-ink-muted)" }}
          >
            ✕
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
              onOpenLink={onOpenLink}
              onSendToRedline={onSendToRedline}
              onSendToDrafter={onSendToDrafter}
              onAddToMission={onAddToMission}
              showSources={!!tandem}
              feedback={feedback}
              onVerdict={setVerdict}
            />
          ))
        )}
        {status === "streaming" &&
          ((tandem ? stripStreamingSources(liveText) : liveText) ? (
            <StreamingBubble
              text={tandem ? stripStreamingSources(liveText) : liveText}
              onOpenLink={onOpenLink}
            />
          ) : (
            <WorkingIndicator />
          ))}
      </div>

      <div className="px-3 py-2 shrink-0" style={{ borderTop: "1px solid var(--color-rule)" }}>
        <Composer
          draft={draft}
          setDraft={setDraft}
          streaming={status === "streaming"}
          onSend={() => {
            void send(draft);
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
  showSources,
  feedback,
  onVerdict,
}: {
  msg: BrowseMessage;
  onOpenLink?: (url: string) => void;
  onSendToRedline?: (markdown: string) => void;
  onSendToDrafter?: (markdown: string) => void;
  onAddToMission?: (markdown: string) => void;
  showSources?: boolean;
  feedback?: Record<string, number>;
  onVerdict?: (source: Source, verdict: number) => void;
}) {
  const isUser = msg.role === "user";
  const isError = msg.status === "error";
  // In tandem mode a reply may carry a trailing sources block; split it off so
  // the JSON never renders and the sources get their own rateable strip.
  const { text, sources } =
    showSources && !isUser && !isError
      ? parseSources(msg.body)
      : { text: msg.body, sources: [] as Source[] };
  const showActions = !isUser && !isError && text.trim().length > 0;
  return (
    <div className="flex flex-col gap-0.5 group/msg">
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
        />
      )}
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
              👍
            </button>
            <button
              type="button"
              onClick={() => onVerdict?.(s, -1)}
              title="Not helpful"
              aria-pressed={v === -1}
              style={thumb(v === -1)}
            >
              👎
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
}: {
  body: string;
  onSendToRedline?: (markdown: string) => void;
  onSendToDrafter?: (markdown: string) => void;
  onAddToMission?: (markdown: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [pinned, setPinned] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(body).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  const pin = () => {
    onAddToMission?.(body);
    setPinned(true);
    window.setTimeout(() => setPinned(false), 1400);
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
        {copied ? "Copied ✓" : "⧉ Copy"}
      </button>
      {onAddToMission && (
        <button
          type="button"
          onClick={pin}
          title="Pin this reply to the active mission"
          style={{ ...actionStyle, color: "var(--color-info)" }}
        >
          {pinned ? "Pinned ✓" : "📌 Add to mission"}
        </button>
      )}
      {onSendToDrafter && (
        <button
          type="button"
          onClick={() => onSendToDrafter(body)}
          title="Open this reply in the Prompt Drafter to shape before sending"
          style={{ ...actionStyle, color: "var(--color-info)" }}
        >
          ✍️ Open in Drafter
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

function StreamingBubble({
  text,
  onOpenLink,
}: {
  text: string;
  onOpenLink?: (url: string) => void;
}) {
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
          <MarkdownView body={text} compact onLinkClick={onOpenLink} />
          <span style={{ color: "var(--color-ink-muted)" }}>▌</span>
        </div>
      ) : (
        <div
          style={{
            fontSize: "calc(12.5px * var(--rl-discussion-zoom, 1))",
            lineHeight: 1.5,
            color: "var(--color-ink-muted)",
          }}
        >
          working…
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
  const taRef = useRef<HTMLTextAreaElement>(null);
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
            if (!streaming) onSend();
          }
        }}
        placeholder="Ask about this page…"
        rows={2}
        disabled={streaming}
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
