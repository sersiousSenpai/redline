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
//!   resume command, and Dismiss. When the agent died under a plan in review
//!   the restore starts on its own (lib/autoResume) and the notice says so —
//!   "Resuming… attempt 2 of 3" — keeping Retry and Copy resume command; when
//!   the automatic tries run out it is the failure with Retry again.
//! - **Plan modified during Ask**: Claude revised when only asked.
//! - **Resolution block issue**: the revision's resolutions didn't parse or
//!   didn't match the comments sent.
//! - **Comments live on an earlier version** (the clean slate): the pointer
//!   to them.
//!
//! Each is ONE 28 px strip on the redlining amber (the mode tokens, so every
//! theme holds its contrast): a status mark in the one vocabulary (the amber
//! pulse when it needs you, the shared Spinner while a restore runs), one
//! short sentence, and compact text actions at the right — the explanation
//! rides the strip's tooltip, never a paragraph under it. Dismissable where
//! classic's was.

import { ChevronDown } from "lucide-react";
import { useRef } from "react";
import "./plan.css";

import { Panel, useClickPopover } from "../popover";
import { FixControl } from "../ReadinessStrip";
import { NoticeStrip as Notice } from "./NoticeStrip";
import type { ReadinessItem } from "../../lib/readiness";
import type { RestoreHarness } from "../../lib/restoreHarness";
import type { AutoNotice } from "../../lib/autoResume";

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
    /** Its CLI is still running, in this terminal (kept through a quit):
     *  nothing to restore, and resuming would run it twice. */
    stillRunning?: string | null;
    /** Which harness the restore resumes on; a legacy plan asks. */
    decision: { harness: RestoreHarness; legacy: boolean; chosen: boolean; label: string };
    onHarness: (harness: RestoreHarness) => void;
    /** What would stop the restore bringing the plan back. */
    blockers: ReadinessItem[];
    onFix: (item: ReadinessItem) => Promise<boolean>;
    onRestore: () => void;
    onCopyResume: () => void;
    onDismiss: () => void;
    /** The automatic resume, while it runs, waits or has given up. */
    auto?: AutoNotice | null;
    /** Stop the automatic resume (the reviewer is taking over). */
    onStopAuto?: () => void;
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
  const w = p.warning;
  return (
    <div className="rl-plan-notices" role="region" aria-label="About this plan">
      {p.detached && <Detached {...p.detached} onShowTerminal={p.onShowTerminal} />}
      {p.askModeViolation && (
        <Notice
          title="Plan modified during Ask"
          detail="review the diff"
          tip="You asked only questions, but it returned a revised plan anyway. This was processed as a normal revision — review the diff."
          onDismiss={p.onDismissAskMode}
        />
      )}
      {w && (
        <Notice
          title="Resolution block issue"
          detail={[
            w.parseError && `could not be parsed: ${w.parseError}`,
            w.unmatchedIds.length > 0 && `unknown comments: ${w.unmatchedIds.join(", ")}`,
            w.unresolvedSubmittedIds.length > 0 && `sent without a resolution: ${w.unresolvedSubmittedIds.join(", ")}`,
          ].filter(Boolean).join(" · ")}
          tip={[
            w.parseError && `The resolution block could not be parsed: ${w.parseError}`,
            w.unmatchedIds.length > 0 && `Resolutions for unknown comments: ${w.unmatchedIds.join(", ")}`,
            w.unresolvedSubmittedIds.length > 0 && `Sent comments without a resolution: ${w.unresolvedSubmittedIds.join(", ")}`,
          ].filter(Boolean).join("\n")}
          onDismiss={p.onDismissWarning}
        />
      )}
      {p.prior !== null && (
        <Notice quiet title={`Comments and resolutions from v${p.prior} live on that version.`}>
          <button type="button" className="rl-plan-notice-btn" onClick={() => p.onViewPrior(p.prior!)}>
            Review them
          </button>
        </Notice>
      )}
    </div>
  );
}

function Detached(d: NonNullable<PlanNoticesProps["detached"]> & { onShowTerminal: (() => void) | null }) {
  const blocked = d.blockers.length > 0;
  if (d.stillRunning && !d.restoring)
    return (
      <Notice
        title={`Still running in ${d.stillRunning}`}
        tip={`Its ${d.decision.label} session kept running while Redline was closed, so there is nothing to restore: resuming it would run the conversation twice. If it is asking something, it asks in its terminal.`}
        onDismiss={d.onDismiss}
      >
        {d.onShowTerminal && (
          <button type="button" className="rl-plan-notice-btn" data-primary="" onClick={d.onShowTerminal}>
            Open terminal
          </button>
        )}
      </Notice>
    );
  const tried = d.auto?.phase === "stopped" ? d.auto.attempts : 0;
  // Coming back on its own. Running: the progress, like a click's. Waiting
  // out the backoff: when, and Retry / Copy command — either of which (and
  // Dismiss) takes it out of the timer's hands. Why the last try failed is
  // the tooltip.
  if (d.auto && d.auto.phase !== "stopped") {
    const a = d.auto;
    const stop = () => d.onStopAuto?.();
    const tip = [
      `The ${d.decision.label} session behind this plan stopped, so Redline is reopening it.`,
      a.phase === "scheduled" && d.failure && `The last try didn't take: ${d.failure}`,
      "The conversation and your comments are kept — this re-presents the plan it was holding, it doesn't revise it.",
    ].filter(Boolean).join("\n");
    return (
      <Notice
        title={`Resuming… attempt ${a.attempt} of ${a.of}`}
        detail={a.phase === "resuming" ? (d.restoring ? d.status : null) : `Trying again in ${a.inSeconds} seconds.`}
        tip={tip}
        mark="working"
        onDismiss={a.phase === "scheduled" ? () => { stop(); d.onDismiss(); } : undefined}
      >
        {a.phase === "scheduled" && (
          <>
            <button type="button" className="rl-plan-notice-btn" data-primary="" onClick={d.onRestore} disabled={blocked}>
              Retry
            </button>
            <CopyCommand onCopy={() => { stop(); d.onCopyResume(); }} disabled={blocked} />
          </>
        )}
        {d.onShowTerminal && (
          <button type="button" className="rl-plan-notice-btn" onClick={d.onShowTerminal}>
            Show terminal
          </button>
        )}
      </Notice>
    );
  }
  if (d.restoring)
    return (
      <Notice title="Reopening this plan…" detail={d.status} tip={`The original ${d.decision.label} conversation and your comments are kept — this re-presents the plan it was holding, it doesn't revise it.`} mark="working">
        {d.onShowTerminal && (
          <button type="button" className="rl-plan-notice-btn" onClick={d.onShowTerminal}>
            Show terminal
          </button>
        )}
      </Notice>
    );
  if (d.failure)
    return (
      <Notice
        title="Couldn't reopen this plan."
        detail={d.failure}
        tip={[d.failure, tried > 0 && `Redline tried ${tried === 1 ? "once" : `${tried} times`} on its own and stopped there.`].filter(Boolean).join("\n")}
        onDismiss={d.onDismiss}
      >
        <button type="button" className="rl-plan-notice-btn" data-primary="" onClick={d.onRestore}>
          Retry
        </button>
        {d.onShowTerminal && (
          <button type="button" className="rl-plan-notice-btn" onClick={d.onShowTerminal}>
            Show terminal
          </button>
        )}
        <CopyCommand onCopy={d.onCopyResume} />
      </Notice>
    );
  // The plain detached strip. The lede is the one sentence; the body (what
  // ended, that nothing is lost, what Restore does) is the tooltip, on the
  // strip and on Restore.
  const tip = [d.copy.body, tried > 0 && "Redline tried to reopen it on its own and stopped — fix what's flagged, then restore."].filter(Boolean).join("\n");
  return (
    <Notice title={d.copy.lede} detail={blocked ? d.blockers.map((b) => b.label).join(" · ") : null} tip={tip} onDismiss={d.onDismiss}>
      {d.decision.legacy && (
        <span className="rl-plan-notice-group" role="radiogroup" aria-label="Written in">
          <span className="rl-plan-notice-faint">Written in</span>
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
        <FixControl key={item.id} item={item} onFix={d.onFix} />
      ))}
      <button
        type="button"
        className="rl-plan-notice-btn"
        data-primary=""
        onClick={d.onRestore}
        disabled={blocked}
        title={blocked ? `${d.blockers[0].label} — restore can't bring the plan back until that's fixed.` : tip}
      >
        Restore
      </button>
      <CopyCommand
        onCopy={d.onCopyResume}
        disabled={blocked}
        title={`For a ${d.decision.label} running in a terminal Redline doesn't own — copy the resume command to paste yourself.`}
      />
    </Notice>
  );
}

/** Copy command, in both of its places: a text action while the strip has
 *  room, and — under 480 px of strip (plan.css's container query) — the one
 *  row of a ▾ menu beside Restore, so Restore and × always fit. */
function CopyCommand({ onCopy, disabled = false, title }: { onCopy: () => void; disabled?: boolean; title?: string }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const { open, close, toggle, panelProps } = useClickPopover(anchor, "right", "below", 220);
  return (
    <>
      <button type="button" className="rl-plan-notice-btn rl-plan-notice-wide" onClick={onCopy} disabled={disabled} title={title}>
        Copy command
      </button>
      <button
        ref={anchor}
        type="button"
        className="rl-plan-notice-x rl-plan-notice-more"
        aria-label="More restore actions"
        title="More restore actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <ChevronDown size={16} aria-hidden />
      </button>
      {open && (
        <Panel label="Restore actions" className="rl-plan-menu-panel" {...panelProps}>
          <div className="rl-plan-menu-list">
            <button
              type="button"
              role="menuitem"
              className="rl-plan-menu-item"
              disabled={disabled}
              title={title}
              onClick={() => {
                close();
                onCopy();
              }}
            >
              Copy resume command
            </button>
          </div>
        </Panel>
      )}
    </>
  );
}
