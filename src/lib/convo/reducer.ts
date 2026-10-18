// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The conversation mirror's frontend half: `ConvoEvent`s in (./types.ts),
//! one view of the conversation out. Pure — `SessionConversation` holds the
//! state in a `useReducer` and renders `convoView(state)`.
//!
//! - **Merge is a keyed upsert.** An event is its `id`; the same bytes read
//!   twice yield the same ids, so a batch applied twice changes nothing and
//!   hands back the SAME state object (React skips the render).
//! - **Order is `(epoch, offset)`**, then first sight: the several events one
//!   transcript line yields share an offset, and keep the order they came in.
//!   An older page lands in front by its keys alone.
//! - **Facts outlive their rows.** The mode, the model, the composer's
//!   readiness, the binding, open asks and the latest plan are stamped with
//!   the key of the event that set them, and only a NEWER event replaces
//!   one. Trimming the oldest rows, or a page of older ones arriving late,
//!   never rolls the mode chip back.
//! - **Sends are optimistic.** The composer's `expect` puts a bubble up at
//!   once; `delivered` / `undelivered` move it, and the transcript's own
//!   `user_text` absorbs it (by `promptId`, else by its text), so the bubble
//!   never shows twice.
//! - **About 400 rows are kept.** Following the live end, the oldest rows
//!   fall off and `hasOlder` says there is more. Scrolling up pages them
//!   back, and the window stays that wide until the reader is back at the
//!   bottom (`trim`).

import type {
  ConvoAsk,
  ConvoAskOutcome,
  ConvoBatch,
  ConvoBlocker,
  ConvoEvent,
  ConvoEventKind,
  ConvoHarness,
  ConvoMode,
  ConvoPage,
  ConvoSnapshot,
} from "./types";

/** Rows kept while following the live end (the plan's "~400 rows"). */
export const MAX_ROWS = 400;

/** Clock slack when a send is matched to the transcript by its text: the
 *  transcript stamps its own time, the composer stamps the host's. */
const TEXT_MATCH_SKEW_MS = 5_000;

/** Kinds that draw something in the conversation; what the cap counts. */
const ROW_KINDS: ReadonlySet<ConvoEventKind> = new Set<ConvoEventKind>([
  "user_text",
  "assistant_text",
  "thinking",
  "tool_use",
  "epoch",
  "compact",
  "plan_proposed",
  "ask_opened",
]);

// ── State ─────────────────────────────────────────────────────────────────

/** Where an event sits: its `(epoch, offset)`, then the order it was first
 *  seen in. */
export interface EventKey {
  epoch: number;
  offset: number;
  seq: number;
}

interface Stamped<T> {
  key: EventKey;
  value: T;
}

/** A composer send the transcript hasn't shown yet. */
export interface PendingSend {
  nonce: string;
  text: string;
  /** When the composer sent it (host clock, ms). */
  at: number;
  status: "pending" | "delivered" | "undelivered";
  /** The CLI's prompt id, once `delivered` names it. */
  promptId: string | null;
  /** The `user_text` event that took its place; the bubble then draws from
   *  that event. */
  absorbedBy: string | null;
}

export interface BoundFact {
  harness: ConvoHarness;
  sessionId: string;
  transcriptPath: string | null;
}

export interface ReadinessFact {
  ready: boolean;
  blocker: ConvoBlocker | null;
}

export interface ModelFact {
  model: string;
  effort: string | null;
}

export interface PlanFact {
  toolUseId: string;
  sessionId: string;
  title: string | null;
  outcome: "approved" | "denied" | "feedback" | null;
  feedback: string | null;
}

export interface ConvoFacts {
  bound: Stamped<BoundFact> | null;
  mode: Stamped<ConvoMode> | null;
  model: Stamped<ModelFact> | null;
  readiness: Stamped<ReadinessFact> | null;
  /** Every ask seen, by `askId`. */
  asks: Readonly<Record<string, Stamped<ConvoAsk>>>;
  /** Asks answered (by anyone), by `askId`. Kept apart from `asks` so a
   *  close that arrives before its open (a page landing late) still wins. */
  closed: Readonly<Record<string, ConvoAskOutcome>>;
  /** Plans proposed, by the ExitPlanMode `toolUseId`. */
  plans: Readonly<Record<string, Stamped<PlanFact>>>;
}

export interface ConvoState {
  /** Held events, in order. */
  events: readonly ConvoEvent[];
  /** First-sight order, by id. */
  seq: Readonly<Record<string, number>>;
  nextSeq: number;
  hasOlder: boolean;
  /** Rows held before the oldest fall off; widened by paging. */
  limit: number;
  sends: readonly PendingSend[];
  facts: ConvoFacts;
}

export type ConvoAction =
  /** A new terminal, or none: forget everything. */
  | { type: "reset" }
  /** `convo_subscribe`'s answer. Merged, not swapped: a batch that beat the
   *  invoke's reply onto the channel is already held. */
  | { type: "snapshot"; snapshot: ConvoSnapshot }
  | { type: "batch"; batch: ConvoBatch }
  /** `convo_page`'s answer: older events. */
  | { type: "page"; page: ConvoPage }
  /** The composer announced a send (`convo_expect`). */
  | { type: "expect"; nonce: string; text: string; at: number }
  /** A send that never reached the PTY (blocked, failed): its bubble goes. */
  | { type: "retract"; nonce: string }
  /** The reader is back at the live end: fall back to `MAX_ROWS`. */
  | { type: "trim" };

const EMPTY_FACTS: ConvoFacts = {
  bound: null,
  mode: null,
  model: null,
  readiness: null,
  asks: {},
  closed: {},
  plans: {},
};

export function initialConvoState(): ConvoState {
  return {
    events: [],
    seq: {},
    nextSeq: 0,
    hasOlder: false,
    limit: MAX_ROWS,
    sends: [],
    facts: EMPTY_FACTS,
  };
}

export function convoReducer(state: ConvoState, action: ConvoAction): ConvoState {
  switch (action.type) {
    case "reset":
      return initialConvoState();
    case "snapshot": {
      const next = ingest(state, action.snapshot.events);
      const older = action.snapshot.hasOlder && !next.hasOlder ? { ...next, hasOlder: true } : next;
      return trimTo(older, older.limit);
    }
    case "batch": {
      if (action.batch.reset) {
        const fresh = ingest(initialConvoState(), action.batch.events);
        return trimTo(fresh, MAX_ROWS);
      }
      // Scrolled up into paged rows: nothing falls off under the reader.
      const next = ingest(state, action.batch.events);
      return state.limit > MAX_ROWS ? next : trimTo(next, MAX_ROWS);
    }
    case "page": {
      const next = ingest(state, action.page.events);
      const limit = Math.max(next.limit, rowCount(next.events));
      if (next === state && limit === state.limit && state.hasOlder === action.page.hasOlder) return state;
      return { ...next, hasOlder: action.page.hasOlder, limit };
    }
    case "expect": {
      if (state.sends.some((send) => send.nonce === action.nonce)) return state;
      const send: PendingSend = {
        nonce: action.nonce,
        text: action.text,
        at: action.at,
        status: "pending",
        promptId: null,
        absorbedBy: null,
      };
      return { ...state, sends: absorb([...state.sends, send], state.events) };
    }
    case "retract": {
      const sends = state.sends.filter((send) => send.nonce !== action.nonce);
      return sends.length === state.sends.length ? state : { ...state, sends };
    }
    case "trim": {
      if (state.limit === MAX_ROWS) return state;
      return trimTo({ ...state, limit: MAX_ROWS }, MAX_ROWS);
    }
  }
}

// ── Merge ─────────────────────────────────────────────────────────────────

function keyOf(event: ConvoEvent, seq: Readonly<Record<string, number>>): EventKey {
  return { epoch: event.epoch, offset: event.offset, seq: seq[event.id] ?? 0 };
}

export function compareKeys(a: EventKey, b: EventKey): number {
  return a.epoch - b.epoch || a.offset - b.offset || a.seq - b.seq;
}

/** Upsert `incoming` by id. The same events again return `state` itself. */
function ingest(state: ConvoState, incoming: readonly ConvoEvent[]): ConvoState {
  if (incoming.length === 0) return state;
  const byId = new Map(state.events.map((event) => [event.id, event] as const));
  let seq: Record<string, number> | null = null;
  let nextSeq = state.nextSeq;
  const changed: ConvoEvent[] = [];
  for (const event of incoming) {
    const prev = byId.get(event.id);
    if (prev && sameEvent(prev, event)) continue;
    if (!(event.id in state.seq) && !(seq && event.id in seq)) {
      seq ??= { ...state.seq };
      seq[event.id] = nextSeq++;
    }
    byId.set(event.id, event);
    changed.push(event);
  }
  if (changed.length === 0) return state;
  const seqs = seq ?? state.seq;
  const events = [...byId.values()].sort((a, b) => compareKeys(keyOf(a, seqs), keyOf(b, seqs)));
  changed.sort((a, b) => compareKeys(keyOf(a, seqs), keyOf(b, seqs)));
  const facts = applyFacts(state.facts, changed, seqs);
  const sends = absorb(settleSends(state.sends, changed), events);
  return { ...state, events, seq: seqs, nextSeq, facts, sends };
}

function sameEvent(a: ConvoEvent, b: ConvoEvent): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** The sticky facts, each moved only by an event newer than the one that
 *  set it. `changed` is in order, so within one batch the last word wins. */
function applyFacts(
  facts: ConvoFacts,
  changed: readonly ConvoEvent[],
  seq: Readonly<Record<string, number>>,
): ConvoFacts {
  let next = facts;
  const newer = (stamp: Stamped<unknown> | null | undefined, key: EventKey) =>
    !stamp || compareKeys(key, stamp.key) >= 0;
  for (const event of changed) {
    const key = keyOf(event, seq);
    switch (event.kind) {
      case "bound":
        if (newer(next.bound, key))
          next = {
            ...next,
            bound: {
              key,
              value: { harness: event.harness, sessionId: event.sessionId, transcriptPath: event.transcriptPath },
            },
          };
        break;
      case "mode_change":
        if (newer(next.mode, key)) next = { ...next, mode: { key, value: event.mode } };
        break;
      case "model_seen":
        if (newer(next.model, key))
          next = { ...next, model: { key, value: { model: event.model, effort: event.effort ?? null } } };
        break;
      case "readiness":
        if (newer(next.readiness, key))
          next = { ...next, readiness: { key, value: { ready: event.ready, blocker: event.blocker } } };
        break;
      case "ask_opened":
        if (newer(next.asks[event.ask.askId], key))
          next = { ...next, asks: { ...next.asks, [event.ask.askId]: { key, value: event.ask } } };
        break;
      case "ask_closed":
        if (next.closed[event.askId] !== event.outcome)
          next = { ...next, closed: { ...next.closed, [event.askId]: event.outcome } };
        break;
      case "plan_proposed": {
        const prev = next.plans[event.toolUseId];
        next = {
          ...next,
          plans: {
            ...next.plans,
            [event.toolUseId]: {
              key: prev && compareKeys(prev.key, key) < 0 ? prev.key : key,
              value: {
                toolUseId: event.toolUseId,
                sessionId: event.sessionId,
                title: event.title ?? null,
                outcome: prev?.value.outcome ?? null,
                feedback: prev?.value.feedback ?? null,
              },
            },
          },
        };
        break;
      }
      case "plan_outcome": {
        const prev = next.plans[event.toolUseId];
        // An outcome whose proposal hasn't been seen yet (a page landing
        // late) is kept under the proposal's id, keyed AFTER it, so the
        // proposal fills it in when it arrives.
        next = {
          ...next,
          plans: {
            ...next.plans,
            [event.toolUseId]: {
              key: prev?.key ?? key,
              value: {
                toolUseId: event.toolUseId,
                sessionId: prev?.value.sessionId ?? "",
                title: prev?.value.title ?? null,
                outcome: event.outcome,
                feedback: event.feedback ?? null,
              },
            },
          },
        };
        break;
      }
      default:
        break;
    }
  }
  return next;
}

// ── Sends ─────────────────────────────────────────────────────────────────

/** `delivered` / `undelivered` move their send. Delivered wins over a late
 *  undelivered: the transcript has the prompt, whatever the timer said. */
function settleSends(sends: readonly PendingSend[], changed: readonly ConvoEvent[]): readonly PendingSend[] {
  let next = sends;
  for (const event of changed) {
    if (event.kind !== "delivered" && event.kind !== "undelivered") continue;
    const i = next.findIndex((send) => send.nonce === event.nonce);
    if (i < 0) continue;
    const send = next[i];
    const moved: PendingSend =
      event.kind === "delivered"
        ? { ...send, status: "delivered", promptId: event.promptId ?? send.promptId }
        : send.status === "delivered"
          ? send
          : { ...send, status: "undelivered" };
    if (moved !== send) next = next.map((s, j) => (j === i ? moved : s));
  }
  return next;
}

/** Collapse whitespace and drop control characters: what `pty_submit`
 *  sanitises away, and what the transcript trims, never decides a match. */
export function normalizeSendText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
}

/** Match each unabsorbed send, oldest first, to a `user_text` no other send
 *  holds: by `promptId` when both sides have one, else by its text, from no
 *  earlier than the send itself. */
function absorb(sends: readonly PendingSend[], events: readonly ConvoEvent[]): readonly PendingSend[] {
  if (!sends.some((send) => send.absorbedBy === null)) return sends;
  const claimed = new Set(sends.map((send) => send.absorbedBy).filter((id): id is string => id !== null));
  const prompts = events.filter(
    (event): event is Extract<ConvoEvent, { kind: "user_text" }> => event.kind === "user_text",
  );
  let changed = false;
  const next = sends.map((send) => {
    if (send.absorbedBy !== null) return send;
    const open = prompts.filter((event) => !claimed.has(event.id));
    const byPrompt = send.promptId ? open.find((event) => event.promptId === send.promptId) : undefined;
    const text = normalizeSendText(send.text);
    const match =
      byPrompt ??
      open.find(
        (event) => event.ts >= send.at - TEXT_MATCH_SKEW_MS && normalizeSendText(event.text) === text,
      );
    if (!match) return send;
    claimed.add(match.id);
    changed = true;
    return { ...send, absorbedBy: match.id };
  });
  return changed ? next : sends;
}

// ── The cap ───────────────────────────────────────────────────────────────

function rowCount(events: readonly ConvoEvent[]): number {
  let rows = 0;
  for (const event of events) if (ROW_KINDS.has(event.kind)) rows++;
  return rows;
}

/** Keep the newest `limit` rows (and what sits between them). What falls off
 *  takes its absorbed sends, its closed asks and its superseded plans along;
 *  the open asks and the latest plan stay, because they still matter. */
function trimTo(state: ConvoState, limit: number): ConvoState {
  let rows = 0;
  let cut = 0;
  for (let i = state.events.length - 1; i >= 0; i--) {
    if (!ROW_KINDS.has(state.events[i].kind)) continue;
    if (++rows > limit) {
      cut = i + 1;
      break;
    }
  }
  if (cut === 0) return state;
  const kept = state.events.slice(cut);
  const first = keyOf(kept[0] ?? state.events[state.events.length - 1], state.seq);
  const ids = new Set(kept.map((event) => event.id));
  const seq: Record<string, number> = {};
  for (const event of kept) seq[event.id] = state.seq[event.id];
  const latest = latestPlan(state.facts);
  const asks: Record<string, Stamped<ConvoAsk>> = {};
  const closed: Record<string, ConvoAskOutcome> = {};
  for (const [id, ask] of Object.entries(state.facts.asks)) {
    const outcome = state.facts.closed[id];
    if (outcome === undefined || compareKeys(ask.key, first) >= 0) {
      asks[id] = ask;
      if (outcome !== undefined) closed[id] = outcome;
    }
  }
  const plans: Record<string, Stamped<PlanFact>> = {};
  for (const [id, plan] of Object.entries(state.facts.plans))
    if (plan === latest || compareKeys(plan.key, first) >= 0) plans[id] = plan;
  return {
    ...state,
    events: kept,
    seq,
    hasOlder: true,
    sends: state.sends.filter((send) => send.absorbedBy === null || ids.has(send.absorbedBy)),
    facts: { ...state.facts, asks, closed, plans },
  };
}

function latestPlan(facts: ConvoFacts): Stamped<PlanFact> | null {
  let latest: Stamped<PlanFact> | null = null;
  for (const plan of Object.values(facts.plans))
    if (plan.value.sessionId && (!latest || compareKeys(plan.key, latest.key) > 0)) latest = plan;
  return latest;
}

// ── The view ──────────────────────────────────────────────────────────────

export interface UserBubble {
  /** The transcript event, or `send:<nonce>` for an optimistic one. */
  id: string;
  text: string;
  /** `sent`: the transcript has it. The rest are an optimistic bubble's. */
  delivery: "sent" | "pending" | "delivered" | "undelivered";
  nonce: string | null;
}

export type ToolStatus = "running" | "done" | "error";

/** One thing a turn did. `at` is its event's `ts`. */
export type TurnItem =
  | { kind: "prose"; id: string; at: number; text: string }
  | { kind: "thinking"; id: string; at: number }
  | {
      kind: "tool";
      id: string;
      at: number;
      toolUseId: string;
      name: string;
      summary: string;
      status: ToolStatus;
      preview: string | null;
    }
  | { kind: "compact"; id: string; at: number; trigger: "manual" | "auto" | null }
  | { kind: "plan"; id: string; at: number; plan: PlanFact }
  | { kind: "ask"; id: string; at: number; ask: ConvoAsk; outcome: ConvoAskOutcome | null };

export interface Turn {
  id: string;
  epoch: number;
  /** Null for a turn whose prompt is out of view (or a turn the CLI started
   *  by itself). */
  user: UserBubble | null;
  items: TurnItem[];
  startedAt: number;
  /** When it ended: `turn_end`, an interrupt, or the next prompt. */
  endedAt: number | null;
  durationMs: number | null;
  ended: boolean;
  interrupted: boolean;
}

export type Block =
  | { kind: "turn"; turn: Turn }
  | { kind: "epoch"; id: string; reason: "clear" | "resume" | "fork" }
  | { kind: "compact"; id: string; trigger: "manual" | "auto" | null };

export interface ConvoView {
  blocks: Block[];
  /** Optimistic bubbles the transcript hasn't shown yet, oldest first. They
   *  render after `blocks`. */
  pending: UserBubble[];
  /** The turn still running, if any: the last one, not ended. */
  activeTurn: Turn | null;
  lastTurn: Turn | null;
  mode: ConvoMode | null;
  model: ModelFact | null;
  readiness: ReadinessFact | null;
  bound: BoundFact | null;
  /** Asks no one has answered yet, oldest first. */
  openAsks: ConvoAsk[];
  /** The CLI's own type-ahead queue (`queued`), oldest first. */
  queue: string[];
  /** The latest plan proposed, with its outcome once it has one. */
  plan: PlanFact | null;
  hasOlder: boolean;
  /** Where `convo_page` continues from. */
  oldest: { epoch: number; offset: number } | null;
}

/** What a turn is made of: the kinds that move its last-seen time. A host
 *  event (readiness, a delivery) belongs to no turn. */
const TURN_CONTENT: ReadonlySet<ConvoEventKind> = new Set<ConvoEventKind>([
  "assistant_text",
  "thinking",
  "tool_use",
  "tool_result",
  "compact",
  "plan_proposed",
  "plan_outcome",
  "ask_opened",
  "ask_closed",
]);

interface Draft extends Turn {
  tools: Map<string, number>;
  plans: Map<string, number>;
  asks: Map<string, number>;
  lastTs: number;
}

export function convoView(state: ConvoState): ConvoView {
  const { facts } = state;
  const blocks: Block[] = [];
  const absorbed = new Map<string, PendingSend>();
  for (const send of state.sends) if (send.absorbedBy) absorbed.set(send.absorbedBy, send);
  let current: Draft | null = null;
  let queue: string[] = [];

  const open = (event: ConvoEvent, user: UserBubble | null): Draft => {
    const draft: Draft = {
      id: `turn:${event.id}`,
      epoch: event.epoch,
      user,
      items: [],
      startedAt: event.ts,
      endedAt: null,
      durationMs: null,
      ended: false,
      interrupted: false,
      tools: new Map(),
      plans: new Map(),
      asks: new Map(),
      lastTs: event.ts,
    };
    blocks.push({ kind: "turn", turn: draft });
    return draft;
  };
  /** A turn ended by what came after it, not by its own `turn_end`. */
  const close = () => {
    if (current && !current.ended) {
      current.ended = true;
      current.endedAt = current.lastTs;
      current.durationMs = Math.max(0, current.lastTs - current.startedAt);
    }
    current = null;
  };
  const ensure = (event: ConvoEvent): Draft => (current ??= open(event, null));

  for (const event of state.events) {
    if (current && TURN_CONTENT.has(event.kind)) current.lastTs = Math.max(current.lastTs, event.ts);
    switch (event.kind) {
      case "epoch":
        close();
        queue = [];
        blocks.push({ kind: "epoch", id: event.id, reason: event.reason });
        break;
      case "user_text": {
        close();
        const send = absorbed.get(event.id);
        current = open(event, {
          id: event.id,
          text: event.text,
          delivery: "sent",
          nonce: send?.nonce ?? null,
        });
        break;
      }
      case "assistant_text": {
        if (!event.text.trim()) break;
        ensure(event).items.push({ kind: "prose", id: event.id, at: event.ts, text: event.text });
        break;
      }
      case "thinking": {
        const turn = ensure(event);
        // One mark for a run of thinking blocks: the text is never shown,
        // so two in a row say nothing more than one.
        if (turn.items[turn.items.length - 1]?.kind !== "thinking") turn.items.push({ kind: "thinking", id: event.id, at: event.ts });
        break;
      }
      case "tool_use": {
        const turn = ensure(event);
        turn.tools.set(event.toolUseId, turn.items.length);
        turn.items.push({
          kind: "tool",
          id: event.id,
          at: event.ts,
          toolUseId: event.toolUseId,
          name: event.name,
          summary: event.summary,
          status: "running",
          preview: null,
        });
        break;
      }
      case "tool_result": {
        const at = current?.tools.get(event.toolUseId);
        const item = at === undefined ? undefined : current!.items[at];
        if (item?.kind === "tool")
          current!.items[at!] = { ...item, status: event.isError ? "error" : "done", preview: event.preview || null };
        break;
      }
      case "interrupted":
        if (current) {
          current.interrupted = true;
          current.ended = true;
          current.endedAt = event.ts;
          current.durationMs = Math.max(0, event.ts - current.startedAt);
          current = null;
        }
        break;
      case "turn_end":
        if (current) {
          current.ended = true;
          current.endedAt = event.ts;
          current.durationMs = event.durationMs ?? Math.max(0, event.ts - current.startedAt);
          current = null;
        }
        break;
      case "compact":
        if (current) current.items.push({ kind: "compact", id: event.id, at: event.ts, trigger: event.trigger ?? null });
        else blocks.push({ kind: "compact", id: event.id, trigger: event.trigger ?? null });
        break;
      case "plan_proposed": {
        const turn = ensure(event);
        const plan = facts.plans[event.toolUseId]?.value ?? {
          toolUseId: event.toolUseId,
          sessionId: event.sessionId,
          title: event.title ?? null,
          outcome: null,
          feedback: null,
        };
        turn.plans.set(event.toolUseId, turn.items.length);
        turn.items.push({ kind: "plan", id: event.id, at: event.ts, plan });
        break;
      }
      case "ask_opened": {
        const turn = ensure(event);
        turn.asks.set(event.ask.askId, turn.items.length);
        turn.items.push({ kind: "ask", id: event.id, at: event.ts, ask: event.ask, outcome: facts.closed[event.ask.askId] ?? null });
        break;
      }
      case "queued":
        if (event.op === "enqueue") {
          if (event.text) queue.push(event.text);
        } else if (event.op === "dequeue") queue.shift();
        else if (event.op === "popAll") queue = [];
        else if (event.op === "remove") {
          const at = event.text ? queue.indexOf(event.text) : -1;
          if (at >= 0) queue.splice(at, 1);
        }
        break;
      default:
        break;
    }
  }

  const turns = blocks.flatMap((block) => (block.kind === "turn" ? [block.turn] : []));
  const lastTurn = turns[turns.length - 1] ?? null;
  const pending: UserBubble[] = state.sends
    .filter((send) => send.absorbedBy === null)
    .map((send) => ({ id: `send:${send.nonce}`, text: send.text, delivery: send.status, nonce: send.nonce }));
  const openAsks = Object.entries(facts.asks)
    .filter(([id]) => facts.closed[id] === undefined)
    .map(([, ask]) => ask)
    .sort((a, b) => compareKeys(a.key, b.key))
    .map((ask) => ask.value);
  const first = state.events[0];
  return {
    blocks: blocks.map((block) => (block.kind === "turn" ? { kind: "turn", turn: finish(block.turn as Draft) } : block)),
    pending,
    activeTurn: lastTurn && !lastTurn.ended ? finish(lastTurn as Draft) : null,
    lastTurn: lastTurn ? finish(lastTurn as Draft) : null,
    mode: facts.mode?.value ?? null,
    model: facts.model?.value ?? null,
    readiness: facts.readiness?.value ?? null,
    bound: facts.bound?.value ?? null,
    openAsks,
    queue,
    plan: latestPlan(facts)?.value ?? null,
    hasOlder: state.hasOlder,
    oldest: first ? { epoch: first.epoch, offset: first.offset } : null,
  };
}

/** A draft's working maps stay behind; the same draft always yields the
 *  same turn object, so a block and `activeTurn` are one value. */
const finished = new WeakMap<Draft, Turn>();
function finish(draft: Draft): Turn {
  let turn = finished.get(draft);
  if (!turn) {
    turn = {
      id: draft.id,
      epoch: draft.epoch,
      user: draft.user,
      items: draft.items,
      startedAt: draft.startedAt,
      endedAt: draft.endedAt,
      durationMs: draft.durationMs,
      ended: draft.ended,
      interrupted: draft.interrupted,
    };
    finished.set(draft, turn);
  }
  return turn;
}
