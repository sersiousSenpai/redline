import { useEffect, useState } from "react";
import type { PlanDecisionWindowEvent } from "../types";

interface DecisionWindowBannerProps {
  event: PlanDecisionWindowEvent;
  onOpen: () => void;
  onApprove: () => void;
  /** Fired once the countdown reaches zero (Ambient auto-approves server-side). */
  onExpire: () => void;
}

// Ambient-mode prompt: a plan arrived, auto-approving on a countdown unless the
// reviewer opens it. Because the terminal is co-present, this is visible without
// any window switch.
export function DecisionWindowBanner({
  event,
  onOpen,
  onApprove,
  onExpire,
}: DecisionWindowBannerProps) {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.ceil((event.deadlineMs - Date.now()) / 1000)),
  );

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
      className="flex items-center justify-between gap-4 px-6 py-2 border-b font-sans"
      style={{
        borderColor: "var(--color-rule)",
        background: "var(--color-bg-elevated)",
        fontSize: "12px",
      }}
    >
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
