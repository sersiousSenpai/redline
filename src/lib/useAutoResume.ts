// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The automatic restore's wiring — the boot path's whole share of it. The
// rules are `autoResume`; the state and the timer are `autoResumeController`,
// loaded on the first death or the first restore. The restore itself is the
// SAME function a click calls (App's `restorePlanSessionWith`), so the one
// restore state machine and its one-at-a-time rule hold for both.
//
// Two signals, one trigger:
// - `session-detached`: the daemon reconciled a plan session to Detached — a
//   held hook's connection dropped, the revise watchdog found the agent dead
//   (its liveness gate), the staleness sweep, a delivery that found nobody.
//   This is the trigger.
// - `pty-exit` of the terminal a plan session runs in, while it is in review
//   and not yet detached: a revising agent holds no hook, so nothing drops,
//   and the watchdog would take a minute and a half to notice. The exit asks
//   the daemon to reconcile now (`report_agent_exit`, the watchdog's own
//   liveness gate), and its detach is the trigger above. Never a restore
//   started off the exit itself: until the daemon says Detached, a restore
//   would close on the first summary that says the session is not detached.
//
// Non-plan terminal agents (a Claude or Codex shell the reviewer started,
// with no plan row) get no automatic resume: out of scope, see `autoResume`.

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { AutoResumeController, AutoResumeDeps } from "./autoResumeController";
import { userStops } from "./userStops";

export type { AutoStart } from "./autoResumeController";

export function useAutoResume(deps: AutoResumeDeps): {
  /** The reviewer said stop: no further automatic attempt for it. */
  cancel: (sessionId: string) => void;
} {
  const ref = useRef(deps);
  ref.current = deps;
  const ctl = useRef<AutoResumeController | null>(null);
  const loading = useRef<Promise<AutoResumeController> | null>(null);
  const load = () =>
    (loading.current ??= import("./autoResumeController").then((m) => {
      const c = m.createAutoResume(ref);
      ctl.current = c;
      c.sync();
      return c;
    }));

  useEffect(() => {
    let gone = false;
    const offs: (() => void)[] = [];
    const keep = (p: Promise<() => void>) =>
      void p.then((off) => (gone ? off() : offs.push(off))).catch(() => {});
    keep(
      listen<{ sessionId: string }>("session-detached", (e) => {
        void load().then((c) => c.detached(e.payload.sessionId)).catch(() => {});
      }),
    );
    keep(
      listen<{ id: string }>("pty-exit", (e) => {
        const { summaries, sessionTerminals } = ref.current;
        const id = e.payload.id;
        if (userStops().closed.has(id)) return;
        for (const [sessionId, terminalId] of sessionTerminals) {
          if (terminalId !== id) continue;
          const s = summaries.find((x) => x.sessionId === sessionId);
          if (!s || s.status !== "in_review" || s.archivedAt || s.attachState === "detached") continue;
          void invoke("report_agent_exit", { sessionId }).catch(() => {});
        }
      }),
    );
    return () => {
      gone = true;
      for (const off of offs) off();
    };
  }, []);

  // Every step of the restore machine and every summary refresh. A restore
  // is reason enough to load: a click's has its "Resuming…" too.
  useEffect(() => {
    if (ctl.current) ctl.current.sync();
    else if (deps.restoreAttempt) void load().catch(() => {});
  }, [deps.restoreAttempt, deps.summaries]);

  return { cancel: (sessionId) => ctl.current?.cancel(sessionId) };
}
