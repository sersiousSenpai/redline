// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Session identity in the flow shell: what the session stage is showing.
//!
//! In flow a session exists from the moment it launches. Board 4b already
//! has a sidebar row, a title, a spinner and a conversation for it before any
//! plan row exists in the database, so "the selected plan" (App's `activeId`)
//! is not enough to say what is on the stage. Three things can be:
//!
//! - the New-session screen (`start`), the Front Door in flow mode;
//! - a launch whose plan has not arrived (`launch`), keyed by its terminal;
//! - a plan session (`plan`), with the terminal its CLI runs in when known.
//!
//! The handoff between the last two is the one that matters: when a launch's
//! plan arrives (`plan-received` carries the same Claude session id the
//! terminal's hooks report), the target flips from `launch` to `plan` with the
//! SAME terminal id, so the conversation bound to that terminal keeps its
//! identity and never remounts.
//!
//! Which terminal a plan session runs in comes from three places, folded into
//! one `sessionId → terminalId` map: the terminal-attention hooks (every entry
//! names its terminal and, once the CLI has reported it, its session), the
//! engine's app-wide `convo-bound` event (emitted on every bind, so a session
//! is known before its first turn ends), and a held plan's `heldTerminalId`.
//! The later report wins: a session restored into a fresh terminal moves.
//!
//! Everything but `useSessionTerminals` is pure; App owns the state.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { TermAttention } from "../types";
import {
  CONVO_BOUND_EVENT,
  CONVO_TITLE_EVENT,
  type ConvoBoundNotice,
  type ConvoTitleNotice,
} from "./convo/types";
import type { NeedReason } from "./sessionGroups";

/** What the session stage shows. */
export type StageTarget =
  | { kind: "start" }
  | {
      kind: "launch";
      terminalId: string;
      prompt: string;
      startedAt: number;
      projectPath: string | null;
    }
  | { kind: "plan"; sessionId: string; terminalId: string | null };

/** A session the stage can show before it has a plan: one `launchPlan`
 *  call, plan or run, recorded the moment its command reached a terminal. */
export interface FlowLaunch {
  launchId: string;
  terminalId: string;
  prompt: string;
  startedAt: number;
  projectPath: string | null;
  mode: "plan" | "run";
  /** Which CLI it runs: the conversation mirror reads the two differently. */
  harness: "claude" | "codex";
  /** The dock has reported this terminal live at least once. Until then an
   *  absent id is ignorance rather than news (the `launchLiveness` rule). */
  confirmed: boolean;
}

export type SessionTerminals = ReadonlyMap<string, string>;

/** A launch's slot, as App's `pendingLaunch` / `runFlight` hold it. */
export interface InFlight {
  terminalId: string;
  prompt: string;
  startedAt: number;
}

export interface StageInput {
  /** The plan session selected (App's `activeId`). */
  activeId: string | null;
  /** The launch the user is looking at, by terminal id; null follows
   *  `activeId`. App clears it whenever a session is selected. */
  focusedLaunch: string | null;
  launches: readonly FlowLaunch[];
  /** App's single pending plan launch and run flight. They stand in for a
   *  launch the list does not hold yet (the record and the slot are set in
   *  the same tick, but not the same render). */
  pendingLaunch?: InFlight | null;
  runFlight?: InFlight | null;
  terminals: SessionTerminals;
}

/** What the stage shows. A focused launch wins while it is still a launch;
 *  then the selected plan; then the New-session screen. */
export function deriveStageTarget(i: StageInput): StageTarget {
  if (i.focusedLaunch) {
    const id = i.focusedLaunch;
    const launch = i.launches.find((l) => l.terminalId === id);
    if (launch) {
      return {
        kind: "launch",
        terminalId: launch.terminalId,
        prompt: launch.prompt,
        startedAt: launch.startedAt,
        projectPath: launch.projectPath,
      };
    }
    const slot = [i.pendingLaunch, i.runFlight].find((f) => f?.terminalId === id);
    if (slot) {
      return {
        kind: "launch",
        terminalId: slot.terminalId,
        prompt: slot.prompt,
        startedAt: slot.startedAt,
        projectPath: null,
      };
    }
  }
  if (i.activeId) {
    return {
      kind: "plan",
      sessionId: i.activeId,
      terminalId: i.terminals.get(i.activeId) ?? null,
    };
  }
  return { kind: "start" };
}

/** Two targets that show the same thing — the stage keys its conversation
 *  on this, so a launch becoming its plan is NOT a change of conversation. */
export function stageTerminal(t: StageTarget): string | null {
  return t.kind === "start" ? null : t.terminalId;
}

// ── The launch list ─────────────────────────────────────────────────────────

export type LaunchEvent =
  | { type: "launched"; launch: Omit<FlowLaunch, "confirmed"> }
  /** Its plan arrived: from here on it is a plan session row. */
  | { type: "arrived"; launchId: string }
  /** The dock's live terminals; null while it has not reported. */
  | { type: "terminals"; live: readonly string[] | null };

/** The launches still waiting on a plan (or, for a run, still running).
 *  Returns `prev` by identity when nothing changed. */
export function reduceLaunches(
  prev: readonly FlowLaunch[],
  event: LaunchEvent,
): readonly FlowLaunch[] {
  switch (event.type) {
    case "launched": {
      const rest = prev.filter((l) => l.terminalId !== event.launch.terminalId);
      return [{ ...event.launch, confirmed: false }, ...rest];
    }
    case "arrived": {
      if (!event.launchId) return prev;
      const next = prev.filter((l) => l.launchId !== event.launchId);
      return next.length === prev.length ? prev : next;
    }
    case "terminals": {
      // Unreported is the absence of news, never a death certificate.
      if (event.live === null) return prev;
      const live = new Set(event.live);
      let changed = false;
      const next: FlowLaunch[] = [];
      for (const l of prev) {
        if (live.has(l.terminalId)) {
          if (!l.confirmed) changed = true;
          next.push(l.confirmed ? l : { ...l, confirmed: true });
        } else if (l.confirmed) {
          // Vouched for once, gone now: its terminal closed, and no plan can
          // come from a dead PTY.
          changed = true;
        } else {
          next.push(l);
        }
      }
      return changed ? next : prev;
    }
  }
}

/** The sidebar's launch rows (BRIEF, "Session identity in flow"): titled by
 *  the prompt's first line until a plan brings a title of its own, and
 *  spinning until the CLI reports the turn over. */
export interface SidebarLaunch {
  terminalId: string;
  title: string;
  startedAt: number;
  projectPath: string | null;
  working: boolean;
}

export function sidebarLaunches(
  launches: readonly FlowLaunch[],
  kinds: ReadonlyMap<string, TermAttention["kind"]>,
  titles: ReadonlyMap<string, string> = new Map(),
): SidebarLaunch[] {
  return launches.map((l) => {
    const kind = kinds.get(l.terminalId);
    return {
      terminalId: l.terminalId,
      // The CLI's own name for the session, once it has one (`convo-title`).
      title: titles.get(l.terminalId) || launchTitle(l.prompt),
      startedAt: l.startedAt,
      projectPath: l.projectPath,
      // Nothing heard yet is a CLI still starting, which is work.
      working: kind === undefined || kind === "working",
    };
  });
}

/** A prompt's first non-empty line, trimmed to a row's worth. */
export function launchTitle(prompt: string): string {
  const line = prompt.split("\n").map((s) => s.trim()).find(Boolean) ?? "";
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}

// ── sessionId → terminalId ──────────────────────────────────────────────────

/** Fold bindings into the map; the later report for a session wins. Returns
 *  `prev` by identity when nothing changed. */
export function bindTerminals(
  prev: SessionTerminals,
  pairs: readonly { sessionId: string | null; terminalId: string }[],
): SessionTerminals {
  let next: Map<string, string> | null = null;
  for (const { sessionId, terminalId } of pairs) {
    if (!sessionId || !terminalId) continue;
    if ((next ?? prev).get(sessionId) === terminalId) continue;
    next ??= new Map(prev);
    next.set(sessionId, terminalId);
  }
  return next ?? prev;
}

/** The terminals' latest attention entries: a newer transition (`at`)
 *  replaces an older one, whichever order the snapshot and the live events
 *  land in; the same `at` refills (a your-turn's excerpt arrives second). */
export function latestAttention(
  prev: ReadonlyMap<string, TermAttention>,
  entries: readonly TermAttention[],
): ReadonlyMap<string, TermAttention> {
  let next: Map<string, TermAttention> | null = null;
  for (const e of entries) {
    const held = (next ?? prev).get(e.terminalId);
    if (held && (held.at > e.at || held === e)) continue;
    next ??= new Map(prev);
    next.set(e.terminalId, e);
  }
  return next ?? prev;
}

/** The terminals' latest attention kinds, for the launch rows' spinners. */
export function attentionKinds(
  attention: ReadonlyMap<string, TermAttention>,
): ReadonlyMap<string, TermAttention["kind"]> {
  return new Map([...attention].map(([id, e]) => [id, e.kind]));
}

/** Why a CLI is waiting on you, in the sidebar's words. Claude reports an
 *  AskUserQuestion and a tool approval alike as `permission_prompt`, so the
 *  message tells them apart. */
export function needReason(e: TermAttention): NeedReason | null {
  if (e.kind !== "needs-you") return null;
  if (e.reason === "permission_prompt") return /question/i.test(e.message ?? "") ? "Question" : "Permission";
  return "Question";
}

/** The sidebar's row keys (`plan:<id>`, `launch:<terminalId>`) whose CLI is
 *  mid-turn, and why each waiting one needs you. A launch nobody has heard
 *  from yet is starting, which is work. */
export function sidebarActivity(
  terminals: SessionTerminals,
  attention: ReadonlyMap<string, TermAttention>,
  launches: readonly FlowLaunch[],
): { working: ReadonlySet<string>; needs: Readonly<Record<string, NeedReason>> } {
  const working = new Set<string>();
  const needs: Record<string, NeedReason> = {};
  const read = (key: string, entry: TermAttention | undefined, unheardIsWork: boolean) => {
    if (!entry) {
      if (unheardIsWork) working.add(key);
      return;
    }
    if (entry.kind === "working") working.add(key);
    const reason = needReason(entry);
    if (reason) needs[key] = reason;
  };
  for (const [sessionId, terminalId] of terminals) read(`plan:${sessionId}`, attention.get(terminalId), false);
  for (const l of launches) read(`launch:${l.terminalId}`, attention.get(l.terminalId), true);
  return { working, needs };
}

/** App's `sessionId → terminalId` map and the terminals' attention kinds,
 *  kept from the hooks' `term-attention` events (seeded from the daemon's
 *  snapshot, so a reload starts from the truth) and the engine's
 *  `convo-bound`. Listener first, snapshot second — `convo-bound` is never
 *  replayed to a late listener, so after a reload the snapshot is what knows
 *  an existing plan's terminal; `bind` adds what App
 *  learns itself (a launch's plan arriving, a held plan's terminal).
 *  Inert when `enabled` is false: the classic shell never subscribes. */
export function useSessionTerminals(enabled: boolean): {
  terminals: SessionTerminals;
  attention: ReadonlyMap<string, TermAttention>;
  /** The CLIs' own names for their sessions, by terminal (`convo-title`). */
  titles: ReadonlyMap<string, string>;
  bind: (pairs: readonly { sessionId: string | null; terminalId: string }[]) => void;
} {
  const [terminals, setTerminals] = useState<SessionTerminals>(() => new Map());
  const [attention, setAttention] = useState<ReadonlyMap<string, TermAttention>>(
    () => new Map(),
  );
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(() => new Map());
  const bind = useCallback(
    (pairs: readonly { sessionId: string | null; terminalId: string }[]) =>
      setTerminals((prev) => bindTerminals(prev, pairs)),
    [],
  );
  useEffect(() => {
    if (!enabled) return;
    let gone = false;
    const unlisteners: (() => void)[] = [];
    const keep = (p: Promise<() => void>) =>
      void p
        .then((u) => (gone ? u() : unlisteners.push(u)))
        .catch(() => {});
    const take = (rows: readonly TermAttention[]) => {
      bind(rows);
      setAttention((prev) => latestAttention(prev, rows));
    };
    keep(listen<TermAttention>("term-attention", (e) => take([e.payload])));
    keep(listen<ConvoBoundNotice>(CONVO_BOUND_EVENT, (e) => bind([e.payload])));
    keep(
      listen<ConvoTitleNotice>(CONVO_TITLE_EVENT, (e) => {
        const { terminalId, sessionId, title } = e.payload;
        bind([{ sessionId, terminalId }]);
        setTitles((prev) => (prev.get(terminalId) === title ? prev : new Map(prev).set(terminalId, title)));
      }),
    );
    void invoke<TermAttention[]>("term_attention_snapshot")
      .then((rows) => {
        if (!gone && Array.isArray(rows)) take(rows);
      })
      .catch(() => {});
    return () => {
      gone = true;
      for (const u of unlisteners) u();
    };
  }, [enabled, bind]);
  return { terminals, attention, titles, bind };
}
