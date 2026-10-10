// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useState } from "react";
import type { PlanDecisionWindowEvent } from "../types";

interface DecisionWindowBannerProps {
  event: PlanDecisionWindowEvent;
  onOpen: () => void;
  onApprove: () => void;
  /** Fired once the countdown reaches zero (Ambient auto-approves server-side). */
  onExpire: () => void;
  /** The Front Door or its compact card is out: the banner rises over them. */
  raised?: boolean;
}

/** Over the door's paper and the pill's card (both at z-index 55 in
 *  MonochatIsland.css), level with the door's own setup notice. */
export const RAISED_Z = 75;

// Ambient-mode prompt: a plan arrived, auto-approving on a countdown unless the
// reviewer opens it. Because the terminal is co-present, this is visible without
// any window switch — and it never makes one: from another app, the Dock
// bounces instead (App's `plan-decision-window` listener).
//
// The countdown runs whatever the user is doing, so it is never hidden under
// the door or its card: raised, it stays in its place under the header but
// above them, and the door's inert sweep spares it (`data-rl-over-door`) so it
// can be pressed. It never takes the caret.
export function DecisionWindowBanner({
  event,
  onOpen,
  onApprove,
  onExpire,
  raised = false,
}: DecisionWindowBannerProps) {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.ceil((event.deadlineMs - Date.now()) / 1000)),
  );

  // Said once, politely, a beat after the banner appears: a live region
  // speaks what changes in it, not what it was born holding. The ticking
  // count is for the eye — read out each second, it would drown the page.
  const [said, setSaid] = useState("");
  useEffect(() => {
    const secs = Math.max(0, Math.ceil((event.deadlineMs - Date.now()) / 1000));
    const id = setTimeout(() => setSaid(`Plan version ${event.version} is ready. Auto-approving in ${secs} seconds unless you open it for review.`), 100);
    return () => clearTimeout(id);
  }, [event.version, event.deadlineMs]);

  useEffect(() => {
    const id = setInterval(() => {
      const secs = Math.max(0, Math.ceil((event.deadlineMs - Date.now()) / 1000));
      setRemaining(secs);
      if (secs <= 0) {
        clearInterval(id);
        onExpire();
      }
    }, 500);
    return () => clearInterval(id);
  }, [event.deadlineMs, onExpire]);

  return (
    <div
      role="region"
      aria-label="Plan decision"
      data-rl-over-door
      className="flex items-center justify-between gap-4 px-6 py-2 border-b font-sans"
      style={{
        borderColor: "var(--color-rule)",
        background: "var(--color-bg-elevated)",
        fontSize: "12px",
        ...(raised ? { position: "relative", zIndex: RAISED_Z } : null),
      }}
    >
      <span className="sr-only" role="status" aria-live="polite">{said}</span>
      <span style={{ color: "var(--color-ink)" }}>
        Plan v{event.version} ready ·{" "}
        <span style={{ color: "var(--color-ink-muted)" }}>
          auto-approving in {remaining}s
        </span>
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onOpen}
          className="rounded-sm px-2 py-0.5"
          style={{
            background: "var(--color-info)",
            color: "#fff",
            cursor: "pointer",
          }}
        >
          Open for review
        </button>
        <button
          type="button"
          onClick={onApprove}
          className="rounded-sm px-2 py-0.5"
          style={{
            border: "1px solid var(--color-rule)",
            color: "var(--color-ink-muted)",
            cursor: "pointer",
          }}
        >
          Approve now
        </button>
      </div>
    </div>
  );
}
