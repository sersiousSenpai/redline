// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The plan, as the conversation shows it. The plan document opens only once
//! it exists, and this card is how the conversation says it does:
//!
//! - **ready** (4c): "Plan ready · Open in panel →" and a one-line size, in
//!   the turn that wrote it — the glass sheet with a focus rim, because it is
//!   the one thing in the thread asking for a move;
//! - **inline** (4d): with the plan closed, "📝 Plan · <title> · 2 marks ·
//!   Open", the way back to it from wherever the conversation has got to.
//!
//! The conversation (convo-ui's SessionConversation) decides where in the
//! thread a card goes; the stage hands it the title, marks and Open through
//! the seam's props, and this renders them.

import { FilePenLine } from "lucide-react";

export interface PlanReadyCardProps {
  variant: "ready" | "inline";
  title: string;
  /** Unsent marks on the latest version. */
  marks: number;
  /** "3 sections · 11 steps." — lib/planReady's `planReadySummary`. */
  summary: string | null;
  onOpen: () => void;
}

export function PlanReadyCard({ variant, title, marks, summary, onOpen }: PlanReadyCardProps) {
  if (variant === "inline")
    return (
      <div className="rl-plan-card rl-glass rl-glass-sheet" data-variant="inline">
        <FilePenLine aria-hidden size={14} strokeWidth={2} className="rl-plan-card-icon" />
        <span className="rl-plan-card-title">Plan · {title}</span>
        {marks > 0 && <span className="rl-plan-card-meta">{marks} mark{marks === 1 ? "" : "s"}</span>}
        <span className="rl-plan-card-spacer" />
        <button type="button" className="rl-plan-card-open" onClick={onOpen} aria-label={`Open the plan: ${title}`}>
          Open
        </button>
      </div>
    );
  return (
    <div className="rl-plan-card rl-glass rl-glass-sheet" data-variant="ready">
      <div className="rl-plan-card-row">
        <FilePenLine aria-hidden size={14} strokeWidth={2} className="rl-plan-card-icon" />
        <span className="rl-plan-card-title">Plan ready</span>
        <span className="rl-plan-card-spacer" />
        <button type="button" className="rl-plan-card-link" onClick={onOpen} aria-label={`Open the plan in the panel: ${title}`}>
          Open in panel →
        </button>
      </div>
      <div className="rl-plan-card-summary">
        {summary ? `${summary} ` : ""}Mark anything you'd change, then approve.
      </div>
    </div>
  );
}

export default PlanReadyCard;
