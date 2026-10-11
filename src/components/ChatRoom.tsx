// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { ConversationSourceContext } from "./ContinueAs";
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Check, Mic, Plus, X } from "lucide-react";

import type { Companion, CompanionMessage } from "../types";
import { useAgentTurn } from "../hooks/useAgentTurn";
import { useStickToBottom } from "../hooks/useStickToBottom";
import { usePoll } from "../hooks/usePoll";
import { useDictation } from "../lib/useDictation";
import { useReadAloud } from "../audio/useReadAloud";
import { composePrompt, resolveLaunchProject, type ProjectChoice } from "../lib/launch";
import { CONTINUE_EVENT, handoffGate, prepareConversationPreview, type ContinueDestination, type ContinuationMessage } from "../lib/conversationContinuation";
import { ProjectPicker, type ProjectOption } from "./ProjectPicker";
import { toolbarPose, type ToolbarPose } from "../lib/toolbarPose";
import { EFFORT_OPTIONS, MODEL_OPTIONS } from "../lib/seatAssign";
import { usePersistedState } from "../theme/usePersistedState";
import { readSharedDraft, useSharedDraft, writeSharedDraft } from "../hooks/useSharedDraft";
import { BrowserDialog } from "./BrowserSurfaces";
import { ComposerMenu } from "./ComposerMenu";
import { MonochatTrace } from "./MonochatTrace";
import { useMenuOverlay } from "./menuOverlay";
import { ReplyBlock, UserTurn } from "./ReplyBlock";
import { SendStopButton, sendState } from "./SendStopButton";
import { contextResets, type TurnMeter } from "../lib/turnMeter";
import { modelInfo } from "../lib/modelInfo";
import type { ChatProgressStatus } from "../lib/chatProgress";
import { ChatContextChip } from "./ChatContextChip";
import { ideaNote, planFromReplyInstruction, type ChatContext } from "../lib/chatRoom";
import { ChatModePicker, nextChatMode, type ChatMode, type BuildAssignee } from "./ChatModePicker";
import { QueueTray, type QueueItem } from "./QueueTray";
import { ChangesCard, type ChatChanges } from "./ChangesCard";
import { backendLabel, defaultChoice, type BackendChoice, type ModelCatalogs } from "../lib/backendChoice";
import { standaloneNote } from "../lib/notes";

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
// Remounted per thread by the parent (`key={companionId}`): the per-chat
// settings below are `usePersistedState`, which reads its key once, so
// switching chats is a remount by design rather than a stale mode carried
// across.

export interface ChatPlanReceipt { kind?: "plan" | "run"; status: "starting" | "planning" | "error" | "done"; instruction: string; terminalId?: string; launchId?: string; sessionId?: string; title?: string; error?: string; blocked?: import("../lib/readiness").ReadinessItem }
export interface ChatPlanRequest { harness?: BackendChoice; companionId: string; messages: ContinuationMessage[]; instruction: string; project: ProjectChoice; title: string }

export interface ChatWorkbenchComposer {
  picker: ReactNode; mode: ChatMode; cycleMode: () => void; onSubmit: (steer?: boolean) => void;
  project: ProjectChoice; onProjectChange: (project: ProjectChoice) => void;
  /** A reply is running: the composer's primary button is Stop while the box
   *  is empty and Queue once it isn't (design decision 5). */
  streaming: boolean; onStop: () => void;
}

export interface ChatRoomProps {
  /** The card's composer, which owns input when supplied. Its sentence is the
   *  shared draft under `draftKey`, so the room reads it there rather than
   *  being handed a copy that would re-render its owner on every keystroke. */
  composer?: { draftKey: string; attachments?: string[]; onAttachmentsConsumed?: () => void; project?: ProjectChoice; render: (actions: ReactNode, workbench: ChatWorkbenchComposer) => ReactNode };
  harness?: BackendChoice;
  modelCatalogs?: ModelCatalogs;
  onHarnessChange?: (harness: BackendChoice) => void;
  onNeedModels?: () => void;
  onRun?: (request: ChatPlanRequest) => void;
  onReviewChanges?: (projectPath: string) => void;
  target?: import("../lib/activeSurface").SurfaceInfo;
  modelControls?: React.ReactNode;
  onActivityChange?: (busy: boolean) => void;
  onSent?: () => void;
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
  seedId?: string;
  seedAutoSend?: boolean;
  seedTarget?: import("../lib/activeSurface").SurfaceInfo;
  /** What the card attached to the seed, read when the sentence left it. */
  seedContext?: string | null;
  /** The seed was sent — clear it, so a remount can't send it twice. */
  onSeedConsumed?: () => void;
  /** What the card's pressed chips attach to this send, read as it goes out.
   *  It reaches `companion_send` as `context` (and `contextAll`), out of band:
   *  the agent's prompt carries it and the bubble shows only what was typed.
   *  Null attaches nothing. */
  contextFor?: () => Promise<import("../lib/surfaceContext").ChatAttachment | null>;
  /** An attachment may never have reached the agent: its send failed or was
   *  pulled back (`unsent`), or the conversation started a fresh CLI session
   *  (`fresh-session`). The owner decides what the next send carries again. */
  onContextLost?: (why: import("../lib/surfaceContext").ContextLoss) => void;
  /** Working directory for the spawn (the agent's read-only file tools). */
  cwd: string | null;
  /** False while the Voice panel owns the mic — one capture at a time. */
  dictationEnabled: boolean;
  projectOptions?: ProjectOption[];
  lastLaunchProject?: string | null;
  onPlan?: (request: ChatPlanRequest) => void;
  onQueuePlan?: (request: ChatPlanRequest) => void;
  queuedInstruction?: string | null;
  onCancelQueuedPlan?: () => void;
  receipt?: ChatPlanReceipt | null;
  onShowTerminal?: (id: string) => void;
  onOpenPlan?: (id: string) => void;
  onFix?: (item: import("../lib/readiness").ReadinessItem) => Promise<boolean>;
  /** The room has the whole plate (the island is open), so it reads at plate
   *  scale. The ~360px pose keeps the compact rhythm whatever this says. */
  expanded?: boolean;
  /** "→ Draft" on a reply: open the Drafter seeded with it. */
  onDraft?: (markdown: string) => void;
  onClose: () => void;
}

const NO_PROJECTS: ProjectOption[] = [];

export function ChatRoom({
  composer,
  harness,
  modelCatalogs, onHarnessChange, onNeedModels, onRun, onReviewChanges,
  target,
  modelControls,
  onActivityChange,
  onSent,
  companionId,
  onSelectChat,
  onEmpty,
  cwd,
  dictationEnabled,
  projectOptions = NO_PROJECTS,
  lastLaunchProject = null,
  onPlan, receipt, onShowTerminal, onOpenPlan, onFix, onQueuePlan, queuedInstruction, onCancelQueuedPlan,
  expanded = false,
  onDraft,
  onClose,
  seed,
  seedId,
  seedAutoSend = true,
  seedTarget,
  seedContext = null,
  onSeedConsumed,
  contextFor,
  onContextLost,
}: ChatRoomProps) {
  const [draft, setDraft] = useSharedDraft(composer?.draftKey ?? `rl.chatDraft.${companionId}`);
  // Carry a draft from the former separate chat input into the one composer.
  // Clear the old key only after handing its text to the persistent owner.
  useEffect(() => {
    if (!composer) return;
    const legacy = `rl.chatDraft.${companionId}`;
    const savedDraft = readSharedDraft(legacy);
    if (!savedDraft.trim()) return;
    setDraft(previous => previous.includes(savedDraft) ? previous : previous.trim() ? `${previous}\n\n${savedDraft}` : savedDraft);
    writeSharedDraft(legacy, "");
  }, [!!composer, companionId, setDraft]);
  // Paths, not bytes — the established convention. `composePrompt` folds them
  // into a `Context:` list the agent's Read/Grep can act on.
  const [attachments, setAttachments] = useState<string[]>([]);
  const [chats, setChats] = useState<Companion[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = usePersistedState<ChatMode>(`rl.chatMode.${companionId}`, "chat");
  const [assignee, setAssignee] = usePersistedState<BuildAssignee>(`rl.chatAssignee.${companionId}`, "chat");
  const [localHarness, setLocalHarness] = usePersistedState<BackendChoice>(`rl.chatHarness.${companionId}`, defaultChoice());
  const selectedHarness = harness ?? localHarness;
  const provider = backendLabel(selectedHarness.backend);
  const changeHarness = (next: BackendChoice) => { setLocalHarness(next); onHarnessChange?.(next); };
  const [project, setBoundProject] = useState<ProjectChoice>(null);
  const [projectLoaded, setProjectLoaded] = useState(false);
  const setProject = (next: ProjectChoice) => { void invoke<string | null>("companion_set_project", { companionId, projectPath: next?.path ?? null }).then(path => { setBoundProject(typeof path === "string" && path ? { path } : null); }).catch(error => setNotice(String(error))); };
  useEffect(() => {
    let alive = true;
    void invoke<string | null>("companion_get_project", { companionId }).then(async path => {
      // Migrate a previously explicit per-chat choice once; never infer write
      // authorization from whichever repository happens to be on screen.
      if (!path) { try { const prior = JSON.parse(localStorage.getItem(`rl.chatProject.${companionId}`) ?? "null") as ProjectChoice; if (prior?.path) path = await invoke<string | null>("companion_set_project", { companionId, projectPath: prior.path }); } catch { /* Keep a missing project unbound. */ } }
      if (alive) { setBoundProject(typeof path === "string" && path ? { path } : null); setProjectLoaded(true); }
    }).catch(() => { if (alive) setProjectLoaded(true); });
    return () => { alive = false; };
  }, [companionId]);
  const [buildConflict, setBuildConflict] = useState(false);
  const buildPath = mode === "build" ? project?.path : undefined;
  useEffect(() => { if (!buildPath) setBuildConflict(false); }, [buildPath]);
  usePoll(() => invoke<boolean>("companion_build_activity", { companionId, projectPath: buildPath }), buildPath ? 10_000 : null, { pauseWhenHidden: true, onResult: setBuildConflict }, [companionId, buildPath]);
  const [armedRun, setArmedRun] = useState<ChatPlanRequest | null>(null);
  const [changes, setChanges] = useState<ChatChanges[]>([]);
  const refreshChanges = useCallback(() => { void invoke<ChatChanges[]>("companion_changes", { companionId }).then(rows => setChanges(rows ?? [])).catch(() => {}); }, [companionId]);
  useEffect(() => { refreshChanges(); const un = listen<{companionId: string; changes: ChatChanges}>("companion-changes", event => { if (event.payload.companionId === companionId) setChanges(rows => [...rows.filter(row => row.messageId !== event.payload.changes.messageId), event.payload.changes]); }); return () => { void un.then(fn => fn()); }; }, [companionId, refreshChanges]);
  const [armedPlan, setArmedPlan] = useState<string | null>(null);
  const [graduations, setGraduations] = useState<{ sessionId: string; title: string }[]>([]);
  useEffect(() => { void invoke<typeof graduations>("companion_graduations", { companionId }).then(value => setGraduations(value ?? [])).catch(() => {}); }, [companionId, receipt?.status]);
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
    queue = [], steer, promote, steerNotice,
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
    onSendFailed: (text) => { setDraft(current => current.trim() ? `${current}\n\n${text}` : text); onContextLost?.("unsent"); },
    buildSendArgs: async (text, extra) => {
      const opts = extra as { mode?: ChatMode; target?: typeof target; context?: string | null } | undefined;
      // A seed brings the attachment read when it left the card. A chip
      // that can't be read attaches nothing rather than failing the send.
      const attached = opts && "context" in opts ? { context: opts.context ?? null } : await contextFor?.().catch(() => null);
      return {
        companionId,
        text,
        cwd,
        harness: selectedHarness,
        mode: opts?.mode ?? "chat",
        target: opts?.target ?? target,
        context: attached?.context ?? null,
        contextAll: attached?.contextAll ?? null,
      };
    },
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
  const [retrieving, setRetrieving] = useState<ChatProgressStatus | null>(null);
  useEffect(() => {
    const un = listen<{ companionId: string; label: string; at?: number }>(
      "companion-status",
      (e) => {
        if (e.payload.companionId === companionId) setRetrieving({ label: e.payload.label, at: e.payload.at ?? Date.now() });
      },
    );
    return () => {
      void un.then((f) => f());
    };
  }, [companionId]);
  useEffect(() => {
    if (status !== "streaming") setRetrieving(null);
  }, [status]);

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


  // A WARM agent per open room (companion_warm.rs): spawn it on mount, so the
  // next turn skips the CLI boot and the transcript replay, and let it go on
  // unmount. Claude only; Codex stays per-turn. Keyed on what the spawn
  // depends on, so a model or folder change re-warms on the new one.
  const warmKey = JSON.stringify([project?.path ?? cwd, selectedHarness, mode]);
  useEffect(() => {
    if (selectedHarness.backend !== "claude-code") return;
    void invoke("companion_prewarm", { companionId, cwd: project?.path ?? cwd, harness: selectedHarness, mode: mode === "build" && assignee === "chat" ? "build" : "chat" }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companionId, warmKey]);
  useEffect(() => () => { void invoke("companion_release", { companionId }).catch(() => {}); }, [companionId]);

  // What the room knows: the workspace brief and evidence the last turn
  // carried, for the Context chip. Read once on mount, then pushed per turn.
  const [context, setContext] = useState<ChatContext | null>(null);
  // A whole brief once the thread has a reply means a fresh CLI session — a
  // rotation, or a move to another provider — that holds only what was
  // pressed when it started (the backend hands it `contextAll`).
  const replied = useRef(false);
  replied.current = messages.some((m) => m.role === "assistant" && m.status === "complete");
  const contextLost = useRef(onContextLost);
  contextLost.current = onContextLost;
  useEffect(() => {
    let live = true;
    void invoke<ChatContext | null>("companion_context", { companionId })
      .then((value) => { if (live && value?.brief) setContext(value); })
      .catch(() => {});
    const un = listen<ChatContext>("companion-context", (e) => {
      if (e.payload.companionId !== companionId) return;
      if (e.payload.delivery === "full" && replied.current) contextLost.current?.("fresh-session");
      if (e.payload.brief) setContext(e.payload);
    });
    return () => {
      live = false;
      void un.then((f) => f());
    };
  }, [companionId]);

  useEffect(()=>{if(steerNotice)setNotice(steerNotice);},[steerNotice]);
  const send = useCallback(
    (text: string, opts?: { localBody?: string; mode?: "chat" | "build"; steer?: boolean }) => {
      const composed = composePrompt(text, composer?.attachments ?? attachments);
      if (!composed) return;
      onSent?.();
      stick();
      setNotice(null);
      sendTurn(composed, {
        localBody: opts?.localBody ?? composed,
        extra: { mode: opts?.mode ?? "chat" }, mode: opts?.mode ?? "chat", steer: opts?.steer,
      });
      setAttachments([]); composer?.onAttachmentsConsumed?.();
    },
    [attachments, composer, sendTurn, onSent],
  );

  // Send the door's sentence, exactly once, and only into a thread that is
  // genuinely empty: `loaded` rules out sending before the history answers,
  // and the emptiness check rules out a second send if this room ever remounts
  // with a stale seed still in the parent's hand.
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    const identity = seedId ?? seed;
    if (!identity || seeded.current === identity || !seed?.trim() || !loaded) return;
    seeded.current = identity;
    if (seedAutoSend) { stick(); onSent?.(); sendTurn(seed, { extra: { target: seedTarget, context: seedContext } }); }
    else setDraft(previous => previous.trim() ? `${previous}\n\n${seed}` : seed);
    onSeedConsumed?.();
  }, [seed, seedId, seedAutoSend, seedTarget, seedContext, loaded, sendTurn, onSeedConsumed, onSent, setDraft]);

  const streaming = status === "streaming";
  useEffect(() => { onActivityChange?.(streaming); }, [streaming, onActivityChange]);
  const canPlan = !!onPlan && (messages.some(message => message.status === "complete") || !!draft.trim());
  const armedInstruction = queuedInstruction ?? armedPlan;
  // Only the room's own picker shows this; the card's composer resolves its
  // own, so under the card nothing is deferred or scanned. The guess
  // regex-scans the whole transcript, so it runs on the deferred draft and
  // only when the transcript or that draft moves.
  const deferredDraft = useDeferredValue(composer ? null : draft);
  const planningProject = useMemo(
    () => deferredDraft === null ? null : resolveLaunchProject([...messages.map(message => message.body), deferredDraft].join("\n"), project, { projectOptions, openFolder: null, lastLaunchProject }),
    [messages, deferredDraft, project, projectOptions, lastLaunchProject],
  );
  const queued = queue.length;
  const plan = (instruction: string) => {
    if ((!canPlan && !instruction.trim()) || receipt?.status === "starting" || (receipt?.status === "planning" && receipt.kind !== "run")) return;
    setDraft("");
    if (!handoffGate(status, queued)) {
      if (onQueuePlan) onQueuePlan({ companionId, messages, instruction, project, harness: selectedHarness, title: me?.title ?? "Chat" });
      else setArmedPlan(instruction);
      return;
    }
    onPlan?.({ companionId, messages, instruction, project, harness: selectedHarness, title: me?.title ?? "Chat" });
  };
  useEffect(() => {
    if (armedPlan === null || !handoffGate(status, queued)) return;
    const instruction = armedPlan;
    setArmedPlan(null);
    onPlan?.({ companionId, messages, instruction, project, harness: selectedHarness, title: me?.title ?? "Chat" });
  }, [armedPlan, status, queued, onPlan, companionId, messages, project, me?.title]);
  useEffect(() => { if (armedRun && handoffGate(status, queued)) { setArmedRun(null); onRun?.({...armedRun,messages}); } }, [armedRun, status, queued, onRun,messages]);
  const retryReceipt = () => {
    if (!receipt) return;
    if (receipt.kind === "run") {
      const request = {companionId,messages,instruction:receipt.instruction,project,harness:selectedHarness,title:me?.title ?? "Chat"};
      if (handoffGate(status,queued)) onRun?.(request); else setArmedRun(request);
    } else plan(receipt.instruction);
  };
  const submit = (action: ChatMode = mode, immediateSteer = false) => {
    const instruction = composePrompt(draft, composer?.attachments ?? attachments);
    if (action !== "plan" && !instruction.trim()) return;
    if (action === "plan") { plan(instruction); setAttachments([]); composer?.onAttachmentsConsumed?.(); }
    else if (action === "build" && assignee === "agent") {
      if (!projectLoaded || !project?.path) { setNotice("Pick a project to build in"); return; }
      if (!onRun) { setNotice("A new agent cannot be launched from this chat yet"); return; }
      const request = { companionId, messages, instruction, project, harness: selectedHarness, title: me?.title ?? "Chat" };
      if (handoffGate(status, queued)) onRun(request); else setArmedRun(request);
      setDraft(""); setAttachments([]); composer?.onAttachmentsConsumed?.();
    } else {
      if (action === "build" && (!projectLoaded || !project?.path)) { setNotice("Pick a project to build in"); return; }
      send(draft, { mode: action, steer: immediateSteer && streaming }); setDraft("");
    }
  };
  const queueRows: QueueItem[] = queue.map(row => ({ id: row.id, text: row.body, mode: row.mode ?? "chat", assignee: "chat" }));
  if (armedInstruction !== null) queueRows.push({ id: "armed-plan", text: armedInstruction, mode: "plan" });
  if (armedRun) queueRows.push({ id: "armed-run", text: armedRun.instruction, mode: "build", assignee: "agent" });
  /** × on a queued row: out of the queue, its text back in the composer. */
  const removeQueue = async (id: string) => {
    let text: string | null = null;
    if (id === "armed-plan") { text = armedInstruction; setArmedPlan(null); onCancelQueuedPlan?.(); }
    else if (id === "armed-run") { text = armedRun?.instruction ?? null; setArmedRun(null); }
    else { text = await unqueue(id); if (text !== null) onContextLost?.("unsent"); }
    if (text) setDraft(previous => previous.trim() ? `${text}\n\n${previous}` : text);
  };
  const picker = <ChatModePicker mode={mode} onModeChange={setMode} assignee={assignee} onAssigneeChange={setAssignee} harness={selectedHarness} onHarnessChange={changeHarness} catalogs={modelCatalogs} onOpen={onNeedModels} warning={buildConflict ? "Another agent is building here" : null} />;
  const continueAs = (destination: ContinueDestination) => {
    const request = prepareConversationPreview({ conversationKind: "companion", conversationId: companionId, messages });
    window.dispatchEvent(new CustomEvent(CONTINUE_EVENT, { detail: { ...request, destination } }));
  };
  // Read replies aloud. Persisted per install, not per chat: it is a property
  // of how the user likes to work, not of one conversation.
  const [speakReplies, setSpeakReplies] = usePersistedState<boolean>(
    "redline.chat.speakReplies",
    false,
  );
  // Why the studio voice's stand-in reads, shown until the studio voice speaks
  // again, unless another notice has taken its place by then.
  const studioNote = useRef<string | null>(null);
  const readAloud = useReadAloud({
    enabled: speakReplies,
    liveText,
    streaming,
    threadKey: companionId,
    onError: (m) => setNotice(`🔇 The voice engine failed, so the system voice is reading — ${m}`),
    onFallback: (n) => {
      const shown = studioNote.current;
      studioNote.current = n;
      setNotice((cur) => n ?? (cur === shown ? null : cur));
    },
  });
  // Stop what is being read, else flip reading aloud — and turning it on is
  // the moment to start the voice engine, never the chat's mount.
  const toggleReadAloud = () => {
    if (readAloud.speaking) {
      readAloud.stop();
      return;
    }
    if (!speakReplies) readAloud.warm();
    setSpeakReplies((value) => !value);
  };
  const dictation = useDictation({
    enabled: dictationEnabled && !composer,
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

  const [chatAction, setChatAction] = useState<{ kind: "rename" | "delete"; id: string; title: string } | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const rename = useCallback((id: string, title: string) => { setActionError(null); setChatAction({ kind: "rename", id, title }); }, []);
  const remove = useCallback((id: string) => { setActionError(null); setChatAction({ kind: "delete", id, title: "" }); }, []);
  const commitChatAction = async () => {
    if (!chatAction || actionBusy) return;
    setActionBusy(true); setActionError(null);
    try {
      if (chatAction.kind === "rename") {
        await invoke("companion_rename", { companionId: chatAction.id, title: chatAction.title.trim(), byUser: true });
        refreshChats();
      } else {
        await invoke("companion_delete", { companionId: chatAction.id });
        const rows = await invoke<Companion[]>("companion_list");
        setChats(rows);
        if (chatAction.id === companionId) onEmpty();
      }
      setChatAction(null);
    } catch (error) { setActionError(String(error)); }
    finally { setActionBusy(false); }
  };

  const setModel = useCallback(
    (model: string | null, effort: string | null) => {
      void invoke("companion_set_model", { companionId, model, effort })
        .then(refreshChats)
        .catch((e) => setNotice(String(e)));
    },
    [companionId, refreshChats],
  );

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
  const roomy = expanded && !compact;
  const columnWidth = roomy ? 820 : 780;

  // Per-reply capture, so an idea does not evaporate with the scrollback.
  // All three reuse existing paths: the plan graduation, the Drafter seed and
  // a standalone memory note.
  const saveIdea = useCallback(async (body: string) => {
    await invoke("memory_note_write", {
      write: standaloneNote(ideaNote(body, { id: companionId, title: me?.title ?? "Chat" }, project?.path ?? cwd)),
    });
  }, [companionId, me?.title, project?.path, cwd]);
  // Stable, so a settled bubble sits out every render that isn't about it —
  // a keystroke in the composer re-renders this room, never the transcript.
  const planRef = useRef(plan);
  planRef.current = plan;
  const planFromReply = useCallback((body: string) => planRef.current(planFromReplyInstruction(body)), []);
  const [activityOpen, setActivityOpen] = useState(false);
  useEffect(() => setActivityOpen(false), [companionId]);

  const conversationActions = <>
    {composer && chats.length > 0 && <ComposerMenu label="Conversation history" value={companionId}
      options={chats.map(chat => ({ value: chat.companionId, label: chat.title }))} onChange={onSelectChat}>History</ComposerMenu>}
    {composer && <MonochatTrace conversationId={companionId} busy={streaming} open={activityOpen} onOpenChange={setActivityOpen}/>}
    <ComposerMenu label="Conversation actions" options={[
      { value: "plan-conversation", label: "Plan from this conversation", detail: "Carry its context and decisions into a plan", disabled: !canPlan, group: "Continue this work" },
      { value: "drafter", label: "Draft first…", disabled: !canPlan || streaming },
      { value: "auto", label: "Auto session…", disabled: !canPlan || streaming },
      { value: "plan", label: "Edit the brief…", disabled: !canPlan || streaming },
      { value: "voice", label: readAloud.speaking ? "Stop reading aloud" : speakReplies ? "Disable reading aloud" : "Read replies aloud", group: "Conversation" },
      ...(composer ? [{ value: "activity", label: "Activity & usage", detail: "Token usage and activity for this conversation" }] : [{ value: "new", label: "New conversation" }]),
      { value: "rename", label: "Rename…" },
      { value: "delete", label: "Delete…" },
      ...(composer ? [] : chats.filter(chat => chat.companionId !== companionId).slice(0, 8).map(chat => ({ value: `chat:${chat.companionId}`, label: chat.title, group: "Recent conversations" }))),
    ]} onChange={value => {
      if (value.startsWith("chat:")) onSelectChat(value.slice(5));
      else if (value === "plan-conversation") { plan(composePrompt(draft, composer?.attachments ?? attachments)); composer?.onAttachmentsConsumed?.(); }
      else if (value === "new") { if (composer) onEmpty(); else newChat(); }
      else if (value === "activity") setActivityOpen(true);
      else if (value === "rename") rename(companionId, me?.title ?? "Chat");
      else if (value === "delete") remove(companionId);
      else if (value === "voice") toggleReadAloud();
      else continueAs(value as ContinueDestination);
    }}>More</ComposerMenu>
  </>;

  return (
    <ConversationSourceContext.Provider value={{ conversationKind: "companion", conversationId: companionId, messages }}>
    {chatAction && <BrowserDialog title={chatAction.kind === "rename" ? "Name this conversation" : "Delete this conversation?"}
      closeLabel="Cancel" onClose={() => { if (!actionBusy) setChatAction(null); }}
      footer={<button className="rb-button rb-button-primary" type="button" disabled={actionBusy || (chatAction.kind === "rename" && !chatAction.title.trim())} onClick={() => void commitChatAction()}>{actionBusy ? "Saving…" : chatAction.kind === "rename" ? "Save name" : "Delete conversation"}</button>}>
      {chatAction.kind === "rename" ? <input aria-label="Conversation name" className="rb-input" value={chatAction.title} onChange={event => setChatAction({ ...chatAction, title: event.target.value })} onKeyDown={event => { if (event.key === "Enter" && chatAction.title.trim()) void commitChatAction(); }}/>
        : <p>The conversation will be deleted. Its captured memory stays in the lake.</p>}
      {actionError && <p role="alert">{actionError}</p>}
    </BrowserDialog>}
    <div data-chat-room data-room={roomy || undefined} data-chat-empty={!!composer && loaded && messages.length === 0 && status === "idle" && !receipt} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" style={{ height: "100%", background: "var(--color-paper)" }}>
      {/* Header: which chat, on what model, and the two ways out of it. */}
      <div
        ref={headerRef}
        data-chat-toolbar
        className="flex min-w-0 shrink-0 items-center gap-2 px-3 py-2"
        style={{ borderBottom: "1px solid var(--color-rule)", flexWrap: "nowrap" }}
      >
        {<ChatsMenu
          chats={chats}
          activeId={companionId}
          onSelect={onSelectChat}
          onNew={newChat}
          onRename={rename}
          onDelete={remove}
        />}
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
        <ToolbarButton label={compact ? <X size={13} strokeWidth={2} /> : "Close"} title="Close chat" onClick={onClose} />
      </div>

      {context && <ChatContextChip context={context} onOpenPlan={onOpenPlan} maxWidth={columnWidth} />}

      {/* Thread */}
      <div
        ref={scrollRef}
        data-chat-messages
        onScroll={onScroll}
        className="rl-thin-scroll-y"
        style={{ flex: "1 1 0%", minHeight: 0, minWidth: 0, overflowY: "auto", overflowX: "hidden", overflowWrap: "anywhere" }}
      >
        <div
          style={{
            maxWidth: columnWidth,
            margin: "0 auto",
            // The bottom keeps the queue tray's pill clear of the newest line:
            // the tray overlays the thread rather than shrinking it.
            padding: roomy ? "22px 24px 40px" : "18px 20px 36px",
            display: "flex",
            flexDirection: "column",
            gap: roomy ? 22 : 14,
          }}
        >
          {!loaded ? null : messages.length === 0 && status === "idle" ? (
            composer ? null : <ChatEmptyState onAsk={(q) => send(q)} />
          ) : (
            messages.map((m) => (
              <ChatBubble
                key={m.id}
                msg={m}
                meter={meters[m.id]}
                contextReset={resets.has(m.id)}
                room={roomy}
                provider={provider}
                seat={selectedHarness.model}
                inspectKey={companionId}
                onPlan={canPlan ? planFromReply : undefined}
                onDraft={onDraft}
                onSaveIdea={saveIdea}
                onResend={send}
              />
            ))
          )}
          {changes.map(change => <ChangesCard key={change.messageId} changes={change} companionId={companionId} onReview={onReviewChanges} onUndone={refreshChanges} />)}
          {receipt && <div data-chat-plan-receipt={companionId} className="rl-fd-morph rl-fd-planning-prompt" role="status" style={{ padding: 16, border: "1px solid var(--color-rule)", borderRadius: 12 }}>
            {receipt.status === "starting" ? "Starting…" : receipt.status === "planning" ? <>{receipt.kind === "run" ? "Build started" : "Planning: watch it in the terminal ↓"} {receipt.terminalId && <button type="button" onClick={() => onShowTerminal?.(receipt.terminalId!)}>Show</button>}</> : receipt.status === "error" ? <>{receipt.error} <button type="button" onClick={retryReceipt}>Retry</button>{receipt.blocked && onFix && <button type="button" onClick={() => void onFix(receipt.blocked!).then(fixed => { if (fixed) retryReceipt(); })}>Fix</button>}</> : <>{receipt.kind === "run" ? "Build session" : "Became a plan"}: {receipt.title ?? "Plan"} {receipt.sessionId && <button type="button" onClick={() => onOpenPlan?.(receipt.sessionId!)}>Open →</button>}</>}
          </div>}
          {graduations.filter(item => item.sessionId !== receipt?.sessionId).map(item => <div key={item.sessionId} className="rl-fd-planning-prompt">Became a plan: {item.title} <button type="button" onClick={() => onOpenPlan?.(item.sessionId)}>Open →</button></div>)}
          {streaming && (
            // The reply as it will settle: the same skeleton, and its tail is
            // the turn's one status line. It streams plain; the settled row
            // draws a diagram the stream showed as its fence.
            <ReplyBlock
              phase="live"
              byline={providerByline(meter, provider)}
              seat={selectedHarness.model}
              text={liveText}
              meter={meter}
              activity={activity}
              startedAt={startedAt}
              status={retrieving}
              room={roomy}
            />
          )}
          {/* In-turn notices end the thread, quietly: a bar above it would
              take height from the thread mid-turn. */}
          {notice && <p className="rl-thread-note" aria-live="polite">{notice}</p>}
        </div>
      </div>

      {/* Over the thread's reserved bottom, never taking height from it. */}
      <QueueTray rows={queueRows} onRemove={id => { void removeQueue(id); }} onSteer={id => { void steer(id).catch(error => setNotice(String(error))); }} onPromote={id => { if (!id.startsWith("armed-")) void promote(id).catch(error => setNotice(String(error))); }} />
      {/* The floating launch composer owns input when supplied. */}
      {composer ? composer.render(conversationActions, { picker, mode, cycleMode: () => setMode(nextChatMode(mode)), onSubmit: steer => submit(mode, steer), project, onProjectChange: setProject, streaming, onStop: cancel }) : <div
        data-chat-composer
        className="min-w-0 shrink-0 py-2.5"
        style={{ borderTop: "1px solid var(--color-rule)", paddingInline: 20 }}
      >
        <div style={{ maxWidth: columnWidth, margin: "0 auto" }}>
          {attachments.length > 0 && (
            <div className="mb-1.5 flex min-w-0 flex-wrap gap-1.5" style={{ maxHeight: 64, overflowY: "auto" }}>
              {attachments.map((p) => (
                <span
                  key={p}
                  className="font-sans inline-flex items-center gap-1 rounded-full px-2 py-0.5"
                  title={p}
                  style={{
                    fontSize: 10.5,
                    border: "1px solid var(--color-rule)",
                    color: "var(--color-ink-muted)",
                    maxWidth: "100%",
                  }}
                >
                  <span className="truncate">{p.slice(p.lastIndexOf("/") + 1) || p}</span>
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
              style={{ fontSize: 11.5, color: "var(--color-ink-muted)", maxHeight: 60, overflowY: "auto" }}
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
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); setMode(nextChatMode(mode)); return; }
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(mode, e.altKey); }
              }}
              aria-label="Message Redline"
              placeholder={mode === "plan" ? "Any final instruction for the plan?" : streaming ? "Type ahead — this queues behind the reply…" : "What are we working on?"}
              rows={2}
              style={{
                flex: 1,
                minWidth: 0,
                maxHeight: 160,
                overflowY: "auto",
                resize: "none",
                padding: roomy ? "9px 12px" : "7px 10px",
                fontSize: roomy ? 15 : 12.5,
                lineHeight: 1.5,
                color: "var(--color-ink)",
                background: "var(--color-paper)",
                border: `1px solid ${mode === "build" ? "var(--color-warning)" : mode === "plan" ? "var(--color-info)" : "var(--color-rule)"}`,
                borderRadius: 8,
              }}
            />
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
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
            {!modelControls && <ToolbarButton label={readAloud.speaking ? "🔊 Stop" : "🔊"} title="Read replies aloud" on={speakReplies} onClick={toggleReadAloud} onPointerEnter={readAloud.warm} />}
            {modelControls ?? <ModelChip model={me?.model ?? null} effort={me?.effort ?? null} onChange={setModel} />}
            {modelControls && <MonochatTrace conversationId={companionId} busy={streaming}/>}
            {mode !== "chat" && <ProjectPicker value={project?.path ?? planningProject} onChange={path => setProject({ path })} options={projectOptions} />}
            {conversationActions}

            {picker}
            <SendStopButton
              state={sendState(streaming, !!draft.trim())}
              label={mode === "plan" ? "Plan" : "Send"}
              onSend={() => submit(mode)}
              onStop={cancel}
              disabled={mode === "chat" ? !draft.trim() : !canPlan || receipt?.status === "starting" || (receipt?.status === "planning" && receipt.kind !== "run")}
            />
          </div>
        </div>
      </div>}
    </div>
    </ConversationSourceContext.Provider>
  );
}

/** The provider a reply is signed with (BC-26): the family of the model that
 *  answered once the meter has seen it, otherwise the one it was sent to. The
 *  live reply and its settled row read the same meter, so the same name. */
function providerByline(meter: TurnMeter | null | undefined, sentTo: string): string {
  const family = modelInfo(meter?.model)?.family;
  return family === "gpt" ? "Codex" : family === "claude" ? "Claude" : sentTo;
}

// Memoized: every prop is stable while the composer is being typed in, so the
// transcript's markdown is not re-rendered per keystroke.
const ChatBubble = memo(function ChatBubble({
  msg,
  onResend,
  meter,
  contextReset,
  room = false,
  provider,
  seat,
  inspectKey,
  onPlan,
  onDraft,
  onSaveIdea,
}: {
  msg: CompanionMessage;
  onResend: (body: string) => void;
  /** This row's settled meter — the byline, steps line and tail it keeps. */
  meter?: TurnMeter | null;
  /** This turn's context restarted (compaction or a fresh CLI session). */
  contextReset?: boolean;
  /** Plate scale: roomier prose and cards, larger meta text. */
  room?: boolean;
  /** The chat's provider, for a reply whose meter names no model. */
  provider: string;
  /** The model this chat asked for, if it named one. */
  seat: string | null;
  /** The conversation's raw-wire key, for the reply's ⋯. */
  inspectKey: string;
  /** The reply's capture row (Copy · → Plan · → Draft · Save idea), each
   *  handed the reply's body. */
  onPlan?: (body: string) => void;
  onDraft?: (body: string) => void;
  onSaveIdea: (body: string) => Promise<void>;
}) {
  if (msg.role === "user") {
    return <UserTurn body={msg.body} room={room} unsent={msg.status === "unsent"} onResend={() => onResend(msg.body)} />;
  }
  const isError = msg.status === "error";
  return (
    <ReplyBlock
      phase="settled"
      // Redline wrote an error row's sentence, not the model.
      byline={isError ? "Redline" : providerByline(meter, provider)}
      seat={seat}
      text={msg.body}
      error={isError}
      meter={meter}
      contextReset={contextReset}
      room={room}
      inspect={{ surface: "companion", key: inspectKey }}
      actions={
        !isError && msg.body.trim() ? (
          <ReplyActions
            body={msg.body}
            onPlan={onPlan && (() => onPlan(msg.body))}
            onDraft={onDraft && (() => onDraft(msg.body))}
            onSaveIdea={() => onSaveIdea(msg.body)}
          />
        ) : undefined
      }
    />
  );
});

/** Copy · → Plan · → Draft · Save idea, in a settled reply's tail. Each label
 *  flips to a short confirmation in place rather than raising a toast. */
function ReplyActions({
  body,
  onPlan,
  onDraft,
  onSaveIdea,
}: {
  body: string;
  onPlan?: () => void;
  onDraft?: () => void;
  onSaveIdea: () => Promise<void>;
}) {
  const [done, setDone] = useState<"copy" | "idea" | "idea-failed" | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  const flash = (what: NonNullable<typeof done>) => {
    setDone(what);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDone(null), 1600);
  };
  return (
    <span data-reply-actions className="contents">
      <button type="button" className="rl-reply-action" title="Copy this reply as markdown"
        onClick={() => void navigator.clipboard?.writeText(body).then(() => flash("copy"), () => {})}>
        {done === "copy" ? "Copied ✓" : "Copy"}
      </button>
      {onPlan && <button type="button" className="rl-reply-action" title="Plan from this conversation, built around this reply" onClick={onPlan}>→ Plan</button>}
      {onDraft && <button type="button" className="rl-reply-action" title="Open the Drafter with this reply" onClick={onDraft}>→ Draft</button>}
      <button type="button" className="rl-reply-action" title="Save this reply to your memory as a note"
        onClick={() => void onSaveIdea().then(() => flash("idea"), () => flash("idea-failed"))}>
        {done === "idea" ? "Saved ✓" : done === "idea-failed" ? "Couldn't save" : "Save idea"}
      </button>
    </span>
  );
}

function ToolbarButton({
  label,
  title,
  onClick,
  onPointerEnter,
  disabled,
  on,
}: {
  label: ReactNode;
  title: string;
  onClick: () => void;
  onPointerEnter?: () => void;
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
      onPointerEnter={onPointerEnter}
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
        // One shorthand either way: a `borderColor` dropped from under
        // `border` when the toggle turns off would take the rule's colour
        // with it.
        border: `1px solid ${on ? "var(--color-info)" : "var(--color-rule)"}`,
        background: "transparent",
        color: on ? "var(--color-info-text)" : "var(--color-ink)",
        opacity: disabled ? 0.45 : 1,
        whiteSpace: "nowrap",
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
        color: hot ? "var(--color-on-info)" : "var(--color-ink-muted)",
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
        into something, select <strong>Plan</strong> in the composer or use <strong>More…</strong> to draft it
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
