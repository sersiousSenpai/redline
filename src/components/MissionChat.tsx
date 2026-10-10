// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useMemo, useEffect, useRef, useState } from "react";
import { Copy, Pin, Target, X } from "lucide-react";
import type { Mission, MissionFinding, MissionMessage } from "../types";
import { useAgentTurn } from "../hooks/useAgentTurn";
import { useStickToBottom } from "../hooks/useStickToBottom";
import { useSharedDraft } from "../hooks/useSharedDraft";
import { ReplyBlock, UserTurn } from "./ReplyBlock";
import { SendStopButton, sendState } from "./SendStopButton";
import { QueueTray } from "./QueueTray";
import { contextResets, type TurnMeter } from "../lib/turnMeter";

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

/** The orchestrator runs on Claude, and a reply is signed by its provider
 *  (BC-26) — the same name streaming and settled. */
const BYLINE = "Claude";

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
  // Composer draft survives surface switches and app restarts (the component
  // is keyed by missionId, so each mission keeps its own).
  const [draft, setDraft] = useSharedDraft(`rl.chatDraft.mission.${missionId}`);
  const [showFindings, setShowFindings] = useState(true);
  const [editingGoal, setEditingGoal] = useState(false);
  // The synthesize handoff itself lives at App level (`mission-synthesize-done`
  // → Drafter) — the backend owns the pending flag, so it survives this panel
  // unmounting mid-turn. Nothing to track here.

  // The turn lifecycle — persisted thread, live stream, mid-turn remount
  // restore (partial text + spinner), self-heal — lives in the shared hook.
  const { messages, queue, liveText, status, startedAt, loaded, send, cancel, unqueue, meter, activity, meters } =
    useAgentTurn<MissionMessage>({
      surface: "mission",
      key: missionId,
      meterKind: "mission",
      idField: "missionId",
      historyCmd: "get_mission_thread",
      historyArgs: { missionId },
      sendFailPrefix: "Couldn't reach the orchestrator",
      buildSendArgs: (text, extra) => ({
        missionId,
        text,
        cwd: projectDir ?? null,
        // The backend owns the pending-synthesize flag: the completed reply
        // comes back as `mission-synthesize-done` at App level, surviving
        // this panel's unmount.
        synthesize: extra === "synthesize",
      }),
      makeMessage: ({ id, role, body, status }) => ({
        id,
        missionId,
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

  useEffect(() => {
    stick();
  }, [missionId]);


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
        // The bottom padding keeps the queue tray's pill clear of the newest
        // line: the tray overlays the thread rather than shrinking it.
        className="flex-1 min-h-0 overflow-y-auto rl-thin-scroll-y flex flex-col gap-2.5 px-3 pt-3 pb-9"
      >
        {!loaded ? null : messages.length === 0 && status === "idle" ? (
          <div style={{ fontSize: "12px", color: "var(--color-ink-muted)", lineHeight: 1.5 }}>
            I'm watching your tabs for this mission. Ask me to compare what you've
            opened, weigh in on what you've pinned, or spot gaps — then hit{" "}
            <strong>Synthesize</strong> when you're ready to draft.
          </div>
        ) : (
          messages.map((m) => (
            <MessageBubble
              key={m.id}
              msg={m}
              meter={meters[m.id]}
              contextReset={resets.has(m.id)}
              onOpenLink={onOpenLink}
              onSynthesize={onSynthesize}
              onResend={() => {
                stick();
                send(m.body);
              }}
            />
          ))
        )}
        {status === "streaming" && (
          // From the first line of the stream, not the first token: its tail
          // is the turn's one status line, filling the wait.
          <ReplyBlock
            phase="live"
            byline={BYLINE}
            text={liveText}
            meter={meter}
            activity={activity}
            startedAt={startedAt}
            onOpenLink={onOpenLink}
          />
        )}
      </div>

      <QueueTray
        rows={queue.map((row) => ({ id: row.id, text: row.body }))}
        onRemove={(id) => {
          void unqueue(id).then((text) => {
            if (text) setDraft((prev) => (prev.trim() ? `${text}\n\n${prev}` : text));
          });
        }}
      />
      <div className="px-3 py-2 shrink-0" style={{ borderTop: "1px solid var(--color-rule)" }}>
        <button
          type="button"
          onClick={() => {
            stick();
            send(SYNTHESIZE_PROMPT, {
              localBody: "✦ Synthesize the mission",
              extra: "synthesize",
            });
          }}
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
            stick();
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
  onClose,
  tabCount,
}: {
  mission: Mission;
  editing: boolean;
  setEditing: (v: boolean) => void;
  onEditGoal: (title: string, goal: string) => void;
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
      <Target size={14} strokeWidth={2} style={{ marginTop: "1px", flexShrink: 0 }} />
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
        style={{ color: "var(--color-ink-muted)" }}
      >
        <X size={13} strokeWidth={2} />
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
        <span className="inline-flex items-center gap-1">
          <Pin size={11} strokeWidth={2} /> Pinned findings ({findings.length})
        </span>
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
                    style={{ color: "var(--color-ink-muted)", display: "inline-flex" }}
                  >
                    <X size={11} strokeWidth={2} />
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
  onResend,
  meter,
  contextReset,
}: {
  msg: MissionMessage;
  onOpenLink?: (url: string) => void;
  onSynthesize?: (markdown: string) => void;
  onResend?: () => void;
  /** This row's settled meter — the byline, steps line and tail it keeps. */
  meter?: TurnMeter | null;
  /** This turn's context restarted (compaction or a fresh CLI session). */
  contextReset?: boolean;
}) {
  if (msg.role === "user") {
    return <UserTurn body={msg.body} unsent={msg.status === "unsent"} onResend={onResend} onOpenLink={onOpenLink} />;
  }
  const isError = msg.status === "error";
  return (
    <ReplyBlock
      phase="settled"
      byline={BYLINE}
      text={msg.body}
      error={isError}
      meter={meter}
      contextReset={contextReset}
      inspect={{ surface: "mission", key: msg.missionId }}
      onOpenLink={onOpenLink}
      actions={!isError && msg.body.trim() ? <MessageActions body={msg.body} onSynthesize={onSynthesize} /> : undefined}
    />
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
  return (
    <span data-reply-actions className="contents">
      <button type="button" className="rl-reply-action" onClick={copy} title="Copy this reply">
        {copied ? "Copied ✓" : <><Copy size={11} strokeWidth={2} aria-hidden /> Copy</>}
      </button>
      {onSynthesize && (
        <button type="button" className="rl-reply-action" data-tone="info" onClick={() => onSynthesize(body)} title="Open this in the Prompt Drafter to draft from it">
          Open in Drafter ▶
        </button>
      )}
    </span>
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
        placeholder={
          streaming
            ? "Type ahead — sends queue behind the reply…"
            : "Ask the orchestrator about your tabs…"
        }
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
      <SendStopButton state={sendState(streaming, !!draft.trim())} onSend={onSend} onStop={onStop} disabled={!draft.trim()} />
    </div>
  );
}
