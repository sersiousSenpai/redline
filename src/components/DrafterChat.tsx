// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";
import { MarkdownView } from "./MarkdownView";
import {
  useAgentThread,
  type AgentThreadMessage,
} from "../hooks/useAgentThread";

interface DrafterChatProps {
  draftId: string;
  /** The project the prompt will launch into (scopes the agent's Read/Grep). */
  projectPath: string | null;
  /** Serialize the CURRENT draft (sidecars on) — called at send time so the
   *  agent's mirror flush can never trail the debounce. */
  getMarkdown: () => string;
  onClose: () => void;
}

/** The Prompt Drafter's 💬 discussion pane: a per-draft prompt-crafting
 *  collaborator on the `draft-chat-*` event family. Hosted INSIDE the drafter
 *  as an internal split — the secondary-pane exclusivity model is untouched.
 *  The agent can write into the doc via tracked suggestions; its replies here
 *  are the discussion side. */
export function DrafterChat({
  draftId,
  projectPath,
  getMarkdown,
  onClose,
}: DrafterChatProps) {
  const { messages, liveText, status, loaded, send, cancel } = useAgentThread({
    threadKey: draftId,
    keyField: "draftId",
    eventPrefix: "draft-chat",
    loadCommand: "get_draft_chat_thread",
    sendCommand: "draft_chat_send",
    cancelCommand: "draft_chat_cancel",
  });
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    stickRef.current = true;
  }, [draftId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, liveText]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  function sendTurn() {
    const text = draft;
    setDraft("");
    stickRef.current = true;
    send(text, {
      draftMarkdown: getMarkdown(),
      projectPath: projectPath ?? null,
      cwd: projectPath ?? null,
    });
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      style={{
        width: "340px",
        flexShrink: 0,
        background: "var(--color-paper)",
        borderLeft: "1px solid var(--color-rule)",
      }}
      data-drafter-chat="true"
    >
      <div
        className="flex shrink-0 items-start gap-1.5 px-3 py-2"
        style={{ borderBottom: "1px solid var(--color-rule)" }}
      >
        <span style={{ fontSize: "13px", lineHeight: "16px" }}>💬</span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span
            className="truncate"
            style={{
              fontSize: "12px",
              fontWeight: 600,
              color: "var(--color-ink)",
            }}
          >
            Draft discussion
          </span>
          <span
            className="truncate"
            style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}
          >
            {status === "streaming"
              ? "thinking…"
              : "helps craft this prompt — can write into the doc"}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Close"
          className="px-1 leading-none opacity-60 hover:opacity-100"
          style={{ fontSize: "13px", color: "var(--color-ink-muted)" }}
        >
          ✕
        </button>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="rl-thin-scroll-y flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 py-3"
      >
        {!loaded ? null : messages.length === 0 && status === "idle" ? (
          <div
            style={{
              fontSize: "12px",
              color: "var(--color-ink-muted)",
              lineHeight: 1.5,
            }}
          >
            Discuss the prompt you're drafting. Ask me to tighten it, find
            what's missing, or just say "draft me a prompt for…" — I can write
            straight into the document as tracked changes you accept or reject.
          </div>
        ) : (
          messages.map((m) => <Bubble key={m.id} msg={m} />)
        )}
        {status === "streaming" && <StreamingBubble text={liveText} />}
      </div>

      <div
        className="shrink-0 px-3 py-2"
        style={{ borderTop: "1px solid var(--color-rule)" }}
      >
        <Composer
          draft={draft}
          setDraft={setDraft}
          streaming={status === "streaming"}
          onSend={sendTurn}
          onStop={cancel}
        />
      </div>
    </div>
  );
}

function Bubble({ msg }: { msg: AgentThreadMessage }) {
  const isUser = msg.role === "user";
  const isError = msg.status === "error";
  return (
    <div className="group/msg flex flex-col gap-0.5">
      <span
        className="truncate"
        style={{
          fontSize: "9px",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          color: isUser ? "var(--color-ink-muted)" : "var(--color-info)",
        }}
      >
        {isUser ? "You" : "Draft agent"}
      </span>
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
        <MarkdownView body={msg.body} compact rich />
      )}
      {!isUser && !isError && msg.body.trim().length > 0 && (
        <CopyAction body={msg.body} />
      )}
    </div>
  );
}

function CopyAction({ body }: { body: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-0.5 flex items-center gap-1.5 opacity-0 transition-opacity group-hover/msg:opacity-100">
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(body).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          });
        }}
        title="Copy this reply"
        style={{
          fontSize: "10px",
          lineHeight: 1,
          padding: "2px 6px",
          border: "1px solid var(--color-rule)",
          borderRadius: "5px",
          background: "var(--color-paper)",
          color: "var(--color-ink-muted)",
          cursor: "pointer",
        }}
      >
        {copied ? "Copied ✓" : "⧉ Copy"}
      </button>
    </div>
  );
}

function StreamingBubble({ text }: { text: string }) {
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
        Draft agent
      </span>
      {text ? (
        <div>
          <MarkdownView body={text} compact />
          <span style={{ color: "var(--color-ink-muted)" }}>▌</span>
        </div>
      ) : (
        <div
          style={{
            fontSize: "12.5px",
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
            if (!streaming && draft.trim()) onSend();
          }
        }}
        placeholder="Discuss this draft…"
        rows={2}
        disabled={streaming}
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
