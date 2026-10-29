// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The one notice strip (D41, D42): a status mark in the one vocabulary (the
//! amber pulse when it needs you, the shared Spinner while something runs),
//! ONE text element — a short sentence and at most a faint tail, ellipsized,
//! never a second line — compact 13 px text actions at the right, and a
//! 16 px × where it can be dismissed. 28 px tall. The explanation is the
//! tooltip. The plan's notices (PlanNotices) and the conversation's stopped
//! and waiting strips (agent/SessionConversation, agent/AskCard) both draw
//! it; its rules are plan.css's `.rl-plan-notice*` family.

import { X } from "lucide-react";
import "./plan.css";

import { TermStateBadge } from "../TermStateBadge";

export function NoticeStrip({
  title,
  detail,
  tip,
  mark = "needs",
  quiet = false,
  label,
  attrs,
  onDismiss,
  children,
}: {
  /** The one short sentence. */
  title: string;
  /** A faint tail on the same line: the live progress, the failure. */
  detail?: string | null;
  /** The explanation, on hover. */
  tip?: string;
  mark?: "needs" | "working";
  quiet?: boolean;
  /** The strip's accessible name, when the sentence isn't it. */
  label?: string;
  /** `data-*` hooks for the surface that hosts it. */
  attrs?: Record<`data-${string}`, string | undefined>;
  onDismiss?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div
      className="rl-plan-notice"
      data-tone={quiet ? "quiet" : "redline"}
      role={quiet ? undefined : "status"}
      aria-label={label}
      title={tip}
      {...attrs}
    >
      {!quiet && (
        <span className="rl-plan-notice-mark">
          <TermStateBadge state={mark === "working" ? "working" : "needs-you"} size={8} />
        </span>
      )}
      <span className="rl-plan-notice-text">
        {title}
        {detail && <span className="rl-plan-notice-faint"> {detail}</span>}
      </span>
      {children && <span className="rl-plan-notice-actions">{children}</span>}
      {onDismiss && (
        <button type="button" className="rl-plan-notice-x" onClick={onDismiss} aria-label={`Dismiss: ${title}`} title="Dismiss">
          <X size={16} aria-hidden />
        </button>
      )}
    </div>
  );
}
