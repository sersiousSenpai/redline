// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Check, FileText, Mic, Plus, Rocket, X } from "lucide-react";

import type { Companion, CompanionMessage } from "../types";
import { useAgentTurn } from "../hooks/useAgentTurn";
import { useStickToBottom } from "../hooks/useStickToBottom";
import { useDictation } from "../lib/useDictation";
import { useReadAloud } from "../audio/useReadAloud";
import { composePrompt } from "../lib/launch";
import { toolbarPose, type ToolbarPose } from "../lib/toolbarPose";
import { EFFORT_OPTIONS, MODEL_OPTIONS } from "../lib/seatAssign";
import { usePersistedState } from "../theme/usePersistedState";
import { useMenuOverlay } from "./menuOverlay";
import { MarkdownView } from "./MarkdownView";
import StreamingBubble from "./StreamingBubble";
import TurnFooter from "./TurnFooter";
import { contextResets, type TurnMeter } from "../lib/turnMeter";
import { QueuedChip, UnsentNote } from "./QueuedChip";
import { WorkingIndicator } from "./WorkingIndicator";

// THE CHAT ROOM — Redline's unbound conversation.
//
// Every other agent surface in the app is bound to an object: a plan revision,
// a draft document, a browser tab, a mission goal, a code review, the memory
// catalog. None of them is "just talk", which is why thinking out loud has
// meant leaving Redline for a general chat app — and re-typing, from memory,
// the context Redline already holds.
//
// This is that room, and the reason to hold the conversation here rather than
// elsewhere: it is grounded in the record. The first turn arrives with the
// class catalog baked in and a server-side answer-pack for whatever was asked,
// so "what did I decide about the loop orchestrator" is answered rather than
// researched.
//
// NOT A NEW AGENT. The backend is `companion.rs`, which was always described as
// "one continuous conversation with no fixed goal, one tier above the
// per-surface agents" and lost its face when the Companion drawer merged into
// voice. The names stay `companion` end to end — tables, events, commands, seat,
// skill — so nothing is renamed to give it a room; "Chat" is the UI word only.
//
// Remounted per thread by the parent (`key={companionId}`): the composer draft
// is keyed per chat and `usePersistedState` reads its key once, so switching
// chats is a remount by design rather than a stale draft carried across.

const HANDOFF_PROMPTS: Record<HandoffTarget, string> = {
  drafter:
    "Distill this conversation into a clean, Drafter-ready brief: what we're " +
    "building and why, the decisions we actually reached (not the options we " +
    "discarded), the open questions, and an outline for the work. Write it as " +
    "the document itself — no preamble, no 'here's your brief'. Markdown only, " +
    "no raw HTML.",
  plan:
    "Distill this conversation into a single prompt to hand to a fresh Claude " +
    "Code planning session: what to build, the constraints and decisions we " +
    "reached, and what to leave alone. Write it as the prompt itself — no " +
    "preamble. Markdown only, no raw HTML.",
};

export type HandoffTarget = "plan" | "drafter";

export interface ChatRoomProps {
  /** The chat on screen. The parent remounts on change. */
  companionId: string;
  /** Switch to another chat, or to a freshly created one. */
  onSelectChat: (companionId: string) => void;
  /** Every chat was deleted — the parent decides where to go. */
  onEmpty: () => void;
  /** The sentence the Front Door handed over, sent as message 1.
   *
   *  The room sends it rather than App, and that ordering is the point: App
   *  invoking `companion_send` before the room mounts would race the room's
   *  own history fetch, and a first message that lands a beat before the
   *  fetch appears — then vanishes when the fetch answers with an empty
   *  thread. Sending from here means the optimistic bubble and the persisted
   *  row are the same lifecycle. */
  seed?: string | null;
  /** The seed was sent — clear it, so a remount can't send it twice. */
  onSeedConsumed?: () => void;
  /** Working directory for the spawn (the agent's read-only file tools). */
  cwd: string | null;
  /** False while the Voice panel owns the mic — one capture at a time. */
  dictationEnabled: boolean;
  /** Present only while this room has the whole plate: shrink it back to the
   *  conversation column. Absent in the column, where there is nothing to
   *  shrink. */
  onCollapse?: () => void;
  onClose: () => void;
}

export function ChatRoom({
  companionId,
  onSelectChat,
  onEmpty,
  cwd,
  dictationEnabled,
  onCollapse,
  onClose,
  seed,
  onSeedConsumed,
}: ChatRoomProps) {
  const [draft, setDraft] = usePersistedState<string>(
    `rl.chatDraft.${companionId}`,
    "",
  );
  // Paths, not bytes — the established convention. `composePrompt` folds them
  // into a `Context:` list the agent's Read/Grep can act on.
  const [attachments, setAttachments] = useState<string[]>([]);
  const [chats, setChats] = useState<Companion[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const me = useMemo(
    () => chats.find((c) => c.companionId === companionId) ?? null,
    [chats, companionId],
  );

  const refreshChats = useCallback(() => {
    void invoke<Companion[]>("companion_list")
      .then(setChats)
      .catch(() => setChats([]));
  }, []);
  useEffect(refreshChats, [refreshChats]);

  const {
    messages,
    liveText,
    status,
    startedAt,
    loaded,
    send: sendTurn,
    cancel,
    unqueue,
    meter,
    activity,
    meters,
  } = useAgentTurn<CompanionMessage>({
    // Every name below already matches the hook's convention, so the existing
    // `companion_*` commands and `companion-*` events wire up untouched.
    surface: "companion",
    key: companionId,
    idField: "companionId",
    meterKind: "companion",
    historyCmd: "companion_get_thread",
    historyArgs: { companionId },
    sendFailPrefix: "Couldn't reach the chat agent",
    buildSendArgs: (text, extra) => ({
      companionId,
      text,
      cwd,
      // The backend owns the pending-handoff flag: the completed reply comes
      // back as `companion-handoff-done` at App level, surviving this room's
      // unmount while the distillation runs.
      handoff: (extra as HandoffTarget | undefined) ?? null,
    }),
    makeMessage: ({ id, role, body, status }) => ({
      id,
      companionId,
      role,
      body,
      status,
      surfaceKind: "chat",
      surfaceId: companionId,
      surfaceLabel: null,
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

  // What the agent is retrieving right now. Retrieval takes most of a first
  // turn's wall clock, so without this the ticker sits blank through the part
  // where the most is happening.
  const [retrieving, setRetrieving] = useState<string | null>(null);
  useEffect(() => {
    const un = listen<{ companionId: string; label: string }>(
      "companion-status",
      (e) => {
        if (e.payload.companionId === companionId) setRetrieving(e.payload.label);
      },
    );
    return () => {
      void un.then((f) => f());
    };
  }, [companionId]);
  useEffect(() => {
    if (status !== "streaming" || liveText) setRetrieving(null);
  }, [status, liveText]);

  // The auto-title landing: the provisional first sentence becomes a real name
  // a beat after the first reply, and the dropdown has to show it.
  useEffect(() => {
    const un = listen<{ companionId: string; title: string }>(
      "companion-retitled",
      () => refreshChats(),
    );
    return () => {
      void un.then((f) => f());
    };
  }, [refreshChats]);


  const send = useCallback(
    (text: string, opts?: { localBody?: string; extra?: HandoffTarget }) => {
      const composed = composePrompt(text, attachments);
      if (!composed) return;
      stick();
      setNotice(null);
      sendTurn(composed, {
        localBody: opts?.localBody ?? composed,
        extra: opts?.extra,
      });
      setAttachments([]);
    },
    [attachments, sendTurn],
  );

  // Send the door's sentence, exactly once, and only into a thread that is
  // genuinely empty: `loaded` rules out sending before the history answers,
  // and the emptiness check rules out a second send if this room ever remounts
  // with a stale seed still in the parent's hand.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !seed?.trim() || !loaded || messages.length > 0) return;
    seeded.current = true;
    stick();
    sendTurn(seed);
    onSeedConsumed?.();
  }, [seed, loaded, messages.length, sendTurn, onSeedConsumed]);

  const streaming = status === "streaming";
  // Read replies aloud. Persisted per install, not per chat: it is a property
  // of how the user likes to work, not of one conversation.
  const [speakReplies, setSpeakReplies] = usePersistedState<boolean>(
    "redline.chat.speakReplies",
    false,
  );
  const readAloud = useReadAloud({
    enabled: speakReplies,
    liveText,
    streaming,
    threadKey: companionId,
    onError: (m) => setNotice(`🔇 Voice synthesis failed — ${m}`),
  });
  const dictation = useDictation({
    enabled: dictationEnabled,
    onFinal: (spoken) =>
      setDraft((prev) => (prev.trim() ? `${prev.trim()} ${spoken}` : spoken)),
  });

  const attach = async () => {
    try {
      const picked = await openDialog({ multiple: true });
      const paths = Array.isArray(picked)
        ? picked
        : typeof picked === "string"
          ? [picked]
          : [];
      if (paths.length > 0) {
        setAttachments((prev) => [...new Set([...prev, ...paths])]);
      }
    } catch {
      /* cancelled or dialog unavailable */
    } finally {
      taRef.current?.focus();
    }
  };

  const newChat = useCallback(() => {
    void invoke<Companion>("companion_create", { title: null })
      .then((c) => {
        refreshChats();
        onSelectChat(c.companionId);
      })
      .catch((e) => setNotice(String(e)));
  }, [onSelectChat, refreshChats]);

  const rename = useCallback(
    (id: string, current: string) => {
      const next = window.prompt("Name this chat", current);
      if (next == null || !next.trim()) return;
      void invoke("companion_rename", {
        companionId: id,
        title: next.trim(),
        byUser: true,
      })
        .then(refreshChats)
        .catch((e) => setNotice(String(e)));
    },
    [refreshChats],
  );

  const remove = useCallback(
    (id: string) => {
      if (
        !window.confirm(
          "Delete this chat? The conversation goes; everything it captured stays in the lake.",
        )
      )
        return;
      void invoke("companion_delete", { companionId: id })
        .then(() =>
          invoke<Companion[]>("companion_list").then((rows) => {
            setChats(rows);
            if (id !== companionId) return;
            const next = rows[0];
            if (next) onSelectChat(next.companionId);
            else onEmpty();
          }),
        )
        .catch((e) => setNotice(String(e)));
    },
    [companionId, onEmpty, onSelectChat],
  );

  const setModel = useCallback(
    (model: string | null, effort: string | null) => {
      void invoke("companion_set_model", { companionId, model, effort })
        .then(refreshChats)
        .catch((e) => setNotice(String(e)));
    },
    [companionId, refreshChats],
  );

  const graduate = useCallback(
    (target: HandoffTarget) => {
      send(HANDOFF_PROMPTS[target], {
        localBody: target === "plan" ? "✦ Take this to a plan" : "✦ Take this to a draft",
        extra: target,
      });
    },
    [send],
  );

  const canGraduate = messages.some((m) => m.role === "assistant") && !streaming;

  // The header carries the same actions whether this room has the whole plate
  // or is the ~360px column beside a surface, and labelled they do not fit the
  // second — they used to run off the right edge, taking Close with them.
  // Measured rather than told: the column is user-draggable, so its width is
  // not something the host can predict on this component's behalf.
  const headerRef = useRef<HTMLDivElement>(null);
  const [pose, setPose] = useState<ToolbarPose>("full");
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) =>
      setPose((prev) => toolbarPose(entry.contentRect.width, prev)),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const compact = pose === "compact";

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: "var(--color-paper)" }}>
      {/* Header: which chat, on what model, and the two ways out of it. */}
      <div
        ref={headerRef}
        className="flex shrink-0 items-center gap-2 px-4 py-2"
        style={{ borderBottom: "1px solid var(--color-rule)" }}
      >
        <ChatsMenu
          chats={chats}
          activeId={companionId}
          onSelect={onSelectChat}
          onNew={newChat}
          onRename={rename}
          onDelete={remove}
        />
        <span
          className="font-sans truncate"
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--color-ink)",
            // The title yields room before any action does: it is the one
            // thing in this row that the conversation below also says.
            flex: 1,
            minWidth: 0,
          }}
          title={me?.title}
        >
          {me?.title ?? "Chat"}
        </span>
        <ModelChip
          model={me?.model ?? null}
          effort={me?.effort ?? null}
          onChange={setModel}
        />
        {/* Read aloud. The Companion talks WITHOUT becoming a voice session:
            a `companion:` key would have split this one conversation across
            two thread tables (see useReadAloud's note). Speaking is stopped
            by tapping it again, and by anything that ends the turn. */}
        <ToolbarButton
          label={readAloud.speaking ? "🔊 Stop" : "🔊"}
          title={
            speakReplies
              ? "Stop reading replies aloud"
              : "Read replies aloud as they arrive"
          }
          on={speakReplies}
          onClick={() => {
            if (readAloud.speaking) readAloud.stop();
            else setSpeakReplies((v) => !v);
          }}
        />
        <ToolbarButton
          label={compact ? <Rocket size={13} strokeWidth={2} /> : "→ Plan"}
          title="Distil this conversation into a prompt and launch a plan session from it"
          disabled={!canGraduate}
          onClick={() => graduate("plan")}
        />
        <ToolbarButton
          label={compact ? <FileText size={13} strokeWidth={2} /> : "→ Draft"}
          title="Distil this conversation into a Drafter document"
          disabled={!canGraduate}
          onClick={() => graduate("drafter")}
        />
        {onCollapse && (
          <ToolbarButton
            label="⤡"
            title="Keep this conversation beside you instead of in front of you"
            onClick={onCollapse}
          />
        )}
        <ToolbarButton
          label={compact ? <X size={13} strokeWidth={2} /> : "Close"}
          title="Back to the document"
          onClick={onClose}
        />
      </div>

      {notice && (
        <div
          className="font-sans shrink-0 px-4 py-1.5"
          style={{
            fontSize: 12,
            color: "var(--color-warning)",
            borderBottom: "1px solid var(--color-rule)",
          }}
        >
          {notice}
        </div>
      )}

      {/* Thread */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="rl-thin-scroll-y"
        style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
      >
        <div
          style={{
            maxWidth: 780,
            margin: "0 auto",
            padding: "18px 20px 20px",
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {!loaded ? null : messages.length === 0 && status === "idle" ? (
            <ChatEmptyState onAsk={(q) => send(q)} />
          ) : (
            messages.map((m) => (
              <ChatBubble
                key={m.id}
                msg={m}
                meter={meters[m.id]}
                contextReset={resets.has(m.id)}
                onUnqueue={() => {
                  void unqueue(m.id).then((text) => {
                    if (text)
                      setDraft((prev) => (prev.trim() ? `${text}\n\n${prev}` : text));
                  });
                }}
                onResend={() => send(m.body)}
              />
            ))
          )}
          {streaming && (
            <>
              {/* One shared bubble now. Note the change of behaviour here: the
                  chat room was the ONE surface that streamed with `rich`, so a
                  half-written ```mermaid fence reached MermaidView mid-stream
                  and flashed a "Diagram error" card. The shared bubble streams
                  plain and the settled row below renders rich. */}
              <StreamingBubble
                text={liveText}
                agent="Claude"
                inspect={{ surface: "companion", key: companionId }}
                meter={meter}
                activity={activity}
              />
              {!liveText && (
                <WorkingIndicator
                  label={retrieving ?? "Thinking"}
                  startedAt={startedAt ?? undefined}
                />
              )}
            </>
          )}
        </div>
      </div>

      {/* Composer */}
      <div
        className="shrink-0 px-5 py-2.5"
        style={{ borderTop: "1px solid var(--color-rule)" }}
      >
        <div style={{ maxWidth: 780, margin: "0 auto" }}>
          {attachments.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {attachments.map((p) => (
                <span
                  key={p}
                  className="font-sans inline-flex items-center gap-1 rounded-full px-2 py-0.5"
                  title={p}
                  style={{
                    fontSize: 10.5,
                    border: "1px solid var(--color-rule)",
                    color: "var(--color-ink-muted)",
                  }}
                >
                  {p.slice(p.lastIndexOf("/") + 1) || p}
                  <button
                    type="button"
                    title="Remove"
                    onClick={() => setAttachments((a) => a.filter((x) => x !== p))}
                    style={{ cursor: "pointer", display: "flex" }}
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {dictation.listening && (
            <div
              className="font-sans mb-1"
              style={{ fontSize: 11.5, color: "var(--color-ink-muted)" }}
            >
              {dictation.partial || "Listening…"}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <textarea
              ref={taRef}
              className="font-sans"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send(draft);
                  setDraft("");
                }
              }}
              placeholder={
                streaming
                  ? "Type ahead — this queues behind the reply…"
                  : "Think out loud…"
              }
              rows={2}
              style={{
                flex: 1,
                minWidth: 0,
                resize: "none",
                padding: "7px 10px",
                fontSize: 12.5,
                lineHeight: 1.5,
                color: "var(--color-ink)",
                background: "var(--color-paper)",
                border: "1px solid var(--color-rule)",
                borderRadius: 8,
              }}
            />
            <IconButton
              title="Attach files as context"
              onClick={() => void attach()}
              icon={<Plus size={14} />}
            />
            <IconButton
              title={
                dictationEnabled
                  ? dictation.listening
                    ? "Stop dictating"
                    : "Dictate"
                  : "The voice panel is using the microphone"
              }
              onClick={dictation.toggle}
              disabled={!dictationEnabled}
              hot={dictation.listening}
              icon={<Mic size={14} />}
            />
            {streaming && (
              <ToolbarButton
                label="Stop"
                title="Stop the current reply (queued messages still send)"
                onClick={cancel}
              />
            )}
            <button
              type="button"
              className="font-sans"
              onClick={() => {
                send(draft);
                setDraft("");
              }}
              disabled={!draft.trim()}
              title={
                streaming
                  ? "Queue this — it sends when the reply finishes"
                  : "Send (⏎)"
              }
              style={{
                fontSize: 11,
                padding: "6px 14px",
                borderRadius: 8,
                cursor: "pointer",
                border: "none",
                background: "var(--color-info)",
                color: "var(--color-on-accent)",
                opacity: draft.trim() ? 1 : 0.5,
              }}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RoleTag({ role }: { role: string }) {
  const isUser = role === "user";
  return (
    <span
      className="font-sans"
      style={{
        fontSize: "9px",
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.07em",
        color: isUser ? "var(--color-ink-muted)" : "var(--color-info)",
      }}
    >
      {isUser ? "You" : "Chat"}
    </span>
  );
}

function ChatBubble({
  msg,
  onUnqueue,
  onResend,
  meter,
  contextReset,
}: {
  msg: CompanionMessage;
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
  return (
    <div
      className="flex flex-col gap-0.5"
      style={isQueued || isUnsent ? { opacity: 0.65 } : undefined}
    >
      <RoleTag role={msg.role} />
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
        <MarkdownView body={msg.body} compact rich={!isUser} />
      )}
      {isQueued && <QueuedChip onUnqueue={onUnqueue} />}
      {isUnsent && <UnsentNote onResend={onResend} />}
      {!isUser && <TurnFooter meter={meter} contextReset={contextReset} />}
    </div>
  );
}

function ToolbarButton({
  label,
  title,
  onClick,
  disabled,
  on,
}: {
  label: ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  /** A toggle that is currently ON — tinted rather than merely pressed, the
   *  same signal the browser chrome's pills use. */
  on?: boolean;
}) {
  return (
    <button
      type="button"
      className="font-sans"
      onClick={onClick}
      disabled={disabled}
      title={title}
      // The compact pose is an icon and nothing else, so the accessible name
      // has to come from here rather than from the button's content.
      aria-label={title}
      style={{
        fontSize: 11,
        padding: "3px 10px",
        borderRadius: 999,
        cursor: disabled ? "default" : "pointer",
        border: "1px solid var(--color-rule)",
        background: "transparent",
        color: "var(--color-ink)",
        opacity: disabled ? 0.45 : 1,
        whiteSpace: "nowrap",
        ...(on
          ? {
              color: "var(--color-info)",
              borderColor: "var(--color-info)",
            }
          : null),
      }}
      aria-pressed={on}
    >
      {label}
    </button>
  );
}

function IconButton({
  title,
  onClick,
  icon,
  disabled,
  hot,
}: {
  title: string;
  onClick: () => void;
  icon: React.ReactNode;
  disabled?: boolean;
  hot?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 30,
        height: 30,
        borderRadius: 8,
        cursor: disabled ? "default" : "pointer",
        border: "1px solid var(--color-rule)",
        background: hot ? "var(--color-info)" : "transparent",
        color: hot ? "var(--color-on-accent)" : "var(--color-ink-muted)",
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {icon}
    </button>
  );
}

/** `⌄ Chats` — the way between conversations, and the only place a chat is
 *  renamed or deleted. A dropdown rather than a sidebar: chats are a list you
 *  visit, not a workspace you keep on screen. */
function ChatsMenu({
  chats,
  activeId,
  onSelect,
  onNew,
  onRename,
  onDelete,
}: {
  chats: Companion[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, current: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useMenuOverlay(open);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div ref={rootRef} data-no-drag="true" style={{ position: "relative" }}>
      <button
        type="button"
        className="font-sans"
        onClick={() => setOpen((o) => !o)}
        title="Your chats"
        style={{
          fontSize: 11,
          padding: "3px 10px",
          borderRadius: 999,
          cursor: "pointer",
          border: "1px solid var(--color-rule)",
          background: "transparent",
          color: "var(--color-ink)",
          whiteSpace: "nowrap",
        }}
      >
        Chats <span style={{ opacity: 0.6 }}>▾</span>
      </button>
      {open && (
        <div
          className="font-sans"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            zIndex: 60,
            minWidth: 260,
            maxHeight: 340,
            overflowY: "auto",
            padding: 4,
            borderRadius: 10,
            border: "1px solid var(--color-rule)",
            background: "var(--color-bg-elevated)",
            boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
          }}
        >
          <button
            type="button"
            className="font-sans"
            onClick={() => {
              setOpen(false);
              onNew();
            }}
            style={rowStyle(false)}
          >
            <span>＋ New chat</span>
          </button>
          {chats.map((c) => (
            <div key={c.companionId} style={{ display: "flex", alignItems: "center" }}>
              <button
                type="button"
                className="font-sans truncate"
                onClick={() => {
                  setOpen(false);
                  if (c.companionId !== activeId) onSelect(c.companionId);
                }}
                title={c.title}
                style={{ ...rowStyle(c.companionId === activeId), flex: 1, minWidth: 0 }}
              >
                <Check
                  size={11}
                  style={{
                    opacity: c.companionId === activeId ? 1 : 0,
                    flexShrink: 0,
                  }}
                />
                <span className="truncate">{c.title}</span>
              </button>
              <button
                type="button"
                title="Rename"
                onClick={() => onRename(c.companionId, c.title)}
                style={miniStyle}
              >
                ✎
              </button>
              <button
                type="button"
                title="Delete"
                onClick={() => onDelete(c.companionId)}
                style={miniStyle}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const rowStyle = (on: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  padding: "5px 8px",
  borderRadius: 6,
  cursor: "pointer",
  border: "none",
  textAlign: "left",
  fontSize: 12,
  background: on ? "color-mix(in srgb, var(--color-info) 12%, transparent)" : "transparent",
  color: "var(--color-ink)",
});

const miniStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  borderRadius: 6,
  cursor: "pointer",
  border: "none",
  background: "transparent",
  color: "var(--color-ink-muted)",
  fontSize: 11,
  flexShrink: 0,
};

/** `[model · effort ▾]` — this conversation's seat, not the app's.
 *
 *  A brainstorm and a quick lookup are not the same workload, and the
 *  `companion` seat is one setting for both. "Seat default" clears the override
 *  rather than pinning today's seat value, so moving the seat still moves every
 *  chat that never asked for something else. Options come from `seatAssign.ts`
 *  — the same list the Agent Seats chart offers, never a second copy. */
function ModelChip({
  model,
  effort,
  onChange,
}: {
  model: string | null;
  effort: string | null;
  onChange: (model: string | null, effort: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useMenuOverlay(open);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const label = model ? (effort ? `${model} · ${effort}` : model) : "seat default";
  return (
    <div ref={rootRef} data-no-drag="true" style={{ position: "relative" }}>
      <button
        type="button"
        className="font-sans"
        onClick={() => setOpen((o) => !o)}
        title="The model this conversation runs on"
        style={{
          fontSize: 10.5,
          padding: "3px 9px",
          borderRadius: 999,
          cursor: "pointer",
          border: "1px solid var(--color-rule)",
          background: "transparent",
          color: "var(--color-ink-muted)",
          whiteSpace: "nowrap",
        }}
      >
        {label} <span style={{ opacity: 0.6 }}>▾</span>
      </button>
      {open && (
        <div
          className="font-sans"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            zIndex: 60,
            minWidth: 180,
            padding: 4,
            borderRadius: 10,
            border: "1px solid var(--color-rule)",
            background: "var(--color-bg-elevated)",
            boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
          }}
        >
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onChange(null, null);
            }}
            style={rowStyle(!model)}
          >
            <Check size={11} style={{ opacity: model ? 0 : 1 }} />
            Seat default
          </button>
          <Divider />
          {MODEL_OPTIONS.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onChange(m, effort)}
              style={rowStyle(m === model)}
            >
              <Check size={11} style={{ opacity: m === model ? 1 : 0 }} />
              {m}
            </button>
          ))}
          <Divider />
          {EFFORT_OPTIONS.map((e) => (
            <button
              key={e}
              type="button"
              disabled={!model}
              onClick={() => onChange(model, e)}
              title={model ? undefined : "Pick a model first"}
              style={{ ...rowStyle(e === effort), opacity: model ? 1 : 0.45 }}
            >
              <Check size={11} style={{ opacity: e === effort ? 1 : 0 }} />
              effort: {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Divider() {
  return (
    <div
      style={{ height: 1, margin: "4px 6px", background: "var(--color-rule)" }}
      aria-hidden
    />
  );
}

const EXAMPLES = [
  "What did I decide about the loop orchestrator?",
  "I've been thinking about how anchoring should work…",
  "Talk me through whether this is worth building.",
];

function ChatEmptyState({ onAsk }: { onAsk: (q: string) => void }) {
  return (
    <div
      className="font-sans"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: "28px 0 8px",
        color: "var(--color-ink-muted)",
        fontSize: 12.5,
        lineHeight: 1.6,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--color-ink)" }}>
        Think out loud
      </div>
      <div>
        A conversation with no fixed goal — for the half-formed idea that isn&rsquo;t a
        plan yet. It knows your record: the prompts you&rsquo;ve sent, the decisions
        you&rsquo;ve made, what you were researching, every plan session. When it turns
        into something, <strong>→ Plan</strong> or <strong>→ Draft</strong> carries it
        onward, and the plan session it opens stays a child of this conversation.
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
        {EXAMPLES.map((q) => (
          <button
            key={q}
            type="button"
            className="font-sans"
            onClick={() => onAsk(q)}
            style={{
              fontSize: 11,
              padding: "3px 10px",
              borderRadius: 999,
              cursor: "pointer",
              border: "1px solid var(--color-rule)",
              background: "var(--color-paper)",
              color: "var(--color-ink)",
            }}
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
