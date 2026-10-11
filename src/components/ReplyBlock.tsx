// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! One reply anatomy for every chat surface (design decision 4): the same
//! skeleton while a reply streams and once it has settled, so nothing above,
//! inside or around its text arrives or leaves when the turn ends.
//!
//! ```
//! CLAUDE  ▸ Used 2 tools · 12.4s                head row: byline, then steps
//! The seat table already has the columns…      text: StreamingText ≡ MarkdownView
//! Copy · Save idea · ⋯      34.2k in · 1.4k out  tail row: one fixed height
//! ```
//!
//! - **Byline.** The provider that wrote the reply (or is writing it: the one
//!   it was sent to, BC-26), plus the model only when it differs from the one
//!   the surface is configured for — the fallback-swap honesty signal. Both
//!   phases read the same meter at the swap, so they read the same string.
//! - **Steps line.** Present exactly when the turn used tools
//!   (`replySteps.hasSteps`), in both phases: the current tool while live,
//!   "Used N tools · 12.4s" settled. It expands to the steps, reads and
//!   searches folded; anything a reader can act on is never behind it. It
//!   sits on the byline's row, one fixed height whether or not it is there:
//!   an agent that writes before its first tool would otherwise push a line
//!   in above text already being read. The page chat turns it off and draws
//!   each step as a row of its own under the text (`children`), where a new
//!   one moves nothing already written.
//! - **Text.** `StreamingText` live, `MarkdownView` settled — byte-identical
//!   markup for a body with no diagram.
//! - **Tail row.** One fixed height in both phases. Live it is the turn's one
//!   status line (`chatProgress`, the shared shimmer, `role="status"`), and
//!   on a hover or focus the ⋯ to the raw stream; settled it is the surface's
//!   actions (on hover, on focus, and always on the latest reply), the ⋯,
//!   and one ellipsized meter line. A raw stream opened on a live reply stays
//!   open on the reply it settles into.
//!
//! No box, no caret, no second indicator, and no Stop: Stop is the
//! composer's primary button (`SendStopButton`).

import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";

import { MarkdownView } from "./MarkdownView";
import { StreamingText } from "./StreamingText";
import { Panel, useClickPopover } from "./popover";
import { costEnabled } from "./TurnFooter";
import { UnsentNote } from "./TurnNotes";
import { chatProgress, elapsedLabel, type ChatProgressStatus } from "../lib/chatProgress";
import { foldSteps, hasSteps, stepsLabel, toolSteps } from "../lib/replySteps";
import { modelInfo } from "../lib/modelInfo";
import {
  meterFooterLabel,
  turnCostUsd,
  wasTruncated,
  type Activity,
  type TurnMeter,
} from "../lib/turnMeter";
import "./ComposerMenu.css";
import "./ReplyBlock.css";

/** The raw-wire pane. Lazy on purpose — it is devtools, most turns never open
 *  it, and `boot.test.ts` pins that no module reaches it statically. */
const StreamInspector = lazy(() => import("./StreamInspector"));

/** Threads whose raw stream was open on a live reply as it went: the reply it
 *  settles into, mounting in the same commit, opens it again. */
const handedOver = new Set<string>();

export interface ReplyBlockProps {
  phase: "live" | "settled";
  /** Who wrote it: the provider ("Claude", "Codex"), or "Redline" over an
   *  error row, whose sentence Redline wrote. */
  byline: string;
  /** The model the surface asked for, when it names one. The byline adds the
   *  model that answered only when it is a different one. */
  seat?: string | null;
  text: string;
  /** Live: the turn's meter. Settled: the row's, which is the same meter. */
  meter?: TurnMeter | null;
  /** Live: what the turn has been doing, newest last. */
  activity?: readonly Activity[] | null;
  /** Live: when the turn started (the backend's clock, so a remount keeps it). */
  startedAt?: number | null;
  /** Live: the surface's own words for the current step (retrieval
   *  narration). Never wins over a rate limit. */
  status?: ChatProgressStatus | null;
  /** Live: the backend is re-running the turn after a transient error. */
  retrying?: boolean;
  /** Settled: the body is Redline's note that the turn failed. */
  error?: boolean;
  /** Settled: draw diagrams (the default). The plan comment's quick chat
   *  stays plain, so a short answer can't sprout one. */
  rich?: boolean;
  /** The chat room at plate scale: roomy prose, larger meta text. */
  room?: boolean;
  /** This turn's context restarted (compaction or a fresh CLI session). */
  contextReset?: boolean;
  /** Settled: the surface's actions on this reply, for the tail row. */
  actions?: ReactNode;
  /** Draw the head row's steps line. Off on a surface that shows the steps
   *  as rows of their own under the text (`children`). */
  stepsLine?: boolean;
  /** Where this thread's raw wire is captured, for the tail's ⋯. Omit and
   *  there is no ⋯ — and nothing is ever captured. */
  inspect?: { surface: string; key: string };
  onOpenLink?: (url: string) => void;
  className?: string;
  /** Rows that belong to the reply, under its text (Memory's citations). */
  children?: ReactNode;
}

export function ReplyBlock({
  phase,
  byline,
  seat = null,
  text,
  meter = null,
  activity,
  startedAt = null,
  status = null,
  retrying = false,
  error = false,
  rich = true,
  room = false,
  contextReset = false,
  actions,
  stepsLine = true,
  inspect,
  onOpenLink,
  className,
  children,
}: ReplyBlockProps) {
  const live = phase === "live";
  const [stepsOpen, setStepsOpen] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  // A raw stream watched on a live reply is not shut on the turn's last lines:
  // the live block leaves it to its thread as it goes, and the settled block
  // taking its place picks it up (a commit runs removals' layout cleanups
  // before additions' layout effects). Unclaimed, it lapses with the task.
  const wire = inspect ? `${inspect.surface}\u0000${inspect.key}` : null;
  const watching = useRef(inspecting);
  watching.current = inspecting;
  useLayoutEffect(() => {
    if (!wire) return;
    if (!live && handedOver.delete(wire)) setInspecting(true);
    return () => {
      if (!live || !watching.current) return;
      handedOver.add(wire);
      queueMicrotask(() => handedOver.delete(wire));
    };
  }, [wire, live]);
  // When the reply last grew: the tail reads "Writing the reply" until a
  // newer step arrives. Kept off state, because the text re-renders this
  // block every frame anyway.
  const output = useRef({ length: 0, at: 0 });
  if (live && text.length !== output.current.length) {
    output.current = { length: text.length, at: text ? Date.now() : 0 };
  }
  const model = modelInfo(meter?.model);
  const named = model && swapped(seat, model.id) ? `${byline} · ${model.short}` : byline;
  const steps = stepsLine && meter && hasSteps(meter) ? (live ? toolSteps(activity) : (meter.steps ?? [])) : null;
  return (
    <div
      className={className ? `rl-reply ${className}` : "rl-reply"}
      data-reply={phase}
      data-room={room || undefined}
    >
      {/* The steps ride the byline's row, which is there from the first
          frame: a tool that fires after the text has begun adds words to it,
          never a line above text being read. */}
      <div className="rl-reply-head">
        <div className="rl-reply-byline" data-error={error || undefined} title={meter?.model ?? undefined}>
          {named}
        </div>
        {meter && steps && (
          <button
            type="button"
            className="rl-reply-steps"
            data-reply-steps
            aria-expanded={stepsOpen}
            disabled={steps.length === 0}
            onClick={() => setStepsOpen((open) => !open)}
          >
            <span aria-hidden>{stepsOpen ? "▾" : "▸"}</span>
            <span className="rl-reply-steps-label">{stepsLabel(phase, meter, activity)}</span>
          </button>
        )}
      </div>
      {steps && stepsOpen && (
        <ul className="rl-reply-steplist">
          {foldSteps(steps).map((row, i) => (
            <li key={i} title={row.folded?.join("\n")}>
              {row.label}
            </li>
          ))}
        </ul>
      )}
      {live ? (
        <StreamingText className="rl-reply-text" text={text} room={room} onOpenLink={onOpenLink} />
      ) : (
        <div className="rl-reply-text">
          {error ? (
            <div className="rl-reply-error">{text}</div>
          ) : (
            <MarkdownView body={text} compact room={room} rich={rich} onLinkClick={onOpenLink} />
          )}
        </div>
      )}
      {children}
      <div className="rl-reply-tail" data-reply-tail>
        {live ? (
          <LiveStatus
            activity={activity ?? []}
            meter={meter}
            status={status}
            startedAt={startedAt}
            retrying={retrying}
            lastOutputAt={output.current.at}
            more={inspect && (
              <div className="rl-reply-actions rl-hide-scroll-x">
                <ReplyMore inspecting={inspecting} onInspect={() => setInspecting((on) => !on)} />
              </div>
            )}
          />
        ) : (
          <>
            <div className="rl-reply-actions rl-hide-scroll-x">
              {actions}
              {inspect && <ReplyMore inspecting={inspecting} onInspect={() => setInspecting((on) => !on)} />}
            </div>
            <ReplyMeter meter={meter} contextReset={contextReset} />
          </>
        )}
      </div>
      {inspect && inspecting && (
        <Suspense fallback={null}>
          <StreamInspector surface={inspect.surface} turnKey={inspect.key} onClose={() => setInspecting(false)} />
        </Suspense>
      )}
    </div>
  );
}

/** Whether the model that answered is not the one the surface asked for — a
 *  `--fallback-model` swap. An alias matches its full ids ("opus" and
 *  "claude-opus-4-6"); with nothing asked for there is nothing to differ from. */
function swapped(seat: string | null, model: string): boolean {
  const plain = (id: string) => id.trim().toLowerCase().replace(/^claude-/, "").replace(/\[1m\]$/, "");
  if (!seat?.trim()) return false;
  const want = plain(seat);
  const got = plain(model);
  return !got.startsWith(want) && !want.startsWith(got);
}

/** The live tail: the turn's one status line, with its elapsed clock on the
 *  right where the settled meter will sit, and `more` (the ⋯) between them.
 *  Its own component so the one-second clock re-renders a phrase, never the
 *  reply's text. The clock sits outside the live region, so a screen reader
 *  hears the phrase change and not every second. */
function LiveStatus({
  activity,
  meter,
  status,
  startedAt,
  retrying,
  lastOutputAt,
  more,
}: {
  activity: readonly Activity[];
  meter: TurnMeter | null;
  status: ChatProgressStatus | null;
  startedAt: number | null;
  retrying: boolean;
  lastOutputAt: number;
  more?: ReactNode;
}) {
  const [mountedAt] = useState(Date.now);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const progress = chatProgress(activity, meter, status, startedAt ?? mountedAt, Math.max(now, lastOutputAt), lastOutputAt);
  const quiet = progress.quietFor >= 30_000;
  const label = retrying
    ? "Temporary model error — retrying…"
    : quiet && !meter?.rateLimited
      ? "Still waiting for the agent"
      : progress.label;
  return (
    <>
      <span role="status" className="rl-reply-status" data-stalled={meter?.rateLimited ? true : undefined}>
        <span className="rl-working-label">
          {label}
          <span className="rl-working-glint" data-label={label} aria-hidden />
        </span>
      </span>
      {more}
      <span className="rl-reply-meter" aria-hidden>
        {quiet ? `quiet ${elapsedLabel(progress.quietFor)} · ${progress.elapsed}` : progress.elapsed}
      </span>
    </>
  );
}

/** The settled tail's one meter line: `truncated` first and in the warning
 *  colour, so the ellipsis can never cut it off; then the tokens and the
 *  time. The model and everything else are in its tooltip. */
function ReplyMeter({ meter, contextReset }: { meter: TurnMeter | null; contextReset: boolean }) {
  if (!meter) return null;
  const truncated = wasTruncated(meter);
  const cost = costEnabled() ? turnCostUsd(meter) : null;
  const parts = [
    contextReset ? "context reset" : null,
    meterFooterLabel(meter, false),
    cost == null ? null : `~$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`,
  ].filter((part): part is string => !!part);
  if (!truncated && parts.length === 0) return null;
  return (
    <span
      className="rl-reply-meter"
      title={[
        meter.model,
        meter.effort,
        `input ${meter.inputTokens.toLocaleString()}`,
        `output ${meter.outputTokens.toLocaleString()}`,
        `cache read ${meter.cacheReadTokens.toLocaleString()}`,
        `cache write ${meter.cacheCreationTokens.toLocaleString()}`,
        meter.serviceTier ? `tier ${meter.serviceTier}` : null,
        meter.toolCalls > 0 ? `${meter.toolCalls} tool calls` : null,
        truncated ? "the model hit its output limit: this reply is cut off, not finished" : null,
        contextReset ? "the context restarted here (auto-compaction or a fresh CLI session)" : null,
        cost == null ? null : "cost is the CLI's list-price estimate, not what a subscription is billed",
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      {truncated && <span className="rl-reply-truncated">truncated</span>}
      {truncated && parts.length > 0 && " · "}
      {parts.join(" · ")}
    </span>
  );
}

/** The tail's ⋯: the raw-stream inspector, entered from the reply it
 *  explains rather than from a header button. */
function ReplyMore({ inspecting, onInspect }: { inspecting: boolean; onInspect: () => void }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useClickPopover(trigger, "left", "above", 220, true);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="rl-reply-action"
        aria-label="More for this reply"
        title="More"
        aria-haspopup="menu"
        aria-expanded={pop.open}
        onClick={pop.toggle}
      >
        <MoreHorizontal size={13} aria-hidden />
      </button>
      {pop.open && (
        <Panel label="More for this reply" {...pop.panelProps} className="rl-composer-menu">
          <button
            type="button"
            role="menuitem"
            className="rl-composer-option"
            onClick={() => {
              onInspect();
              pop.close();
            }}
          >
            <span>
              <strong>{inspecting ? "Hide the raw stream" : "Show the raw stream"}</strong>
              <small>{inspecting ? "Capture stops and the buffer is freed" : "Capture this thread's wire from here on"}</small>
            </span>
          </button>
        </Panel>
      )}
    </>
  );
}

/** The user's side of a turn: a compact card with no "You" byline — the
 *  reply under it is the one that needs a name. */
export function UserTurn({
  body,
  room = false,
  onResend,
  unsent = false,
  onOpenLink,
  context,
  children,
}: {
  body: string;
  /** What the message carried, shown above its text (the page chat's chips). */
  context?: ReactNode;
  room?: boolean;
  /** The send never became a turn: say so, and offer it again. */
  unsent?: boolean;
  onResend?: () => void;
  /** Where a link in it opens, on a surface that opens links itself. */
  onOpenLink?: (url: string) => void;
  /** What rode with it (attachments). */
  children?: ReactNode;
}) {
  return (
    <div className="rl-user-turn" data-user-turn data-room={room || undefined}>
      {context}
      {body && <MarkdownView body={body} compact room={room} onLinkClick={onOpenLink} />}
      {children}
      {unsent && <UnsentNote onResend={onResend} />}
    </div>
  );
}
