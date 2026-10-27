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
//!   local queue (`QueueTray`) and goes, in order, when it can.
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

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { ArrowRight, Check, ChevronDown, FilePenLine, Hammer, X } from "lucide-react";
import { MarkdownView } from "../MarkdownView";
import { QueueTray } from "../QueueTray";
import { Spinner } from "../Spinner";
import { answerAsk, convoExpect, convoPage, convoSubscribe, convoUnsubscribe, ptyInterrupt, ptySubmit } from "./convo/api";
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
} from "./convo/readiness";
import type { TermState } from "../../lib/termState";
import { AskCard } from "./AskCard";
import { SessionComposer } from "./SessionComposer";
import "./conversation.css";

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
    host: view.readiness,
    harness: props.harness,
  });
  const [queue, setQueue] = useState<QueuedSend[]>([]);
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

  const onSend = (text: string) => {
    const nonce = newNonce();
    if (routeSend(readiness, queue) === "send") {
      inFlight.current = true;
      const seen = view.readiness;
      void deliver(text, nonce).then((sent) => {
        inFlight.current = false;
        if (!sent) {
          setQueue((q) => enqueueSend(q, { id: nonce, text, at: Date.now() }));
          setHeld({ at: seen });
        }
        kick();
      });
    } else setQueue((q) => enqueueSend(q, { id: nonce, text, at: Date.now() }));
  };

  // The flush: one at a time, in order, whenever the composer can type.
  const next = nextFlush(queue, readiness, { inFlight: inFlight.current, held: isHeld });
  useEffect(() => {
    if (!next || inFlight.current) return;
    inFlight.current = true;
    const seen = view.readiness;
    void deliver(next.text, next.id).then((sent) => {
      inFlight.current = false;
      if (sent) setQueue((q) => q.filter((item) => item.id !== next.id));
      else setHeld({ at: seen });
      kick();
    });
    // `next` is null while one is typing or the queue is held, so its id
    // moving is exactly "the head can go now".
  }, [next?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const stop = () => {
    if (terminalId) void ptyInterrupt(terminalId).catch(() => {});
  };

  // ── What it says ──
  const status = workingStatus(view, { term: props.termState, projectPath: props.projectPath });
  const stats = useMemo(() => planStatsLabel(planStats(props.planMarkdown)), [props.planMarkdown]);
  const working = view.activeTurn !== null || props.termState === "working";
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
  const tail =
    view.openAsks.length > 0 || showWorking ? (
      <>
        {view.openAsks.map((ask) => (
          <AskCard key={ask.askId} ask={ask} onShowTerminal={onShowTerminal} />
        ))}
        {showWorking && <WorkingRow status={status!} onStop={terminalId ? stop : null} />}
      </>
    ) : null;
  const cliQueue = useMemo(() => cliQueued(view), [view]);

  return (
    <div className="rl-convo" data-layout={layout}>
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
          <QueueTray
            rows={queue.map((item) => ({ id: item.id, text: item.text }))}
            onRemove={(id) => {
              const { queue: rest, text } = unqueueSend(queue, id);
              setQueue(rest);
              if (text) setRestore({ text, nonce: Date.now() });
            }}
            onPromote={(id) => setQueue((q) => promoteSend(q, id))}
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
          {row.target && <span className="rl-convo-tool-target">{row.target}</span>}
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

function Bubble({ bubble, queued = false, onShowTerminal }: { bubble: UserBubble; queued?: boolean; onShowTerminal: () => void }) {
  const undelivered = bubble.delivery === "undelivered" && !queued;
  return (
    <div className="rl-convo-bubble-wrap" data-delivery={queued ? "queued" : bubble.delivery}>
      <div className="rl-convo-bubble">{bubble.text}</div>
      {queued && <div className="rl-convo-bubble-note">Queued</div>}
      {undelivered && (
        <div className="rl-convo-bubble-note" role="alert">
          Undelivered ·{" "}
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

function WorkingRow({ status, onStop }: { status: WorkingStatus; onStop: (() => void) | null }) {
  return (
    <div className="rl-convo-working" role="status" data-kind={status.kind}>
      {status.kind === "needs-you" ? (
        <span className="rl-convo-needs" aria-hidden />
      ) : (
        <Spinner size={12} className="rl-convo-spinner" />
      )}
      <span className="rl-convo-working-label">{status.label}</span>
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
