// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";
import { Copy, Link2, PenLine, X } from "lucide-react";
import type { Linked, LinkedMessage } from "../types";
import { captureSnapshotOrCached } from "../lib/domSnapshot";
import { useAgentTurn } from "../hooks/useAgentTurn";
import { usePersistedState } from "../theme/usePersistedState";
import { MarkdownView } from "./MarkdownView";
import { QueuedChip, UnsentNote } from "./QueuedChip";
import { WorkingIndicator } from "./WorkingIndicator";

interface LinkedChatProps {
  linked: Linked;
  /** The tab the user is currently on — passed live and updated as they switch
   *  tabs WITHOUT remounting this component (it is keyed by `linkedId`, not by
   *  tab), so each new turn is tab-tagged with wherever they are now. */
  tab: {
    /** Native webview label (`browser-<id>`) — used to snapshot the tab. */
    label: string | null;
    n: number | null;
    browseId: string | null;
    url: string | null;
    title: string | null;
  };
  /** Working dir for the agent (scopes Read/Grep/Glob); `$HOME` if null. */
  projectDir?: string | null;
  onClose: () => void;
  onOpenLink?: (url: string) => void;
  /** Send a reply (markdown) to Claude Code — confirms the target repo first. */
  onSendToRedline?: (markdown: string) => void;
  /** Open a reply (markdown) in the Prompt Drafter to shape before sending. */
  onSendToDrafter?: (markdown: string) => void;
}

/** The little per-turn header for a message: a user turn shows which tab it was
 *  on ("🔗 tab 2 — Example"); an assistant turn is just "Linked". Pure so it can
 *  be unit-tested without mounting the component. */
export function tabChipLabel(msg: Pick<LinkedMessage, "role" | "tabN" | "tabTitle">): string {
  if (msg.role !== "user") return "Linked";
  if (msg.tabN == null) return "You";
  return `🔗 tab ${msg.tabN}${msg.tabTitle ? ` — ${msg.tabTitle}` : ""}`;
}

/** The linked-discussion panel: ONE conversation that follows the user across
 *  tabs. Sibling of `MissionChat`/`BrowserChat`, on the `linked-*` event family.
 *  Keyed by `linked.linkedId` by the parent — deliberately NOT by the tab, so
 *  switching tabs never resets the thread. Each user turn shows which tab it was
 *  on. */
export function LinkedChat({
  linked,
  tab,
  projectDir,
  onClose,
  onOpenLink,
  onSendToRedline,
  onSendToDrafter,
}: LinkedChatProps) {
  const linkedId = linked.linkedId;
  // Composer draft survives surface switches and app restarts (the component
  // is keyed by linkedId, so each discussion keeps its own).
  const [draft, setDraft] = usePersistedState<string>(`rl.chatDraft.linked.${linkedId}`, "");
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  // The current tab, held in a ref so the streaming reply's assistant bubble can
  // be tagged with the tab the turn was sent on even if the user switches mid-
  // stream. Seeded fresh each render.
  const tabRef = useRef(tab);
  tabRef.current = tab;

  // The turn lifecycle — persisted thread, live stream, mid-turn remount
  // restore (partial text + spinner), self-heal — lives in the shared hook.
  // Keyed on `linkedId` ONLY — switching tabs must NOT tear down the stream.
  const { messages, liveText, status, startedAt, loaded, send, cancel, unqueue } =
    useAgentTurn<LinkedMessage>({
      surface: "linked",
      key: linkedId,
      idField: "linkedId",
      historyCmd: "linked_get_thread",
      historyArgs: { linkedId },
      sendFailPrefix: "Couldn't reach the linked discussion",
      buildSendArgs: async (text) => {
        const t = tabRef.current;
        // A fresh snapshot every turn (unlike BrowserChat's first-turn-only) —
        // the tab changes turn-to-turn, so re-ground the agent each time.
        let snapshot: string | undefined;
        if (t.label) {
          try {
            snapshot = await captureSnapshotOrCached(t.label);
          } catch {
            /* the agent can /snapshot itself if there's none */
          }
        }
        return {
          linkedId,
          text,
          tabN: t.n,
          tabBrowseId: t.browseId,
          tabUrl: t.url,
          tabTitle: t.title,
          snapshot,
          cwd: projectDir ?? null,
        };
      },
      makeMessage: ({ id, role, body, status }) => {
        const t = tabRef.current;
        return {
          id,
          linkedId,
          role,
          body,
          status,
          tabBrowseId: t.browseId,
          tabN: t.n,
          tabTitle: t.title,
          tabUrl: t.url,
          createdAt: Date.now(),
        };
      },
    });

  useEffect(() => {
    stickRef.current = true;
  }, [linkedId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, liveText]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  return (
    <div
      className="flex flex-col h-full min-h-0"
      style={{ background: "var(--color-paper)", borderLeft: "1px solid var(--color-rule)" }}
    >
      <LinkedHeader
        title={linked.title}
        tab={tab}
        streaming={status === "streaming"}
        onClose={onClose}
      />

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-y-auto rl-thin-scroll-y flex flex-col gap-2.5 px-3 py-3"
      >
        {!loaded ? null : messages.length === 0 && status === "idle" ? (
          <div style={{ fontSize: "12px", color: "var(--color-ink-muted)", lineHeight: 1.5 }}>
            This one conversation follows you across every tab. Ask about the tab
            you're on, then switch tabs and keep going — I'll carry the thread and
            check in with a tab's own discussion when I need to go deep.
          </div>
        ) : (
          messages.map((m) =>
            m.role === "system" ? (
              // A conversion marker ("Continued from tab N — Title"): the rows
              // above it were copied from the tab's own chat; below it the
              // discussion spans all tabs.
              <div key={m.id} className="flex items-center gap-2 my-1" aria-hidden>
                <span className="flex-1" style={{ borderTop: "1px solid var(--color-rule)" }} />
                <span
                  className="truncate"
                  style={{
                    fontSize: "10px",
                    fontWeight: 600,
                    color: "var(--color-ink-muted)",
                    maxWidth: "80%",
                  }}
                >
                  {m.body}
                </span>
                <span className="flex-1" style={{ borderTop: "1px solid var(--color-rule)" }} />
              </div>
            ) : (
              <MessageBubble
                key={m.id}
                msg={m}
                onOpenLink={onOpenLink}
                onSendToRedline={onSendToRedline}
                onSendToDrafter={onSendToDrafter}
                onUnqueue={() => {
                  void unqueue(m.id).then((text) => {
                    if (text) setDraft((prev) => (prev.trim() ? `${text}\n\n${prev}` : text));
                  });
                }}
                onResend={() => {
                  stickRef.current = true;
                  send(m.body);
                }}
              />
            ),
          )
        )}
        {status === "streaming" &&
          (liveText ? (
            <StreamingBubble text={liveText} onOpenLink={onOpenLink} />
          ) : (
            <WorkingIndicator startedAt={startedAt ?? undefined} />
          ))}
      </div>

      <div className="px-3 py-2 shrink-0" style={{ borderTop: "1px solid var(--color-rule)" }}>
        <Composer
          draft={draft}
          setDraft={setDraft}
          streaming={status === "streaming"}
          onSend={() => {
            stickRef.current = true;
            send(draft);
            setDraft("");
          }}
          onStop={cancel}
        />
      </div>
    </div>
  );
}

function LinkedHeader({
  title,
  tab,
  streaming,
  onClose,
}: {
  title: string;
  tab: LinkedChatProps["tab"];
  streaming: boolean;
  onClose: () => void;
}) {
  const here =
    tab.n != null
      ? `on tab ${tab.n}${tab.title ? ` — ${tab.title}` : ""}`
      : "following your tabs";
  return (
    <div
      className="flex items-start gap-1.5 px-3 py-2 shrink-0"
      style={{ borderBottom: "1px solid var(--color-rule)" }}
    >
      <Link2 size={14} strokeWidth={2} style={{ marginTop: "1px", flexShrink: 0 }} />
      <div className="flex flex-col min-w-0 flex-1">
        <span
          style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-ink)" }}
          className="truncate"
        >
          {title}
        </span>
        <span style={{ fontSize: "10px", color: "var(--color-ink-muted)" }} className="truncate">
          {here}
          {streaming ? " · thinking…" : ""}
        </span>
      </div>
      <button
        type="button"
        onClick={onClose}
        title="Close"
        className="px-1 leading-none opacity-60 hover:opacity-100"
        style={{ color: "var(--color-ink-muted)" }}
      >
        <X size={13} strokeWidth={2} />
      </button>
    </div>
  );
}

function MessageBubble({
  msg,
  onOpenLink,
  onSendToRedline,
  onSendToDrafter,
  onUnqueue,
  onResend,
}: {
  msg: LinkedMessage;
  onOpenLink?: (url: string) => void;
  onSendToRedline?: (markdown: string) => void;
  onSendToDrafter?: (markdown: string) => void;
  onUnqueue?: () => void;
  onResend?: () => void;
}) {
  const isUser = msg.role === "user";
  const isError = msg.status === "error";
  const isQueued = isUser && msg.status === "queued";
  const isUnsent = isUser && msg.status === "unsent";
  const showActions = !isUser && !isError && msg.body.trim().length > 0;
  // Per-turn tab tag: which tab this message was on.
  const tabLabel = tabChipLabel(msg);
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
        className="truncate"
        title={isUser && msg.tabUrl ? msg.tabUrl : undefined}
      >
        {tabLabel}
      </span>
      {isError ? (
        <div style={{ fontSize: "12.5px", lineHeight: 1.5, whiteSpace: "pre-wrap", color: "var(--color-warning)" }}>
          {msg.body}
        </div>
      ) : (
        <MarkdownView body={msg.body} compact rich onLinkClick={onOpenLink} />
      )}
      {isQueued && <QueuedChip onUnqueue={onUnqueue} />}
      {isUnsent && <UnsentNote onResend={onResend} />}
      {showActions && (
        <MessageActions
          body={msg.body}
          onSendToRedline={onSendToRedline}
          onSendToDrafter={onSendToDrafter}
        />
      )}
    </div>
  );
}

function MessageActions({
  body,
  onSendToRedline,
  onSendToDrafter,
}: {
  body: string;
  onSendToRedline?: (markdown: string) => void;
  onSendToDrafter?: (markdown: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(body).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
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

function StreamingBubble({ text, onOpenLink }: { text: string; onOpenLink?: (url: string) => void }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span
        style={{ fontSize: "9px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--color-info)" }}
      >
        Linked
      </span>
      {text ? (
        <div>
          <MarkdownView body={text} compact onLinkClick={onOpenLink} />
          <span style={{ color: "var(--color-ink-muted)" }}>▌</span>
        </div>
      ) : (
        <div style={{ fontSize: "12.5px", lineHeight: 1.5, color: "var(--color-ink-muted)" }}>working…</div>
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
            // Sending mid-stream queues the message behind the reply.
            onSend();
          }
        }}
        placeholder={streaming ? "Type ahead — sends queue behind the reply…" : "Ask across your tabs…"}
        rows={2}
        className="flex-1 rounded px-2 py-1"
        style={{
          fontSize: "12px",
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
          style={{ background: "var(--color-bg-elevated)", border: "1px solid var(--color-rule)", color: "var(--color-ink)", fontSize: "11px" }}
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
        style={{ background: "var(--color-info)", color: "var(--color-on-accent)", fontSize: "11px", opacity: draft.trim() ? 1 : 0.5 }}
      >
        Send
      </button>
    </div>
  );
}
