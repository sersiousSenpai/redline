// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { tourShortcuts } from "../lib/keymap";
import { isEditableTarget } from "../lib/landing";

// A first-run guided tour: dim the window, cut a spotlight around the real
// region being explained, and float a themed tooltip card pointing at it. The
// regions are located at runtime via `data-tour="<id>"` attributes (see the
// table in the plan), so the tour rides on the live layout instead of a parallel
// mock. Steps without an anchor — or whose anchor is absent/collapsed — render
// as a centered card, which also covers the empty first-run state where the
// editor and discussion panes have no content yet.
//
// Styling mirrors the existing modal idiom (FeedbackModal): inline styles over
// theme vars, no reusable modal primitive, no new dependency.

type Placement = "top" | "bottom" | "left" | "right" | "center";

interface Bullet {
  label: string;
  text: ReactNode;
  /** Accent color for the label; defaults to ink. */
  color?: string;
}

interface Shortcut {
  /** Keys in the combo, rendered as separate caps joined by "+". */
  keys: string[];
  text: string;
}

interface TourStep {
  id: string;
  /** `data-tour` id of the region to spotlight. Omit for a centered card. */
  anchor?: string;
  title: string;
  /** One-line gist, shown emphasized above the rest. */
  lead?: ReactNode;
  /** Structured rows (modes, comment types, actions) — visually separated. */
  bullets?: Bullet[];
  /** Keyboard-shortcut rows, rendered as keycaps + an action label. Read as
   *  the step shows: they name keys the user may have changed since. */
  shortcuts?: () => Shortcut[];
  /** Supporting detail, shown muted below the lead/bullets. */
  body?: ReactNode;
  /** Preferred side of the anchor for the card; ignored for centered steps. */
  placement?: Placement;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface OnboardingTourProps {
  onClose: () => void;
  /** Fires with the current step's anchor id (or undefined) whenever the step
   *  changes. App uses it to reveal a collapsed region (e.g. the terminal dock)
   *  before it's spotlighted, and restore it once the step moves on. */
  onAnchorChange?: (anchor: string | undefined) => void;
}

const PAD = 8; // breathing room between the spotlight ring and the target
const GAP = 14; // distance from the target to the tooltip card
const MARGIN = 16; // keep the card this far from the viewport edges
const CARD_W = 340;

// A single keycap — a small bordered, monospaced box so shortcut keys read as
// physical keys instead of a run-on string.
function KeyCap({ children }: { children: ReactNode }) {
  return (
    <span
      className="font-mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 16,
        padding: "1px 6px",
        fontSize: "11px",
        lineHeight: 1.5,
        color: "var(--color-anchor-text)",
        background: "var(--color-anchor-bg)",
        border: "1px solid var(--color-rule)",
        borderRadius: 4,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

// Authored copy lives here so it can be wordsmithed in one place. Voice: warm,
// plain, second-person — matches the README / Feedback tone. Each card is a
// short lead + optional structured bullets + a muted detail line, so nothing
// reads as a wall of text. The shortcuts step reads the declarative keymap
// registry (lib/keymap.ts), so a new global binding shows up here without a
// second copy.
//
// The steps walk the workbench's frame (W6): the door tab's composer, the tab
// strip, the sidebar's Places and project groups, the Agent tab, the
// terminals tab, the plan, the right rail's tabs, the Plan pane's verbs, the
// status bar's pill. Anchor hygiene: every `anchor` names a `data-tour` that a
// real element carries (OnboardingTour.anchors.test.tsx pins each one, and the
// app fixture's `tour` scene finds each on screen); the theme/mode pickers
// live INSIDE the Settings popover and exist only while it's open, so steps
// about them anchor the always-present settings trigger instead. A step whose
// anchor is not on screen right now (an Agent tab before any session) shows
// as a centred card.
const STEPS: TourStep[] = [
  {
    id: "welcome",
    title: "Welcome to Redline",
    lead: (
      <>
        Redline turns Claude Code's plans into documents you mark up — the way
        a lawyer redlines a contract.
      </>
    ),
    body: (
      <>
        Your sessions are on the left, each one's tabs in the middle — the
        plan, its agent, its terminals — and a rail on the right. Here's the
        quick tour; replay it anytime from <strong>Redline → Getting Started</strong>.
      </>
    ),
  },
  {
    id: "landing",
    anchor: "landing",
    // The door tab's composer: the coachmark sits below it, where the
    // recents would be on a first run.
    placement: "bottom",
    title: "Type what you want to build",
    lead: (
      <>
        One sentence in the box, then <strong>⏎</strong> — Claude starts
        planning it in a real project.
      </>
    ),
    body: (
      <>
        This is a door tab. Its menu also opens a draft, a chat, the browser,
        a code review, Localhost or Memory, right here in place.
      </>
    ),
  },
  {
    id: "tabs",
    anchor: "tabs",
    placement: "bottom",
    title: "Every session is a set of tabs",
    lead: <>The plan, its agent, its terminals, and whatever you open beside them.</>,
    shortcuts: () => [
      { keys: ["⌘", "T"], text: "A new door tab" },
      { keys: ["⌘", "W"], text: "Close the tab (never the window)" },
      { keys: ["⌘", "1–9"], text: "Go to a tab" },
    ],
  },
  {
    id: "sessions",
    anchor: "sessions",
    placement: "right",
    title: "Places, then your sessions",
    lead: <>Home and Localhost first; then every plan, grouped by project.</>,
    body: (
      <>
        A session's terminals sit under its row with what they are doing.
        Click one to open it; expand a row to revisit earlier revisions.
      </>
    ),
  },
  {
    id: "agent",
    anchor: "agent-tab",
    placement: "bottom",
    title: "Talk to the agent in its own tab",
    lead: <>The Agent tab is the session's conversation with Claude, as it happens.</>,
    body: (
      <>
        Answer its questions there, queue the next message mid-turn, or switch
        the tab to <strong>CLI</strong> for the same terminal underneath.
      </>
    ),
  },
  {
    id: "terminal",
    anchor: "terminals-tab",
    placement: "bottom",
    title: "Terminals are a tab too",
    lead: (
      <>
        Run <code>claude</code>, then press <strong>Shift+Tab</strong> for plan
        mode.
      </>
    ),
    body: (
      <>
        When Claude proposes a plan — here or in any terminal of your own —
        Redline holds it instead of letting it run. That's your cue to review.
      </>
    ),
  },
  {
    id: "editor",
    anchor: "editor",
    placement: "left",
    title: "Read & mark up the plan",
    lead: (
      <>
        <strong>Select any text</strong> in the plan and a menu offers four ways
        to respond.
      </>
    ),
    bullets: [
      { label: "Edit", text: "Rewrite the wording.", color: "var(--color-info)" },
      { label: "Feedback", text: "Leave a note to address.", color: "var(--color-warning)" },
      { label: "Question", text: "Ask without changing the plan.", color: "var(--color-success)" },
      { label: "Strike", text: "Propose a deletion.", color: "var(--color-ink-muted)" },
    ],
  },
  {
    id: "rail",
    anchor: "rail",
    placement: "left",
    title: "The rail follows the pane",
    lead: <>Its tabs are whatever the pane in front needs.</>,
    bullets: [
      { label: "Discussion", text: "Your marks and Claude's answers." },
      { label: "Talk", text: "Discuss it aloud or by typing." },
      { label: "Files", text: "The project's tree." },
      { label: "Changes", text: "What changed, ready to commit." },
    ],
    body: (
      <>
        <strong>⌘⌥B</strong> folds it to the edge.
      </>
    ),
  },
  {
    id: "plan-verbs",
    anchor: "plan-verbs",
    placement: "top",
    title: "Send back, or approve",
    bullets: [
      {
        label: "Send to Claude",
        text: "Ship your marks back for a revision.",
        color: "var(--color-info)",
      },
      {
        label: "Approve & build",
        text: "Accept it; Claude builds it.",
        color: "var(--color-success)",
      },
    ],
    body: (
      <>
        They live at the foot of the plan. If you step away, a held plan can
        detach; <strong>Restore</strong> sends it back into a terminal.
      </>
    ),
  },
  {
    id: "pill",
    anchor: "pill",
    placement: "top",
    title: "Plan a build from anywhere",
    lead: <>The pill in the status bar is always one sentence away.</>,
    body: (
      <>
        Rest the pointer on it for a quick composer; click it for a new door
        tab. <strong>Shift+Enter</strong> does the same from the keyboard.
      </>
    ),
  },
  {
    id: "shortcuts",
    anchor: "command",
    placement: "bottom",
    title: "Keyboard shortcuts",
    lead: (
      <>
        <strong>⌘K</strong> (or this field) runs anything — surfaces, plans,
        themes. And when the layout gets away from you, <strong>⌘⇧0</strong>{" "}
        snaps every pane back to its resting shape.
      </>
    ),
    shortcuts: tourShortcuts,
  },
  {
    id: "finish",
    anchor: "settings",
    placement: "bottom",
    title: "Make it yours",
    lead: <>Settings holds how Redline treats incoming plans, and how it looks.</>,
    bullets: [
      { label: "Active", text: "Hold every plan for review.", color: "var(--color-info)" },
      { label: "Ambient", text: "Countdown, then auto-approve.", color: "var(--color-warning)" },
      { label: "Paused", text: "Let Claude run untouched.", color: "var(--color-ink-muted)" },
    ],
    body: (
      <>
        Themes and fonts are there too. That's the loop: draft → plan → review
        → send → approve.
      </>
    ),
  },
];

/** Every region the tour points at, in step order: what the anchors test
 *  and the fixture's tour scene check. */
export const TOUR_ANCHORS: readonly string[] = STEPS.flatMap((s) => (s.anchor ? [s.anchor] : []));

function measureAnchor(anchor: string | undefined): Rect | null {
  if (!anchor) return null;
  const el = document.querySelector<HTMLElement>(`[data-tour="${anchor}"]`);
  if (!el) return null;
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
  const r = el.getBoundingClientRect();
  // A collapsed / zero-size target can't be spotlighted meaningfully — fall
  // back to a centered card.
  if (r.width < 4 || r.height < 4) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

// Expand the target by PAD, clamped to the viewport — the lit rectangle.
function spotlightRect(rect: Rect): Rect {
  const top = Math.max(0, rect.top - PAD);
  const left = Math.max(0, rect.left - PAD);
  const right = Math.min(window.innerWidth, rect.left + rect.width + PAD);
  const bottom = Math.min(window.innerHeight, rect.top + rect.height + PAD);
  return { top, left, width: right - left, height: bottom - top };
}

function cardPosition(
  rect: Rect | null,
  placement: Placement,
  cardH: number,
): { top: number; left: number } {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const clamp = (top: number, left: number) => ({
    top: Math.min(Math.max(top, MARGIN), Math.max(MARGIN, H - cardH - MARGIN)),
    left: Math.min(Math.max(left, MARGIN), Math.max(MARGIN, W - CARD_W - MARGIN)),
  });
  if (!rect || placement === "center") {
    return clamp((H - cardH) / 2, (W - CARD_W) / 2);
  }
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  switch (placement) {
    case "top":
      return clamp(rect.top - GAP - cardH, cx - CARD_W / 2);
    case "left":
      return clamp(cy - cardH / 2, rect.left - GAP - CARD_W);
    case "right":
      return clamp(cy - cardH / 2, rect.left + rect.width + GAP);
    case "bottom":
    default:
      return clamp(rect.top + rect.height + GAP, cx - CARD_W / 2);
  }
}

export function OnboardingTour({ onClose, onAnchorChange }: OnboardingTourProps) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  const step = STEPS[index];
  const isFirst = index === 0;
  const isLast = index === STEPS.length - 1;

  const close = useCallback(() => {
    onAnchorChange?.(undefined); // restore any region the tour revealed
    onClose();
  }, [onAnchorChange, onClose]);
  const next = useCallback(() => {
    if (isLast) close();
    else setIndex((i) => i + 1);
  }, [isLast, close]);
  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  // Tell App which region this step points at so it can reveal a collapsed pane
  // (e.g. the terminal dock) before we try to spotlight it.
  useEffect(() => {
    onAnchorChange?.(step.anchor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  // Measure the anchor on step change, on resize, and across a few frames + a
  // post-transition tick — revealing a collapsed pane resizes it asynchronously,
  // so a single synchronous read would miss the final geometry and the card
  // would strand in the centered fallback.
  useLayoutEffect(() => {
    const recompute = () => {
      const r = measureAnchor(step.anchor);
      setRect(r);
      const cardH = cardRef.current?.getBoundingClientRect().height ?? 200;
      setPos(cardPosition(r, r ? (step.placement ?? "bottom") : "center", cardH));
    };
    recompute();
    const raf1 = requestAnimationFrame(() => {
      recompute();
      requestAnimationFrame(recompute);
    });
    const t = setTimeout(recompute, 220); // catch pane expand/collapse transition
    window.addEventListener("resize", recompute);
    return () => {
      cancelAnimationFrame(raf1);
      clearTimeout(t);
      window.removeEventListener("resize", recompute);
    };
  }, [step.anchor, step.placement, index]);

  // Keyboard: Esc skips, arrows / Enter navigate — except in a text field,
  // where they are the caret's and the newline's (the composer step asks for
  // a sentence and a ⏎ that sends it, not one that turns the page).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (isEditableTarget(e.target as HTMLElement | null)) {
        return;
      } else if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        back();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [next, back, close]);

  const lit = rect ? spotlightRect(rect) : null;
  const band = (s: React.CSSProperties): React.CSSProperties => ({
    position: "fixed",
    background: "var(--color-overlay)",
    pointerEvents: "auto",
    ...s,
  });

  return (
    // A modal layer of its own: the open front door's inert sweep leaves it
    // live (its "type your prompt" step opens the door under it). The layer
    // itself lets the pointer through, so the lit region is the real thing:
    // a press in the composer it lights puts the caret there.
    <div className="fixed inset-0" style={{ zIndex: 60, pointerEvents: "none" }} data-rl-modal-layer>
      {/* Scrim. With a target, dim four bands around it so the region stays
          lit; otherwise dim the whole window. Bands absorb clicks so the app
          around the lit region isn't interactable mid-tour. */}
      {lit ? (
        <>
          <div style={band({ top: 0, left: 0, width: "100vw", height: lit.top })} />
          <div
            style={band({
              top: lit.top + lit.height,
              left: 0,
              width: "100vw",
              height: `calc(100vh - ${lit.top + lit.height}px)`,
            })}
          />
          <div
            style={band({
              top: lit.top,
              left: 0,
              width: lit.left,
              height: lit.height,
            })}
          />
          <div
            style={band({
              top: lit.top,
              left: lit.left + lit.width,
              width: `calc(100vw - ${lit.left + lit.width}px)`,
              height: lit.height,
            })}
          />
          {/* Spotlight ring. */}
          <div
            style={{
              position: "fixed",
              top: lit.top,
              left: lit.left,
              width: lit.width,
              height: lit.height,
              border: "2px solid var(--color-info)",
              borderRadius: "6px",
              boxShadow: "0 0 0 1px var(--color-paper)",
              pointerEvents: "none",
            }}
          />
        </>
      ) : (
        <div style={band({ inset: 0, width: "100vw", height: "100vh" })} />
      )}

      {/* Each step, said politely once its card is placed: the card never
          takes the caret, so a screen reader would otherwise never hear it.
          Empty until then, so even the first step is a change to speak. */}
      <div className="sr-only" role="status" aria-live="polite">
        {pos ? `Getting started, step ${index + 1} of ${STEPS.length}: ${step.title}` : ""}
      </div>
      {/* Tooltip card. */}
      <div
        ref={cardRef}
        role="dialog"
        aria-label={`Getting started: ${step.title}`}
        // Which step, the region it points at and whether that region was
        // found and lit: what the app fixture's tour scene reads.
        data-rl-tour-step={step.id}
        data-rl-tour-anchor={step.anchor}
        data-rl-tour-lit={rect ? "" : undefined}
        className="fixed rounded-md shadow-xl border p-5 flex flex-col"
        style={{
          pointerEvents: "auto",
          top: pos?.top ?? -9999,
          left: pos?.left ?? -9999,
          width: `min(${CARD_W}px, calc(100vw - ${MARGIN * 2}px))`,
          // A short window keeps the whole card on screen: its copy scrolls,
          // its Back / Next row stays.
          maxHeight: `calc(100vh - ${MARGIN * 2}px)`,
          borderColor: "var(--color-rule)",
          background: "var(--color-bg-elevated)",
          visibility: pos ? "visible" : "hidden",
        }}
      >
        <h2
          className="font-serif font-semibold"
          style={{ fontSize: "17px", color: "var(--color-ink)", marginBottom: 8 }}
        >
          {step.title}
        </h2>
        <div className="flex flex-col rl-thin-scroll-y" style={{ gap: 10, minHeight: 0, overflowY: "auto" }}>
          {step.lead && (
            <p
              style={{
                margin: 0,
                fontSize: "13.5px",
                lineHeight: 1.5,
                color: "var(--color-ink)",
              }}
            >
              {step.lead}
            </p>
          )}
          {step.bullets && (
            <div
              className="flex flex-col"
              style={{
                gap: 7,
                paddingLeft: 12,
                borderLeft: "2px solid var(--color-rule)",
              }}
            >
              {step.bullets.map((b) => (
                <div key={b.label} style={{ fontSize: "12.5px", lineHeight: 1.45 }}>
                  <span
                    style={{
                      fontWeight: 600,
                      color: b.color ?? "var(--color-ink)",
                    }}
                  >
                    {b.label}
                  </span>
                  <span style={{ color: "var(--color-ink-muted)" }}> — {b.text}</span>
                </div>
              ))}
            </div>
          )}
          {step.shortcuts && (
            <div className="flex flex-col" style={{ gap: 6 }}>
              {step.shortcuts().map((s) => (
                <div
                  key={s.text}
                  className="flex items-center"
                  style={{ gap: 8 }}
                >
                  <span
                    className="flex items-center shrink-0"
                    style={{ gap: 4, width: 118 }}
                  >
                    {s.keys.map((k, i) => (
                      <span key={k} className="flex items-center" style={{ gap: 4 }}>
                        {i > 0 && (
                          <span
                            style={{
                              fontSize: "11px",
                              color: "var(--color-ink-muted)",
                            }}
                          >
                            +
                          </span>
                        )}
                        <KeyCap>{k}</KeyCap>
                      </span>
                    ))}
                  </span>
                  <span
                    style={{ fontSize: "12.5px", color: "var(--color-ink-muted)" }}
                  >
                    {s.text}
                  </span>
                </div>
              ))}
            </div>
          )}
          {step.body && (
            <p
              style={{
                margin: 0,
                fontSize: "12.5px",
                lineHeight: 1.5,
                color: "var(--color-ink-muted)",
              }}
            >
              {step.body}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between" style={{ marginTop: 18 }}>
          <button
            type="button"
            onClick={close}
            style={{
              fontSize: "12px",
              color: "var(--color-ink-muted)",
              background: "transparent",
              border: "none",
              cursor: "pointer",
            }}
          >
            Skip tour
          </button>

          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1" style={{ marginRight: 4 }}>
              {STEPS.map((s, i) => (
                <span
                  key={s.id}
                  aria-hidden
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background:
                      i === index
                        ? "var(--color-info)"
                        : "var(--color-rule)",
                    display: "inline-block",
                  }}
                />
              ))}
            </span>
            {!isFirst && (
              <button
                type="button"
                onClick={back}
                className="rounded px-3 py-1.5"
                style={{
                  background: "var(--color-bg-elevated)",
                  border: "1px solid var(--color-rule)",
                  color: "var(--color-ink-muted)",
                  fontSize: "12px",
                  cursor: "pointer",
                }}
              >
                Back
              </button>
            )}
            <button
              type="button"
              onClick={next}
              className="rounded px-3 py-1.5 font-medium"
              style={{
                background: "var(--color-info)",
                color: "var(--color-on-accent)",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              {isLast ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
