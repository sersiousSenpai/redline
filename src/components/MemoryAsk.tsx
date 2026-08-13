// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { MemChatMessage } from "../types";
import type { ClassNode } from "../lib/classTree";
import type { TimelineFocus } from "../lib/timeline";
import { extractCitations } from "../lib/memcite";
import { useAgentTurn } from "../hooks/useAgentTurn";
import { usePersistedState } from "../theme/usePersistedState";
import { MarkdownView } from "./MarkdownView";
import { QueuedChip, UnsentNote } from "./QueuedChip";
import { WorkingIndicator } from "./WorkingIndicator";

// The Memory surface's Ask tab (Second Brain P4): ONE persisted conversation
// over the lake + catalog, backed by memchat.rs on the `memchat-*` event
// family. Replies render through the markdown pipeline, and the citations the
// agent actually wrote (`#seq`, `[[Class]]`) become chips that jump the
// Timeline to that evidence via `onCite` — the surface owns the tab switch.

interface MemoryAskProps {
  /** Focus the Timeline on cited evidence (the surface switches tabs). */
  onCite: (focus: TimelineFocus) => void;
}

export function MemoryAsk({ onCite }: MemoryAskProps) {
  // Composer draft survives surface switches and app restarts (the Ask
  // thread is a singleton, so one key).
  const [draft, setDraft] = usePersistedState<string>("rl.chatDraft.memchat", "");
  const [notice, setNotice] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  // The accepted class tree, loaded lazily on the first class-chip click and
  // cached for the session — chip resolution, not a browsing surface.
  const treeRef = useRef<ClassNode[] | null>(null);

  // The turn lifecycle — persisted thread, live stream, mid-turn remount
  // restore (partial text + spinner), self-heal — lives in the shared hook.
  // The Ask thread is a singleton (`threadId` is the constant "memchat").
  const {
    messages,
    liveText,
    status,
    startedAt,
    loaded,
    send: sendTurn,
    cancel,
    unqueue,
    clear: clearLocal,
  } = useAgentTurn<MemChatMessage>({
    surface: "memchat",
    key: "memchat",
    idField: null,
    historyCmd: "memchat_thread",
    sendFailPrefix: "Couldn't reach the memory agent",
    buildSendArgs: (text) => ({ text }),
    makeMessage: ({ id, role, body, status }) => ({
      id,
      threadId: "memchat",
      role,
      body,
      status,
      createdAt: Date.now(),
    }),
  });

  // What the agent is retrieving right now. Retrieval takes most of a turn's
  // wall clock, so without this the user watches a blank ticker through the
  // part of the turn where the most is actually happening. Rides the same
  // event channel as the deltas — no new polling.
  const [retrieving, setRetrieving] = useState<string | null>(null);
  useEffect(() => {
    const un = listen<{ threadId: string; label: string }>("memchat-status", (e) => {
      setRetrieving(e.payload.label);
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);
  // The status belongs to one turn: clear it when the turn ends, and when the
  // answer starts streaming (by then retrieval is done).
  useEffect(() => {
    if (status !== "streaming" || liveText) setRetrieving(null);
  }, [status, liveText]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, liveText]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const send = useCallback(
    (text: string) => {
      stickRef.current = true;
      setNotice(null);
      sendTurn(text);
    },
    [sendTurn],
  );

  const clear = useCallback(() => {
    if (
      !window.confirm(
        "Start a new conversation? The thread here is cleared; everything it captured stays in the lake.",
      )
    )
      return;
    void invoke("memchat_clear")
      .then(() => {
        clearLocal();
        setNotice(null);
      })
      .catch((e) => setNotice(String(e)));
  }, [clearLocal]);

  // A class chip names a title; the Timeline filters by node id. Resolve
  // through the accepted tree (cached), case-insensitively.
  const citeClass = useCallback(
    async (title: string) => {
      try {
        if (!treeRef.current) {
          treeRef.current = await invoke<ClassNode[]>("classmem_tree");
        }
        const want = title.toLowerCase();
        const node = treeRef.current.find(
          (n) => n.status !== "proposed" && n.title.toLowerCase() === want,
        );
        if (node) {
          onCite({ classNodeId: node.id, label: node.title });
        } else {
          setNotice(`“${title}” isn't an accepted class in the catalog.`);
        }
      } catch (e) {
        setNotice(String(e));
      }
    },
    [onCite],
  );

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {/* Toolbar: the reset lives here; asking happens in the composer. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 16px",
          borderBottom: "1px solid var(--color-rule)",
          flexShrink: 0,
        }}
      >
        <span
          className="font-sans"
          style={{ fontSize: 12, color: "var(--color-ink-muted)", flex: 1, minWidth: 0 }}
        >
          Ask your memory — answers cite the record, and each citation chip jumps the
          Timeline to its evidence.
        </span>
        <button
          type="button"
          className="font-sans"
          onClick={clear}
          disabled={!messages.length && status !== "error"}
          title="Clear this thread and start over (the lake keeps everything)"
          style={{
            fontSize: "11px",
            padding: "3px 12px",
            borderRadius: 999,
            cursor: "pointer",
            border: "1px solid var(--color-rule)",
            background: "transparent",
            color: "var(--color-ink)",
            opacity: messages.length || status === "error" ? 1 : 0.5,
          }}
        >
          New conversation
        </button>
      </div>

      {notice && (
        <div
          className="font-sans"
          style={{
            padding: "6px 16px",
            fontSize: 12,
            color: "var(--color-warning)",
            borderBottom: "1px solid var(--color-rule)",
            flexShrink: 0,
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
            padding: "14px 20px 18px",
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {!loaded ? null : messages.length === 0 && status === "idle" ? (
            <AskEmptyState onAsk={send} />
          ) : (
            messages.map((m) => (
              <AskBubble
                key={m.id}
                msg={m}
                onCite={onCite}
                onCiteClass={citeClass}
                onUnqueue={() => {
                  void unqueue(m.id).then((text) => {
                    if (text) setDraft((prev) => (prev.trim() ? `${text}\n\n${prev}` : text));
                  });
                }}
                onResend={() => send(m.body)}
              />
            ))
          )}
          {status === "streaming" &&
            (liveText ? (
              <div className="flex flex-col gap-0.5">
                <RoleTag role="assistant" />
                <div>
                  <MarkdownView body={liveText} compact />
                  <span style={{ color: "var(--color-ink-muted)" }}>▌</span>
                </div>
              </div>
            ) : (
              <WorkingIndicator
                label={retrieving ?? "Thinking"}
                startedAt={startedAt ?? undefined}
              />
            ))}
        </div>
      </div>

      {/* Composer */}
      <div
        style={{
          borderTop: "1px solid var(--color-rule)",
          padding: "10px 20px",
          flexShrink: 0,
        }}
      >
        <div style={{ maxWidth: 780, margin: "0 auto", display: "flex", gap: 8, alignItems: "flex-end" }}>
          <textarea
            className="font-sans"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                // Sending mid-stream queues the question behind the reply.
                send(draft);
                setDraft("");
              }
            }}
            placeholder={
              status === "streaming"
                ? "Type ahead — questions queue behind the reply…"
                : "What did I decide about…"
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
          {status === "streaming" && (
            <button
              type="button"
              className="font-sans"
              onClick={cancel}
              title="Stop the current reply (queued questions still send)"
              style={{
                fontSize: "11px",
                padding: "6px 14px",
                borderRadius: 8,
                cursor: "pointer",
                border: "1px solid var(--color-rule)",
                background: "var(--color-bg-elevated)",
                color: "var(--color-ink)",
              }}
            >
              Stop
            </button>
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
              status === "streaming"
                ? "Queue this question — it sends when the reply finishes"
                : undefined
            }
            style={{
              fontSize: "11px",
              padding: "6px 14px",
              borderRadius: 8,
              cursor: "pointer",
              border: "none",
              background: "var(--color-info)",
              color: "var(--color-on-accent)",
              opacity: draft.trim() ? 1 : 0.5,
            }}
          >
            Ask
          </button>
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
      {isUser ? "You" : "Memory"}
    </span>
  );
}

function AskBubble({
  msg,
  onCite,
  onCiteClass,
  onUnqueue,
  onResend,
}: {
  msg: MemChatMessage;
  onCite: (focus: TimelineFocus) => void;
  onCiteClass: (title: string) => void;
  onUnqueue?: () => void;
  onResend?: () => void;
}) {
  const isUser = msg.role === "user";
  const isError = msg.status === "error";
  const isQueued = isUser && msg.status === "queued";
  const isUnsent = isUser && msg.status === "unsent";
  const cites = !isUser && !isError ? extractCitations(msg.body) : { seqs: [], classes: [] };
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
      {(cites.seqs.length > 0 || cites.classes.length > 0) && (
        <div
          className="font-sans"
          style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4, alignItems: "center" }}
        >
          <span style={{ fontSize: 10, color: "var(--color-ink-muted)" }}>Evidence</span>
          {cites.seqs.map((s) => (
            <CiteChip
              key={`s${s}`}
              label={`#${s}`}
              title={`Jump the Timeline to event #${s}`}
              onClick={() => onCite({ seqs: [s], label: `#${s}` })}
            />
          ))}
          {cites.seqs.length > 1 && (
            <CiteChip
              label="all cited"
              title="Filter the Timeline to every event this reply cites"
              onClick={() =>
                onCite({ seqs: cites.seqs, label: `${cites.seqs.length} cited events` })
              }
            />
          )}
          {cites.classes.map((c) => (
            <CiteChip
              key={`c${c.toLowerCase()}`}
              label={c}
              title={`Filter the Timeline to events filed under “${c}”`}
              onClick={() => onCiteClass(c)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CiteChip({
  label,
  title,
  onClick,
}: {
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="font-sans"
      onClick={onClick}
      title={title}
      style={{
        fontSize: "10px",
        padding: "1px 8px",
        borderRadius: 999,
        cursor: "pointer",
        maxWidth: 180,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        border: "1px solid color-mix(in srgb, var(--color-info) 45%, var(--color-rule))",
        background: "color-mix(in srgb, var(--color-info) 10%, transparent)",
        color: "var(--color-ink)",
      }}
    >
      {label}
    </button>
  );
}

const EXAMPLES = [
  "What did I decide about the loop orchestrator?",
  "What was I researching last week?",
  "Which plans touched the browser pane?",
];

function AskEmptyState({ onAsk }: { onAsk: (q: string) => void }) {
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
        Ask your memory
      </div>
      <div>
        One conversation over everything Redline has captured — your prompts, decisions,
        research trails and notes, organized by the catalog. Answers lead with your own
        notes, report the <em>current</em> decision (superseded ones as history), and cite
        the record; every chip jumps the Timeline to its evidence.
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
        {EXAMPLES.map((q) => (
          <button
            key={q}
            type="button"
            className="font-sans"
            onClick={() => onAsk(q)}
            style={{
              fontSize: "11px",
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
