// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import {
  badgeCount,
  chatNews,
  isVisible,
  markSeen,
  notifyDelay,
  onePerSession,
  planNews,
  revealOnReturn,
  shouldNotify,
  takeNews,
  terminalNews,
  terminalSession,
  type AlertTarget,
  type LoudTerminal,
  type SessionNews,
} from "../lib/attentionAlerts";
import { getNotifyPrefs } from "../lib/notifyPrefs";
import { notify } from "../lib/osNotice";
import { latestDisplayVersion } from "../lib/revisionVersions";
import { attentionText, type TermState } from "../lib/termState";
import type { Companion, PlanDecisionWindowEvent, SessionSummary, TermAttention } from "../types";
import { planKey } from "../workbench/model";
import { visibleTargetsKey } from "../workbench/onScreen";
import { useWorkbench, type WorkbenchStore } from "../workbench/store";

export interface AttentionAlertSources {
  store: WorkbenchStore;
  summaries: readonly SessionSummary[];
  /** The wall's derivation (`TerminalTabs.onStatesChange`), once reported. */
  termStatuses: ReadonlyMap<string, { state: TermState; label: string }>;
  /** The hooks' latest entry per terminal (`useSessionTerminals`). */
  terminalAttention: ReadonlyMap<string, TermAttention>;
  /** The live PTYs, once known: a dead terminal's last hook is not news. */
  liveTermIds: readonly string[] | null;
  /** sessionId → the terminal its CLI runs in. */
  sessionTerminals: ReadonlyMap<string, string>;
  /** Each plan session's name, by its set key. */
  sessionLabels: ReadonlyMap<string, string>;
  chats: readonly Companion[];
  /** A notification was answered: show what it was about. */
  onReveal: (target: AlertTarget) => void;
}

/** A decision window's own notice covers its plan's arrival for this long. */
const DECISION_COVERS_MS = 30_000;

/** The OS notifications and the Dock badge, for every agent: a plan
 *  session's CLI and its held plan, the terminals on the walls, the chat
 *  rooms (lib/attentionAlerts has the rules).
 *
 *  Everything that happened before this window armed was never news here (a
 *  reload, a late mount): it is handled without notifying. After that, each
 *  new transition notifies once — if, at that moment, the window is not in
 *  front or its session is not the one shown, and its kind is turned on. A
 *  your-turn and a plan wait a beat (`notifyDelay`) and are dropped if they
 *  were read, answered or replaced meanwhile. The desktop notification has
 *  no click callback, and a click on it brings Redline forward: the first
 *  return to the window after a notification shows what it was about, while
 *  that still wants you. */
export function useAttentionAlerts(src: AttentionAlertSources): void {
  const { store, summaries, termStatuses, terminalAttention, liveTermIds, sessionTerminals, sessionLabels, chats } = src;
  const onRevealRef = useRef(src.onReveal);
  onRevealRef.current = src.onReveal;
  const chatsRef = useRef(chats);
  chatsRef.current = chats;
  const armedAt = useRef(Date.now()).current;

  const visibleKey = useWorkbench(store, visibleTargetsKey);
  const visible = useMemo(() => new Set(visibleKey ? visibleKey.split("\n") : []), [visibleKey]);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const owners = useWorkbench(store, (s) => s.owners);

  // Whether Redline's window is the one in front. Not document.hasFocus():
  // that is false while the caret sits in one of Redline's own browser pages
  // (native webviews in this same window), and a notification then would be
  // about the app the user is looking at.
  const [focused, setFocused] = useState(() => document.hasFocus());
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const pendingRef = useRef<{ key: string; target: AlertTarget } | null>(null);

  // The chat rooms' replies not seen yet, latest per room.
  const [replies, setReplies] = useState<readonly SessionNews[]>([]);
  const decisionsRef = useRef(new Map<string, number>());
  useEffect(() => {
    let gone = false;
    const offs: (() => void)[] = [];
    const keep = (p: Promise<() => void>) =>
      void p.then((off) => (gone ? off() : offs.push(off)), () => {});
    keep(
      listen<{ companionId: string; messageId: string; body: string }>("companion-done", (e) => {
        const { companionId, messageId, body } = e.payload;
        const title = chatsRef.current.find((c) => c.companionId === companionId)?.title ?? null;
        const news = chatNews({ companionId, messageId, at: Date.now(), title, body: body ?? "" });
        setReplies((prev) => [...prev.filter((n) => n.session !== news.session), news]);
      }),
    );
    keep(
      listen<PlanDecisionWindowEvent>("plan-decision-window", (e) => {
        decisionsRef.current.set(e.payload.sessionId, Date.now());
      }),
    );
    return () => {
      gone = true;
      for (const off of offs) off();
    };
  }, []);

  const news = useMemo<SessionNews[]>(() => {
    const terminalOf = new Map<string, string>();
    for (const [sessionId, terminalId] of sessionTerminals) terminalOf.set(terminalId, sessionId);
    const out: SessionNews[] = [];
    for (const [id, entry] of terminalAttention) {
      if (liveTermIds && !liveTermIds.includes(id)) continue;
      const known = termStatuses.get(id);
      const state = known ? known.state : entry.kind;
      if (state !== "needs-you" && state !== "your-turn") continue;
      const loud: LoudTerminal = { id, state, at: entry.at, label: known?.label ?? "terminal", text: attentionText(entry) };
      const session = terminalSession(id, terminalOf, owners[id]);
      out.push(terminalNews(loud, session ? { session, label: sessionLabels.get(session) ?? null } : null));
    }
    for (const s of summaries) {
      if (s.archivedAt) continue;
      const last = s.revisions[s.revisions.length - 1];
      const plan = planNews({
        sessionId: s.sessionId,
        label: sessionLabels.get(planKey(s.sessionId)) ?? (s.projectName || "Plan"),
        held: s.held,
        version: latestDisplayVersion(s.revisions, s.latestVersion),
        receivedAt: last?.receivedAt ?? null,
        restored: last?.restored ?? false,
      });
      if (plan) out.push(plan);
    }
    out.push(...replies);
    return out;
  }, [summaries, termStatuses, terminalAttention, liveTermIds, sessionTerminals, sessionLabels, owners, replies]);
  const newsRef = useRef(news);
  newsRef.current = news;

  useEffect(() => {
    const win = getCurrentWindow();
    let live = true;
    win.isFocused().then((now) => { if (live) setFocused(now); }, () => {});
    const un = win.onFocusChanged(({ payload }) => {
      setFocused(payload);
      if (!payload) return;
      // Back in front: a notification sent while away was most likely what
      // brought you here (its click does exactly this), so show it — once,
      // and only while it still waits on you and is not already on screen
      // (`revealOnReturn`: finished news never pulls you anywhere).
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending && revealOnReturn(pending, newsRef.current, visibleRef.current)) onRevealRef.current(pending.target);
    });
    return () => {
      live = false;
      void un.then((off) => off(), () => {});
    };
  }, []);

  // Notify.
  const handledRef = useRef(new Set<string>());
  const timersRef = useRef(new Set<number>());
  useEffect(() => {
    const fire = (n: SessionNews) => {
      const at = { focused: focusedRef.current, visible: visibleRef.current, prefs: getNotifyPrefs() };
      if (!shouldNotify(n, at)) return;
      if (!at.focused) pendingRef.current = { key: n.key, target: n.target };
      void notify(n.title, n.body);
    };
    for (const n of onePerSession(takeNews(news, handledRef.current, armedAt))) {
      const delay = notifyDelay(n);
      if (delay === 0) {
        fire(n);
        continue;
      }
      const timer = window.setTimeout(() => {
        timersRef.current.delete(timer);
        const now = newsRef.current.find((x) => x.key === n.key);
        if (!now || now.kind !== n.kind) return;
        if (now.target.type === "plan" && Date.now() - (decisionsRef.current.get(now.target.sessionId) ?? -Infinity) < DECISION_COVERS_MS) return;
        fire(now);
      }, delay);
      timersRef.current.add(timer);
    }
  }, [news, armedAt]);
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  // Seen, and the Dock badge.
  const seenRef = useRef<ReadonlySet<string>>(new Set());
  const badgeRef = useRef<number | null>(null);
  useEffect(() => {
    seenRef.current = markSeen(seenRef.current, news, focused, visible);
    const count = badgeCount(news, seenRef.current);
    if (badgeRef.current !== count) {
      badgeRef.current = count;
      void invoke("set_attention_badge", { count }).catch(() => {});
    }
    // A reply read in its room is done with.
    if (focused && replies.some((n) => isVisible(n, visible))) {
      setReplies((prev) => prev.filter((n) => !isVisible(n, visible)));
    }
  }, [news, focused, visible, replies]);
}
