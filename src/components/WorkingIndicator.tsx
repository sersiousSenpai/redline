// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useState } from "react";
import { PulseLogo } from "./PulseLogo";

/**
 * The app-wide "agent is working" indicator: the pulsing Redline mark, a
 * shimmering label, animated trailing dots, and (optionally) a live elapsed
 * counter. Every chat surface renders this in its pre-first-delta window —
 * the dead air between send and the first streamed token — so "is anything
 * happening?" has one consistent answer everywhere. Styles live next to the
 * `.rl-pulse-blades` block in styles.css and honor `prefers-reduced-motion`.
 */
export function WorkingIndicator({
  label = "Thinking",
  compact = false,
  showLogo = true,
  startedAt,
}: {
  label?: string;
  /** Header-badge sizing: smaller mark + 10px label. */
  compact?: boolean;
  showLogo?: boolean;
  /** When set, renders a live "· 12s" elapsed counter (1s tick). */
  startedAt?: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === undefined) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [startedAt]);
  const elapsed =
    startedAt === undefined
      ? null
      : Math.max(0, Math.round((now - startedAt) / 1000));
  return (
    <span
      role="status"
      aria-label={label}
      className="inline-flex items-center gap-1.5"
      style={{
        fontSize: compact ? "10px" : "12px",
        color: "var(--color-ink-muted)",
        lineHeight: 1,
      }}
    >
      {showLogo && (
        <PulseLogo state="thinking" size={compact ? 12 : 16} title={label} />
      )}
      <span className="rl-working-label">{label}</span>
      <span className="rl-working-dots" aria-hidden>
        <span>.</span>
        <span>.</span>
        <span>.</span>
      </span>
      {elapsed !== null && elapsed >= 1 && (
        <span className="font-mono" style={{ fontSize: "10px" }}>
          · {elapsed}s
        </span>
      )}
    </span>
  );
}
