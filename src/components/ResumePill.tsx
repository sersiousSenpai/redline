// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! "Resuming…": a plan session coming back on its own (lib/autoResume),
//! said where the session is — its sidebar row and its Agent pane's header
//! (the Plan tab's dot and the Detached notice read the same store in App).
//! The one status vocabulary: the shared Spinner while it runs or is about
//! to, the amber opacity pulse on an HTML element once it failed and needs
//! you. No red.
//!
//! A tiny external store rather than props: the rows and the header are
//! memoized and live far from App, and only the row whose pill changed
//! should re-render. The controller (lib/autoResumeController, loaded on the
//! first death) publishes; until it has, every session says nothing. Only
//! types come from lib/autoResume, so the boot path carries none of it —
//! this file is the store and the pill, nothing else.

import { useSyncExternalStore } from "react";

import { Spinner } from "./Spinner";
import type { AutoNotice, ResumePill as Pill } from "../lib/autoResume";

let pills: ReadonlyMap<string, Pill> = new Map();
let notices: ReadonlyMap<string, AutoNotice> = new Map();
const subscribers = new Set<() => void>();

/** Replace every session's pill and notice. The controller keeps the
 *  objects of unchanged entries (`mergeResume`), so only the sessions whose
 *  state moved re-render. */
export function setResume(nextPills: ReadonlyMap<string, Pill>, nextNotices: ReadonlyMap<string, AutoNotice>): void {
  pills = nextPills;
  notices = nextNotices;
  for (const notify of subscribers) notify();
}

const subscribe = (notify: () => void) => {
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
  };
};

export function useResumePill(sessionId: string | null | undefined): Pill | null {
  return useSyncExternalStore(subscribe, () => (sessionId ? pills.get(sessionId) ?? null : null));
}

/** Every session's pill, for a reader that shows several (the tab strip's
 *  dots). Re-renders only when some pill changed. */
export function useResumePills(): ReadonlyMap<string, Pill> {
  return useSyncExternalStore(subscribe, () => pills);
}

/** What the Detached notice says about an automatic resume of `sessionId`. */
export function useAutoNotice(sessionId: string | null | undefined): AutoNotice | null {
  return useSyncExternalStore(subscribe, () => (sessionId ? notices.get(sessionId) ?? null : null));
}

/** The pill itself; draws nothing while the session has nothing to say. */
export function ResumePill({ sessionId, className }: { sessionId: string | null | undefined; className?: string }) {
  const pill = useResumePill(sessionId);
  if (!pill) return null;
  const text = pill.attempt ? `${pill.label} attempt ${pill.attempt} of ${pill.of}` : pill.label;
  return (
    <span className={className ? `rl-resume ${className}` : "rl-resume"} data-tone={pill.tone} role="status" title={text} aria-label={text}>
      {pill.tone === "working" ? <Spinner size={10} /> : <i className="rl-resume-dot" aria-hidden />}
      <span className="rl-resume-word">{pill.label}</span>
    </span>
  );
}
