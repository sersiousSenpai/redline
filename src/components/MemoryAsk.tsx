// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type {
  MemChatCancelledEvent,
  MemChatDeltaEvent,
  MemChatDoneEvent,
  MemChatErrorEvent,
  MemChatMessage,
} from "../types";
import type { ClassNode } from "../lib/classTree";
import type { TimelineFocus } from "../lib/timeline";
import { extractCitations } from "../lib/memcite";
import { MarkdownView } from "./MarkdownView";
import { WorkingIndicator } from "./WorkingIndicator";

// The Memory surface's Ask tab (Second Brain P4): ONE persisted conversation
// over the lake + catalog, backed by memchat.rs on the `memchat-*` event
// family. Replies render through the markdown pipeline, and the citations the
// agent actually wrote (`#seq`, `[[Class]]`) become chips that jump the
// Timeline to that evidence via `onCite` — the surface owns the tab switch.

type ChatStatus = "idle" | "streaming" | "error";

let tmpSeq = 0;
const tmpId = () => `mtmp-${++tmpSeq}`;

interface MemoryAskProps {
  /** Focus the Timeline on cited evidence (the surface switches tabs). */
  onCite: (focus: TimelineFocus) => void;
}

export function MemoryAsk({ onCite }: MemoryAskProps) {
  const [messages, setMessages] = useState<MemChatMessage[]>([]);
  const [liveText, setLiveText] = useState("");
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  // The accepted class tree, loaded lazily on the first class-chip click and
  // cached for the session — chip resolution, not a browsing surface.
  const treeRef = useRef<ClassNode[] | null>(null);

  useEffect(() => {
    let alive = true;
    void invoke<MemChatMessage[]>("memchat_thread")
      .then((rows) => {
        if (!alive) return;
        setMessages(rows);
        setLoaded(true);
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });

    const deltaP = listen<MemChatDeltaEvent>("memchat-delta", (e) => {
      if (!alive) return;
      setStatus("streaming");
      setLiveText((t) => t + e.payload.text);
    });
    const doneP = listen<MemChatDoneEvent>("memchat-done", (e) => {
      if (!alive) return;
      setMessages((m) => [
        ...m,
        {
          id: e.payload.messageId,
          threadId: e.payload.threadId,
          role: "assistant",
          body: e.payload.body,
          status: "complete",
          createdAt: Date.now(),
        },
      ]);
      setLiveText("");
      setStatus("idle");
    });
    const errorP = listen<MemChatErrorEvent>("memchat-error", (e) => {
      if (!alive) return;
      setMessages((m) => [
        ...m,
        {
          id: tmpId(),
          threadId: e.payload.threadId,
          role: "assistant",
          body: e.payload.error,
          status: "error",
          createdAt: Date.now(),
        },
      ]);
      setLiveText("");
      setStatus("error");
    });
    const cancelP = listen<MemChatCancelledEvent>("memchat-cancelled", () => {
      if (!alive) return;
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
  }, []);

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
      const trimmed = text.trim();
      if (!trimmed || status === "streaming") return;
      stickRef.current = true;
      setNotice(null);
      setMessages((m) => [
        ...m,
        {
          id: tmpId(),
          threadId: "memchat",
          role: "user",
          body: trimmed,
          status: "complete",
          createdAt: Date.now(),
        },
      ]);
      setLiveText("");
      setStatus("streaming");
      void invoke("memchat_send", { text: trimmed }).catch((err) => {
        setStatus("error");
        setMessages((m) => [
          ...m,
          {
            id: tmpId(),
            threadId: "memchat",
            role: "assistant",
            body: `Couldn't reach the memory agent: ${err}`,
            status: "error",
            createdAt: Date.now(),
          },
        ]);
      });
    },
    [status],
  );

  const cancel = () => void invoke("memchat_cancel").catch(() => {});

  const clear = useCallback(() => {
    if (
      !window.confirm(
        "Start a new conversation? The thread here is cleared; everything it captured stays in the lake.",
      )
    )
      return;
    void invoke("memchat_clear")
      .then(() => {
        setMessages([]);
        setLiveText("");
        setStatus("idle");
        setNotice(null);
      })
      .catch((e) => setNotice(String(e)));
  }, []);

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
              <AskBubble key={m.id} msg={m} onCite={onCite} onCiteClass={citeClass} />
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
              <WorkingIndicator />
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
                if (status !== "streaming") {
                  send(draft);
                  setDraft("");
                }
              }
            }}
            placeholder="What did I decide about…"
            rows={2}
            disabled={status === "streaming"}
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
          {status === "streaming" ? (
            <button
              type="button"
              className="font-sans"
              onClick={cancel}
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
          ) : (
            <button
              type="button"
              className="font-sans"
              onClick={() => {
                send(draft);
                setDraft("");
              }}
              disabled={!draft.trim()}
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
          )}
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
}: {
  msg: MemChatMessage;
  onCite: (focus: TimelineFocus) => void;
  onCiteClass: (title: string) => void;
}) {
  const isUser = msg.role === "user";
  const isError = msg.status === "error";
  const cites = !isUser && !isError ? extractCitations(msg.body) : { seqs: [], classes: [] };
  return (
    <div className="flex flex-col gap-0.5">
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
