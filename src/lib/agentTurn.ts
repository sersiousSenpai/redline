// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The pure state machine behind `useAgentTurn` — one turn lifecycle for every
//! streaming chat surface (browse, linked, mission, memchat). The hook feeds
//! it three inputs that can interleave arbitrarily: the persisted thread
//! (`history`), a `*_turn_status` probe (`probe`), and the live event stream
//! (`delta`/`done`/`error`/`cancelled`). Two rules make every interleaving
//! safe:
//!
//! 1. **The seq guard.** The backend appends a delta into its partial buffer
//!    BEFORE emitting it, so a probed `partial` at `seq` N folds in exactly
//!    deltas 1..=N. Dropping any delta with `seq <=` the probed watermark is
//!    therefore lossless — a delta can never be both missing from the probe
//!    text and dropped by the guard.
//! 2. **The settled latch.** Events arrive in order, but a probe response is a
//!    command round-trip and can land AFTER the terminal event of the turn it
//!    snapshotted. A terminal action latches `settled`; a streaming probe is
//!    ignored while the latch is set (a genuine new turn always announces
//!    itself through `sendOptimistic` or a delta first, both of which clear
//!    it).

import type { QueuedTurn, TurnStatus } from "../types";
import { mergeMeter, type Activity, type TurnMeter } from "./turnMeter";

/** Activity entries kept per turn on the frontend. The backend ring is 200;
 *  the surfaces render the newest one, so a smaller local cap is enough and
 *  keeps a long tool-heavy turn from growing component state without bound. */
export const ACTIVITY_KEEP = 40;

/** Settled rows a mounted surface holds (docs/perf-budget.md rule 7). No
 *  surface pages its history, so a thread longer than this shows its newest
 *  rows; the older ones stay in SQLite, where the agent still reads them. */
export const THREAD_KEEP = 1000;

/** The message shape every chat surface shares; each surface's persisted row
 *  type (BrowseMessage, LinkedMessage, …) extends it. */
export interface TurnMessage {
  id: string;
  role: string;
  body: string;
  status: string;
  createdAt: number;
  mode?: "chat" | "build";
  assignee?: "chat" | "agent";
}

export type TurnPhase = "idle" | "streaming" | "error";

export interface TurnState<M extends TurnMessage> {
  /** Settled turns: the persisted thread merged with locally-appended rows. */
  messages: M[];
  queue: M[];
  advanced: string[];
  steerNotice?: string;
  /** The in-flight reply's text so far ("" when idle). */
  liveText: string;
  /** Deltas folded into `liveText` — the drop-if-`seq <=` watermark. */
  lastSeq: number;
  phase: TurnPhase;
  /** When the in-flight turn started (backend clock; local approximation
   *  until a probe refines it). */
  startedAt: number | null;
  /** Sends waiting behind the in-flight turn (Phase 3; empty until then). */
  queued: QueuedTurn[];
  /** The first history load resolved (even if empty/failed) — gates the
   *  empty-state hint so it never flashes before the thread arrives. */
  loaded: boolean;
  /** A terminal event settled the current turn; stale streaming probes are
   *  ignored until a send or delta starts the next one. */
  settled: boolean;
  /** The backend hit a transient model error on this turn and is quietly
   *  running it again. The turn never left `streaming` — this only changes
   *  what the bubble says while the second attempt runs. Cleared by the first
   *  delta of the retry and by every terminal action. */
  retrying: boolean;
  /** What the in-flight (or just-settled) turn has spent, and which model is
   *  spending it. Survives a remount through the `probe`, exactly like
   *  `liveText`/`lastSeq`. */
  meter: TurnMeter | null;
  /** What the turn has been doing while you waited — newest last. */
  activity: Activity[];
  /** Settled turns' meters, by message id: the badge and the footer under a
   *  finished bubble. Seeded from `thread_meters` on load and extended by each
   *  terminal event, so they survive a relaunch and not just a remount. */
  meters: Record<string, TurnMeter>;
}

export type TurnAction<M extends TurnMessage> =
  | { type: "reset" }
  | { type: "history"; rows: M[] }
  | { type: "probe"; status: TurnStatus }
  | { type: "delta"; seq: number; text: string }
  | { type: "done"; message: M }
  | { type: "error"; message: M }
  | { type: "cancelled" }
  | { type: "send-optimistic"; message: M }
  // Reconcile the optimistic row once the backend answers the send.
  | { type: "send-resolved"; tmpId: string; messageId?: string; queued?: boolean }
  // The send never reached a turn (build/invoke failure) — the row wasn't sent.
  | { type: "send-failed"; tmpId: string }
  // A queued send left the queue and became the streaming turn.
  | { type: "queue-advanced"; messageId: string }
  // The user pulled a send back out of the queue (its text returns to the
  // composer); the row disappears.
  | { type: "unqueued"; messageId: string }
  | { type: "steered"; message: M; assistant?: M; seq: number }
  | { type: "steer-notice"; message: string }
  | { type: "promoted"; messageId: string }
  // Self-heal confirmed the turn is gone (terminal event lost) — settle idle.
  | { type: "settle" }
  // The backend is re-running a transient failure on the same message. Still
  // streaming — only the bubble's caption changes.
  | { type: "retry"; attempt: number }
  // A coalesced `{surface}-meter` event. Snapshot semantics: a stale one is
  // dropped by `rev` and loses nothing, unlike a dropped delta.
  | { type: "meter"; meter: TurnMeter; activity?: Activity | null }
  // Stored meters for already-settled rows, fetched alongside the history.
  | { type: "meters"; rows: Record<string, TurnMeter> };

export function initialTurnState<M extends TurnMessage>(): TurnState<M> {
  return {
    messages: [],
    queue: [],
    advanced: [],
    liveText: "",
    lastSeq: 0,
    phase: "idle",
    startedAt: null,
    queued: [],
    loaded: false,
    settled: false,
    retrying: false,
    meter: null,
    activity: [],
    meters: {},
  };
}

/** The id-less identity of a row, for deduping a locally-appended message
 *  against its persisted twin (which comes back with a real id). */
const textKey = (m: TurnMessage) => `${m.role}\u0000${m.body}`;

/** Merge freshly fetched history into the live list: id equality first (a
 *  repeated question is not a duplicate), text key as the fallback for
 *  optimistic rows whose persisted twin carries an id we never saw. The merged
 *  list is stably re-ordered by `createdAt` so a refetched terminal row lands
 *  after the optimistic user row that produced it. */
function mergeHistory<M extends TurnMessage>(local: M[], rows: M[]): M[] {
  if (local.length === 0) return rows;
  const seenIds = new Set(local.map((m) => m.id));
  const seenKeys = new Set(local.map(textKey));
  const fresh = rows.filter((r) => !seenIds.has(r.id) && !seenKeys.has(textKey(r)));
  if (fresh.length === 0) return local;
  return [...fresh, ...local].sort((a, b) => a.createdAt - b.createdAt);
}

/** The user message an assistant row is the failed answer to — what a Retry
 *  re-sends. `null` when there is none above it. */
export function priorUserBody<M extends TurnMessage>(
  list: M[],
  index: number,
): string | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (list[i].role === "user") return list[i].body;
  }
  return null;
}

export function reduceTurn<M extends TurnMessage>(
  state: TurnState<M>,
  action: TurnAction<M>,
): TurnState<M> {
  const next = step(state, action);
  return next.messages.length > THREAD_KEEP
    ? { ...next, messages: next.messages.slice(-THREAD_KEEP) }
    : next;
}

function step<M extends TurnMessage>(
  state: TurnState<M>,
  action: TurnAction<M>,
): TurnState<M> {
  switch (action.type) {
    case "reset":
      return initialTurnState<M>();

    case "history":
      return { ...state, messages: mergeHistory(state.messages, action.rows.filter(row => row.status !== "queued")), queue: mergeHistory(state.queue.filter(row => !action.rows.some(fresh => fresh.id === row.id && fresh.status !== "queued")), action.rows.filter(row => row.status === "queued")), loaded: true };

    case "probe": {
      const s = action.status;
      const queue = state.queue.map(row => ({ ...row, mode: s.queued.find(item => item.messageId === row.id)?.mode ?? row.mode }));
      if (!s.streaming) {
        // An idle probe never forces idle — terminal events and the hook's
        // two-miss self-heal own that verdict. It still refreshes the queue.
        return { ...state, queue, queued: s.queued };
      }
      if (state.settled) {
        // Stale snapshot of a turn we already saw end.
        return { ...state, queue, queued: s.queued };
      }
      const ahead = s.seq > state.lastSeq;
      // The meter adopts under its OWN rule, not the seq guard's: it is a
      // snapshot keyed by a monotone `rev`, so a probe that is behind on text
      // can still be ahead on the meter (and vice versa).
      const meter = mergeMeter(state.meter, s.meter ?? null);
      return {
        ...state,
        phase: "streaming",
        startedAt: s.startedAt ?? state.startedAt,
        // Adopt the probed text only when it folds in MORE deltas than we
        // have — otherwise our local accumulation is the newer truth.
        liveText: ahead ? (s.partial ?? "") : state.liveText,
        lastSeq: ahead ? s.seq : state.lastSeq,
        queued: s.queued,
        queue,
        meter,
        // The probe carries the whole ring; a remounting panel takes it
        // wholesale rather than trying to splice its own partial view in.
        activity:
          s.activity && s.activity.length >= state.activity.length
            ? s.activity.slice(-ACTIVITY_KEEP)
            : state.activity,
      };
    }

    case "delta": {
      if (action.seq <= state.lastSeq) return state; // already folded into a probe
      return {
        ...state,
        phase: "streaming",
        liveText: state.liveText + action.text,
        lastSeq: action.seq,
        settled: false,
        // Text is arriving again — whatever the retry caption said, it's over.
        retrying: false,
      };
    }

    case "done": {
      const exists = state.messages.some((m) => m.id === action.message.id);
      return {
        ...state,
        // Dedupe by messageId — a self-heal refetch may have already merged
        // the persisted row before a late done event finally arrived.
        messages: exists ? state.messages : [...state.messages, action.message],
        liveText: "",
        lastSeq: 0,
        phase: "idle",
        startedAt: null,
        settled: true,
        retrying: false,
        // The turn's meter becomes the ROW's meter: the badge and footer
        // belong to the bubble now, not to a stream that just ended.
        meters: state.meter
          ? { ...state.meters, [action.message.id]: state.meter }
          : state.meters,
        meter: null,
        activity: [],
      };
    }

    case "error": {
      // Error rows are persisted backend-side too — after a self-heal refetch
      // a late error event would double the bubble; the text key catches it.
      const key = textKey(action.message);
      const exists = state.messages.some(
        (m) => m.status === "error" && textKey(m) === key,
      );
      return {
        ...state,
        messages: exists ? state.messages : [...state.messages, action.message],
        liveText: "",
        lastSeq: 0,
        phase: "error",
        startedAt: null,
        settled: true,
        retrying: false,
        // A failed turn's economics are the most interesting on the thread:
        // "cost 40k and then died" is exactly what you want to see later.
        meters: state.meter
          ? { ...state.meters, [action.message.id]: state.meter }
          : state.meters,
        meter: null,
        activity: [],
      };
    }

    case "cancelled":
      return {
        ...state,
        liveText: "",
        lastSeq: 0,
        phase: "idle",
        startedAt: null,
        settled: true,
        retrying: false,
        // No row to hang it on. The burn was booked backend-side regardless
        // — this only clears the live readout.
        meter: null,
        activity: [],
      };

    case "send-optimistic": {
      if (state.phase === "streaming") {
        // Type-ahead: this send will queue behind the in-flight turn. Leave
        // the live stream untouched and guess "queued" until send-resolved
        // confirms (or corrects) it.
        return {
          ...state,
          queue: [...state.queue, { ...action.message, status: "queued" }],
          settled: false,
        };
      }
      return {
        ...state,
        messages: [...state.messages, action.message],
        liveText: "",
        lastSeq: 0,
        phase: "streaming",
        startedAt: action.message.createdAt,
        settled: false,
        retrying: false,
        meter: null,
        activity: [],
      };
    }

    case "send-resolved": {
      const pending = state.queue.find(row => row.id === action.tmpId) ?? state.messages.find(row => row.id === action.tmpId);
      if (!pending) return state;
      const queued = action.queued && !state.advanced.includes(action.messageId ?? "");
      const row = { ...pending, id: action.messageId ?? pending.id, status: queued ? "queued" : "complete" };
      const messages = state.messages.filter(item => item.id !== action.tmpId);
      const queue = state.queue.filter(item => item.id !== action.tmpId);
      return { ...state, messages: queued ? messages : state.messages.some(item => item.id === action.tmpId) ? state.messages.map(item => item.id === action.tmpId ? row : item) : [...messages, row], queue: queued ? state.queue.some(item => item.id === action.tmpId) ? state.queue.map(item => item.id === action.tmpId ? row : item) : [...queue, row] : queue };
    }

    case "send-failed": {
      const row = state.queue.find(item => item.id === action.tmpId);
      return { ...state, queue: state.queue.filter(item => item.id !== action.tmpId), messages: row ? [...state.messages, { ...row, status: "unsent" }] : state.messages.map(item => item.id === action.tmpId ? { ...item, status: "unsent" } : item) };
    }

    case "queue-advanced": {
      const row = state.queue.find(item => item.id === action.messageId);
      return {
        ...state,
        messages: row ? [...state.messages, { ...row, status: "complete", createdAt: Date.now() }] : state.messages,
        queue: state.queue.filter(item => item.id !== action.messageId),
        advanced: [...state.advanced, action.messageId].slice(-16),
        queued: state.queued.filter(item => item.messageId !== action.messageId),
        liveText: "", lastSeq: 0, phase: "streaming", settled: false,
        meter: null, activity: [],
      };
    }

    case "steer-notice": return {...state,steerNotice:action.message};

    case "steered": {
      const segment = action.assistant ?? (state.liveText ? { ...action.message, id: `${action.message.id}-segment`, role: "assistant", body: state.liveText } : null);
      const messages = [...state.messages];
      if (segment && !messages.some(row => row.id === segment.id)) messages.push(segment);
      if (!messages.some(row => row.id === action.message.id)) messages.push(action.message);
      return { ...state, messages, queue: state.queue.filter(row => row.id !== action.message.id), queued: state.queued.filter(row => row.messageId !== action.message.id), liveText: "", lastSeq: action.seq, phase: "streaming", settled: false };
    }

    case "promoted": {
      const row = state.queue.find(item => item.id === action.messageId);
      return row ? { ...state, queue: [row, ...state.queue.filter(item => item.id !== row.id)] } : state;
    }

    case "unqueued":
      return { ...state, messages: state.messages.filter(row => row.id !== action.messageId), queue: state.queue.filter(row => row.id !== action.messageId), queued: state.queued.filter(row => row.messageId !== action.messageId) };

    case "settle":
      return {
        ...state,
        liveText: "",
        lastSeq: 0,
        phase: "idle",
        startedAt: null,
        settled: true,
        retrying: false,
        // No row to hang it on. The burn was booked backend-side regardless
        // — this only clears the live readout.
        meter: null,
        activity: [],
      };

    case "retry":
      // A retry is not a new turn: the reservation, the elapsed clock and the
      // user's bubble all survive it. Only the caption changes. Ignored once
      // the turn has settled, so a late event can't reanimate a finished
      // bubble.
      if (state.settled) return state;
      return { ...state, phase: "streaming", retrying: true, liveText: "", lastSeq: 0 };

    case "meter": {
      const meter = mergeMeter(state.meter, action.meter);
      // `mergeMeter` returns the CURRENT object when the event is stale, so
      // identity equality is the whole guard — no re-render, no state churn.
      if (meter === state.meter && !action.activity) return state;
      const activity = action.activity
        ? [...state.activity, action.activity].slice(-ACTIVITY_KEEP)
        : state.activity;
      return { ...state, meter, activity };
    }

    case "meters":
      return { ...state, meters: { ...action.rows, ...state.meters } };
  }
}
