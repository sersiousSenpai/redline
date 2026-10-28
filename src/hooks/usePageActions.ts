// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Which pages the agent is acting on, from the action route's
//! acknowledgements (`browser-action`, browser_actions.rs). The page chat's
//! live line names a running action and its tab ("Clicking · tab 2"), and
//! the tab shows a dot from the action until the turn that drove it ends
//! (BC-41). What the action did is not here: the backend writes that onto
//! the turn as a step of its own, so it outlives this listener.

import { dropListener } from "../lib/dropListener";
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { PageAction } from "../lib/browserChat/transcript";

/** A page action accepted and not yet finished, and when it was heard of. */
export type RunningPageAction = PageAction & { at: number };

interface Acknowledgement {
  label: string;
  kind: string;
  tab: number | null;
  status: "accepted" | "running" | "completed" | "failed" | "interrupted";
  /** The page-chat turns running against the page when it was asked for. */
  turns?: string[];
}

/** How long a finished action's dot waits for the turn that drove it to end
 *  before it clears on its own: an action the page chat didn't drive (the
 *  Companion, a mission) ends no page-chat turn. Also how long an ended
 *  turn is remembered, for an outcome that arrives after its turn did. */
const LINGER_MS = 20_000;

export function usePageActions(): { running: ReadonlyMap<string, RunningPageAction>; acting: ReadonlySet<string> } {
  const [running, setRunning] = useState<ReadonlyMap<string, RunningPageAction>>(() => new Map());
  const [acting, setActing] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    // Finished actions whose dot still shows, with the timer that clears it;
    // the turns that drove each page's actions; and the turns heard ending.
    // An action's outcome always comes (the route acknowledges one even when
    // its request is dropped), so a running action keeps its dot until then.
    const finished = new Map<string, number>();
    const drivers = new Map<string, Set<string>>();
    const ended = new Map<string, number>();
    const drop = (label: string) => {
      window.clearTimeout(finished.get(label));
      finished.delete(label);
      drivers.delete(label);
      setActing((prev) => (prev.has(label) ? new Set([...prev].filter((other) => other !== label)) : prev));
    };
    // A finished action's dot goes once every turn that drove it has ended.
    const settle = (label: string) => {
      const by = drivers.get(label);
      if (finished.has(label) && by?.size && [...by].every((turn) => ended.has(turn))) drop(label);
    };
    const subscriptions = [
      listen<Acknowledgement>("browser-action", ({ payload: ack }) => {
        const live = ack.status === "accepted" || ack.status === "running";
        for (const turn of ack.turns ?? []) {
          drivers.set(ack.label, (drivers.get(ack.label) ?? new Set<string>()).add(turn));
          // Named as an action is accepted, a thread is running a turn now:
          // an earlier turn of it that ended no longer speaks for it.
          if (ack.status === "accepted") {
            window.clearTimeout(ended.get(turn));
            ended.delete(turn);
          }
        }
        setRunning((prev) => {
          if (!live && !prev.has(ack.label)) return prev;
          const next = new Map(prev);
          if (live) next.set(ack.label, { kind: ack.kind, tab: ack.tab, at: Date.now() });
          else next.delete(ack.label);
          return next;
        });
        window.clearTimeout(finished.get(ack.label));
        if (live) {
          finished.delete(ack.label);
          setActing((prev) => (prev.has(ack.label) ? prev : new Set(prev).add(ack.label)));
          return;
        }
        finished.set(ack.label, window.setTimeout(() => drop(ack.label), LINGER_MS));
        settle(ack.label);
      }),
      // A page-chat turn ending clears the dots of the actions it drove that
      // have finished; another turn's, or one still running, keeps its dot.
      ...["browse-done", "browse-error", "browse-cancelled"].map((event) =>
        listen<{ browseId?: string }>(event, ({ payload }) => {
          const turn = payload?.browseId;
          if (!turn) return;
          window.clearTimeout(ended.get(turn));
          ended.set(turn, window.setTimeout(() => ended.delete(turn), LINGER_MS));
          for (const label of [...finished.keys()]) settle(label);
        }),
      ),
    ];
    return () => {
      for (const timer of [...finished.values(), ...ended.values()]) window.clearTimeout(timer);
      for (const subscription of subscriptions) void subscription.then(dropListener).catch(() => {});
    };
  }, []);
  return { running, acting };
}
