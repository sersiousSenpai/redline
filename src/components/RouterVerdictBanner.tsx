// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { AiReviewDoneEvent } from "../types";

// SHADOW-MODE attention-router banner. Shows what the router WOULD have done —
// "auto" (it believes a human would find nothing here) or "attend" (a human
// should look) — plus the reason and the checkable signals behind it. Purely
// informational: the verdict drives no behavior anywhere; the pane opens,
// holds, and submits exactly as it would without it. The banner exists so a
// few dozen reviews build an inspectable calibration record.

/** The banner's headline — pure, so tests pin the exact shadow labeling. */
export function routerBannerLine(s: AiReviewDoneEvent | null): string | null {
  if (!s?.verdict) return null;
  return `router (shadow): ${s.verdict} — ${s.verdictReason || "no reason recorded"}`;
}

/** The muted trailer: which signals fired at which published bar. */
export function routerBannerDetail(s: AiReviewDoneEvent | null): string | null {
  if (!s?.verdict) return null;
  const signals =
    s.verdictSignals && s.verdictSignals.length > 0
      ? s.verdictSignals.join(", ")
      : "none";
  const bar = s.verdictBar ?? 1;
  return `signals: ${signals} · bar: ${bar}`;
}

export default function RouterVerdictBanner({
  summary,
}: {
  summary: AiReviewDoneEvent | null;
}) {
  const line = routerBannerLine(summary);
  const detail = routerBannerDetail(summary);
  if (!line) return null;
  const attend = summary?.verdict === "attend";
  return (
    <div
      className="rl-review-ai shrink-0"
      data-testid="router-verdict-banner"
      data-verdict={summary?.verdict}
      title="Shadow mode: this verdict is recorded for calibration only — it never opens, holds, lands, or skips anything."
    >
      <div className="rl-review-ai-head">
        <span
          aria-hidden
          style={{ color: attend ? "var(--color-warning)" : "var(--color-info)" }}
        >
          ⚑
        </span>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {line}
        </span>
        <span
          style={{
            marginLeft: "auto",
            color: "var(--color-ink-muted)",
            whiteSpace: "nowrap",
          }}
        >
          {detail}
        </span>
      </div>
    </div>
  );
}
