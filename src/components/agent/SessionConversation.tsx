// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The session stage's conversation: the live `claude` / `codex` CLI in the
//! session's PTY, mirrored from its transcript and drawn like a desktop chat
//! (4b), beside the plan (4c), or in the full pose's Chat tab (5a). The CLI
//! keeps running in its terminal exactly as before; the composer types into
//! that same PTY, and Stop is its Esc.
//!
//! - **State** is `components/agent/convo/reducer.ts`, fed by `convoSubscribe` (the tail
//!   now, batches after) and `convoPage` when the reader scrolls to the top.
//!   A new `terminalId` is a new subscription; unmounting unsubscribes, and
//!   a hook only arms in-conversation asks while someone is subscribed.
//! - **Turns** draw as 4b draws them: your bubble, the steps it took ("Read
//!   `docs/x.md`"), its prose, and the working row ("Writing the plan ·
//!   1m 12s · Stop"). Settled, a turn folds to one line ("✓ Read 4 files ·
//!   planned in 2m 04s", `status.turnSegments`), which expands.
//! - **Cards**: an open ask (`AskCard`) at the end, where the CLI is waiting;
//!   the plan as "Plan ready" while its panel shows (4c) and as one inline
//!   line while it is closed (4d).
//! - **Sends** are optimistic: the bubble shows at once and the transcript's
//!   own prompt replaces it. A send the PTY can't take now waits in the
//!   local queue (the work drawer, `WorkDrawer`) and goes, in order, when
//!   it can; Steer types it now, ahead of the rest.
//! - **A Codex session no second client can read** (`bound.mirrored` false:
//!   one Redline's launcher didn't start) says so, opens on its terminal
//!   once, and offers no composer: nothing sent from here could be seen
//!   arriving.
//!
//! Why not the chat surfaces' `ReplyBlock`: its anatomy is a byline, a steps
//! LINE over the text and a tail row of actions, with Stop deliberately in
//! the composer only. 4b draws steps as rows, has no byline or tail, and puts
//! Stop on the working row — so prose reuses `MarkdownView` (the same markup
//! a settled reply renders) and the rest is drawn to the board. `UserTurn`
//! is a tinted, bordered card at 88% width; 4b's bubble is a plain fill at
//! 520px, so it is drawn here too.

import { fileExists, openFileLink } from "../../lib/fileLinks";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Check, ChevronDown, FilePenLine, Hammer, X } from "lucide-react";
import { MarkdownView } from "../MarkdownView";
import { Spinner } from "../Spinner";
import { answerAsk, convoExpect, convoPage, convoQueue, convoSteer, convoSubscribe, convoUnqueue, convoUnsubscribe, interruptTerminal, ptyKeys, ptyScreenTail, ptySubmit } from "./convo/api";
import { keysFor, parsePermissionPrompt, parseProceedPrompt, type PermissionPrompt, type ProceedPrompt } from "./convo/proceedPrompt";
import { questionsToRelease } from "./askRelease";
import type { ConvoAsk, ConvoAskOutcome, ConvoMode } from "./convo/types";
import {
  MAX_ROWS,
  convoReducer,
  convoView,
  initialConvoState,
  normalizeSendText,
  type Block,
  type ConvoView,
  type ModelFact,
  type PlanFact,
  type ReadinessFact,
  type Turn,
  type TurnItem,
  type UserBubble,
} from "./convo/reducer";
import {
  formatElapsed,
  planStats,
  planStatsLabel,
  toolRows,
  turnSegments,
  workingStatus,
  type Segment,
  type ToolRow,
  type WorkingStatus,
} from "./convo/status";
import {
  HELD_RETRY_MS,
  composerReadiness,
  enqueueSend,
  nextFlush,
  promoteSend,
  routeSend,
  unqueueSend,
  type QueuedSend,
  readQueuedSends,
  writeQueuedSends,
} from "./convo/readiness";
import type { TermState } from "../../lib/termState";
import { AskCard, PermissionPromptCard, ProceedCard, StoppedCard, TerminalAskCard } from "./AskCard";
import { setTerminalAsking } from "../../lib/openAsks";
import { SessionComposer } from "./SessionComposer";
import { WorkDrawer, type DrawerAgent } from "./WorkDrawer";
import "./conversation.css";

/** What the conversation knows that a header around it wants to say: the
 *  model and mode the transcript last reported, whether a turn is running
 *  or waiting on you, whether there are earlier messages to page back to,
 *  and the CLI session the terminal is bound to. */
export interface ConvoFacts {
  model: ModelFact | null;
  mode: ConvoMode | null;
  working: boolean;
  needsYou: boolean;
  hasOlder: boolean;
  boundSessionId: string | null;
  /** The plan is held for your review (D25): the header's status says so
   *  ("Plan ready · waiting for you"); null otherwise. */
  held: string | null;
}

export interface ConvoActions {
  /** Page back and scroll to the oldest message shown. */
  earlier: () => void;
  /** Stop the running turn (Esc into the PTY). */
  stop: () => void;
}

export interface SessionConversationProps {
  /** The session's PTY; null = not launched yet / no terminal. */
  terminalId: string | null;
  /** The plan session id, once known. */
  sessionId: string | null;
  harness: "claude" | "codex";
  /** stage = 720px centred (4b); column = 440px chat beside the plan (4c);
   *  panel = the full pose's right-panel Chat tab (5a). */
  layout: "stage" | "column" | "panel";
  planTitle?: string | null;
  /** Unsubmitted marks on the latest plan. */
  planMarks?: number;
  /** The plan panel is showing (split/full). */
  planOpen: boolean;
  /** "Open in panel →" / the inline card's "Open". */
  onOpenPlan: () => void;
  /** "Answer in terminal", "Undelivered · Open Terminal". */
  onShowTerminal: () => void;
  // ── Optional, additive to the seam ──
  /** The session's folder: the stage composer's 📁 chip, and tool paths
   *  read relative to it. */
  projectPath?: string | null;
  /** The latest plan's markdown, for "3 sections · 11 steps". */
  planMarkdown?: string | null;
  /** This terminal's derived state (`deriveTermState`), when the stage has
   *  it: its needs-you and working count before any event does. */
  termState?: TermState | null;
  /** Resume the same conversation to carry on its approved plan's build
   *  (App's `buildApproved("same")`): the Stopped card's Retry when the
   *  agent died mid-build. */
  onRetryBuild?: (() => void) | null;
  /** The voice panel is open on this conversation. */
  talking?: boolean;
  /** Open or close the voice panel; without it, Talk raises
   *  `redline:flow-talk`. */
  onTalk?: () => void;
  /** Where the plan is in its life, from the session (the transcript's own
   *  outcome can be paged off, or predate this terminal): the plan card at
   *  the end of the conversation follows it, so an approved, building or
   *  built plan never reads "Plan ready … then approve". */
  planState?: {
    /** The top bar's mode word and kind: "Building v4", "Approved v2"… */
    label: string;
    kind: "chat" | "plan" | "redline" | "build";
    /** Claude is waiting on this plan's review. */
    held: boolean;
    /** Claude's answers waiting on your accept or reopen. */
    toReview: number;
    /** A run's own count, when there is one: "step 3 of 11". */
    step?: string | null;
  } | null;
  /** The model and effort the session recorded, until the transcript says
   *  which answered; and the mode a plan in review is in. */
  fallbackModel?: ModelFact | null;
  fallbackMode?: ConvoMode | null;
  /** Out of sight (the terminal view, the Feedback tab, another surface):
   *  its open questions go to the terminal, since a held AskUserQuestion
   *  shows nowhere else (components/agent/askRelease). It stays subscribed. */
  hidden?: boolean;
  /** A header drawn above the thread with what the conversation knows
   *  (the Agent pane's agent · model · mode row and its Chat | CLI). */
  header?: (facts: ConvoFacts, actions: ConvoActions) => ReactNode;
}

/** Terminal-and-session pairs already switched to their terminal: once per
 *  session, across remounts, so the reader's own toggle wins after that. */
const terminalShown = new Set<string>();

/** How close to the top, in px, scrolling asks for the page before. */
const PAGE_AT = 160;
/** How close to the bottom still counts as following the live end. */
const STICK_WITHIN = 48;

function SessionConversation(props: SessionConversationProps) {
  const { terminalId, layout, onShowTerminal } = props;
  const [state, dispatch] = useReducer(convoReducer, undefined, initialConvoState);
  const view = useMemo(() => convoView(state), [state]);
  const [failed, setFailed] = useState(false);

  // ── Subscription ──
  useEffect(() => {
    dispatch({ type: "reset" });
    setFailed(false);
    if (!terminalId) return;
    let live = true;
    let subscription: string | null = null;
    convoSubscribe(terminalId, (batch) => {
      if (live) dispatch({ type: "batch", batch });
    }).then(
      (snapshot) => {
        if (!live) {
          void convoUnsubscribe(terminalId, snapshot.subscriptionId).catch(() => {});
          return;
        }
        subscription = snapshot.subscriptionId;
        dispatch({ type: "snapshot", snapshot });
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
      if (subscription) void convoUnsubscribe(terminalId, subscription).catch(() => {});
    };
  }, [terminalId]);

  // ── A question never waits out of sight (components/agent/askRelease) ──
  // Hidden, every open question is released to the terminal as it arrives;
  // unmounting (another session on the stage) releases what is still open.
  const released = useRef(new Set<string>());
  const openAsks = useRef(view.openAsks);
  openAsks.current = view.openAsks;
  const release = useCallback(() => {
    for (const askId of questionsToRelease(openAsks.current, released.current)) {
      released.current.add(askId);
      void answerAsk(askId, { kind: "terminal" }).catch(() => released.current.delete(askId));
    }
  }, []);
  useEffect(() => {
    if (props.hidden) release();
  }, [props.hidden, view.openAsks, release]);
  useEffect(() => release, [release]);

  // ── A Codex session only its terminal shows ──
  const terminalOnly = view.bound?.mirrored === false;
  const boundSession = view.bound?.sessionId ?? null;
  useEffect(() => {
    if (!terminalOnly || !terminalId || !boundSession) return;
    const key = `${terminalId}:${boundSession}`;
    if (terminalShown.has(key)) return;
    terminalShown.add(key);
    onShowTerminal();
  }, [terminalOnly, terminalId, boundSession, onShowTerminal]);

  // ── Scrolling: follow the live end, page at the top ──
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  /** A page in flight: the height before it, and the oldest row it pages
   *  back from — the anchor moves only once that row is no longer oldest. */
  const paging = useRef<{ height: number; oldest: string } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const oldestKey = view.oldest ? `${view.oldest.epoch}:${view.oldest.offset}` : "";
  const pageOlder = useCallback(() => {
    const el = scroller.current;
    if (!terminalId || !view.hasOlder || !view.oldest || paging.current || !el) return;
    paging.current = { height: el.scrollHeight, oldest: oldestKey };
    setLoadingOlder(true);
    convoPage(terminalId, view.oldest.epoch, view.oldest.offset).then(
      (page) => {
        if (page.events.length === 0) paging.current = null;
        dispatch({ type: "page", page });
      },
      () => {
        paging.current = null;
      },
    ).finally(() => setLoadingOlder(false));
  }, [terminalId, view.hasOlder, view.oldest, oldestKey]);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_WITHIN;
    if (bottom && !atBottom.current && state.limit > MAX_ROWS) dispatch({ type: "trim" });
    atBottom.current = bottom;
    if (el.scrollTop < PAGE_AT) pageOlder();
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (paging.current) {
      // Older rows landed above: keep what the reader was looking at still.
      if (paging.current.oldest !== oldestKey) {
        el.scrollTop += el.scrollHeight - paging.current.height;
        paging.current = null;
      }
    } else if (atBottom.current) el.scrollTop = el.scrollHeight;
  });

  // ── Sending ──
  const readiness = composerReadiness({
    terminalId,
    bound: view.bound !== null,
    // The wall saw the agent leave while the host still says "unbound" (an
    // older daemon): the composer says it stopped, not that it is starting.
    host: props.termState === "exited" && view.readiness && !view.readiness.ready && view.readiness.blocker === "unbound" ? { ...view.readiness, blocker: "exited" } : view.readiness,
    harness: props.harness,
  });
  const [queue, setQueue] = useState<QueuedSend[]>(() => readQueuedSends(terminalId));
  const queueRef = useRef(queue);
  queueRef.current = queue;
  // D25: the plan is held for review — the CLI is blocked in the review
  // hook, so nothing typed now would reach it. Sends wait here (and in the
  // terminal's outbox), Steer is off, and the hold's release delivers them.
  const reviewHeld = !!props.planState?.held;
  const wasHeld = useRef(reviewHeld);
  // The render a hold is released in belongs to the release (its effect
  // below delivers what waited); the flush must not race it for the head.
  const releasing = wasHeld.current && !reviewHeld;
  // A release's sends wait for the CLI to take input (the release effect
  // below); until they have gone, the ordinary flush leaves the queue alone.
  const [releasedAt, setReleasedAt] = useState<number | null>(null);
  const [restore, setRestore] = useState<{ text: string; nonce: number } | null>(null);
  // A send the PTY refused holds the queue until the host says something new
  // about readiness, or HELD_RETRY_MS passes (`nextFlush`).
  const [held, setHeld] = useState<{ at: ReadinessFact | null } | null>(null);
  const isHeld = held !== null && held.at === view.readiness;
  useEffect(() => {
    if (!isHeld) return;
    const t = window.setTimeout(() => setHeld(null), HELD_RETRY_MS);
    return () => window.clearTimeout(t);
  }, [isHeld]);
  const inFlight = useRef(false);
  const [, kick] = useReducer((n: number) => n + 1, 0);
  // Another session (not this one launching) drops what waited for the old one.
  const owner = useRef({ terminalId, sessionId: props.sessionId });
  useEffect(() => {
    const prev = owner.current;
    const moved =
      (prev.terminalId && terminalId && prev.terminalId !== terminalId) ||
      (prev.sessionId && props.sessionId && prev.sessionId !== props.sessionId);
    if (moved) setQueue([]);
    owner.current = { terminalId, sessionId: props.sessionId };
  }, [terminalId, props.sessionId]);
  // The queue survives a reload (`readQueuedSends`): read back for the
  // terminal it waits for — at mount, or when that terminal is first known —
  // and written on every change. A move to another terminal drops the old
  // terminal's copy with its queue.
  const persistedFor = useRef(terminalId);
  useEffect(() => {
    if (persistedFor.current !== terminalId) {
      if (persistedFor.current) writeQueuedSends(persistedFor.current, []);
      persistedFor.current = terminalId;
      const stored = readQueuedSends(terminalId);
      if (stored.length) setQueue((q) => (q.length ? q : stored));
      return;
    }
    writeQueuedSends(terminalId, queue);
  }, [terminalId, queue]);

  /** Sends go into the PTY one after another, never interleaved: each waits
   *  for the one before it to be typed. */
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  /** Type one send into the PTY: announce it (the bubble), then submit.
   *  True when the PTY took it. */
  const deliver = useCallback(
    (text: string, nonce: string): Promise<boolean> => {
      if (!terminalId) return Promise.resolve(false);
      dispatch({ type: "expect", nonce, text, at: Date.now() });
      const id = terminalId;
      const run = chain.current.then(async () => {
        try {
          await convoExpect(id, nonce, text);
          const result = await ptySubmit(id, text);
          if (result.status === "sent") return true;
        } catch {
          // Falls through: the send waits rather than vanishing.
        }
        dispatch({ type: "retract", nonce });
        return false;
      });
      chain.current = run;
      return run;
    },
    [terminalId],
  );

  /** While the agent is in a turn, a send waits in the terminal's outbox —
   *  a drawer row — and is typed in when the turn ends, rather than going
   *  into the CLI's own type-ahead. True when the outbox took it; false
   *  when nothing holds it (no turn running), so it is sent from here. */
  const hold = useCallback(
    async (id: string, text: string): Promise<boolean> => {
      if (!terminalId) return false;
      try {
        return (await convoQueue(terminalId, id, text)).status === "queued";
      } catch {
        return false;
      }
    },
    [terminalId],
  );

  const onSend = (text: string) => {
    const nonce = newNonce();
    if (reviewHeld) {
      setQueue((q) => enqueueSend(q, { id: nonce, text, at: Date.now() }));
      return;
    }
    const route = routeSend(readiness, queue);
    if (route === "send") inFlight.current = true;
    void hold(nonce, text).then((held) => {
      if (held) {
        if (route === "send") inFlight.current = false;
        kick();
        return;
      }
      if (route !== "send") {
        setQueue((q) => enqueueSend(q, { id: nonce, text, at: Date.now() }));
        return;
      }
      const seen = view.readiness;
      void deliver(text, nonce).then((sent) => {
        inFlight.current = false;
        if (!sent) {
          setQueue((q) => enqueueSend(q, { id: nonce, text, at: Date.now() }));
          setHeld({ at: seen });
        }
        kick();
      });
    });
  };

  // The flush: one at a time, in order, whenever the composer can type —
  // into the outbox instead while a turn runs.
  const next = nextFlush(queue, readiness, { inFlight: inFlight.current, held: isHeld || reviewHeld || releasing || releasedAt !== null });
  useEffect(() => {
    if (!next || inFlight.current) return;
    inFlight.current = true;
    const seen = view.readiness;
    void hold(next.id, next.text)
      .then((held) => (held ? true : deliver(next.text, next.id)))
      .then((sent) => {
        inFlight.current = false;
        if (sent) setQueue((q) => q.filter((item) => item.id !== next.id));
        else setHeld({ at: seen });
        kick();
      });
    // `next` is null while one is typing or the queue is held, so its id
    // moving is exactly "the head can go now".
  }, [next?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The hold released (Approve, Revise, Discuss): the CLI's turn runs on,
  // and what waited goes into it, oldest first, THROUGH THE OUTBOX — but
  // only once the CLI is taking input. Typed the instant the hold let go,
  // a send landed in whatever the CLI drew next: its own "Ready to code?"
  // prompt took the Enter as an answer and ate the words (the re-walk's
  // "Undelivered" after Approve & build). So the release is remembered,
  // and the sends go after a settle and with the composer ready — a prompt
  // of the CLI's own is a blocker until it is answered. Each held here
  // joins the outbox first and is steered from there: the daemon types it
  // into the running turn when the CLI can take it, and otherwise keeps it
  // at the outbox's head for the turn's end. A Codex turn's steer would
  // interrupt it, so its rows wait for the turn's end instead.
  useEffect(() => {
    const was = wasHeld.current;
    wasHeld.current = reviewHeld;
    if (!was || reviewHeld || !terminalId) return;
    if (view.outbox.length === 0 && queueRef.current.length === 0) return;
    setReleasedAt(Date.now());
    // Only the release itself matters; the rest is read when it goes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewHeld]);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(false);
    if (releasedAt === null) return;
    const t = window.setTimeout(() => setSettled(true), Math.max(0, releasedAt + RELEASE_SETTLE_MS - Date.now()));
    return () => window.clearTimeout(t);
  }, [releasedAt]);
  useEffect(() => {
    if (releasedAt === null || !settled || !readiness.ready || !terminalId || inFlight.current) return;
    const id = terminalId;
    const outbox = view.outbox.map((item) => item.id);
    const local = queueRef.current;
    setReleasedAt(null);
    if (outbox.length === 0 && local.length === 0) return;
    inFlight.current = true;
    void (async () => {
      const codex = props.harness === "codex";
      // Oldest first: the outbox's rows, then the ones held here.
      if (!codex) for (const row of outbox) await convoSteer(id, row).catch(() => null);
      for (const item of local) {
        if (await hold(item.id, item.text)) {
          setQueue((q) => q.filter((x) => x.id !== item.id));
          if (!codex) await convoSteer(id, item.id).catch(() => null);
          continue;
        }
        // Nothing holds it (the turn already ended): typed now, as any send.
        const sent = await deliver(item.text, item.id);
        if (!sent) break;
        setQueue((q) => q.filter((x) => x.id !== item.id));
      }
      inFlight.current = false;
      kick();
    })();
    // `releasedAt` + `settled` + readiness are the trigger; the rest is read now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [releasedAt, settled, readiness.ready, terminalId]);

  /** Stop: Esc into the PTY, and the attention daemon told (one path with
   *  the dock's Esc, `interruptTerminal`). */
  const stop = useCallback(() => {
    if (terminalId) void interruptTerminal(terminalId).catch(() => {});
  }, [terminalId]);
  /** Steer: a held send goes NOW. One the outbox holds is typed into the
   *  running turn (Claude folds type-ahead into it), or, for a harness with
   *  no such path, heads the outbox while the turn is stopped through the
   *  one interrupt path, its end delivering it. One held here waits for a
   *  CLI that can't take input yet, so it goes first once it can — never
   *  to the back. */
  const steer = (id: string) => {
    if (terminalId && view.outbox.some((item) => item.id === id)) {
      void convoSteer(terminalId, id)
        .then((result) => {
          if (result.status === "interrupt") return interruptTerminal(terminalId);
        })
        .catch(() => {});
      return;
    }
    setQueue((q) => promoteSend(q, id));
  };
  /** Edit and Remove, wherever the send is held. */
  const takeBack = (id: string, edit: boolean) => {
    if (terminalId && view.outbox.some((item) => item.id === id)) {
      void convoUnqueue(terminalId, id)
        .then((text) => {
          if (edit && text) setRestore({ text, nonce: Date.now() });
        })
        .catch(() => {});
      return;
    }
    const { queue: rest, text } = unqueueSend(queue, id);
    setQueue(rest);
    if (edit && text) setRestore({ text, nonce: Date.now() });
  };
  const drawerRows = useMemo(() => (view.outbox.length === 0 ? queue : [...view.outbox, ...queue]), [view.outbox, queue]);


  // ── What it says ──
  // The agent's CLI is gone from its terminal: the wall's derivation reads
  // it exited (a process sample found the shell back in front), or the
  // daemon's own foreground check says so first (`exited` readiness: a CLI
  // that was live, with the shell in front again and no SessionEnd). The
  // PTY lives on either way, so nothing else would end the turn it left
  // open — a killed build spun "Waiting for Claude to start" for 20 min.
  const agentExited = props.termState === "exited" || (view.readiness?.ready === false && view.readiness.blocker === "exited");
  const term: TermState | null | undefined = agentExited ? "exited" : props.termState;
  const status = workingStatus(view, { term, projectPath: props.projectPath, planHeld: reviewHeld, building: props.planState?.kind === "build" });
  const stats = useMemo(() => planStatsLabel(planStats(props.planMarkdown)), [props.planMarkdown]);
  // Held, the turn is open but nothing is working: no Stop (an Esc into a
  // CLI blocked in the review hook would cancel the plan), no timer.
  const working = !reviewHeld && !agentExited && (view.activeTurn !== null || props.termState === "working");
  const planMode = view.mode === "plan";
  const placeholder =
    layout === "stage"
      ? planMode
        ? "Add to the plan…"
        : `Reply to ${props.harness === "codex" ? "Codex" : "Claude"}…`
      : "Ask about the plan…";
  // The plan a card stands for. Its proposal may be out of view (paged off,
  // or from before this terminal was mirrored); the stage's own title then
  // still puts the card up, at the end.
  const plan: PlanFact | null =
    view.plan ?? (props.planTitle && props.sessionId ? { toolUseId: "", sessionId: props.sessionId, title: props.planTitle, outcome: null, feedback: null } : null);
  const planHeld = !!view.plan && state.events.some((e) => e.kind === "plan_proposed" && e.toolUseId === view.plan?.toolUseId);
  const planContext = useMemo<PlanContext>(
    () => ({ latest: view.plan?.toolUseId ?? null, open: props.planOpen, title: props.planTitle ?? null, marks: props.planMarks ?? 0, stats }),
    [view.plan?.toolUseId, props.planOpen, props.planTitle, props.planMarks, stats],
  );
  const blocks = useStableBlocks(view.blocks);
  // What the CLI is waiting on and what it is doing sit at the end of the
  // running turn — 12px under its prose on the stage, as 4b draws it — or at
  // the end of the conversation when no turn is running.
  const activeId = view.activeTurn?.id ?? null;
  const showWorking = !!status && status.kind !== "plan-ready" && (working || status.kind === "needs-you");
  // The CLI holds a dialog of its own with no card behind it.
  const terminalAsk = view.openAsks.length === 0 && view.readiness?.ready === false && view.readiness.blocker === "native_dialog";
  // A card held open here is the terminal needing you — a held question
  // fires no Notification hook, so without this its row, its tab dot, the
  // top bar's count and ⌘⇧J all read "working" (`lib/openAsks`). So is the
  // CLI's own dialog with no card behind it: a question released to the
  // terminal as this pane went out of sight is still a question (the last
  // walk's row flipping to WORKING seconds after leaving it). Unmounting
  // withdraws nothing: the terminal's next transition, an answer typed
  // into it, or its agent leaving does (TerminalTabs).
  const asksOpen = view.openAsks.length > 0 || terminalAsk;
  useEffect(() => {
    if (terminalId) setTerminalAsking(terminalId, asksOpen);
  }, [terminalId, asksOpen]);
  // A dialog the CLI holds with no card behind it may be its own "Ready to
  // code?" (ExitPlanMode's proceed prompt): read the terminal's recent
  // output while it waits, and put the "Ready to build this plan?" card up
  // for that exact prompt, answered with the keys a person would press.
  const [proceed, setProceed] = useState<ProceedPrompt | null>(null);
  // …or a tool's permission the CLI asks itself ("Do you want to create
  // notes.txt?"), when no hook armed a card for it.
  const [permission, setPermission] = useState<PermissionPrompt | null>(null);
  useEffect(() => {
    if (!terminalAsk || !terminalId) {
      setProceed(null);
      setPermission(null);
      return;
    }
    let alive = true;
    const read = () =>
      void ptyScreenTail(terminalId)
        .then((tail) => {
          if (!alive) return;
          setProceed((prev) => sameProceed(prev, parseProceedPrompt(tail)));
          setPermission((prev) => {
            const next = parsePermissionPrompt(tail);
            return next && prev && prev.question === next.question && sameProceed(prev, next) === prev ? prev : next;
          });
        })
        .catch(() => {});
    read();
    const timer = window.setInterval(read, PROCEED_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [terminalAsk, terminalId]);
  const chooseProceed = useCallback(
    async (n: number) => {
      if (!terminalId || !proceed) return;
      await ptyKeys(terminalId, keysFor(proceed, n));
    },
    [terminalId, proceed],
  );
  const choosePermission = useCallback(
    async (n: number) => {
      if (!terminalId || !permission) return;
      await ptyKeys(terminalId, keysFor(permission, n));
    },
    [terminalId, permission],
  );
  // The agent's CLI is gone (its terminal reads exited): the Detached notice,
  // with Retry for a session building its approved plan.
  const stopped = agentExited && view.openAsks.length === 0;
  const building = props.planState?.kind === "build";
  const tail =
    view.openAsks.length > 0 || terminalAsk || showWorking || stopped ? (
      <>
        {stopped && (
          <StoppedCard
            harness={props.harness === "codex" ? "Codex" : "Claude"}
            building={building}
            onRetry={building ? props.onRetryBuild ?? null : null}
            onShowTerminal={onShowTerminal}
          />
        )}
        {view.openAsks.map((ask) => (
          <AskCard key={ask.askId} ask={ask} onShowTerminal={onShowTerminal} />
        ))}
        {terminalAsk && !stopped && proceed && <ProceedCard prompt={proceed} onChoose={chooseProceed} onShowTerminal={onShowTerminal} />}
        {terminalAsk && !stopped && !proceed && permission && <PermissionPromptCard prompt={permission} harness={props.harness === "codex" ? "Codex" : "Claude"} onChoose={choosePermission} onShowTerminal={onShowTerminal} />}
        {terminalAsk && !stopped && !proceed && !permission && <TerminalAskCard harness={props.harness === "codex" ? "Codex" : "Claude"} onShowTerminal={onShowTerminal} />}
        {showWorking && <WorkingRow status={status!} onStop={terminalId ? stop : null} />}
      </>
    ) : null;
  const cliQueue = useMemo(() => cliQueued(view), [view]);
  // Subagents still running in the active turn: `Task` calls without a
  // result yet, for the work drawer.
  const agents = useMemo<DrawerAgent[]>(
    () =>
      (view.activeTurn?.items ?? [])
        .filter((item) => item.kind === "tool" && item.name === "Task" && item.status === "running")
        .map((item) => ({ id: item.id, label: item.kind === "tool" ? item.summary || item.name : "" })),
    [view.activeTurn],
  );
  const needsYou = view.openAsks.length > 0 || props.termState === "needs-you" || props.termState === "your-turn";
  const earlier = () => {
    pageOlder();
    scroller.current?.scrollTo({ top: 0, behavior: "smooth" });
  };
  // Esc anywhere in the pane while a turn runs or a question waits: Stop,
  // the same Esc the terminal would take. Menus and dialogs keep theirs.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented || !terminalId) return;
    if ((e.target as HTMLElement | null)?.closest("[role=menu], [role=dialog], [role=listbox]")) return;
    if (!working && view.openAsks.length === 0) return;
    e.preventDefault();
    stop();
  };

  return (
    <div className="rl-convo" data-layout={layout} onKeyDown={onKeyDown}>
      {props.header?.(
        { model: view.model ?? props.fallbackModel ?? null, mode: view.mode ?? props.fallbackMode ?? null, working, needsYou, hasOlder: view.hasOlder, boundSessionId: view.bound?.sessionId ?? null, held: reviewHeld && status?.kind === "plan-ready" ? status.label : null },
        { earlier, stop },
      )}
      <div ref={scroller} className="rl-convo-scroll rl-thin-scroll-y" onScroll={onScroll}>
        <div className="rl-convo-list" role="log" aria-live="polite" aria-relevant="additions">
          {view.hasOlder && (
            <div className="rl-convo-older">
              {loadingOlder ? (
                "Loading earlier messages…"
              ) : (
                <button type="button" onClick={pageOlder}>
                  Show earlier messages
                </button>
              )}
            </div>
          )}
          {failed && (
            <p className="rl-convo-note">
              The conversation couldn't be read from here.{" "}
              <button type="button" onClick={onShowTerminal}>
                Open Terminal
              </button>
            </p>
          )}
          {terminalOnly && (
            <p className="rl-convo-note">
              This Codex session is shown in its terminal.{" "}
              <button type="button" onClick={onShowTerminal}>
                Open Terminal
              </button>
              {/* No composer here, so Talk rides the note: voice stays one
                  click away on every conversation. */}
              {props.onTalk && (
                <>
                  {" · "}
                  <button type="button" aria-pressed={!!props.talking} onClick={props.onTalk}>
                    {props.talking ? "Close Talk" : "Talk"}
                  </button>
                </>
              )}
            </p>
          )}
          {blocks.map((block) => (
            <BlockView
              key={block.kind === "turn" ? block.turn.id : block.id}
              block={block}
              layout={layout}
              projectPath={props.projectPath ?? null}
              plan={planContext}
              onOpenPlan={props.onOpenPlan}
              onShowTerminal={onShowTerminal}
              tail={block.kind === "turn" && block.turn.id === activeId ? tail : undefined}
            />
          ))}
          {plan && !planHeld &&
            (props.planState && !props.planState.held ? (
              <PlanStatus
                title={props.planTitle ?? plan.title}
                state={props.planState}
                open={props.planOpen}
                onOpen={props.onOpenPlan}
              />
            ) : props.planOpen ? (
              <PlanReady stats={stats} onOpen={null} />
            ) : (
              <InlinePlan title={props.planTitle ?? plan.title} marks={props.planMarks ?? 0} onOpen={props.onOpenPlan} />
            ))}
          {!plan && !failed && !terminalOnly && blocks.length === 0 && view.pending.length === 0 && !working && (
            <p className="rl-convo-empty">
              {terminalId ? `Nothing said here yet.` : "This session isn't running in a Redline terminal, so there is no conversation to show."}
            </p>
          )}
          {view.pending.map((bubble) => (
            <Bubble
              key={bubble.id}
              bubble={bubble}
              queued={cliQueue.matched.has(bubble.nonce ?? "")}
              onShowTerminal={onShowTerminal}
              // Never "Undelivered" with no way on: Retry sends the words
              // again (through the queue when the CLI can't take them yet).
              onRetry={bubble.delivery === "undelivered" && bubble.nonce ? () => { dispatch({ type: "retract", nonce: bubble.nonce! }); onSend(bubble.text); } : undefined}
            />
          ))}
          {cliQueue.unmatched.map((text, i) => (
            <Bubble key={`cli-queue:${i}`} bubble={{ id: `cli-queue:${i}`, text, delivery: "sent", nonce: null }} queued onShowTerminal={onShowTerminal} />
          ))}
          {!activeId && tail}
        </div>
      </div>
      {!terminalOnly && (
        <div className="rl-convo-dock">
          <WorkDrawer
            queued={drawerRows}
            agents={agents}
            held={reviewHeld}
            onSteer={terminalId ? steer : null}
            onEdit={(id) => takeBack(id, true)}
            onRemove={(id) => takeBack(id, false)}
          />
          {readiness.message && (
            <p className="rl-convo-readiness" role="status">
              {readiness.message}
              {readiness.terminalFix && (
                <>
                  {" "}
                  <button type="button" onClick={onShowTerminal}>
                    Open Terminal
                  </button>
                </>
              )}
            </p>
          )}
          <SessionComposer
            terminalId={terminalId}
            sessionId={props.sessionId}
            harness={props.harness}
            layout={layout}
            mode={view.mode ?? props.fallbackMode ?? null}
            model={view.model ?? props.fallbackModel ?? null}
            projectPath={props.projectPath}
            working={working}
            placeholder={placeholder}
            onSend={onSend}
            onStop={stop}
            onShowTerminal={onShowTerminal}
            talking={props.talking}
            onTalk={props.onTalk}
            restore={restore}
          />
        </div>
      )}
    </div>
  );
}

/** The blocks, with each one that reads the same as last time handed back
 *  as last time's object: `convoView` rebuilds every turn per batch, and
 *  the memoized `BlockView` should re-render only the turn that changed. */
function useStableBlocks(blocks: Block[]): Block[] {
  const cache = useRef(new Map<string, { json: string; block: Block }>());
  return useMemo(() => {
    const next = new Map<string, { json: string; block: Block }>();
    const out = blocks.map((block) => {
      const id = block.kind === "turn" ? block.turn.id : block.id;
      const json = JSON.stringify(block);
      const hit = cache.current.get(id);
      const kept = hit && hit.json === json ? hit.block : block;
      next.set(id, { json, block: kept });
      return kept;
    });
    cache.current = next;
    return out;
  }, [blocks]);
}

function newNonce(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** The CLI's own type-ahead queue, against the sends still waiting for
 *  their prompt: a send the CLI queued reads "Queued", not pending, and a
 *  queued line typed in the terminal itself gets a bubble of its own. */
function cliQueued(view: ConvoView): { matched: Set<string>; unmatched: string[] } {
  const matched = new Set<string>();
  const unmatched: string[] = [];
  const waiting = view.pending.map((bubble) => ({ nonce: bubble.nonce ?? "", text: normalizeSendText(bubble.text) }));
  for (const text of view.queue) {
    const hit = waiting.find((send) => !matched.has(send.nonce) && send.text === normalizeSendText(text));
    if (hit) matched.add(hit.nonce);
    else unmatched.push(text);
  }
  return { matched, unmatched };
}

// ── Blocks ────────────────────────────────────────────────────────────────

interface PlanContext {
  /** The latest proposal's tool-use id: it gets the card; older ones a line. */
  latest: string | null;
  open: boolean;
  title: string | null;
  marks: number;
  /** "3 sections · 11 steps", when the plan's markdown is at hand. */
  stats: string | null;
}

interface BlockProps {
  block: Block;
  /** The running turn's open asks and working row. */
  tail?: React.ReactNode;
  layout: SessionConversationProps["layout"];
  projectPath: string | null;
  plan: PlanContext;
  onOpenPlan: () => void;
  onShowTerminal: () => void;
}

/** One block. Memoized on the block object: the reducer hands back the same
 *  turn for a turn nothing new arrived in, so a live batch re-renders only
 *  the turn it touched. */
const BlockView = memo(function BlockView({ block, ...rest }: BlockProps) {
  if (block.kind === "epoch")
    return (
      <div className="rl-convo-divider" role="separator">
        <span>{block.reason === "clear" ? "Conversation cleared" : block.reason === "resume" ? "Resumed in a new session" : "Forked from here"}</span>
      </div>
    );
  if (block.kind === "compact")
    return (
      <div className="rl-convo-divider" role="separator">
        <span>{block.trigger === "auto" ? "Context compacted automatically" : "Context compacted"}</span>
      </div>
    );
  return <TurnView turn={block.turn} {...rest} />;
});

function TurnView({ turn, layout, projectPath, plan, onOpenPlan, onShowTerminal, tail }: Omit<BlockProps, "block"> & { turn: Turn }) {
  const segments = turnSegments(turn);
  return (
    <>
      {turn.user && <Bubble bubble={turn.user} onShowTerminal={onShowTerminal} />}
      {(turn.items.length > 0 || tail) && (
        <div className="rl-convo-turn">
          {turn.items.length > 0 &&
            segments.map((segment) => (
              <SegmentView key={segment.id} segment={segment} turn={turn} layout={layout} projectPath={projectPath} plan={plan} onOpenPlan={onOpenPlan} />
            ))}
          {turn.interrupted && <div className="rl-convo-quiet">Stopped</div>}
          {tail}
        </div>
      )}
    </>
  );
}

function SegmentView({
  segment,
  turn,
  projectPath,
  plan,
  onOpenPlan,
}: {
  segment: Segment;
  turn: Turn;
  layout: SessionConversationProps["layout"];
  projectPath: string | null;
  plan: PlanContext;
  onOpenPlan: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {segment.summary && (
        <div className="rl-convo-summary-wrap">
          <button type="button" className="rl-convo-summary" aria-expanded={open} onClick={() => setOpen(!open)}>
            <Check size={12} aria-hidden className="rl-convo-ok" />
            <span>{segment.summary}</span>
            <ChevronDown size={12} aria-hidden className="rl-convo-summary-caret" />
          </button>
          {open && (
            <div className="rl-convo-folded">
              <Items items={segment.folded} ended projectPath={projectPath} />
            </div>
          )}
        </div>
      )}
      <Items items={segment.shown} ended={turn.ended} projectPath={projectPath} />
      {segment.plan &&
        // The latest plan: "Plan ready" beside its open panel until it is
        // answered, one inline line while the panel is closed. An earlier
        // or answered one is a quiet line, with its outcome under it.
        (segment.plan.plan.toolUseId === plan.latest && !plan.open ? (
          <InlinePlan title={plan.title ?? segment.plan.plan.title} marks={plan.marks} onOpen={onOpenPlan} />
        ) : segment.plan.plan.toolUseId === plan.latest && segment.plan.plan.outcome === null ? (
          // Its panel is open beside it: nothing to open it to.
          <PlanReady stats={plan.stats} onOpen={null} />
        ) : (
          <div className="rl-convo-quiet">
            <FilePenLine size={13} aria-hidden />
            <span>Plan{segment.plan.plan.title ? ` · ${segment.plan.plan.title}` : ""}</span>
          </div>
        ))}
      {segment.plan?.plan.outcome && <PlanOutcome plan={segment.plan.plan} />}
    </>
  );
}

/** A stretch of items: consecutive tool steps as one group of rows, prose
 *  as markdown, an answered ask as a quiet line. Thinking draws nothing —
 *  its text is never mirrored; the working row says "Thinking" while it
 *  lasts. An open ask is drawn at the end of the conversation instead. */
function Items({ items, ended, projectPath }: { items: TurnItem[]; ended: boolean; projectPath: string | null }) {
  const out: React.ReactNode[] = [];
  let tools: TurnItem[] = [];
  const flush = () => {
    if (!tools.length) return;
    const rows = toolRows(tools, { projectPath, ended });
    if (rows.length) out.push(<ToolRows key={`tools:${tools[0].id}`} rows={rows} />);
    tools = [];
  };
  for (const item of items) {
    if (item.kind === "tool") {
      tools.push(item);
      continue;
    }
    flush();
    if (item.kind === "prose")
      out.push(
        <div key={item.id} className="rl-convo-prose">
          <MarkdownView body={item.text} room rich />
        </div>,
      );
    else if (item.kind === "compact")
      out.push(
        <div key={item.id} className="rl-convo-quiet">
          {item.trigger === "auto" ? "Context compacted automatically" : "Context compacted"}
        </div>,
      );
    else if (item.kind === "ask" && item.outcome) out.push(<ClosedAsk key={item.id} ask={item.ask} outcome={item.outcome} />);
  }
  flush();
  return <>{out}</>;
}

function ToolRows({ rows }: { rows: ToolRow[] }) {
  return (
    <div className="rl-convo-tools">
      {rows.map((row) => (
        <div key={row.id} className="rl-convo-tool" data-status={row.status} title={row.more ? row.steps.join("\n") : undefined}>
          {row.status === "done" ? (
            <Check size={13} aria-hidden className="rl-convo-ok" />
          ) : (
            <X size={13} aria-hidden className={row.status === "error" ? "rl-convo-err" : "rl-convo-stopped"} />
          )}
          <span className="rl-convo-tool-verb">{row.verb}</span>
          {row.target &&
            (row.path ? (
              // The file this step read or edited opens as a file pane — the
              // terminal's ⌘-click route, here a plain click (⌘ for a tab).
              <button
                type="button"
                className="rl-convo-tool-target rl-convo-tool-link"
                title={`Open ${row.path}`}
                onClick={(e) => void openFileLink({ path: row.path! }, { cwd: null, home: null }, fileExists, e.metaKey ? "tab" : "preview")}
              >
                {row.target}
              </button>
            ) : (
              <span className="rl-convo-tool-target">{row.target}</span>
            ))}
          {row.more > 0 && <span className="rl-convo-tool-verb">and {row.more} more</span>}
          {row.status === "error" && <span className="sr-only">(failed)</span>}
        </div>
      ))}
    </div>
  );
}

const ASK_OUTCOME: Record<ConvoAskOutcome, string> = {
  allow: "Allowed",
  always: "Always allowed",
  deny: "Denied",
  answered: "Answered",
  // Chosen, or released while the conversation was out of sight: either
  // way it waits in the terminal, unanswered as far as we know.
  terminal: "Handed to the terminal",
  expired: "Expired",
};

function ClosedAsk({ ask, outcome }: { ask: ConvoAsk; outcome: ConvoAskOutcome }) {
  const ok = outcome === "allow" || outcome === "always" || outcome === "answered";
  return (
    <div className="rl-convo-tool" data-status={ok ? "done" : "stopped"}>
      {ok ? <Check size={13} aria-hidden className="rl-convo-ok" /> : <X size={13} aria-hidden className="rl-convo-stopped" />}
      <span className="rl-convo-tool-verb">{ASK_OUTCOME[outcome]}</span>
      <span className="rl-convo-tool-target">{ask.kind === "question" ? (ask.questions?.[0]?.question ?? ask.summary) : ask.summary || ask.toolName}</span>
    </div>
  );
}

// ── Bubbles, cards, the working row ───────────────────────────────────────

/** How long after a hold's release its waiting sends hold back: the CLI
 *  answers the hook and draws what comes next (a prompt of its own, if it
 *  shows one, reaches the readiness as a blocker) in well under this. */
const RELEASE_SETTLE_MS = 1500;

/** How often a terminal holding a dialog with no card is read for the
 *  CLI's own proceed prompt — only while it holds one. */
const PROCEED_POLL_MS = 1000;

function sameProceed(prev: ProceedPrompt | null, next: ProceedPrompt | null): ProceedPrompt | null {
  if (!prev || !next) return next;
  const same = prev.selected === next.selected && prev.options.length === next.options.length && prev.options.every((o, i) => o.label === next.options[i].label);
  return same ? prev : next;
}

function Bubble({ bubble, queued = false, onShowTerminal, onRetry }: { bubble: UserBubble; queued?: boolean; onShowTerminal: () => void; onRetry?: () => void }) {
  const undelivered = bubble.delivery === "undelivered" && !queued;
  return (
    <div className="rl-convo-bubble-wrap" data-delivery={queued ? "queued" : bubble.delivery}>
      <div className="rl-convo-bubble">{bubble.text}</div>
      {queued && <div className="rl-convo-bubble-note">Queued</div>}
      {undelivered && (
        <div className="rl-convo-bubble-note" role="alert">
          Undelivered ·{" "}
          {onRetry && (
            <>
              <button type="button" onClick={onRetry}>
                Retry
              </button>{" "}
              ·{" "}
            </>
          )}
          <button type="button" onClick={onShowTerminal}>
            Open Terminal
          </button>
        </div>
      )}
    </div>
  );
}

/** 4c: the plan is in, and its panel is open beside the conversation. */
function PlanReady({ stats, onOpen }: { stats: string | null; onOpen: (() => void) | null }) {
  return (
    <div className="rl-convo-plan rl-glass rl-glass-sheet">
      <div className="rl-convo-plan-head">
        <FilePenLine size={14} aria-hidden className="rl-convo-plan-icon" />
        <span className="rl-convo-plan-title">Plan ready</span>
        <span className="rl-convo-spacer" />
        {onOpen && (
          <button type="button" className="rl-convo-plan-open" onClick={onOpen}>
            Open in panel →
          </button>
        )}
      </div>
      <p className="rl-convo-plan-body">{stats ? `${stats}. ` : ""}Mark anything you'd change, then approve.</p>
    </div>
  );
}

const PLAN_KIND_ICON = { chat: FilePenLine, plan: FilePenLine, redline: FilePenLine, build: Hammer } as const;

/** A plan past its review (approved, building, built) or back with Claude:
 *  where it is, in the top bar's words and colour, and the way to it. */
function PlanStatus({ title, state, open, onOpen }: {
  title: string | null;
  state: NonNullable<SessionConversationProps["planState"]>;
  open: boolean;
  onOpen: () => void;
}) {
  const Icon = PLAN_KIND_ICON[state.kind];
  const body = (
    <>
      <Icon size={14} aria-hidden className="rl-convo-plan-icon" style={{ color: `var(--color-mode-${state.kind === "chat" ? "plan" : state.kind}-fg)` }} />
      <span className="rl-convo-inline-title">Plan{title ? ` · ${title}` : ""}</span>
      <span className="rl-convo-plan-state" data-kind={state.kind}>
        {state.label}
        {state.step ? `: ${state.step}` : ""}
      </span>
      {state.toReview > 0 && <span className="rl-convo-inline-marks">{state.toReview} to review</span>}
      <span className="rl-convo-spacer" />
      {!open && <span className="rl-convo-inline-open">Open</span>}
    </>
  );
  return open ? (
    <div className="rl-convo-inline-plan rl-glass rl-glass-sheet" data-static="">{body}</div>
  ) : (
    <button type="button" className="rl-convo-inline-plan rl-glass rl-glass-sheet" onClick={onOpen}>
      {body}
    </button>
  );
}

/** 4d: the plan's panel is closed; one line keeps it a click away. */
function InlinePlan({ title, marks, onOpen }: { title: string | null; marks: number; onOpen: () => void }) {
  return (
    <button type="button" className="rl-convo-inline-plan rl-glass rl-glass-sheet" onClick={onOpen}>
      <FilePenLine size={14} aria-hidden className="rl-convo-plan-icon" />
      <span className="rl-convo-inline-title">Plan{title ? ` · ${title}` : ""}</span>
      {marks > 0 && <span className="rl-convo-inline-marks">{marks === 1 ? "1 mark" : `${marks} marks`}</span>}
      <span className="rl-convo-spacer" />
      <span className="rl-convo-inline-open">Open</span>
    </button>
  );
}

function PlanOutcome({ plan }: { plan: PlanFact }) {
  const text =
    plan.outcome === "approved" ? "Approved" : plan.outcome === "denied" ? "Plan declined" : "Sent back with your marks";
  return (
    <div className="rl-convo-tool" data-status={plan.outcome === "approved" ? "done" : "stopped"}>
      {plan.outcome === "approved" ? <Check size={13} aria-hidden className="rl-convo-ok" /> : <ArrowRight size={13} aria-hidden className="rl-convo-stopped" />}
      <span className="rl-convo-tool-verb">{text}</span>
    </div>
  );
}

/** The turn's one working row. A step is named ("Reading docs/x.md",
 *  "Writing the plan", "Needs you"); a turn that is only working is the
 *  quiet typing state — the shared Spinner, its word for a screen reader
 *  alone (D28). */
function WorkingRow({ status, onStop }: { status: WorkingStatus; onStop: (() => void) | null }) {
  const quiet = status.kind === "working";
  return (
    <div className="rl-convo-working" role="status" data-kind={status.kind}>
      {status.kind === "needs-you" ? (
        <span className="rl-convo-needs" aria-hidden />
      ) : (
        <Spinner size={12} className="rl-convo-spinner" />
      )}
      <span className={quiet ? "rl-convo-working-label sr-only" : "rl-convo-working-label"}>{status.label}</span>
      {status.since !== null && <Elapsed since={status.since} />}
      <span className="rl-convo-spacer" />
      {onStop && (
        <button type="button" className="rl-convo-stop" onClick={onStop} title="Stop (Esc in the terminal)">
          Stop
        </button>
      )}
    </div>
  );
}

/** The faint timer, ticking on its own so nothing else re-renders per
 *  second. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return <span className="rl-convo-elapsed">{formatElapsed(now - since)}</span>;
}

/** Memoized: the shell re-renders on every event it hears (attention, polls,
 *  the island); the stage's props change on few of them. */
export default memo(SessionConversation);
