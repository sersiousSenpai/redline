// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  Mission,
  MissionCancelledEvent,
  MissionDeltaEvent,
  MissionDoneEvent,
  MissionErrorEvent,
  MissionFinding,
  MissionMessage,
} from "../types";
import { MarkdownView } from "./MarkdownView";

interface MissionChatProps {
  mission: Mission;
  findings: MissionFinding[];
  /** Working dir for the orchestrator (scopes Read/Grep/Glob); `$HOME` if null. */
  projectDir?: string | null;
  onClose: () => void;
  onOpenLink?: (url: string) => void;
  onRemoveFinding: (findingId: string) => void;
  /** Jump the user into the tab a pin came from (by its discussion browseId). */
  onJumpToFinding?: (browseId: string) => void;
  onEditGoal: (title: string, goal: string) => void;
  /** Hand a synthesized brief (markdown) to the Prompt Drafter. */
  onSynthesize?: (markdown: string) => void;
}

type ChatStatus = "idle" | "streaming" | "error";

let tmpSeq = 0;
const tmpId = () => `mtmp-${++tmpSeq}`;

const SYNTHESIZE_PROMPT =
  "Produce the mission synthesis brief now: a clean, Drafter-ready document " +
  "toward the goal, weaving in every pin and what you've gathered across the " +
  "open tabs — recommended structure, what to emulate, what to avoid, and an " +
  "outline for the deliverable. Markdown only, no raw HTML.";

/** The mission orchestrator panel: a goal header, the pinned-findings board, the
 *  orchestrator chat (a tier above the per-tab page discussions), and a
 *  Synthesize action that seeds the Prompt Drafter. Keyed by `mission.missionId`
 *  by the parent. Sibling of `BrowserChat`, on the `mission-*` event family. */
export function MissionChat({
  mission,
  findings,
  projectDir,
  onClose,
  onOpenLink,
  onRemoveFinding,
  onJumpToFinding,
  onEditGoal,
  onSynthesize,
}: MissionChatProps) {
  const missionId = mission.missionId;
  const [messages, setMessages] = useState<MissionMessage[]>([]);
  const [liveText, setLiveText] = useState("");
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [showFindings, setShowFindings] = useState(true);
  const [editingGoal, setEditingGoal] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  // When set, the next completed reply is the synthesis → hand it to the Drafter.
  const pendingSynthesizeRef = useRef(false);
  // Held in a ref so the event-subscription effect can key on `missionId` alone
  // (onSynthesize is a fresh closure each parent render; subscribing on it would
  // tear down + re-add the listeners mid-stream and drop delta events).
  const onSynthesizeRef = useRef(onSynthesize);
  onSynthesizeRef.current = onSynthesize;

  // Load persisted turns + subscribe to this mission's orchestrator events.
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setMessages([]);
    setLiveText("");
    setStatus("idle");
    pendingSynthesizeRef.current = false;

    void invoke<MissionMessage[]>("get_mission_thread", { missionId })
      .then((rows) => {
        if (!alive) return;
        setMessages(rows);
        setLoaded(true);
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });

    const mine = (p: { missionId: string }) => p.missionId === missionId;

    const deltaP = listen<MissionDeltaEvent>("mission-delta", (e) => {
      if (!alive || !mine(e.payload)) return;
      setStatus("streaming");
      setLiveText((t) => t + e.payload.text);
    });
    const doneP = listen<MissionDoneEvent>("mission-done", (e) => {
      if (!alive || !mine(e.payload)) return;
      setMessages((m) => [
        ...m,
        {
          id: e.payload.messageId,
          missionId,
          role: "assistant",
          body: e.payload.body,
          status: "complete",
          createdAt: Date.now(),
        },
      ]);
      setLiveText("");
      setStatus("idle");
      if (pendingSynthesizeRef.current) {
        pendingSynthesizeRef.current = false;
        onSynthesizeRef.current?.(e.payload.body);
      }
    });
    const errorP = listen<MissionErrorEvent>("mission-error", (e) => {
      if (!alive || !mine(e.payload)) return;
      pendingSynthesizeRef.current = false;
      setMessages((m) => [
        ...m,
        {
          id: tmpId(),
          missionId,
          role: "assistant",
          body: e.payload.error,
          status: "error",
          createdAt: Date.now(),
        },
      ]);
      setLiveText("");
      setStatus("error");
    });
    const cancelP = listen<MissionCancelledEvent>("mission-cancelled", (e) => {
      if (!alive || !mine(e.payload)) return;
      pendingSynthesizeRef.current = false;
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
  }, [missionId]);

  useEffect(() => {
    stickRef.current = true;
  }, [missionId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, liveText]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  function send(text: string, synthesize = false) {
    const trimmed = text.trim();
    if (!trimmed || status === "streaming") return;
    stickRef.current = true;
    pendingSynthesizeRef.current = synthesize;
    setMessages((m) => [
      ...m,
      {
        id: tmpId(),
        missionId,
        role: "user",
        body: synthesize ? "✦ Synthesize the mission" : trimmed,
        status: "complete",
        createdAt: Date.now(),
      },
    ]);
    setLiveText("");
    setStatus("streaming");
    void invoke("mission_send", {
      missionId,
      text: trimmed,
      cwd: projectDir ?? null,
    }).catch((err) => {
      pendingSynthesizeRef.current = false;
      setStatus("error");
      setMessages((m) => [
        ...m,
        {
          id: tmpId(),
          missionId,
          role: "assistant",
          body: `Couldn't reach the orchestrator: ${err}`,
          status: "error",
          createdAt: Date.now(),
        },
      ]);
    });
  }

  function cancel() {
    void invoke("mission_cancel", { missionId }).catch(() => {});
  }

  return (
    <div
      className="flex flex-col h-full min-h-0"
      style={{ background: "var(--color-paper)", borderLeft: "1px solid var(--color-rule)" }}
    >
      <GoalHeader
        mission={mission}
        editing={editingGoal}
        setEditing={setEditingGoal}
        onEditGoal={onEditGoal}
        streaming={status === "streaming"}
        onClose={onClose}
        tabCount={findings.length}
      />

      <FindingsBoard
        findings={findings}
        show={showFindings}
        setShow={setShowFindings}
        onRemove={onRemoveFinding}
        onJump={onJumpToFinding}
      />

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-y-auto rl-thin-scroll-y flex flex-col gap-2.5 px-3 py-3"
      >
        {!loaded ? null : messages.length === 0 && status === "idle" ? (
          <div style={{ fontSize: "12px", color: "var(--color-ink-muted)", lineHeight: 1.5 }}>
            I'm watching your tabs for this mission. Ask me to compare what you've
            opened, weigh in on what you've pinned, or spot gaps — then hit{" "}
            <strong>Synthesize</strong> when you're ready to draft.
          </div>
        ) : (
          messages.map((m) => (
            <MessageBubble key={m.id} msg={m} onOpenLink={onOpenLink} onSynthesize={onSynthesize} />
          ))
        )}
        {status === "streaming" && <StreamingBubble text={liveText} onOpenLink={onOpenLink} />}
      </div>

      <div className="px-3 py-2 shrink-0" style={{ borderTop: "1px solid var(--color-rule)" }}>
        <button
          type="button"
          onClick={() => send(SYNTHESIZE_PROMPT, true)}
          disabled={status === "streaming"}
          className="w-full rounded px-2 py-1.5 font-medium mb-2"
          style={{
            fontSize: "12px",
            background: "var(--color-info)",
            color: "var(--color-on-accent)",
            opacity: status === "streaming" ? 0.5 : 1,
            cursor: status === "streaming" ? "default" : "pointer",
          }}
          title="Compose a brief from everything in this mission and open it in the Prompt Drafter"
        >
          ✦ Synthesize → Drafter
        </button>
        <Composer
          draft={draft}
          setDraft={setDraft}
          streaming={status === "streaming"}
          onSend={() => {
            send(draft);
            setDraft("");
          }}
          onStop={cancel}
        />
      </div>
    </div>
  );
}

function GoalHeader({
  mission,
  editing,
  setEditing,
  onEditGoal,
  streaming,
  onClose,
  tabCount,
}: {
  mission: Mission;
  editing: boolean;
  setEditing: (v: boolean) => void;
  onEditGoal: (title: string, goal: string) => void;
  streaming: boolean;
  onClose: () => void;
  tabCount: number;
}) {
  const [title, setTitle] = useState(mission.title);
  const [goal, setGoal] = useState(mission.goal);
  // Re-seed the editor fields when the mission changes underneath us.
  useEffect(() => {
    setTitle(mission.title);
    setGoal(mission.goal);
  }, [mission.missionId, mission.title, mission.goal]);

  if (editing) {
    return (
      <div
        className="flex flex-col gap-1.5 px-3 py-2 shrink-0"
        style={{ borderBottom: "1px solid var(--color-rule)" }}
      >
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Mission title"
          className="rounded px-2 py-1"
          style={{
            fontSize: "12px",
            border: "1px solid var(--color-rule)",
            background: "var(--color-paper)",
            color: "var(--color-ink)",
          }}
        />
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={3}
          className="rounded px-2 py-1"
          style={{
            fontSize: "12px",
            border: "1px solid var(--color-rule)",
            background: "var(--color-paper)",
            color: "var(--color-ink)",
            resize: "vertical",
            fontFamily: "inherit",
          }}
        />
        <div className="flex items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="px-2 py-0.5"
            style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              if (goal.trim()) {
                onEditGoal(title, goal);
                setEditing(false);
              }
            }}
            className="rounded px-2 py-0.5 font-medium"
            style={{ fontSize: "11px", background: "var(--color-info)", color: "var(--color-on-accent)" }}
          >
            Save
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex items-start gap-1.5 px-3 py-2 shrink-0"
      style={{ borderBottom: "1px solid var(--color-rule)" }}
    >
      <span style={{ fontSize: "13px", lineHeight: "16px" }}>🎯</span>
      <div className="flex flex-col min-w-0 flex-1">
        <span
          style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-ink)" }}
          className="truncate"
          title={mission.goal}
        >
          {mission.title}
        </span>
        <span style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}>
          {tabCount} pin{tabCount === 1 ? "" : "s"}
          {streaming ? " · thinking…" : ""}
        </span>
      </div>
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Edit the mission goal"
        className="px-1 leading-none opacity-60 hover:opacity-100"
        style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}
      >
        ✎
      </button>
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
  );
}

function FindingsBoard({
  findings,
  show,
  setShow,
  onRemove,
  onJump,
}: {
  findings: MissionFinding[];
  show: boolean;
  setShow: (v: boolean) => void;
  onRemove: (id: string) => void;
  onJump?: (browseId: string) => void;
}) {
  if (findings.length === 0) return null;
  return (
    <div className="shrink-0" style={{ borderBottom: "1px solid var(--color-rule)" }}>
      <button
        type="button"
        onClick={() => setShow(!show)}
        className="w-full flex items-center gap-1.5 px-3 py-1.5"
        style={{ fontSize: "10px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--color-ink-muted)" }}
      >
        <span>{show ? "▾" : "▸"}</span>
        <span>📌 Pinned findings ({findings.length})</span>
      </button>
      {show && (
        <div
          className="flex flex-col gap-1.5 px-3 pb-2 overflow-y-auto rl-thin-scroll-y"
          style={{ maxHeight: "30vh" }}
        >
          {findings.map((f) => (
            <div
              key={f.id}
              className="rounded px-2 py-1.5 group/pin"
              style={{ border: "1px solid var(--color-rule)", background: "var(--color-bg-elevated)" }}
            >
              <div className="flex items-center gap-1.5">
                {f.note && (
                  <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--color-ink)" }} className="truncate">
                    {f.note}
                  </span>
                )}
                <div className="flex items-center gap-1 ml-auto opacity-0 group-hover/pin:opacity-100 transition-opacity">
                  {f.browseId && onJump && (
                    <button
                      type="button"
                      onClick={() => onJump(f.browseId!)}
                      title="Go to the tab this came from"
                      style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}
                    >
                      →
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onRemove(f.id)}
                    title="Remove this pin"
                    style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}
                  >
                    ✕
                  </button>
                </div>
              </div>
              {f.sourceTitle && (
                <div style={{ fontSize: "9.5px", color: "var(--color-ink-muted)" }} className="truncate" title={f.sourceUrl ?? undefined}>
                  {f.sourceTitle}
                </div>
              )}
              <div
                style={{ fontSize: "11px", color: "var(--color-ink-muted)", lineHeight: 1.4, maxHeight: "3.6em", overflow: "hidden" }}
              >
                {f.body}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MessageBubble({
  msg,
  onOpenLink,
  onSynthesize,
}: {
  msg: MissionMessage;
  onOpenLink?: (url: string) => void;
  onSynthesize?: (markdown: string) => void;
}) {
  const isUser = msg.role === "user";
  const isError = msg.status === "error";
  const showActions = !isUser && !isError && msg.body.trim().length > 0;
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
        {isUser ? "You" : "Orchestrator"}
      </span>
      {isError ? (
        <div style={{ fontSize: "12.5px", lineHeight: 1.5, whiteSpace: "pre-wrap", color: "var(--color-warning)" }}>
          {msg.body}
        </div>
      ) : (
        <MarkdownView body={msg.body} compact rich onLinkClick={onOpenLink} />
      )}
      {showActions && <MessageActions body={msg.body} onSynthesize={onSynthesize} />}
    </div>
  );
}

function MessageActions({
  body,
  onSynthesize,
}: {
  body: string;
  onSynthesize?: (markdown: string) => void;
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
        {copied ? "Copied ✓" : "⧉ Copy"}
      </button>
      {onSynthesize && (
        <button
          type="button"
          onClick={() => onSynthesize(body)}
          title="Open this in the Prompt Drafter to draft from it"
          style={{ ...actionStyle, color: "var(--color-info)" }}
        >
          Open in Drafter ▶
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
        Orchestrator
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
            if (!streaming) onSend();
          }
        }}
        placeholder="Ask the orchestrator about your tabs…"
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
          style={{ background: "var(--color-bg-elevated)", border: "1px solid var(--color-rule)", color: "var(--color-ink)", fontSize: "11px" }}
        >
          Stop
        </button>
      ) : (
        <button
          type="button"
          onClick={onSend}
          disabled={!draft.trim()}
          className="rounded px-2 py-1 font-medium"
          style={{ background: "var(--color-info)", color: "var(--color-on-accent)", fontSize: "11px", opacity: draft.trim() ? 1 : 0.5 }}
        >
          Send
        </button>
      )}
    </div>
  );
}
