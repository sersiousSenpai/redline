// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The plan panel's footer: everything classic's bottom bar did for the open
//! plan, in the one place it is about (board 4c's 64px, 5a's 60px). The
//! window footer is gone in flow; its plan actions live here and its "needs
//! you" in the top bar.
//!
//! On the left, one status line, first match wins:
//! 1. the plan's CLI session ended (detached) — the notice above the plan
//!    carries the restore; this says why the verbs are off, or its progress;
//! 2. the author is answering a Send — a press shows its terminal;
//! 3. the plan is approved — "Building v4: step 3 of 11 · 1 terminal" while a
//!    run is live, else its state (and PlanStateMenu, as classic wore it);
//! 4. every resolution handled — "approve, or add another round";
//! 5. "Select text to mark it." — the hint, and the manual state menu.
//!
//! Send's tooltip carries classic's tally (2 pending · 1 edit · 1 question).
//!
//! On the right, the review's two verbs — "Send marks to Claude" and
//! "🔨 Approve & build" (its ▾ keeps "build later" and the team builds one
//! click away) — or, once approved, "Reopen plan" and "Build ▾".
//!
//! Every handler is App's own (submitReview, approvePlan, approvePlanLater,
//! startTeamBuild, buildApproved, reopenApproved, setPlanState): this decides
//! what shows, never what happens.

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ChevronDown, Hammer, Loader } from "lucide-react";

import { TEAM_BUILD_ITEMS, teamScaleOf, type Scale } from "../lib/teamBuildItems";
import { ridesSubmit } from "../lib/planSearch";
import type { Comment } from "../types";
import type { ManualPlanState, PlanStateTarget } from "../components/PlanStateMenu";
import { MenuSurface } from "../components/ui/MenuSurface";
import { ContextHint } from "./ContextHint";

const PlanStateMenu = lazy(() =>
  import("../components/PlanStateMenu").then((m) => ({ default: m.PlanStateMenu })),
);

export interface PlanFooterApproval {
  version: number;
  /** NULL is "approved · not built" — or being built by the agent that
   *  wrote it, which `building` says. */
  runState: string | null;
  /** A live orchestrated run can't be reopened under itself. */
  runLive: boolean;
  /** Something is building it right now: a live run, or the plan's own
   *  agent at work in its terminal after Approve & build. */
  building: boolean;
}

export interface PlanFooterBuildTarget {
  id: string;
  label: string;
  detail?: string;
}

export interface PlanPanelFooterProps {
  pose: "split" | "full";
  /** Who wrote the plan and answers a Send ("Claude", "Codex"). */
  author: string;
  /** The plan thread's comments: what the next Send carries is read off
   *  them, as classic's footer read them. */
  comments: readonly Comment[];
  canSubmit: boolean;
  canApprove: boolean;
  waiting: boolean;
  waitingAsk: boolean;
  onSubmit: () => void;
  onApprove: () => void;
  onApproveLater: () => void;
  onBuildTeam?: (scale: Scale) => void;
  approval: PlanFooterApproval | null;
  buildTargets: PlanFooterBuildTarget[];
  onBuild?: (targetId: string) => void;
  onReopen?: () => void;
  planState?: PlanStateTarget;
  onSetPlanState?: (state: ManualPlanState) => void;
  onMoveProject?: () => void;
  /** A live build's step, when the run reports one. */
  progress?: { step: number; of: number } | null;
  /** Terminals working on this plan — the faint "· 1 terminal". */
  terminals: number;
  onShowTerminal?: () => void;
  /** The plan's CLI session ended (the notice above carries the restore),
   *  or a restore is bringing it back. */
  detached?: "ended" | "restoring" | null;
}

/** What the next Send carries, classic's tally, and whether every
 *  resolution has been dealt with. */
export function footerTally(comments: readonly Comment[], waiting: boolean) {
  const pending = comments.filter(ridesSubmit);
  const count = (type: Comment["type"]) => pending.filter((c) => c.type === type).length;
  const tally = [
    `${pending.length} pending`,
    count("edit") ? `${count("edit")} edit` : null,
    count("feedback") ? `${count("feedback")} feedback` : null,
    count("question") ? `${count("question")} question${count("question") === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(" · ");
  return {
    marks: pending.length,
    askOnly: pending.length > 0 && pending.every((c) => c.type === "question" && !c.actionable),
    tally,
    allHandled:
      pending.length === 0 &&
      !waiting &&
      !comments.some((c) => c.status === "resolved") &&
      comments.some((c) => c.status === "accepted" || c.status === "withdrawn"),
  };
}

export function PlanPanelFooter(p: PlanPanelFooterProps) {
  return (
    <footer className="rl-plan-foot" data-pose={p.pose} data-plan-panel-footer>
      <span className="rl-plan-foot-status">
        <Status {...p} />
      </span>
      <span className="rl-plan-foot-spacer" />
      <span className="rl-plan-foot-actions">
        {p.approval ? <ApprovedActions {...p} approval={p.approval} /> : <ReviewActions {...p} />}
      </span>
    </footer>
  );
}

function Spinner({ tone }: { tone: "plan" | "build" }) {
  return <Loader aria-hidden size={13} strokeWidth={2} className="rl-stage-spin" data-tone={tone} />;
}

function Status(p: PlanPanelFooterProps) {
  if (p.detached === "restoring")
    return (
      <span className="rl-plan-foot-line" role="status">
        <Spinner tone="plan" />
        Reopening this plan…
      </span>
    );
  if (p.detached === "ended")
    return (
      <span className="rl-plan-foot-line" role="status">
        {p.author}'s session for this plan ended. Restore it to send or approve.
      </span>
    );
  if (p.waiting) {
    const text = p.waitingAsk ? `${p.author} is answering your questions…` : `${p.author} is revising the plan…`;
    return (
      <span className="rl-plan-foot-line" role="status">
        <Spinner tone="plan" />
        {p.onShowTerminal ? (
          <button type="button" className="rl-plan-foot-terminals" onClick={p.onShowTerminal} title="Watch it in the terminal">
            {text}
          </button>
        ) : (
          text
        )}
      </span>
    );
  }
  if (p.approval) {
    const a = p.approval;
    const text = a.building
      ? `Building v${a.version}${p.progress ? `: step ${p.progress.step} of ${p.progress.of}` : ""}`
      : `Approved v${a.version} · ${a.runState === null ? "not built" : a.runState.replace(/_/g, " ")}`;
    const line = (
      <>
        {a.building && <Spinner tone="build" />}
        {text}
      </>
    );
    return (
      <span className="rl-plan-foot-line">
        {p.planState && p.onSetPlanState ? (
          <Suspense fallback={line}>
            <PlanStateMenu session={p.planState} onState={p.onSetPlanState} onMove={p.onMoveProject}>
              <span className="rl-plan-foot-line">{line}</span>
            </PlanStateMenu>
          </Suspense>
        ) : (
          line
        )}
        {a.building && p.terminals > 0 && (
          <button type="button" className="rl-plan-foot-faint rl-plan-foot-terminals" onClick={p.onShowTerminal} disabled={!p.onShowTerminal} title="Show the terminal">
            · {p.terminals} terminal{p.terminals === 1 ? "" : "s"}
          </button>
        )}
      </span>
    );
  }
  const { allHandled } = footerTally(p.comments, p.waiting);
  return (
    <span className="rl-plan-foot-line">
      <ContextHint>{allHandled ? "All resolutions handled — approve, or add another round of marks." : "Select text to mark it."}</ContextHint>
      {p.planState && !p.planState.held && p.onSetPlanState && (
        <Suspense fallback={null}>
          <span className="rl-plan-foot-state">
            <PlanStateMenu session={p.planState} onState={p.onSetPlanState} onMove={p.onMoveProject} />
          </span>
        </Suspense>
      )}
    </span>
  );
}

function ReviewActions(p: PlanPanelFooterProps) {
  const { marks, askOnly, tally } = footerTally(p.comments, p.waiting);
  const caption = marks === 0 ? "Mark something in the plan first" : `${tally} — ${askOnly ? "asks questions only" : "requests a revision"}`;
  return (
    <>
      <button
        type="button"
        className="rl-plan-btn"
        onClick={p.onSubmit}
        disabled={!p.canSubmit || p.waiting}
        title={caption}
      >
        Send marks to {p.author}
      </button>
      <SplitAction
        label={
          <>
            <Hammer aria-hidden size={13} strokeWidth={2} />
            Approve &amp; build
          </>
        }
        title={`Approve, and ${p.author} builds it now`}
        disabled={!p.canApprove || p.waiting}
        onPrimary={p.onApprove}
        menuLabel="More approve options"
        items={[
          { id: "later", label: "Approve, build later", detail: "the agent stands down; build from here when ready" },
          ...(p.onBuildTeam ? TEAM_BUILD_ITEMS.map((item) => ({ ...item, label: `Approve & build ${item.label}` })) : []),
        ]}
        onItem={(id) => {
          const scale = teamScaleOf(id);
          if (scale) p.onBuildTeam?.(scale);
          else p.onApproveLater();
        }}
      />
    </>
  );
}

function ApprovedActions(p: PlanPanelFooterProps & { approval: PlanFooterApproval }) {
  const [confirming, setConfirming] = useState(false);
  const built = p.approval.runState !== null;
  return (
    <>
      {!p.approval.runLive && p.onReopen && (confirming ? (
        <span className="rl-plan-foot-confirm" role="group" aria-label="Confirm reopen">
          <span className="rl-plan-foot-faint">The agent may already have made changes.</span>
          <button type="button" className="rl-plan-btn" onClick={() => { setConfirming(false); p.onReopen?.(); }}>Reopen anyway</button>
          <button type="button" className="rl-plan-btn rl-plan-btn--quiet" onClick={() => setConfirming(false)}>Cancel</button>
        </span>
      ) : (
        <button
          type="button"
          className="rl-plan-btn"
          onClick={() => (built ? setConfirming(true) : p.onReopen?.())}
          title="Rescind the approval and bring the plan back into review, with its comments"
        >
          Reopen plan
        </button>
      ))}
      {!built && p.buildTargets.length > 0 && p.onBuild && (
        <SplitAction
          label={
            <>
              <Hammer aria-hidden size={13} strokeWidth={2} />
              Build
            </>
          }
          title={`Build ${p.buildTargets[0].label}`}
          onPrimary={() => p.onBuild?.(p.buildTargets[0].id)}
          menuLabel="Build with"
          items={p.buildTargets}
          onItem={(id) => p.onBuild?.(id)}
        />
      )}
    </>
  );
}

/** The filled primary with a ▾ beside it that opens upward — the footer
 *  sits on the panel's bottom edge, so the menu grows into the plan. */
function SplitAction({
  label,
  title,
  disabled = false,
  onPrimary,
  menuLabel,
  items,
  onItem,
}: {
  label: React.ReactNode;
  title?: string;
  disabled?: boolean;
  onPrimary: () => void;
  menuLabel: string;
  items: PlanFooterBuildTarget[];
  onItem: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <span ref={wrap} className="rl-plan-split">
      <button type="button" className="rl-plan-btn rl-plan-btn--primary" onClick={onPrimary} disabled={disabled} title={title}>
        {label}
      </button>
      {items.length > 0 && (
        <button
          type="button"
          className="rl-plan-btn rl-plan-btn--primary rl-plan-split-more"
          aria-label={menuLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
        >
          <ChevronDown aria-hidden size={13} strokeWidth={2} />
        </button>
      )}
      {open && (
        <MenuSurface ariaLabel={menuLabel} className="rl-plan-split-menu">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className="rl-plan-split-item"
              onClick={() => {
                setOpen(false);
                onItem(item.id);
              }}
            >
              {item.label}
              {item.detail && <span className="rl-plan-split-detail">{item.detail}</span>}
            </button>
          ))}
        </MenuSurface>
      )}
    </span>
  );
}

export default PlanPanelFooter;
