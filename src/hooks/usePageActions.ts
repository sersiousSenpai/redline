// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Which pages the agent is acting on, from the action route's
//! acknowledgements (`browser-action`, browser_actions.rs). The page chat's
//! live line names a running action and its tab ("Clicking · tab 2"), and
//! the tab shows a dot from the action until the turn that drove it ends
//! (BC-41). What the action did is not here: the backend writes that onto
//! the turn as a step of its own, so it outlives this listener.

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
}

/** How long a finished action's dot waits for a turn to end before it clears
 *  on its own: an action the page chat didn't drive (the Companion, a
 *  mission) ends no page-chat turn. */
const LINGER_MS = 20_000;

export function usePageActions(): { running: ReadonlyMap<string, RunningPageAction>; acting: ReadonlySet<string> } {
  const [running, setRunning] = useState<ReadonlyMap<string, RunningPageAction>>(() => new Map());
  const [acting, setActing] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    // Finished actions whose dot still shows, with the timer that clears it.
    const finished = new Map<string, number>();
    const drop = (labels: readonly string[]) => {
      if (!labels.length) return;
      for (const label of labels) {
        window.clearTimeout(finished.get(label));
        finished.delete(label);
      }
      setActing((prev) => (labels.some((label) => prev.has(label)) ? new Set([...prev].filter((label) => !labels.includes(label))) : prev));
    };
    const subscriptions = [
      listen<Acknowledgement>("browser-action", ({ payload: ack }) => {
        const live = ack.status === "accepted" || ack.status === "running";
        setRunning((prev) => {
          const next = new Map(prev);
          if (live) next.set(ack.label, { kind: ack.kind, tab: ack.tab, at: Date.now() });
          else next.delete(ack.label);
          return next;
        });
        window.clearTimeout(finished.get(ack.label));
        if (live) {
          finished.delete(ack.label);
          setActing((prev) => (prev.has(ack.label) ? prev : new Set(prev).add(ack.label)));
        } else {
          finished.set(ack.label, window.setTimeout(() => drop([ack.label]), LINGER_MS));
        }
      }),
      // A page-chat turn ending clears the dots of the actions that finished;
      // one still running keeps its dot until its own outcome.
      ...["browse-done", "browse-error", "browse-cancelled"].map((event) => listen(event, () => drop([...finished.keys()]))),
    ];
    return () => {
      for (const timer of finished.values()) window.clearTimeout(timer);
      for (const subscription of subscriptions) void subscription.then((stop) => stop()).catch(() => {});
    };
  }, []);
  return { running, acting };
}
