// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { ContinueAs, ConversationSourceContext } from "./ContinueAs";
import { useMemo, memo, useEffect, useRef, useState } from "react";
import {
  Copy,
  ListTodo,
  MoreHorizontal,
  Pin,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { captureSnapshotOrCached } from "../lib/domSnapshot";
import { contextLine, type ResolvedConversation, type WorkspaceKey } from "../lib/browserChat/scope";
import { needsSnapshot, replyActions, seedPolicy, turnEnvelope, type ReplyAction, type SeedSource } from "../lib/browserChat/turn";
import type { BrowseMessage } from "../types";
import { useAgentTurn } from "../hooks/useAgentTurn";
import { useStickToBottom } from "../hooks/useStickToBottom";
import { useSharedDraft } from "../hooks/useSharedDraft";
import { ReplyBlock, UserTurn } from "./ReplyBlock";
import { SendStopButton, sendState } from "./SendStopButton";
import { QueueTray } from "./QueueTray";
import { ThreadMeterStrip } from "./TurnFooter";
import { contextResets, type TurnMeter } from "../lib/turnMeter";
import { BrowserMenuItem, BrowserPopover } from "./BrowserSurfaces";
import { BrowseHarnessChip, useBrowseHarness } from "./BrowseHarnessChip";
import { agentLabelFor, backendLabel } from "../lib/backendChoice";

interface BrowserChatProps {
  /** The conversation on screen, as the structure layer resolves it: the
   *  thread it shows and sends on (which keys the backend and the persisted
   *  history), the page a turn targets, and whether it follows tabs. The
   *  chat never works any of that out itself (lib/browserChat/README.md). */
  conversation: ResolvedConversation;
  /** BrowserPane's workspace. A turn is captured under it as a mission, or as
   *  no mission for regular browsing and a Mosaic (BC-13). */
  workspace: WorkspaceKey;
  /** Working dir for the agent (scopes Read/Grep/Glob); `$HOME` when null. */
  projectDir?: string | null;
  /** Close the discussion panel (the thread itself is kept). */
  onClose: () => void;
  /** Open an http(s) link the user clicked in a reply as a Redline browser tab,
   *  instead of letting it escape the app's webview. */
  onOpenLink?: (url: string) => void;
  /** Pin an assistant reply to the active mission ("I like this part"). Present
   *  only when a mission is active; the parent attaches the page it was about. */
  onAddToMission?: (markdown: string) => void | Promise<boolean>;
  /** Append an assistant reply to the workspace Cart, creating it if needed. */
  onAddToCart?: (markdown: string) => void | Promise<boolean>;
  /** Text handed to the composer once, on mount or when the nonce changes —
   *  how `💬` on a list item, a picked element and a highlight in the page
   *  arrive here with the passage already quoted. Its `source` is the gesture
   *  it came from, and `seedPolicy` says what that gesture means: send at
   *  once, or merge below the draft, and whether the caret moves (BC-14,
   *  BC-33).
   *
   *  A prop with a nonce, not a direct write to the persisted draft key: the
   *  draft lives in `useSharedDraft`'s memory first, and writing that
   *  localStorage key from outside would never reach a panel already
   *  mounted. Same shape as `openRequest`/`onOpenRequestConsumed` in
   *  BrowserPane and `consumeSeed` on the Front Door. */
  seed?: { text: string; nonce: number; source: SeedSource } | null;
  onSeedConsumed?: () => void;
  /** Swap to the other kind of chat on this tab, until it is switched away. */
  onToggleTabChat?: () => void;
  /** On: new tabs and tab switches stay in the shared chat. Off: each tab
   *  opens its own. */
  linkedMode?: boolean;
  onToggleLinkedMode?: () => void;
  onResearch?: () => void;
}

const ZOOM_KEY = "redline.browseZoom";
const clampZoom = (z: number) => Math.min(1.6, Math.max(0.8, z));

function loadZoom(): number {
  const raw = Number(localStorage.getItem(ZOOM_KEY));
  return Number.isFinite(raw) && raw > 0 ? clampZoom(raw) : 1;
}

/** The provider that wrote the chat's latest completed reply, or null when
 *  nothing has answered yet. Replies older than Codex page chats were Claude's. */
function lastReplyBackend(messages: readonly BrowseMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.status === "complete") return m.backend ?? "claude-code";
  }
  return null;
}

/** A discussion with a browse agent that can see and drive the active browser
 *  tab. Standalone analog of `CommentThread` (browse-* events, `--rl-discussion-zoom`,
 *  auto-grow composer), keyed by a per-tab `browseId` rather than a comment. */
export const BrowserChat = memo(function BrowserChat({
  conversation,
  workspace,
  projectDir,
  onClose,
  onOpenLink,
  onAddToMission,
  onAddToCart,
  seed,
  onSeedConsumed,
  onToggleTabChat,
  linkedMode = false,
  onToggleLinkedMode,
  onResearch,
}: BrowserChatProps) {
  const { browseId } = conversation;
  // Composer draft survives tab switches and app restarts (the component is
  // keyed by browseId, so each tab's discussion keeps its own).
  const [draft, setDraft] = useSharedDraft(`rl.chatDraft.browse.${browseId}`);
  const [zoom, setZoom] = useState(loadZoom);
  const [conversationPanel, setConversationPanel] = useState<"menu" | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  // Whether to keep the newest content in view as it streams. True only while
  // the user is parked at (or near) the bottom — scroll up to read mid-stream
  // and we leave you where you are, like ChatGPT / Claude desktop.

  // The turn lifecycle — persisted thread, live stream, mid-turn remount
  // restore (partial text + spinner), self-heal — lives in the shared hook,
  // keyed by browseId: switching tabs rebinds it; a turn left streaming keeps
  // running backend-side and is picked up loss-free on return.
  //
  // The page this conversation last SENT a snapshot of. It moves only once
  // the backend has the turn, so a send that failed re-grounds the next one;
  // null after a remount, where re-grounding is the safe default (BC-11).
  const lastGroundedLabel = useRef<string | null>(null);
  // This chat's provider/model/effort, which the next turn reads at start.
  const harness = useBrowseHarness(browseId);
  const agent = backendLabel(harness.pick.backend);
  // Who the turn in flight runs on, read as it went out: a pick changed
  // while it streams applies to the next message, not to this byline.
  const sentAgent = useRef<{ browseId: string; agent: string } | null>(null);
  const {
    messages,
    queue,
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
        // The page, scope and workspace this turn was typed against, captured
        // now: a queued turn keeps them through any tab switch (BC-12).
        const target = conversation;
        // A chat showing an inherited pick stores it before its first turn.
        const runsOn = (await harness.commit()).backend;
        sentAgent.current = { browseId, agent: backendLabel(runsOn) };
        // The opening turn embeds a DOM snapshot so the agent is grounded
        // without a round-trip, and so does a turn on a page the conversation
        // has not grounded on; follow-ups rely on its /snapshot tool. The
        // backend treats a turn as "first" until a session on this provider
        // has answered, so a failed opening turn keeps sending it (BC-11,
        // BC-18). Live if the tab is up, otherwise the cached one (a
        // suspended tab still grounds). A miss just means a slower answer.
        // The hook drops the send if the panel switched mid-capture.
        const snapshot = needsSnapshot(target, { lastReplyBackend: lastReplyBackend(messages), runsOn, lastGroundedLabel: lastGroundedLabel.current })
          ? await captureSnapshotOrCached(target.targetLabel)
          : undefined;
        return { ...turnEnvelope(target, workspace, text, projectDir ?? null, snapshot) };
      },
      makeMessage: ({ id, role, body, status, backend }) => ({
        id,
        browseId,
        role,
        body,
        status,
        createdAt: Date.now(),
        backend: backend ?? null,
      }),
      // The backend has the turn, so the page it carried is grounded.
      onSent: (args) => {
        if ("snapshot" in args) lastGroundedLabel.current = String(args.targetLabel);
      },
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

  // A seed that waits for the user (`💬` on a list item, a picked element, an
  // Ask) MERGES into the draft rather than replacing it: whatever the user had
  // half-typed is theirs, and quoting an item is an addition to the question,
  // not a reason to lose it. Nonce-keyed so the same item can be quoted twice,
  // and consumed immediately so a re-render can't paste it again.
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const lastSeedRef = useRef<number | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    if (!seed || seed.nonce === lastSeedRef.current) return;
    const policy = seedPolicy(seed.source);
    // An auto-send seed waits for the thread to finish restoring: sending into
    // a not-yet-loaded thread races the restore. Holding it costs nothing —
    // this effect re-runs the moment `loaded` flips, and the seed is untouched
    // until then (so a remount can't lose it either).
    if (policy.autoSend && !loaded) return;
    lastSeedRef.current = seed.nonce;
    if (policy.autoSend) {
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
    setDraft(policy.mergesDraft && prev.trim() ? `${prev.replace(/\s*$/, "")}\n\n${seed.text}` : seed.text);
    onSeedConsumed?.();
    // Only a gesture whose point is typing next takes the caret (BC-33): land
    // it at the end, below the quote, ready to type the question.
    if (!policy.focusComposer) return;
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, loaded]);

  /** × in the queue tray: out of the queue, its text back in the composer. */
  function unqueueToDraft(id: string) {
    void unqueue(id).then((text) => {
      if (text) setDraft((prev) => (prev.trim() ? `${text}\n\n${prev}` : text));
    });
  }

  function discard() {
    void invoke("browse_discard", { browseId }).catch(() => {});
    clear();
    harness.forget();
    setDraft("");
  }

  return (
    <ConversationSourceContext.Provider value={{ conversationKind: "browse", conversationId: browseId, messages }}>
    <div
      className="rb-chat-frame flex flex-col h-full min-h-0 min-w-0 overflow-hidden"
      data-browser-chat
      style={
        {
          background: "var(--color-paper)",
          borderLeft: "1px solid var(--color-rule)",
          "--rl-discussion-zoom": zoom,
        } as React.CSSProperties
      }
    >
      <div className="rb-thread-tools" data-browser-chat-header>
        <div className="min-w-0 flex-1">
          <span className="block truncate" style={{ fontSize: 13, fontWeight: 600 }}>{conversation.title}</span>
        </div>
        <button type="button" className="rb-button" onClick={onToggleTabChat}>{conversation.kind === "shared" ? "Tab chat" : "Shared chat"}</button>
        {onToggleLinkedMode && <button type="button" className="rb-icon-button" aria-label="Linked mode" aria-pressed={linkedMode} onClick={onToggleLinkedMode}
          title={linkedMode
            ? "Linked mode on — new tabs and tab switches stay in the shared chat. Click to give each tab its own chat."
            : "Linked mode off — each tab opens its own chat. Click to share one chat across tabs."}>{linkedMode ? "🔗" : "⛓️‍💥"}</button>}
        <button ref={moreRef} type="button" className="rb-icon-button" aria-label="Conversation actions" aria-haspopup="menu" aria-expanded={conversationPanel === "menu"}
          onClick={() => setConversationPanel((panel) => panel === "menu" ? null : "menu")}><MoreHorizontal size={17} /></button>
        <button type="button" className="rb-icon-button" aria-label="Close discussion" onClick={onClose}><X size={16} /></button>
      </div>
      {/* One thin row: the model picker, with the context on its right. Not in
          the header — that row is full at the dock's ~360px. */}
      <div className="rb-thread-harness" data-browser-chat-harness>
        <BrowseHarnessChip harness={harness} />
        {/* What the chat is looking at: the page a shared or anchored chat
            acts on, where an anchored one started, and the kind of chat only
            when it is the exception to linked mode (BC-3, BC-5). */}
        <div className="rb-thread-context">
          {contextLine(conversation).map((part) => <span key={part}>{part}</span>)}
        </div>
      </div>
      {conversationPanel === "menu" && <BrowserPopover anchor={moreRef} title="Conversation actions" onClose={() => setConversationPanel(null)}>
        <BrowserMenuItem onClick={() => { setConversationPanel(null); onResearch?.(); }}>Start a research mission</BrowserMenuItem>
        <div className="rb-menu-item" role="group" aria-label="Text size"><span className="rb-menu-label">Text size</span>
          <button type="button" className="rb-button" aria-label="Smaller text" disabled={zoom <= 0.8} onClick={() => adjustZoom(-0.1)}>A−</button>
          <button type="button" className="rb-button" aria-label="Larger text" disabled={zoom >= 1.6} onClick={() => adjustZoom(0.1)}>A+</button>
        </div>
        <BrowserMenuItem disabled={!messages.length} onClick={() => { setConversationPanel(null); discard(); }}>Clear history</BrowserMenuItem>
        {/* What the thread has spent, by model: a consult spawns a real child
            `claude`, so by subprocess is the honest unit. Here rather than
            above the composer, where its arrival took height from the
            thread. */}
        <ThreadMeterStrip meters={meters} />
      </BrowserPopover>}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        // The bottom padding keeps the queue tray's pill clear of the newest
        // line: the tray overlays the thread rather than shrinking it.
        className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden rl-thin-scroll-y flex flex-col gap-2.5 px-3 pt-3 pb-9"
        data-browser-chat-messages
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
              // A reply is signed by the provider that wrote it; an error row
              // is Redline's own note about this chat's current turn.
              agent={m.status === "complete" ? agentLabelFor(m.backend) : agent}
              seat={harness.pick.model}
              meter={meters[m.id]}
              contextReset={resets.has(m.id)}
              onOpenLink={onOpenLink}
              onAddToMission={onAddToMission}
              onAddToCart={onAddToCart}
              onResend={() => {
                stick();
                send(m.body);
              }}
            />
          ))
        )}
        {status === "streaming" && (
          // From the FIRST line of the stream, not the first token: its tail
          // is the turn's one status line, filling the wait.
          <ReplyBlock
            phase="live"
            byline={sentAgent.current?.browseId === browseId ? sentAgent.current.agent : agent}
            seat={harness.pick.model}
            text={liveText}
            meter={meter}
            activity={activity}
            startedAt={startedAt}
            onOpenLink={onOpenLink}
          />
        )}
      </div>

      <QueueTray rows={queue.map((row) => ({ id: row.id, text: row.body }))} onRemove={unqueueToDraft} />
      <div data-browser-chat-composer className="min-w-0 px-3 py-2 shrink-0" style={{ borderTop: "1px solid var(--color-rule)" }}>
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
        {loaded && messages.length === 0 && status === "idle" && onResearch && <button type="button" className="mt-2 text-xs" style={{ color: "var(--color-info)" }} onClick={onResearch}>Start a research mission</button>}
      </div>
    </div>
    </ConversationSourceContext.Provider>
  );
});

function MessageBubble({
  msg,
  agent,
  seat,
  onOpenLink,
  onAddToMission,
  onAddToCart,
  onResend,
  meter,
  contextReset,
}: {
  msg: BrowseMessage;
  /** The provider's name over an assistant reply. */
  agent: string;
  /** The model this chat asked for, if it named one. */
  seat: string | null;
  onOpenLink?: (url: string) => void;
  onAddToMission?: (markdown: string) => void | Promise<boolean>;
  onAddToCart?: (markdown: string) => void | Promise<boolean>;
  onResend?: () => void;
  /** This row's settled meter — the byline, steps line and tail it keeps. */
  meter?: TurnMeter | null;
  /** This turn's context restarted (compaction or a fresh CLI session). */
  contextReset?: boolean;
}) {
  if (msg.role === "user") {
    return <UserTurn body={msg.body} unsent={msg.status === "unsent"} onResend={onResend} onOpenLink={onOpenLink} />;
  }
  const actions = replyActions({ role: msg.role, status: msg.status, body: msg.body, missionActive: !!onAddToMission });
  return (
    <ReplyBlock
      phase="settled"
      byline={agent}
      seat={seat}
      text={msg.body}
      error={msg.status === "error"}
      meter={meter}
      contextReset={contextReset}
      inspect={{ surface: "browse", key: msg.browseId }}
      onOpenLink={onOpenLink}
      actions={
        actions.length ? (
          <MessageActions
            actions={actions}
            messageId={msg.id}
            body={msg.body}
            onAddToMission={onAddToMission}
            onAddToCart={onAddToCart}
          />
        ) : undefined
      }
    />
  );
}

/** A settled reply's actions, in its tail row, in the order `replyActions`
 *  gives them: copy the whole message (covers prose, where per-block buttons
 *  don't reach), add it to the task list, pin it to the mission, continue the
 *  conversation elsewhere. Every one is the user's gesture; handing a reply
 *  to the Drafter or a new plan lives inside Continue as… (BC-24). */
function MessageActions({
  actions,
  messageId,
  body,
  onAddToMission,
  onAddToCart,
}: {
  actions: readonly ReplyAction[];
  messageId: string;
  body: string;
  onAddToMission?: (markdown: string) => void | Promise<boolean>;
  onAddToCart?: (markdown: string) => void | Promise<boolean>;
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
  const addToList = () => {
    // Same truthfulness rule as the pin: an add that never reached the DB
    // must not flash a tick.
    void Promise.resolve(onAddToCart?.(body)).then((ok) => {
      setListed(ok === false ? "failed" : "ok");
      window.setTimeout(() => setListed("idle"), 1400);
    });
  };
  return (
    <span data-reply-actions className="contents">
      {actions.map((action) => {
        switch (action) {
          case "copy":
            return (
              <button key={action} type="button" className="rl-reply-action" onClick={copy} title="Copy this reply">
                {copied ? "Copied ✓" : <><Copy size={11} strokeWidth={2} aria-hidden /> Copy</>}
              </button>
            );
          case "add-to-task-list":
            return onAddToCart && (
              <button key={action} type="button" className="rl-reply-action" data-tone="info" onClick={addToList} title="Add this reply to the task list">
                {listed === "ok" ? "Added ✓" : listed === "failed" ? "Add failed ✗" : <><ListTodo size={12} aria-hidden /> Task list</>}
              </button>
            );
          case "add-to-mission":
            return (
              <button key={action} type="button" className="rl-reply-action" data-tone="info" onClick={pin} title="Pin this reply to the active mission">
                {pinned === "ok" ? "Pinned ✓" : pinned === "failed" ? "Pin failed ✗" : <><Pin size={11} strokeWidth={2} aria-hidden /> Mission</>}
              </button>
            );
          case "continue-as":
            return <ContinueAs key={action} through={messageId} />;
        }
      })}
    </span>
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
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };
  useEffect(autosize, [draft]);
  return (
    <div className="flex min-w-0 items-end gap-1.5">
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
        className="min-w-0 flex-1 rounded px-2 py-1"
        style={{
          fontSize: "calc(12px * var(--rl-discussion-zoom, 1))",
          border: "1px solid var(--color-rule)",
          background: "var(--color-paper)",
          color: "var(--color-ink)",
          fontFamily: "inherit",
          resize: "none",
          maxHeight: 160,
          overflowY: "auto",
        }}
      />
      <SendStopButton state={sendState(streaming, !!draft.trim())} onSend={onSend} onStop={onStop} disabled={!draft.trim()} />
    </div>
  );
}
