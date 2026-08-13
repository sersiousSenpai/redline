// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! ONE lifecycle for every streaming chat surface (browse, linked, mission,
//! memchat), replacing the copy-pasted component-local machinery whose state
//! died on every surface switch. The backend turn registry is the durable
//! truth; this hook makes a remount lossless:
//!
//! - Mount subscribes the `${surface}-*` events FIRST, and only then fires the
//!   thread load + `${surface}_turn_status` probe in parallel — with the
//!   reducer's seq guard, no interleaving of probe text and live deltas can
//!   drop or double a chunk.
//! - While a turn streams, a 10s re-probe with a two-consecutive-miss rule
//!   self-heals a panel whose terminal event was lost (the reader persists the
//!   terminal row before emitting, so a refetch settles the thread truthfully).
//!   A done event racing the first false probe disarms the counter.
//!
//! The imperative core is `AgentTurnController`, a plain class with injected
//! `invoke`/`listen` so the mount ordering and self-heal are unit-testable
//! without rendering; `useAgentTurn` is a thin subscription wrapper.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

import {
  initialTurnState,
  reduceTurn,
  type TurnAction,
  type TurnMessage,
  type TurnPhase,
  type TurnState,
} from "../lib/agentTurn";
import type { QueuedTurn, SendOutcome, TurnStatus } from "../types";

export type AgentSurface = "browse" | "linked" | "mission" | "memchat";

export interface AgentTurnConfig<M extends TurnMessage> {
  surface: AgentSurface;
  /** The backend registry key (browseId / linkedId / missionId); a singleton
   *  surface passes its constant thread id. */
  key: string;
  /** The event-payload field carrying that key — also the arg name for the
   *  status/cancel commands. `null` = singleton: every event is ours and the
   *  commands take no key. */
  idField: string | null;
  /** The persisted-thread command (names predate the shared contract:
   *  `get_browse_thread`, `linked_get_thread`, `get_mission_thread`,
   *  `memchat_thread`). */
  historyCmd: string;
  historyArgs?: Record<string, unknown>;
  /** Error-bubble prefix for a send that never reached the backend,
   *  e.g. "Couldn't reach the browse agent". */
  sendFailPrefix: string;
  /** Build the `${surface}_send` args. Async is fine (surface quirks: browse
   *  first-turn snapshot, linked per-turn snapshot); the controller bails if
   *  the panel unmounted or switched keys during the await. */
  buildSendArgs: (
    text: string,
    extra?: unknown,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Build a surface message row (owns `createdAt` and surface extras like
   *  linked's tab tag — read live state, the controller calls at event time). */
  makeMessage: (seed: {
    id: string;
    role: "user" | "assistant";
    body: string;
    status: "complete" | "error";
  }) => M;
}

export interface AgentTurn<M extends TurnMessage> {
  messages: M[];
  liveText: string;
  status: TurnPhase;
  startedAt: number | null;
  queued: QueuedTurn[];
  loaded: boolean;
  send: (text: string, opts?: SendOpts) => void;
  cancel: () => void;
  /** Pull a queued send back out (the bubble's ×). Resolves to its text so
   *  the composer can restore it; null when it already advanced. */
  unqueue: (messageId: string) => Promise<string | null>;
  /** Wipe the local thread after a backend-side discard/clear. */
  clear: () => void;
}

export interface SendOpts {
  /** Show this as the user bubble instead of the sent text (the mission's
   *  "✦ Synthesize the mission" stand-in). */
  localBody?: string;
  /** Passed through to `buildSendArgs` (e.g. the mission `synthesize` flag). */
  extra?: unknown;
}

/** Re-probe cadence while a turn streams (also the self-heal clock). */
export const HEAL_INTERVAL_MS = 10_000;

/** The two Tauri primitives the controller touches, injectable so the mount
 *  ordering and self-heal are testable without a webview. */
export interface AgentTurnIo {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  listen: <T>(
    event: string,
    handler: (e: { payload: T }) => void,
  ) => Promise<() => void>;
}

const TAURI_IO: AgentTurnIo = { invoke: tauriInvoke, listen: tauriListen };

let tmpSeq = 0;
const tmpId = (surface: string) => `${surface}-tmp-${++tmpSeq}`;

type DeltaPayload = { text: string; seq: number };
type DonePayload = { messageId: string; body: string };
type ErrorPayload = { error: string };
type QueueAdvancedPayload = { messageId: string };

export class AgentTurnController<M extends TurnMessage> {
  private state: TurnState<M> = initialTurnState<M>();
  private subs = new Set<() => void>();
  private unlistens: Array<() => void> | null = null;
  private alive = true;
  /** Consecutive self-heal probes that said "idle" while we showed a stream. */
  private miss = 0;
  private healTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private cfg: () => AgentTurnConfig<M>,
    private io: AgentTurnIo = TAURI_IO,
  ) {}

  getState = (): TurnState<M> => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  };

  private dispatch(action: TurnAction<M>) {
    if (!this.alive) return;
    const next = reduceTurn(this.state, action);
    if (next === this.state) return;
    this.state = next;
    this.syncHeal();
    for (const fn of this.subs) fn();
  }

  private mine(payload: Record<string, unknown>): boolean {
    const { idField, key } = this.cfg();
    return idField == null || payload[idField] === key;
  }

  private keyArgs(): Record<string, unknown> {
    const { idField, key } = this.cfg();
    return idField ? { [idField]: key } : {};
  }

  /** Subscribe the event stream, then load the thread and probe the turn.
   *  The listeners must be LIVE before the probe fires: a delta emitted after
   *  the probe snapshot is then guaranteed to reach us, and the seq guard
   *  handles every other overlap. */
  async attach(): Promise<void> {
    const { surface } = this.cfg();
    const on = <T>(name: string, fn: (p: T) => void) =>
      this.io.listen<T>(`${surface}-${name}`, (e) => {
        if (!this.alive || !this.mine(e.payload as Record<string, unknown>)) return;
        this.miss = 0; // any event is proof of life for the self-heal
        fn(e.payload);
      });
    const unlistens = await Promise.all([
      on<DeltaPayload>("delta", (p) =>
        this.dispatch({ type: "delta", seq: p.seq, text: p.text }),
      ),
      on<DonePayload>("done", (p) =>
        this.dispatch({
          type: "done",
          message: this.cfg().makeMessage({
            id: p.messageId,
            role: "assistant",
            body: p.body,
            status: "complete",
          }),
        }),
      ),
      on<ErrorPayload>("error", (p) =>
        this.dispatch({
          type: "error",
          message: this.cfg().makeMessage({
            id: tmpId(surface),
            role: "assistant",
            body: p.error,
            status: "error",
          }),
        }),
      ),
      on<Record<string, never>>("cancelled", () => this.dispatch({ type: "cancelled" })),
      on<QueueAdvancedPayload>("queue-advanced", (p) =>
        this.dispatch({ type: "queue-advanced", messageId: p.messageId }),
      ),
    ]);
    if (!this.alive) {
      for (const un of unlistens) un();
      return;
    }
    this.unlistens = unlistens;
    void this.fetchHistory();
    void this.probe();
  }

  detach(): void {
    this.alive = false;
    this.unlistens?.forEach((un) => un());
    this.unlistens = null;
    if (this.healTimer != null) clearInterval(this.healTimer);
    this.healTimer = null;
    this.subs.clear();
  }

  send(text: string, opts?: SendOpts): void {
    // Sending while a turn streams is type-ahead: the backend queues it
    // behind the in-flight turn (`queue: true` below) and the reducer shows
    // the bubble with a "Queued" chip.
    const trimmed = text.trim();
    if (!trimmed || !this.alive) return;
    const cfg = this.cfg();
    const id = tmpId(cfg.surface);
    this.dispatch({
      type: "send-optimistic",
      message: cfg.makeMessage({
        id,
        role: "user",
        body: opts?.localBody ?? trimmed,
        status: "complete",
      }),
    });
    void this.dispatchSend(id, trimmed, opts?.extra);
  }

  private async dispatchSend(tmp: string, text: string, extra?: unknown): Promise<void> {
    const cfg = this.cfg();
    let args: Record<string, unknown>;
    try {
      args = await cfg.buildSendArgs(text, extra);
    } catch (err) {
      this.sendFailed(tmp, err);
      return;
    }
    // The panel unmounted or switched keys during the build (a snapshot
    // capture can outlive a tab switch) — drop the send, like the surfaces
    // always have.
    if (!this.alive) return;
    try {
      const outcome = await this.io.invoke<SendOutcome | undefined>(
        `${cfg.surface}_send`,
        { ...args, queue: true },
      );
      if (this.alive && outcome) {
        this.dispatch({
          type: "send-resolved",
          tmpId: tmp,
          messageId: outcome.messageId,
          queued: outcome.queued,
        });
      }
    } catch (err) {
      if (this.alive) this.sendFailed(tmp, err);
    }
  }

  private sendFailed(tmp: string, err: unknown): void {
    const cfg = this.cfg();
    this.dispatch({ type: "send-failed", tmpId: tmp });
    this.dispatch({
      type: "error",
      message: cfg.makeMessage({
        id: tmpId(cfg.surface),
        role: "assistant",
        body: `${cfg.sendFailPrefix}: ${err}`,
        status: "error",
      }),
    });
  }

  cancel(): void {
    void this.io
      .invoke(`${this.cfg().surface}_cancel`, this.keyArgs())
      .catch(() => {});
  }

  /** Pull a queued send back out of the backend queue. Resolves to its text
   *  (for the composer to restore); null when it already advanced — the row
   *  then stays, because it IS (or is about to be) the streaming turn. */
  async unqueue(messageId: string): Promise<string | null> {
    const cfg = this.cfg();
    try {
      const text = await this.io.invoke<string | null>(`${cfg.surface}_unqueue`, {
        ...this.keyArgs(),
        messageId,
      });
      if (text != null && this.alive) this.dispatch({ type: "unqueued", messageId });
      return text ?? null;
    } catch {
      return null;
    }
  }

  /** Local wipe after a backend-side discard: empty thread, but `loaded` so
   *  the surface shows its empty-state hint, not the loading blank. */
  clear(): void {
    this.dispatch({ type: "reset" });
    this.dispatch({ type: "history", rows: [] });
  }

  private async fetchHistory(): Promise<void> {
    const cfg = this.cfg();
    try {
      const rows = await this.io.invoke<M[]>(cfg.historyCmd, cfg.historyArgs ?? {});
      if (this.alive) this.dispatch({ type: "history", rows });
    } catch {
      // Best-effort: an unreadable thread starts the panel empty.
      if (this.alive) this.dispatch({ type: "history", rows: [] });
    }
  }

  private async probe(): Promise<void> {
    const { surface } = this.cfg();
    try {
      const s = await this.io.invoke<TurnStatus>(
        `${surface}_turn_status`,
        this.keyArgs(),
      );
      if (this.alive) this.dispatch({ type: "probe", status: s });
    } catch {
      // A failed probe is no verdict either way.
    }
  }

  /** Keep the self-heal clock running exactly while a turn streams. */
  private syncHeal(): void {
    const want = this.state.phase === "streaming";
    if (want && this.healTimer == null) {
      this.miss = 0;
      this.healTimer = setInterval(() => void this.healTick(), HEAL_INTERVAL_MS);
    } else if (!want && this.healTimer != null) {
      clearInterval(this.healTimer);
      this.healTimer = null;
      this.miss = 0;
    }
  }

  private async healTick(): Promise<void> {
    const cfg = this.cfg();
    let s: TurnStatus;
    try {
      s = await this.io.invoke<TurnStatus>(
        `${cfg.surface}_turn_status`,
        this.keyArgs(),
      );
    } catch {
      return; // no verdict — leave the counter alone
    }
    if (!this.alive || this.state.phase !== "streaming") return;
    if (s.streaming) {
      this.miss = 0;
      // The refresh also repairs any delta gap: the probed text supersedes
      // the local accumulation whenever its seq is ahead.
      this.dispatch({ type: "probe", status: s });
      return;
    }
    // Two consecutive misses confirm the turn is gone (its terminal event was
    // lost) — one miss can be a done event racing the probe, which disarms
    // the counter when it lands.
    this.miss += 1;
    if (this.miss < 2) return;
    this.miss = 0;
    // The reader persisted the terminal row before emitting, so the refetched
    // thread is the truthful settled state.
    await this.fetchHistory();
    this.dispatch({ type: "settle" });
  }
}

const EMPTY_STATE = initialTurnState<TurnMessage>();

/** Bind a chat surface to its backend turn registry. Recreates the underlying
 *  controller when `surface`/`key` change; every other config field is read
 *  live at call time, so inline closures are fine. */
export function useAgentTurn<M extends TurnMessage>(
  config: AgentTurnConfig<M>,
): AgentTurn<M> {
  const cfgRef = useRef(config);
  cfgRef.current = config;
  const [ctl, setCtl] = useState<AgentTurnController<M> | null>(null);

  useEffect(() => {
    const c = new AgentTurnController<M>(() => cfgRef.current);
    setCtl(c);
    void c.attach();
    return () => c.detach();
    // The controller's identity IS the thread's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.surface, config.key]);

  const subscribe = useCallback(
    (fn: () => void) => (ctl ? ctl.subscribe(fn) : () => {}),
    [ctl],
  );
  const getSnapshot = useCallback(
    () => (ctl ? ctl.getState() : (EMPTY_STATE as TurnState<M>)),
    [ctl],
  );
  const state = useSyncExternalStore(subscribe, getSnapshot);

  const send = useCallback(
    (text: string, opts?: SendOpts) => ctl?.send(text, opts),
    [ctl],
  );
  const cancel = useCallback(() => ctl?.cancel(), [ctl]);
  const unqueue = useCallback(
    (messageId: string) => ctl?.unqueue(messageId) ?? Promise.resolve(null),
    [ctl],
  );
  const clear = useCallback(() => ctl?.clear(), [ctl]);

  return {
    messages: state.messages,
    liveText: state.liveText,
    status: state.phase,
    startedAt: state.startedAt,
    queued: state.queued,
    loaded: state.loaded,
    send,
    cancel,
    unqueue,
    clear,
  };
}
