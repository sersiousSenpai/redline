// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { ContinueAs, ConversationSourceContext } from "./ContinueAs";
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Copy,
  ListTodo,
  MoreHorizontal,
  Pin,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { captureSnapshotOrCached } from "../lib/domSnapshot";
import { contextLine, type ResolvedConversation, type WorkspaceKey } from "../lib/browserChat/scope";
import { composerModel, needsSnapshot, replyActions, seedPolicy, turnEnvelope, type ReplyAction, type SeedSource } from "../lib/browserChat/turn";
import {
  attachmentBody,
  composeTurn,
  FOLLOW_WITHIN_PX,
  liveStepLabel,
  liveSteps,
  parkAt,
  userTurnParts,
  workRows,
  type TurnChip,
} from "../lib/browserChat/transcript";
import type { BrowseMessage } from "../types";
import { useAgentTurn } from "../hooks/useAgentTurn";
import type { RunningPageAction } from "../hooks/usePageActions";
import { useStickToBottom } from "../hooks/useStickToBottom";
import { useSharedDraft } from "../hooks/useSharedDraft";
import { useDictation } from "../lib/useDictation";
import { ReplyBlock, UserTurn } from "./ReplyBlock";
import { ThreadMeterStrip } from "./TurnFooter";
import { contextResets, type Activity, type TurnMeter } from "../lib/turnMeter";
import { BrowserMenuItem, BrowserPopover } from "./BrowserSurfaces";
import { BrowseHarnessChip, useBrowseHarness } from "./BrowseHarnessChip";
import { BrowserChatComposer } from "./BrowserChatComposer";
import { EmptyChat, pictureUrl, StatusRail, TurnContext, useTaskListPeek, WorkRows, type RailMission, type RailTray } from "./BrowserChatParts";
import { agentLabelFor, backendLabel } from "../lib/backendChoice";
import "./BrowserChat.css";

/** The raw-wire pane, entered from the conversation's ⋯. Lazy: devtools. */
const StreamInspector = lazy(() => import("./StreamInspector"));

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
  /** Page actions in flight, by the page's label: the live line names the one
   *  on this turn's page ("Clicking · tab 2", BC-41). */
  pageActions?: ReadonlyMap<string, RunningPageAction>;
  /** Pick an element on the page into the composer; absent where the page
   *  can't be picked from. */
  onPickElement?: () => void;
  /** The workspace's Task list: `nonce` moves when the pane wrote to it, and
   *  `onOpen` shows the list itself. */
  taskList?: { nonce: number; onOpen: () => void };
  /** Inside a mission, its goal for the status rail. */
  mission?: RailMission | null;
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

/** A send as it went out: the provider it ran on and the page it was about. */
interface SentTurn {
  agent: string;
  targetLabel: string;
}

/** One step of the live turn, the same whichever copy of the ring it is read from. */
const stepKey = (step: Activity) => `${step.at}\u0000${step.kind}\u0000${step.label}`;

/** The newest of the user's messages in the thread. */
function lastUserId(messages: readonly BrowseMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return messages[i].id;
  return null;
}

/** The composer's chips, kept beside its draft (`rl.chatChips.browse.<id>`)
 *  so they survive a tab switch and a relaunch the way the text does. */
function readChips(raw: string): TurnChip[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) ? list.filter((c): c is TurnChip => !!c && typeof c === "object" && typeof (c as TurnChip).body === "string" && typeof (c as TurnChip).label === "string") : [];
  } catch {
    return [];
  }
}

/** A queued message as the tray reads it: its text, or the context it
 *  carries when that is all it is. */
function queuedText(body: string): string {
  const parts = userTurnParts(body);
  return parts.text || parts.chips.map((chip) => chip.label).join(" · ") || body;
}

/** Whether a key is aimed at something the user types in. */
const typingIn = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/** A picture file's size, read before it is attached so the card can keep
 *  its box (BC-40). */
function pictureSize(data: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("Couldn't read that image"));
    img.src = data;
  });
}

/** A discussion with a browse agent that can see and drive the active browser
 *  tab, keyed by a per-tab `browseId` rather than a comment. Laid out the way
 *  an agent-IDE chat panel is: a one-row header, the thread (the user's
 *  messages as cards, replies as prose with their work rows under them), a
 *  rail of live state, and one composer capsule. */
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
  pageActions,
  onPickElement,
  taskList,
  mission = null,
}: BrowserChatProps) {
  const { browseId } = conversation;
  // Composer draft survives tab switches and app restarts (the component is
  // keyed by browseId, so each tab's discussion keeps its own), and so do the
  // chips attached to it.
  const [draft, setDraft] = useSharedDraft(`rl.chatDraft.browse.${browseId}`);
  const [chipsRaw, setChipsRaw] = useSharedDraft(`rl.chatChips.browse.${browseId}`);
  const chips = useMemo(() => readChips(chipsRaw), [chipsRaw]);
  const setChips = useCallback((next: (prev: TurnChip[]) => TurnChip[]) => setChipsRaw((raw) => {
    const list = next(readChips(raw));
    return list.length ? JSON.stringify(list) : "";
  }), [setChipsRaw]);
  /** New chips join the end; the same context twice is one chip. */
  const addChips = useCallback((added: readonly TurnChip[]) => {
    if (added.length) setChips((prev) => [...prev, ...added.filter((chip) => !prev.some((c) => c.body === chip.body))]);
  }, [setChips]);
  const [zoom, setZoom] = useState(loadZoom);
  const [conversationPanel, setConversationPanel] = useState<"menu" | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [tray, setTray] = useState<RailTray | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);

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
  // Who each send ran on and the page it was sent against, read as it went
  // out: a pick changed while a reply streams applies to the next message,
  // and a tab switched to meanwhile is not the page it acts on (BC-12,
  // BC-26). A message queued behind a reply is kept by its row's id until
  // its own turn starts, so it never re-signs the reply in flight.
  const builtFor = useRef(new WeakMap<object, SentTurn>());
  const sentFor = useRef(new Map<string, SentTurn>());
  const lastStarted = useRef<SentTurn | null>(null);
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
        // A send that starts at once is the turn in flight from this moment;
        // one queued behind a reply is filed under its row by `onSent`.
        const sent: SentTurn = { agent, targetLabel: target.targetLabel };
        if (status !== "streaming") lastStarted.current = sent;
        // A chat showing an inherited pick stores it before its first turn,
        // and runs on the default when that write fails.
        const runsOn = (await harness.commit()).backend;
        sent.agent = backendLabel(runsOn);
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
        const args = { ...turnEnvelope(target, workspace, text, projectDir ?? null, snapshot) };
        builtFor.current.set(args, sent);
        return args;
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
      onSent: (args, outcome) => {
        if ("snapshot" in args) lastGroundedLabel.current = String(args.targetLabel);
        const sent = builtFor.current.get(args);
        if (sent && outcome?.messageId) sentFor.current.set(outcome.messageId, sent);
      },
    });
  const streaming = status === "streaming";
  // The turn in flight answers the newest of your messages in the thread
  // (a queued one joins it as its turn starts). After a remount nothing is
  // known of it, and the chat's own pick and page stand in.
  const inFlight = streaming ? (sentFor.current.get(lastUserId(messages) ?? "") ?? lastStarted.current) : null;

  // A pressure drop is not a bug — it is auto-compaction or a fresh CLI
  // session. Unlabelled, a fall from 78% to 12% reads as a broken meter.
  const resets = useMemo(
    () => contextResets(messages.map((m) => m.id), meters),
    [messages, meters],
  );

  // Follow a streaming thread only while the reader is within 48 px of the
  // bottom (BC-38). Leaving it shows ↓ in the rail, counting the messages
  // that arrived since.
  const [following, setFollowing] = useState(true);
  const leftAt = useRef(0);
  const messageCount = useRef(0);
  messageCount.current = messages.length;
  const {
    ref: scrollRef,
    onScroll,
    stick,
    jump,
    park,
  } = useStickToBottom<HTMLDivElement>([messages, liveText], {
    threshold: FOLLOW_WITHIN_PX,
    onFollow: (next) => {
      if (!next) leftAt.current = messageCount.current;
      setFollowing(next);
    },
  });
  const newCount = following ? 0 : Math.max(0, messages.length - leftAt.current);

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

  // How long the reply's text was when each step was first seen: a step is
  // finished once the reply has written past it. Measured in text, not in
  // time, so a step that lands in the same render as the text before it, or
  // a remount that restores both at once, still reads as running. By what
  // the step is, not by object, since the self-heal probe hands the same
  // steps back as new ones. Kept off state, as ReplyBlock keeps its own.
  const seenAt = useRef(new Map<string, number>());
  if (!streaming) seenAt.current.clear();
  for (const step of activity ?? []) if (!seenAt.current.has(stepKey(step))) seenAt.current.set(stepKey(step), liveText.length);
  const live = streaming ? liveSteps(activity ?? [], (step) => liveText.length > (seenAt.current.get(stepKey(step)) ?? 0)) : null;
  const action = (streaming && pageActions?.get(inFlight?.targetLabel ?? conversation.targetLabel)) || null;
  // The turn's one live line (ReplyBlock's tail) names the step running now;
  // without one it says what the turn is doing otherwise (BC-34, BC-41).
  const liveStatus = live?.running || action
    ? { label: liveStepLabel(live?.running?.label ?? "", action), at: Math.max(live?.running?.at ?? 0, action?.at ?? 0), running: true }
    : null;

  // A reply the reader has been following parks at its start once it is
  // taller than the view (BC-38): read from the top, not chased to its end.
  // Once per turn — ↓ or End during it means they want the end. Re-armed
  // when a turn starts, a queued one included.
  const parkable = useRef(true);
  useEffect(() => {
    parkable.current = true;
  }, [startedAt, browseId]);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const reply = scroller?.querySelector<HTMLElement>('[data-reply="live"]');
    if (!streaming || !parkable.current || !scroller || !reply) return;
    const top = parkAt({
      following,
      replyTop: reply.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop,
      replyHeight: reply.offsetHeight,
      viewHeight: scroller.clientHeight,
    });
    if (top === null) return;
    parkable.current = false;
    park(top);
  }, [liveText, activity, streaming, following]);
  const jumpToEnd = () => {
    parkable.current = false;
    jump();
  };

  // A seed that waits for the user (`💬` on a list item, a picked element, an
  // Ask) arrives as chips for its context and MERGES any text into the draft
  // rather than replacing it: whatever the user had half-typed is theirs.
  // Nonce-keyed so the same item can be quoted twice, and consumed
  // immediately so a re-render can't paste it again.
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const lastSeedRef = useRef<number | null>(null);
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
    // A highlight, an element or a Task-list item is context: a chip, not
    // raw text in the field (BC-40).
    const parts = userTurnParts(seed.text);
    addChips(parts.chips);
    if (parts.text) setDraft((prev) => (policy.mergesDraft && prev.trim() ? `${prev.replace(/\s*$/, "")}\n\n${parts.text}` : parts.text));
    onSeedConsumed?.();
    // Only a gesture whose point is typing next takes the caret (BC-33): land
    // it at the end, ready to type the question.
    if (!policy.focusComposer) return;
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, loaded]);

  /** One send from the composer: its chips and its text, as one message. */
  function sendDraft() {
    const text = composeTurn(chips, draft);
    if (!text) return;
    // Sending jumps to the bottom to see the message and the reply begin;
    // from there the scroll rule takes over.
    jumpToEnd();
    send(text);
    setDraft("");
    setChips(() => []);
    setAttachError(null);
  }

  /** × in the queue tray: out of the queue, its context and text back in the
   *  composer. */
  function unqueueToDraft(id: string) {
    void unqueue(id).then((text) => {
      if (!text) return;
      const parts = userTurnParts(text);
      addChips(parts.chips);
      if (parts.text) setDraft((prev) => (prev.trim() ? `${parts.text}\n\n${prev}` : parts.text));
    });
  }

  function discard() {
    void invoke("browse_discard", { browseId }).catch(() => {});
    clear();
    harness.forget();
    setDraft("");
    setChips(() => []);
  }

  // Speaking into the box is one press away: the mic is the round button's
  // face on an empty box. What is heard lands in the box, at its caret.
  const dictation = useDictation(composerRef);

  const attach = {
    onScreenshot: () => {
      const label = `tab ${conversation.targetNumber} — ${conversation.targetTitle || "this page"}`;
      void invoke<{ path: string; pixelWidth: number; pixelHeight: number }>("browser_take_thumbnail", {
        label: conversation.targetLabel,
        key: `chat-${crypto.randomUUID()}`,
        width: 1200,
      }).then(
        (shot) => {
          setAttachError(null);
          addChips([{ kind: "screenshot", label, path: shot.path, width: shot.pixelWidth, height: shot.pixelHeight, body: attachmentBody("screenshot", label, shot.path, shot.pixelWidth, shot.pixelHeight) }]);
        },
        () => setAttachError("Couldn't capture the page — it has to be on screen."),
      );
    },
    onImage: () => {
      void (async () => {
        const picked = await openDialog({ multiple: false, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }] }).catch(() => null);
        if (typeof picked !== "string") return;
        try {
          const file = await invoke<{ data: string | null }>("read_file_base64", { path: picked });
          if (!file.data) throw new Error("That image is too large to attach.");
          const size = await pictureSize(pictureUrl(picked, file.data));
          const label = picked.split("/").pop() ?? picked;
          setAttachError(null);
          addChips([{ kind: "image", label, path: picked, ...size, body: attachmentBody("image", label, picked, size.width, size.height) }]);
        } catch (error) {
          setAttachError(error instanceof Error ? error.message : String(error));
        }
      })();
    },
    onPickElement,
  };

  const tasks = useTaskListPeek(workspace, taskList?.nonce ?? 0);
  const model = composerModel({ phase: status, queued: queue.length, draft, chips: chips.length, listening: dictation.listening });
  // What the header says the chat follows: the page, and the kind of chat
  // only when it is the exception (BC-3, BC-5).
  const context = contextLine(conversation);

  return (
    <ConversationSourceContext.Provider value={{ conversationKind: "browse", conversationId: browseId, messages }}>
    <div
      ref={frameRef}
      className="rb-chat-frame flex flex-col h-full min-h-0 min-w-0 overflow-hidden"
      data-browser-chat
      style={
        {
          background: "var(--color-paper)",
          borderLeft: "1px solid var(--color-rule)",
          "--rl-discussion-zoom": zoom,
        } as React.CSSProperties
      }
      onKeyDown={(e) => {
        // Esc closes an open tray first; End, outside a field, goes to the
        // newest line and follows from there (BC-38, BC-39).
        if (e.key === "Escape" && tray) {
          e.stopPropagation();
          setTray(null);
        } else if (e.key === "End" && !typingIn(e.target)) {
          e.preventDefault();
          jumpToEnd();
        }
      }}
    >
      {/* One row: what the chat follows, linked mode, ⋯ and ×. No other
          header buttons (BC-36); the model lives in the composer. */}
      <div className="rb-thread-tools" data-browser-chat-header>
        <div className="rb-thread-context rb-chat-title" title={(context.length ? context : [conversation.title]).join(" · ")}>
          {(context.length ? context : [conversation.title]).map((part) => <span key={part}>{part}</span>)}
        </div>
        {onToggleLinkedMode && <button type="button" className="rb-icon-button" aria-label="Linked mode" aria-pressed={linkedMode} onClick={onToggleLinkedMode}
          title={linkedMode
            ? "Linked mode on — new tabs and tab switches stay in the shared chat. Click to give each tab its own chat."
            : "Linked mode off — each tab opens its own chat. Click to share one chat across tabs."}>{linkedMode ? "🔗" : "⛓️‍💥"}</button>}
        <button ref={moreRef} type="button" className="rb-icon-button" aria-label="Conversation actions" aria-haspopup="menu" aria-expanded={conversationPanel === "menu"}
          onClick={() => setConversationPanel((panel) => panel === "menu" ? null : "menu")}><MoreHorizontal size={17} /></button>
        <button type="button" className="rb-icon-button" aria-label="Close discussion" onClick={onClose}><X size={16} /></button>
      </div>
      {conversationPanel === "menu" && <BrowserPopover anchor={moreRef} title="Conversation actions" onClose={() => setConversationPanel(null)}>
        {onToggleTabChat && <BrowserMenuItem onClick={() => { setConversationPanel(null); onToggleTabChat(); }}>
          {conversation.kind === "shared" ? "Open this tab’s own chat" : "Open the shared chat"}
        </BrowserMenuItem>}
        <BrowserMenuItem onClick={() => { setConversationPanel(null); onResearch?.(); }}>Start a research mission</BrowserMenuItem>
        <div className="rb-menu-item" role="group" aria-label="Text size"><span className="rb-menu-label">Text size</span>
          <button type="button" className="rb-button" aria-label="Smaller text" disabled={zoom <= 0.8} onClick={() => adjustZoom(-0.1)}>A−</button>
          <button type="button" className="rb-button" aria-label="Larger text" disabled={zoom >= 1.6} onClick={() => adjustZoom(0.1)}>A+</button>
        </div>
        <BrowserMenuItem onClick={() => { setConversationPanel(null); setInspecting((on) => !on); }}>{inspecting ? "Hide the raw stream" : "Show the raw stream"}</BrowserMenuItem>
        <BrowserMenuItem disabled={!messages.length} onClick={() => { setConversationPanel(null); discard(); }}>Clear history</BrowserMenuItem>
        {/* What the thread has spent, by model: a consult spawns a real child
            `claude`, so by subprocess is the honest unit. Here rather than
            above the composer, where its arrival took height from the
            thread. */}
        <ThreadMeterStrip meters={meters} />
      </BrowserPopover>}
      {inspecting && (
        <Suspense fallback={null}>
          <StreamInspector surface="browse" turnKey={browseId} onClose={() => setInspecting(false)} />
        </Suspense>
      )}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        // The bottom padding keeps the status rail's pills clear of the
        // newest line: the rail overlays the thread rather than shrinking it.
        className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden rl-thin-scroll-y flex flex-col gap-2.5 px-3 pt-3 pb-9"
        data-browser-chat-messages
      >
        {!loaded ? null : messages.length === 0 && status === "idle" ? (
          <EmptyChat onSend={(text) => { jumpToEnd(); send(text); }} onMission={onResearch} />
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
                jumpToEnd();
                send(m.body);
              }}
            />
          ))
        )}
        {streaming && (
          // From the FIRST line of the stream, not the first token: its tail
          // is the turn's one status line, filling the wait. Finished steps
          // are rows under the text, where a new one moves nothing written.
          <ReplyBlock
            phase="live"
            stepsLine={false}
            byline={inFlight?.agent ?? agent}
            seat={harness.pick.model}
            text={liveText}
            meter={meter}
            activity={activity}
            startedAt={startedAt}
            status={liveStatus}
            onOpenLink={onOpenLink}
          >
            <WorkRows rows={workRows(live?.finished ?? [])} />
          </ReplyBlock>
        )}
      </div>

      <StatusRail
        following={following}
        newCount={newCount}
        onJump={jumpToEnd}
        queue={queue.map((row) => ({ id: row.id, text: queuedText(row.body) }))}
        onUnqueue={unqueueToDraft}
        tasks={tasks}
        onOpenTasks={taskList?.onOpen}
        mission={mission}
        tray={tray}
        onTray={setTray}
      />
      <div data-browser-chat-composer data-dictation-anchor data-dictation-send className="rb-composer shrink-0">
        <BrowserChatComposer
          taRef={composerRef}
          frameRef={frameRef}
          draft={draft}
          setDraft={setDraft}
          chips={chips}
          onRemoveChip={(chip) => setChips((prev) => prev.filter((c) => c.body !== chip.body))}
          model={model}
          dictation={dictation}
          picker={<BrowseHarnessChip harness={harness} footer />}
          attach={attach}
          error={attachError}
          onSend={sendDraft}
          onStop={cancel}
        />
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
  /** This row's settled meter — the byline, the steps and the tail it keeps. */
  meter?: TurnMeter | null;
  /** This turn's context restarted (compaction or a fresh CLI session). */
  contextReset?: boolean;
}) {
  if (msg.role === "user") {
    // The context it carried reads back as the chips it was sent with
    // (BC-40); the card shows the rest as the user wrote it.
    const parts = userTurnParts(msg.body);
    return (
      <UserTurn body={parts.text} unsent={msg.status === "unsent"} onResend={onResend} onOpenLink={onOpenLink}
        context={<TurnContext chips={parts.chips} pictures />}
      />
    );
  }
  const actions = replyActions({ role: msg.role, status: msg.status, body: msg.body, missionActive: !!onAddToMission });
  return (
    <ReplyBlock
      phase="settled"
      stepsLine={false}
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
    >
      {/* The steps kept with the row: the same rows it ended the turn with,
          after a relaunch too (BC-34). */}
      <WorkRows rows={workRows(meter?.steps ?? [])} />
    </ReplyBlock>
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
