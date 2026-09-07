// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The in-flight reply bubble, shared by every chat surface.
//!
//! Before this there were four byte-similar copies (`BrowserChat`,
//! `LinkedChat`, `MissionChat`, `CommentThread`) plus three inlined variants,
//! all rendering the same three lines with slightly different bylines. Folding
//! them into one is what pays for the meter: the badge, the activity line and
//! the caret are written once and every surface inherits them.
//!
//! ```
//! ┌─ Claude · opus · xhigh ──────────────── 3.2k ctx · 18% ─┐  model badge + live meter
//! │ ▸ Searching the lake · Grep(seat_burn)                   │  activity line
//! │ The seat table already has the columns you need…▌        │  MarkdownView (rich OFF)
//! └──────────────────────────────────────────────────────────┘
//! ```
//!
//! The activity line is the whole point of "show more of the real stream": a
//! turn that spends 40 seconds retrieving used to render as a pulsing logo.
//! It covers every non-text thing the meter sees — the current tool, thinking,
//! and `Rate limited · waiting` in place of a blank ticker.
//!
//! `rich` is OFF here, deliberately and for everyone. Every surface already
//! streamed with `rich={false}` except the chat room, which streamed `rich` —
//! the one place a half-written ` ```mermaid ` fence reached `MermaidView`
//! mid-stream and flashed a "Diagram error" card. One component, one answer.

import { lazy, Suspense, useState } from "react";

import { MarkdownView } from "./MarkdownView";
import {
  activityLabel,
  contextPressure,
  formatTokens,
  meterBadgeLabel,
  type Activity,
  type TurnMeter,
} from "../lib/turnMeter";

/** The raw-wire pane. Lazy on purpose — it is devtools, most turns never open
 *  it, and `boot.test.ts` pins that no module reaches it statically. */
const StreamInspector = lazy(() => import("./StreamInspector"));

const BYLINE: React.CSSProperties = {
  fontSize: "9px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.07em",
};

const NUMERIC: React.CSSProperties = {
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  fontVariantNumeric: "tabular-nums",
};

/** The badge's right half: how full the context is. Renders tokens alone when
 *  no window is known for the model — a percentage we can't justify is worse
 *  than none. */
function ContextChip({ meter }: { meter: TurnMeter }) {
  if (meter.contextTokens <= 0) return null;
  const pressure = contextPressure(meter);
  const tint =
    pressure?.high === true ? "var(--color-warning)" : "var(--color-ink-muted)";
  return (
    <span
      className="flex items-center gap-1"
      style={{ ...NUMERIC, fontSize: "9px", color: tint }}
      title={
        pressure
          ? `${meter.contextTokens.toLocaleString()} of ${pressure.limit.toLocaleString()} context tokens`
          : `${meter.contextTokens.toLocaleString()} context tokens · window unknown for this model`
      }
    >
      <span>{formatTokens(meter.contextTokens)} ctx</span>
      {pressure && (
        <>
          <span
            aria-hidden
            style={{
              width: "22px",
              height: "3px",
              borderRadius: "2px",
              background: "var(--color-rule)",
              overflow: "hidden",
              display: "inline-block",
            }}
          >
            <span
              style={{
                display: "block",
                height: "100%",
                width: `${Math.round(pressure.fraction * 100)}%`,
                background: tint,
              }}
            />
          </span>
          <span>{Math.round(pressure.fraction * 100)}%</span>
        </>
      )}
    </span>
  );
}

export interface StreamingBubbleProps {
  /** The reply so far. Empty until the first token — which is exactly the
   *  window the activity line exists to fill. */
  text: string;
  /** Who is speaking: "Claude", "Linked", "Orchestrator", … */
  agent: string;
  /** The backend is quietly re-running the turn after a transient model error.
   *  Redline is speaking here, not the model, so the byline says so. */
  retrying?: boolean;
  /** The live meter, if the surface is wired to `useAgentTurn`. */
  meter?: TurnMeter | null;
  /** What the turn has been doing while you waited. */
  activity?: readonly Activity[] | null;
  /** Where this turn's raw wire lives, if the surface wants the inspector
   *  chip. Omit and no chip renders — and nothing is ever captured. */
  inspect?: { surface: string; key: string };
  onOpenLink?: (url: string) => void;
}

export default function StreamingBubble({
  text,
  agent,
  retrying,
  meter,
  activity,
  inspect,
  onOpenLink,
}: StreamingBubbleProps) {
  const [inspecting, setInspecting] = useState(false);
  const badge = retrying ? null : meterBadgeLabel(meter ?? null);
  const doing = retrying
    ? "⟳ Temporary model error — retrying…"
    : activityLabel(activity, meter ?? null);
  const stalled = !!meter?.rateLimited;
  return (
    // `contain: content` follows `.rl-comment-card`: a bubble that repaints on
    // every token must not invalidate layout for the thread above it.
    <div className="flex flex-col gap-0.5" style={{ contain: "content" }}>
      <div className="flex items-baseline justify-between gap-2">
        <span
          style={{
            ...BYLINE,
            color: retrying ? "var(--color-ink-muted)" : "var(--color-info)",
          }}
          title={meter?.model ?? undefined}
        >
          {retrying ? "Redline" : (badge ?? agent)}
        </span>
        <span className="flex items-center gap-1.5">
          {meter && !retrying && <ContextChip meter={meter} />}
          {inspect && (
            // A chip on the badge, never a header button: a devtools surface
            // is entered through the thing it explains.
            <button
              type="button"
              onClick={() => setInspecting((v) => !v)}
              title={
                inspecting
                  ? "Stop capturing the raw stream"
                  : "Show the raw stream for this turn"
              }
              aria-pressed={inspecting}
              style={{
                fontFamily: "var(--font-mono, ui-monospace, monospace)",
                fontSize: "9px",
                lineHeight: 1,
                padding: "1px 4px",
                border: "1px solid var(--color-rule)",
                borderRadius: "4px",
                background: inspecting
                  ? "color-mix(in srgb, var(--color-info) 14%, transparent)"
                  : "transparent",
                color: "var(--color-ink-muted)",
              }}
            >
              {"<>"}
            </button>
          )}
        </span>
      </div>
      {inspect && inspecting && (
        <Suspense fallback={null}>
          <StreamInspector
            surface={inspect.surface}
            turnKey={inspect.key}
            onClose={() => setInspecting(false)}
          />
        </Suspense>
      )}
      {doing && (
        <div
          className="flex items-center gap-1"
          style={{
            fontSize: "calc(10.5px * var(--rl-discussion-zoom, 1))",
            lineHeight: 1.4,
            color: stalled ? "var(--color-warning)" : "var(--color-ink-muted)",
          }}
        >
          <span aria-hidden>▸</span>
          <span className="truncate">{doing}</span>
        </div>
      )}
      {text ? (
        <div>
          <MarkdownView body={text} compact onLinkClick={onOpenLink} />
          <span style={{ color: "var(--color-ink-muted)" }}>
            {retrying ? "" : "▌"}
          </span>
        </div>
      ) : (
        !doing && (
          <div
            style={{
              fontSize: "calc(12.5px * var(--rl-discussion-zoom, 1))",
              lineHeight: 1.5,
              color: "var(--color-ink-muted)",
            }}
          >
            working…
          </div>
        )
      )}
    </div>
  );
}
