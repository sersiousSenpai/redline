// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// What each dock terminal is doing, as ONE derived state. TerminalTabs holds
// the signals — the agent's own hooks (`term-attention`), the held plans, the
// PTY's exit, and `pty_procs`' foreground program and ports — and the tile
// headers, the shelf, the menu, the footer and the notifications all read the
// single answer this module gives. No React, no Tauri: the component owns the
// listeners and timers, this owns the rules.
//
// The hooks report transitions; the clearing rules that need what only the
// frontend knows live here too, each one an acknowledgement of a specific
// transition (keyed by its `at`), so a NEW transition is never swallowed by
// an old acknowledgement:
//
//  * typing into a terminal that needs you means you answered it → working;
//  * Esc / Ctrl-C interrupts the agent, which fires no hook at all (measured,
//    docs/protocol-verification.md experiment (l)) → cleared;
//  * a your-turn whose tile has been on screen and focused for SEEN_AFTER_MS
//    has been read → seen;
//  * a process sample taken after the transition that shows the shell back in
//    the foreground means the agent that reported it is gone → cleared.

import type { TermAttention, TermProc } from "../types";

export type TermState =
  | "needs-you"
  | "your-turn"
  | "working"
  | "running"
  | "serving"
  | "held"
  | "idle"
  | "exited";

export type AttentionKind = TermAttention["kind"];

/** How long a your-turn must sit in the focused, visible tile to count as read. */
export const SEEN_AFTER_MS = 1000;

/** Words for a state, wherever one is named (menu chips, shelf tooltips,
 *  notification titles). */
export const TERM_STATE_LABEL: Record<TermState, string> = {
  "needs-you": "needs you",
  "your-turn": "your turn",
  working: "working",
  running: "running",
  serving: "serving",
  held: "plan held",
  idle: "idle",
  exited: "exited",
};

/** The signals one terminal's state is derived from. */
export interface TermSignals {
  /** The agent's latest hook state AFTER local acknowledgements
   *  (`effectiveAttention`); null when no hook has spoken or it was cleared. */
  attention: AttentionKind | null;
  /** The current your-turn has been read (see SEEN_AFTER_MS). */
  seen: boolean;
  /** A plan from this terminal is held for review (`heldTerminalIds`). */
  held: boolean;
  /** The PTY's process exited (`handleExit`). */
  exited: boolean;
  /** `pty_procs`: the foreground job's program, and whether that is the shell
   *  itself. Both unknown until the first sample lands. */
  fgComm: string | null;
  fgIsShell: boolean;
  /** TCP ports something under this terminal listens on. */
  ports: readonly number[];
  /** The dock's untouched convenience shell. */
  placeholder: boolean;
}

/** Programs that are an AGENT in the foreground rather than a job: an agent at
 *  its prompt with no hook state is idle, not "running". */
const AGENT_COMMS = new Set(["claude", "codex"]);

/** Whether the foreground program is an agent. A `node` that has spoken
 *  through the hooks is one too — an npm-installed CLI runs as `node`. */
export function isAgentComm(comm: string | null, hasAttention: boolean): boolean {
  if (!comm) return false;
  const name = comm.toLowerCase();
  return AGENT_COMMS.has(name) || (hasAttention && name === "node");
}

/** The first state that applies, in priority order. `exited` comes FIRST,
 *  not last: a dead PTY cannot need anything, whatever its last hook said —
 *  and as a fallthrough beneath `idle` it could never apply at all. A
 *  placeholder is idle before any process reading, so a shell still running
 *  its rc files never flashes as "running". */
export function deriveTermState(s: TermSignals): TermState {
  if (s.exited) return "exited";
  if (s.attention === "needs-you") return "needs-you";
  if (s.attention === "your-turn" && !s.seen) return "your-turn";
  if (s.held) return "held";
  if (s.attention === "working") return "working";
  if (s.placeholder) return "idle";
  if (s.ports.length > 0) return "serving";
  if (
    !s.fgIsShell &&
    s.fgComm !== null &&
    !isAgentComm(s.fgComm, s.attention !== null)
  ) {
    return "running";
  }
  return "idle";
}

/** Loud states want you now: they glow, count in the footer and notify. */
export function isLoud(s: TermState): boolean {
  return s === "needs-you" || s === "your-turn";
}

/** Quiet states are safe to take off the wall (see tilePolicy's parking). */
export function isQuiet(s: TermState): boolean {
  return s === "held" || s === "serving" || s === "idle" || s === "exited";
}

// ── Acknowledgements ──────────────────────────────────────────────────────

/** A local answer to ONE attention transition, matched by its `at`. A new
 *  transition carries a new `at`, so an old acknowledgement can never hide
 *  it — even when the kind repeats (two permission cards in a row). */
export interface AttentionAck {
  at: number;
  /** "working": you answered a needs-you. "seen": you read a your-turn.
   *  "cleared": the transition no longer describes the terminal. */
  as: "working" | "seen" | "cleared";
}

/** The attention a terminal's state should be derived from, after its
 *  acknowledgement. */
export function effectiveAttention(
  entry: TermAttention | undefined,
  ack: AttentionAck | undefined,
): { kind: AttentionKind | null; seen: boolean } {
  if (!entry) return { kind: null, seen: false };
  if (!ack || ack.at !== entry.at) return { kind: entry.kind, seen: false };
  if (ack.as === "cleared") return { kind: null, seen: false };
  if (ack.as === "working") return { kind: "working", seen: false };
  return { kind: entry.kind, seen: entry.kind === "your-turn" };
}

/** The acknowledgement a keystroke into this terminal makes, or null when it
 *  changes nothing. An interrupt (Esc, Ctrl-C) stops the agent: whatever it
 *  was doing or asking is over, and no hook will say so. Any other input
 *  answers a needs-you (the agent goes back to work) and reads a your-turn. */
export function ackForInput(
  entry: TermAttention | undefined,
  current: AttentionAck | undefined,
  interrupt: boolean,
): AttentionAck | null {
  if (!entry) return null;
  const { kind } = effectiveAttention(entry, current);
  if (interrupt && (kind === "working" || kind === "needs-you")) {
    return { at: entry.at, as: "cleared" };
  }
  if (kind === "needs-you") return { at: entry.at, as: "working" };
  if (kind === "your-turn" && !(current?.at === entry.at && current.as === "seen")) {
    return { at: entry.at, as: "seen" };
  }
  return null;
}

/** A process sample taken at `sampledAt` that shows the shell back in the
 *  foreground outlives every transition before it: the agent that reported
 *  it has exited. Returns the acknowledgements to add (empty when none) —
 *  only for transitions older than the sample, so a hook that fires between
 *  the sample's request and its answer is never cleared by it. */
export function staleAcks(
  attention: ReadonlyMap<string, TermAttention>,
  acks: ReadonlyMap<string, AttentionAck>,
  procs: readonly TermProc[],
  sampledAt: number,
): [string, AttentionAck][] {
  const out: [string, AttentionAck][] = [];
  for (const proc of procs) {
    if (!proc.fgIsShell) continue;
    const entry = attention.get(proc.id);
    if (!entry || entry.at >= sampledAt) continue;
    if (effectiveAttention(entry, acks.get(proc.id)).kind === null) continue;
    out.push([proc.id, { at: entry.at, as: "cleared" }]);
  }
  return out;
}

// ── The event stream ──────────────────────────────────────────────────────

/** Fold hook events into the latest-per-terminal map. A newer `at` replaces;
 *  the SAME `at` is the same transition filling in its excerpt (it can arrive
 *  in a second event) and replaces too; an older one is a straggler and is
 *  dropped. Returns `prev` itself when nothing changed, so a no-op event
 *  costs no render. */
export function mergeAttention(
  prev: ReadonlyMap<string, TermAttention>,
  events: readonly TermAttention[],
): ReadonlyMap<string, TermAttention> {
  let next: Map<string, TermAttention> | null = null;
  for (const e of events) {
    if (!e || typeof e.terminalId !== "string" || typeof e.at !== "number") continue;
    const cur = (next ?? prev).get(e.terminalId);
    if (cur && (cur.at > e.at || sameAttention(cur, e))) continue;
    if (!next) next = new Map(prev);
    next.set(e.terminalId, e);
  }
  return next ?? prev;
}

function sameAttention(a: TermAttention, b: TermAttention): boolean {
  return a.at === b.at && a.kind === b.kind && attentionText(a) === attentionText(b);
}

/** What the agent said with a loud transition: the needs-you message or the
 *  your-turn excerpt. */
export function attentionText(entry: TermAttention | undefined): string | null {
  if (!entry) return null;
  if (entry.kind === "needs-you") return entry.message;
  if (entry.kind === "your-turn") return entry.excerpt;
  return null;
}

/** The loud terminals among `ids`, oldest transition first — the order ⌘⇧J
 *  walks and the footer counts. Ties keep `ids` order (stable sort). */
export function loudOldestFirst(
  ids: readonly string[],
  states: ReadonlyMap<string, TermState>,
  attention: ReadonlyMap<string, TermAttention>,
): string[] {
  return ids
    .filter((id) => isLoud(states.get(id) ?? "idle"))
    .sort((a, b) => (attention.get(a)?.at ?? 0) - (attention.get(b)?.at ?? 0));
}

/** ⌘⇧J's target: the terminal after the focused one in the oldest-first loud
 *  list, wrapping — so repeated presses walk every terminal that needs you
 *  rather than bouncing between the first two. Null when nothing is loud. */
export function nextNeedsYou(
  loudOldestFirst: readonly string[],
  focusedId: string | null | undefined,
): string | null {
  if (loudOldestFirst.length === 0) return null;
  const i = focusedId ? loudOldestFirst.indexOf(focusedId) : -1;
  return loudOldestFirst[(i + 1) % loudOldestFirst.length];
}

/** Record one acknowledgement, returning `prev` itself when it is already
 *  there — a keystroke that changes nothing must cost no render. */
export function putAck(
  prev: ReadonlyMap<string, AttentionAck>,
  id: string,
  ack: AttentionAck,
): ReadonlyMap<string, AttentionAck> {
  const cur = prev.get(id);
  if (cur && cur.at === ack.at && cur.as === ack.as) return prev;
  const next = new Map(prev);
  next.set(id, ack);
  return next;
}

/** Fold a `pty_procs` sample into the per-terminal map, returning `prev`
 *  itself when no terminal's program or ports moved — the poll runs every
 *  few seconds and an unchanged fleet must not re-render the wall. */
export function mergeProcs(
  prev: ReadonlyMap<string, TermProc>,
  rows: readonly TermProc[],
): ReadonlyMap<string, TermProc> {
  const valid = rows.filter(
    (r) => r && typeof r.id === "string" && Array.isArray(r.ports),
  );
  const same =
    valid.length === prev.size &&
    valid.every((r) => {
      const p = prev.get(r.id);
      return (
        !!p &&
        p.fgComm === r.fgComm &&
        p.fgIsShell === r.fgIsShell &&
        p.ports.length === r.ports.length &&
        p.ports.every((port, i) => port === r.ports[i])
      );
    });
  return same ? prev : new Map(valid.map((r) => [r.id, r]));
}
