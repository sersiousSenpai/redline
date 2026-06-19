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
  /** Keyboard-shortcut rows, rendered as keycaps + an action label. */
  shortcuts?: Shortcut[];
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
// reads as a wall of text.
const STEPS: TourStep[] = [
  {
    id: "welcome",
    title: "Welcome to Redline",
    lead: (
      <>
        Redline sits between you and Claude Code, turning its plans into
        something you can mark up.
      </>
    ),
    body: (
      <>
        Here's the quick tour — replay it anytime from{" "}
        <strong>Redline → Getting Started</strong>.
      </>
    ),
  },
  {
    id: "terminal",
    anchor: "terminal",
    placement: "top",
    title: "Run Claude here",
    lead: (
      <>
        Run <code>claude</code>, then press <strong>Shift+Tab</strong> for plan
        mode.
      </>
    ),
    body: (
      <>
        When Claude proposes a plan, Redline intercepts it instead of letting it
        run — your cue to review.
      </>
    ),
  },
  {
    id: "companion",
    title: "Works with any terminal",
    lead: (
      <>
        Redline captures plans from Claude Code <strong>anywhere</strong> — not
        just this built-in terminal.
      </>
    ),
    body: (
      <>
        Run Claude in your own terminal or editor; whenever it enters plan mode,
        the plan still lands here for review.
      </>
    ),
  },
  {
    id: "mode",
    anchor: "mode",
    placement: "bottom",
    title: "Active, Ambient, or Paused",
    lead: <>Choose how Redline handles incoming plans.</>,
    bullets: [
      { label: "Active", text: "Hold every plan for review.", color: "var(--color-info)" },
      { label: "Ambient", text: "Countdown, then auto-approve.", color: "var(--color-warning)" },
      { label: "Paused", text: "Let Claude run untouched.", color: "var(--color-ink-muted)" },
    ],
  },
  {
    id: "sessions",
    anchor: "sessions",
    placement: "right",
    title: "Plans land here",
    lead: <>Every intercepted plan becomes a review session, newest first.</>,
    body: (
      <>
        Click one to open it; expand a row to revisit earlier revisions.
      </>
    ),
  },
  {
    id: "editor",
    anchor: "editor",
    placement: "left",
    title: "Read & mark up the plan",
    lead: <>The plan opens here like a document.</>,
    body: (
      <>
        <strong>Select any text</strong> to mark it up — a menu pops up over your
        selection.
      </>
    ),
  },
  {
    id: "comment-types",
    title: "Four ways to respond",
    bullets: [
      { label: "Edit", text: "Rewrite the wording.", color: "var(--color-info)" },
      { label: "Feedback", text: "Leave a note to address.", color: "var(--color-warning)" },
      { label: "Question", text: "Ask without changing the plan.", color: "var(--color-success)" },
      { label: "Strike", text: "Propose a deletion.", color: "var(--color-ink-muted)" },
    ],
    body: (
      <>
        Feedback can be tagged <strong>Local</strong> (tied to your selection) or{" "}
        <strong>Structural</strong> (a plan-wide concern).
      </>
    ),
  },
  {
    id: "discussion",
    anchor: "discussion",
    placement: "left",
    title: "Your comments collect here",
    lead: <>Every comment shows up in this pane.</>,
    body: (
      <>
        Accept a resolution once Claude addresses it, or reopen it with a note.
      </>
    ),
  },
  {
    id: "footer",
    anchor: "footer",
    placement: "top",
    title: "Send back, or approve",
    bullets: [
      {
        label: "Send to Claude Code",
        text: "Ship your comments back for a revision.",
        color: "var(--color-info)",
      },
      {
        label: "Approve plan",
        text: "Accept as-is; Claude builds it.",
        color: "var(--color-success)",
      },
    ],
    body: <>Send while there's still feedback; Approve once it's right.</>,
  },
  {
    id: "detach",
    title: "If you step away",
    lead: (
      <>
        Claude won't wait forever — a held plan can <strong>detach</strong> and
        hand control back to the terminal.
      </>
    ),
    body: (
      <>
        No work lost: reopen the session and hit <strong>Restore</strong> to send
        the plan back into a terminal and pick up where you left off.
      </>
    ),
  },
  {
    id: "shortcuts",
    title: "Keyboard shortcuts",
    lead: <>Show or hide a pane without reaching for the mouse.</>,
    shortcuts: [
      { keys: ["Shift", "←"], text: "Sidebar" },
      { keys: ["Shift", "→"], text: "Discussion pane" },
      { keys: ["Shift", "↓"], text: "Terminal" },
      { keys: ["Shift", "↑"], text: "Switch sidebar tabs" },
      { keys: ["⌘ / Ctrl", "+"], text: "Zoom in" },
      { keys: ["⌘ / Ctrl", "−"], text: "Zoom out" },
      { keys: ["⌘ / Ctrl", "0"], text: "Reset zoom" },
    ],
  },
  {
    id: "finish",
    anchor: "theme",
    placement: "bottom",
    title: "Make it yours",
    lead: <>Pick a theme up top — there are twelve.</>,
    body: (
      <>
        That's the loop: intercept → review → send → approve. Replay anytime from{" "}
        <strong>Redline → Getting Started</strong>.
      </>
    ),
  },
];

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

  // Keyboard: Esc skips, arrows / Enter navigate.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
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
    ...s,
  });

  return (
    <div className="fixed inset-0" style={{ zIndex: 60 }}>
      {/* Scrim. With a target, dim four bands around it so the region stays
          lit; otherwise dim the whole window. Bands absorb clicks so the app
          underneath isn't interactable mid-tour. */}
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

      {/* Tooltip card. */}
      <div
        ref={cardRef}
        role="dialog"
        aria-label="Getting started"
        className="fixed rounded-md shadow-xl border p-5 flex flex-col"
        style={{
          top: pos?.top ?? -9999,
          left: pos?.left ?? -9999,
          width: `min(${CARD_W}px, calc(100vw - ${MARGIN * 2}px))`,
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
        <div className="flex flex-col" style={{ gap: 10 }}>
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
              {step.shortcuts.map((s) => (
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
