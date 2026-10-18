// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! What classic's plan pane says about the plan, in the flow shell: a slim
//! strip above the plan body (split and full), or at the top of the stage
//! while the plan is closed — so no notice the classic shell shows is lost
//! by switching shells, whatever the pose.
//!
//! - **The plan's CLI session ended** (classic's detached banner): the
//!   restore with its progress, its failure and Retry, the harness a legacy
//!   plan was "Written in", what would stop the restore (with its fix), Copy
//!   resume command, and Dismiss.
//! - **Plan modified during Ask**: Claude revised when only asked.
//! - **Resolution block issue**: the revision's resolutions didn't parse or
//!   didn't match the comments sent.
//! - **Comments live on an earlier version** (the clean slate): the pointer
//!   to them.
//!
//! Each is one row on the redlining amber (the mode tokens, so every theme
//! holds its contrast), dismissable where classic's was.

import { X } from "lucide-react";

import { FixControl } from "../components/ReadinessStrip";
import type { ReadinessItem } from "../lib/readiness";
import type { RestoreHarness } from "../lib/restoreHarness";

const HARNESSES: [RestoreHarness, string][] = [
  ["claude-code", "Claude Code"],
  ["codex", "Codex"],
  ["cursor", "Cursor"],
  ["antigravity", "Antigravity"],
];

export interface PlanNoticesProps {
  /** Claude returned a revision when only asked questions. */
  askModeViolation: boolean;
  onDismissAskMode: () => void;
  /** The revision's resolution block didn't parse or match. */
  warning: { parseError: string | null; unmatchedIds: string[]; unresolvedSubmittedIds: string[] } | null;
  onDismissWarning: () => void;
  /** The plan's CLI session ended; null while it is attached. */
  detached: {
    restoring: boolean;
    /** The restore's own progress line, while it runs. */
    status: string | null;
    /** Why the last restore failed, when it did. */
    failure: string | null;
    copy: { lede: string; body: string };
    /** Which harness the restore resumes on; a legacy plan asks. */
    decision: { harness: RestoreHarness; legacy: boolean; chosen: boolean; label: string };
    onHarness: (harness: RestoreHarness) => void;
    /** What would stop the restore bringing the plan back. */
    blockers: ReadinessItem[];
    onFix: (item: ReadinessItem) => Promise<boolean>;
    onRestore: () => void;
    onCopyResume: () => void;
    onDismiss: () => void;
  } | null;
  /** The latest version is a clean slate and these comments live on an
   *  earlier one: its number, or null. */
  prior: number | null;
  onViewPrior: (version: number) => void;
  /** Show the session's terminal (the restore runs in it), when it has one. */
  onShowTerminal: (() => void) | null;
}

/** Whether there is anything to show — the stage draws no empty strip. */
export function hasNotices(p: PlanNoticesProps): boolean {
  return p.askModeViolation || !!p.warning || !!p.detached || p.prior !== null;
}

export function PlanNotices(p: PlanNoticesProps) {
  if (!hasNotices(p)) return null;
  return (
    <div className="rl-plan-notices" role="region" aria-label="About this plan">
      {p.detached && <Detached {...p.detached} onShowTerminal={p.onShowTerminal} />}
      {p.askModeViolation && (
        <Notice title="Plan modified during Ask" onDismiss={p.onDismissAskMode}>
          You asked only questions, but it returned a revised plan anyway. This was processed as a normal revision — review
          the diff.
        </Notice>
      )}
      {p.warning && (
        <Notice title="Resolution block issue" onDismiss={p.onDismissWarning}>
          {p.warning.parseError && <span className="rl-plan-notice-line">The resolution block could not be parsed: {p.warning.parseError}</span>}
          {p.warning.unmatchedIds.length > 0 && (
            <span className="rl-plan-notice-line">Resolutions for unknown comments: {p.warning.unmatchedIds.join(", ")}</span>
          )}
          {p.warning.unresolvedSubmittedIds.length > 0 && (
            <span className="rl-plan-notice-line">Sent comments without a resolution: {p.warning.unresolvedSubmittedIds.join(", ")}</span>
          )}
        </Notice>
      )}
      {p.prior !== null && (
        <Notice quiet>
          Comments and resolutions from v{p.prior} live on that version.
          <button type="button" className="rl-plan-notice-btn" onClick={() => p.onViewPrior(p.prior!)}>
            Review them
          </button>
        </Notice>
      )}
    </div>
  );
}

function Notice({
  title,
  quiet = false,
  onDismiss,
  children,
}: {
  title?: string;
  quiet?: boolean;
  onDismiss?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rl-plan-notice" data-tone={quiet ? "quiet" : "redline"} role={quiet ? undefined : "status"}>
      <div className="rl-plan-notice-text">
        {title && <strong className="rl-plan-notice-title">{title}</strong>}
        {children}
      </div>
      {onDismiss && (
        <button type="button" className="rl-plan-notice-x" onClick={onDismiss} aria-label={`Dismiss: ${title ?? "notice"}`} title="Dismiss">
          <X size={13} aria-hidden />
        </button>
      )}
    </div>
  );
}

function Detached(d: NonNullable<PlanNoticesProps["detached"]> & { onShowTerminal: (() => void) | null }) {
  const blocked = d.blockers.length > 0;
  if (d.restoring)
    return (
      <Notice title="Reopening this plan…">
        {d.status && <span className="rl-plan-notice-line">{d.status}</span>}
        <span className="rl-plan-notice-line rl-plan-notice-faint">
          The original {d.decision.label} conversation and your comments are kept — this re-presents the plan it was
          holding, it doesn't revise it.
        </span>
        {d.onShowTerminal && (
          <span className="rl-plan-notice-actions">
            <button type="button" className="rl-plan-notice-btn" onClick={d.onShowTerminal}>
              Show the terminal
            </button>
          </span>
        )}
      </Notice>
    );
  if (d.failure)
    return (
      <Notice title="Couldn't reopen this plan." onDismiss={d.onDismiss}>
        <span className="rl-plan-notice-line">{d.failure}</span>
        <span className="rl-plan-notice-actions">
          <button type="button" className="rl-plan-notice-btn" data-primary="" onClick={d.onRestore}>
            Retry
          </button>
          {d.onShowTerminal && (
            <button type="button" className="rl-plan-notice-btn" onClick={d.onShowTerminal}>
              Show the terminal
            </button>
          )}
          <button type="button" className="rl-plan-notice-btn" onClick={d.onCopyResume}>
            Copy resume command
          </button>
        </span>
      </Notice>
    );
  return (
    <Notice title={d.copy.lede} onDismiss={d.onDismiss}>
      <span className="rl-plan-notice-line">{d.copy.body}</span>
      <span className="rl-plan-notice-line rl-plan-notice-faint">
        Restore plan session reopens the same conversation and re-presents the plan for review, in the background —
        nothing is retyped and nothing is lost.
      </span>
      {d.decision.legacy && (
        <span className="rl-plan-notice-actions" role="radiogroup" aria-label="Written in">
          <span className="rl-plan-notice-faint">Written in:</span>
          {HARNESSES.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              className="rl-plan-notice-btn"
              aria-checked={d.decision.harness === value && d.decision.chosen}
              onClick={() => d.onHarness(value)}
            >
              {label}
            </button>
          ))}
        </span>
      )}
      {d.blockers.map((item) => (
        <span key={item.id} className="rl-plan-notice-actions">
          <span className="rl-plan-notice-line">{item.label}</span>
          <FixControl item={item} onFix={d.onFix} />
        </span>
      ))}
      <span className="rl-plan-notice-actions">
        <button
          type="button"
          className="rl-plan-notice-btn"
          data-primary=""
          onClick={d.onRestore}
          disabled={blocked}
          title={blocked ? `${d.blockers[0].label} — restore can't bring the plan back until that's fixed.` : undefined}
        >
          Restore plan session
        </button>
        <button
          type="button"
          className="rl-plan-notice-btn"
          onClick={d.onCopyResume}
          disabled={blocked}
          title={`For a ${d.decision.label} running in a terminal Redline doesn't own — copy the resume command to paste yourself.`}
        >
          Copy resume command
        </button>
      </span>
    </Notice>
  );
}
