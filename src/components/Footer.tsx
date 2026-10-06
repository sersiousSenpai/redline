// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { TEAM_BUILD_ITEMS, teamScaleOf, type Scale } from "../lib/teamBuildItems";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { Comment } from "../types";
import { agentLabelFor } from "../lib/backendChoice";
import { Button } from "./ui/Button";
import type { ManualPlanState, PlanStateTarget } from "./PlanStateMenu";
import { MenuSurface } from "./ui/MenuSurface";
import { ridesSubmit } from "../lib/planSearch";

const PlanStateMenu = lazy(() => import("./PlanStateMenu").then((module) => ({ default: module.PlanStateMenu })));

/** Where an approved plan can be built from — the same agent, or a hand-off. */
export interface BuildTarget {
  id: string;
  label: string;
  detail?: string;
}

/** The open plan, once approved. `runState` NULL is "approved · not built". */
export interface FooterApproval {
  version: number;
  runState: string | null;
  /** A live orchestrated run can't be reopened under itself. */
  runLive: boolean;
}

interface FooterProps {
  comments: Comment[];
  planState?: PlanStateTarget;
  onSetPlanState?: (state: ManualPlanState) => void;
  onMoveProject?: () => void;
  /** A session is open in the main pane — false when the app sits idle. */
  sessionReady: boolean;
  canSubmit: boolean;
  canApprove: boolean;
  waiting: boolean;
  /** The in-flight submit was an Ask batch — the author is answering. */
  waitingAsk: boolean;
  onSubmit: () => void;
  /** "Approve & build": the same agent builds now. */
  onApprove: () => void;
  /** "Approve, build later": approved, the agent stands down, nothing builds. */
  onApproveLater: () => void;
  /** Approve and build with a team (Track O): Auto, or the Custom dialog. */
  onBuildTeam?: (scale: Scale) => void;
  /** Present once the open plan is approved. */
  approval?: FooterApproval | null;
  buildTargets?: BuildTarget[];
  onBuild?: (targetId: string) => void;
  /** Rescind the approval and bring the plan back held, in review. */
  onReopen?: () => void;
  /** Terminal dock collapsed (and not fullscreen) — show a peek segment. */
  termCollapsed: boolean;
  termTabCount: number;
  termHasUnseen: boolean;
  onExpandTerminal: () => void;
  /** Which provider authored this plan; absent reads as Claude. */
  backend?: string | null;
}

export function Footer({
  comments,
  planState, onSetPlanState, onMoveProject,
  sessionReady,
  canSubmit,
  canApprove,
  waiting,
  waitingAsk,
  onSubmit,
  onApprove,
  onApproveLater,
  onBuildTeam,
  approval = null,
  buildTargets = [],
  onBuild,
  onReopen,
  termCollapsed,
  termTabCount,
  termHasUnseen,
  onExpandTerminal,
  backend,
}: FooterProps) {
  const author = agentLabelFor(backend);
  // What the next Send carries — an unpromoted research comment doesn't.
  const pending = comments.filter(ridesSubmit);
  const counts = countByType(pending);
  const total = pending.length;
  // "All resolutions handled" surfaces once the reviewer has dispatched every
  // author resolution in the current revision: nothing pending, nothing still
  // sitting at resolved (i.e. awaiting accept/reopen), and at least one comment
  // has reached a terminal state. The line is a nudge, not a state machine —
  // the buttons below already drive everything.
  const hasUnreviewedResolution = comments.some(
    (c) => c.status === "resolved",
  );
  const hasTerminalComment = comments.some(
    (c) => c.status === "accepted" || c.status === "withdrawn",
  );
  const allResolutionsHandled =
    total === 0 &&
    !hasUnreviewedResolution &&
    hasTerminalComment &&
    !waiting;
  // Ask-mode whenever the tray is non-empty and every pending comment is a
  // non-actionable question — mirrors the backend's SubmissionMode::infer
  // exactly (a promoted question flips the batch to Revise). Purely for UI
  // labelling.
  const askMode =
    total > 0 && pending.every((c) => c.type === "question" && !c.actionable);
  const submitCaption = askMode ? "asks questions only" : "requests a revision";
  const waitingCopy = waitingAsk
    ? `${author} is working — answering in the terminal…`
    : `${author} is working — revising in the terminal…`;

  // No session open and nothing in flight — the app is waiting for a plan.
  // The selected provider's plan opens the review surface.
  const idle = !sessionReady && !waiting;

  // Semantic status dot for the footer: amber while you have pending work,
  // info-blue while the author is in-flight, success-green when the tray is clear,
  // muted while idle.
  const dotColor = waiting
    ? "var(--color-info)"
    : idle
      ? "var(--color-ink-muted)"
      : total > 0
        ? "var(--color-warning)"
        : "var(--color-success)";

  return (
    <footer
      className="rl-app-footer flex items-center justify-between gap-4 px-6 py-2 border-t"
      style={{
        borderColor: "var(--color-rule)",
        color: "var(--color-ink-muted)",
        fontSize: "var(--rl-text-sm)",
      }}
    >
      <span className="rl-footer-status flex items-center gap-2">
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: 9999,
            background: dotColor,
            display: "inline-block",
          }}
        />
        {waiting ? (
          <button
            type="button"
            onClick={onExpandTerminal}
            title="Show terminal"
            className="italic flex items-center gap-1"
            style={{
              color: "var(--color-ink-muted)",
              fontSize: "var(--rl-text-sm)",
              cursor: "pointer",
            }}
          >
            {waitingCopy}
          </button>
        ) : approval ? (
          <span style={{ color: "var(--color-success)" }}>
          {planState && onSetPlanState ? <Suspense fallback={<>Approved · v{approval.version}</>}><PlanStateMenu session={planState} onState={onSetPlanState} onMove={onMoveProject}>
            Approved · v{approval.version} · {approval.runState === null ? "not built" : approval.runState.replace(/_/g, " ")}
          </PlanStateMenu></Suspense> : <>
            Approved · v{approval.version}
            <span style={{ color: "var(--color-ink-muted)" }}>
              {approval.runState === null
                ? " · not built"
                : ` · ${approval.runState.replace(/_/g, " ")}`}
            </span>
          </>}
          </span>
        ) : idle ? (
          <span>
            Waiting for a plan — start a planning session from the front door
          </span>
        ) : allResolutionsHandled ? (
          <span style={{ color: "var(--color-success)" }}>
            All resolutions handled — Approve plan, or add another round of
            comments.
          </span>
        ) : total === 0 ? (
          "no pending comments"
        ) : (
          <>
            {total} pending ·{" "}
            <Badge n={counts.edit} label="edit" color="var(--color-info)" />
            {" · "}
            <Badge
              n={counts.feedback}
              label="feedback"
              color="var(--color-warning)"
            />
            {" · "}
            <Badge
              n={counts.question}
              label="question"
              color="var(--color-success)"
            />
          </>
        )}
        {!approval && planState && !planState.held && onSetPlanState && <Suspense fallback={null}><PlanStateMenu session={planState} onState={onSetPlanState} onMove={onMoveProject}/></Suspense>}
        {termCollapsed && (
          <>
            <span style={{ color: "var(--color-rule)" }}>·</span>
            <button
              type="button"
              onClick={onExpandTerminal}
              title="Show terminal"
              className="flex items-center gap-1"
              style={{
                color: "var(--color-ink-muted)",
                fontSize: "var(--rl-text-sm)",
                cursor: "pointer",
              }}
            >
              {termHasUnseen && (
                <span
                  aria-label="new terminal output"
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 9999,
                    background: "var(--color-info)",
                    display: "inline-block",
                  }}
                />
              )}
              {termTabCount} terminal{termTabCount === 1 ? "" : "s"}
            </button>
          </>
        )}
      </span>
      <span data-tour="footer" className="rl-footer-actions flex items-center gap-2">
        <Button
          size="sm"
          onClick={onSubmit}
          disabled={!canSubmit || waiting}
          className="font-medium"
        >
          {/* One constant verb naming the destination — the original author
              session, never the per-comment Discuss fork. The caption carries
              the mode so the label can't be mistaken for the sidecar. */}
          <span className="flex flex-col items-center leading-tight">
            <span>Send to {author}</span>
            {total > 0 && (
              <span
                style={{
                  fontSize: "10px",
                  fontWeight: 400,
                  color: "var(--color-ink-muted)",
                }}
              >
                {submitCaption}
              </span>
            )}
          </span>
        </Button>
        {approval ? (
          <ApprovedActions
            approval={approval}
            buildTargets={buildTargets}
            onBuild={onBuild}
            onReopen={onReopen}
          />
        ) : (
          // Approving never routes through a run graph: Approve & build hands
          // the plan to the agent that wrote it; build later parks it here.
          <SplitButton
            label="Approve & build"
            sublabel={`with ${author}`}
            disabled={!canApprove || waiting}
            onPrimary={onApprove}
            menuLabel="More approve options"
            items={[
              { id: "later", label: "Approve, build later", detail: "the agent stands down; build from here when ready" },
              ...(onBuildTeam ? TEAM_BUILD_ITEMS.map((item) => ({ ...item, label: `Approve & build ${item.label}` })) : []),
            ]}
            onItem={(id) => {
              const scale = teamScaleOf(id);
              if (scale) onBuildTeam?.(scale);
              else onApproveLater();
            }}
          />
        )}
      </span>
    </footer>
  );
}

function Badge({
  n,
  label,
  color,
}: {
  n: number;
  label: string;
  color: string;
}) {
  // Tracked microtype on the label keeps the chrome reading as an IDE/editor
  // surface. The count stays in the normal type for legibility.
  return (
    <span style={{ color }}>
      {n}{" "}
      <span
        style={{
          textTransform: "uppercase",
          letterSpacing: "0.12em",
          fontSize: "var(--rl-text-xs)",
          fontWeight: 600,
        }}
      >
        {label}
      </span>
    </span>
  );
}

function countByType(comments: Comment[]): Record<Comment["type"], number> {
  const out: Record<Comment["type"], number> = {
    edit: 0,
    feedback: 0,
    question: 0,
    "block-insert": 0,
    "block-delete": 0,
    "block-move": 0,
  };
  for (const c of comments) {
    out[c.type] += 1;
  }
  return out;
}

/** An approved plan's actions: Build ▾ while it isn't built, and Reopen
 *  unless a live run sits on it. Reopening something already building asks
 *  once, inline — the agent may already have changed files. */
function ApprovedActions({
  approval,
  buildTargets,
  onBuild,
  onReopen,
}: {
  approval: FooterApproval;
  buildTargets: BuildTarget[];
  onBuild?: (targetId: string) => void;
  onReopen?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const built = approval.runState !== null;
  return (
    <>
      {!approval.runLive && onReopen && (confirming ? (
        <span className="flex items-center gap-2" role="group" aria-label="Confirm reopen">
          <span style={{ fontSize: "11px" }}>The agent may already have made changes.</span>
          <Button size="sm" onClick={() => { setConfirming(false); onReopen(); }}>Reopen anyway</Button>
          <Button size="sm" onClick={() => setConfirming(false)}>Cancel</Button>
        </span>
      ) : (
        <Button
          size="sm"
          onClick={() => (built ? setConfirming(true) : onReopen())}
          title="Rescind the approval and bring the plan back into review, with its comments"
        >
          Reopen
        </Button>
      ))}
      {!built && buildTargets.length > 0 && onBuild && (
        <SplitButton
          label="Build"
          sublabel={buildTargets[0].label}
          onPrimary={() => onBuild(buildTargets[0].id)}
          menuLabel="Build with"
          items={buildTargets}
          onItem={onBuild}
        />
      )}
    </>
  );
}

/** A primary action with a ▾ beside it that opens a small menu upward — the
 *  footer sits on the bottom edge, so the menu grows into the page. */
function SplitButton({
  label,
  sublabel,
  disabled = false,
  onPrimary,
  menuLabel,
  items,
  onItem,
}: {
  label: string;
  sublabel?: string;
  disabled?: boolean;
  onPrimary: () => void;
  menuLabel: string;
  items: BuildTarget[];
  onItem: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <span ref={wrap} className="relative inline-flex items-stretch">
      <Button size="sm" variant="success" onClick={onPrimary} disabled={disabled} className="font-medium" style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}>
        <span className="flex flex-col items-center leading-tight">
          <span>{label}</span>
          {sublabel && <span style={{ fontSize: "10px", fontWeight: 400, opacity: 0.85 }}>{sublabel}</span>}
        </span>
      </Button>
      <Button
        size="sm"
        variant="success"
        ariaLabel={menuLabel}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: "1px solid color-mix(in srgb, var(--color-on-accent) 35%, transparent)", paddingLeft: 6, paddingRight: 6 }}
      >
        ▾
      </Button>
      {open && (
        <MenuSurface
          ariaLabel={menuLabel}
          className="absolute right-0 z-50 py-1"
          style={{ bottom: "calc(100% + 6px)", minWidth: 220 }}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className="block w-full text-left px-3 py-1.5 hover:bg-[color-mix(in_srgb,var(--color-ink)_7%,transparent)]"
              style={{ color: "var(--color-ink)", fontSize: "12px" }}
              onClick={() => { setOpen(false); onItem(item.id); }}
            >
              {item.label}
              {item.detail && <span className="block" style={{ color: "var(--color-ink-muted)", fontSize: "10.5px" }}>{item.detail}</span>}
            </button>
          ))}
        </MenuSurface>
      )}
    </span>
  );
}
