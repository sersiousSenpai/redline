// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { Comment } from "../types";
import { Button } from "./ui/Button";

interface FooterProps {
  comments: Comment[];
  /** A session is open in the main pane — false when the app sits idle. */
  sessionReady: boolean;
  canSubmit: boolean;
  canApprove: boolean;
  /** Same gating as canApprove — Orchestrate is approve + multi-agent execute. */
  canOrchestrate: boolean;
  waiting: boolean;
  /** The in-flight submit was an Ask batch — Claude is answering, not revising. */
  waitingAsk: boolean;
  onSubmit: () => void;
  onApprove: () => void;
  onOrchestrate: () => void;
  /** Terminal dock collapsed (and not fullscreen) — show a peek segment. */
  termCollapsed: boolean;
  termTabCount: number;
  termHasUnseen: boolean;
  onExpandTerminal: () => void;
  /** Which harness holds this plan ("claude-code" | "codex"; absent reads as
   *  claude-code). Two buttons say a vendor's name out loud, and saying the
   *  wrong one is worse than saying none. */
  backend?: string | null;
}

export function Footer({
  comments,
  sessionReady,
  canSubmit,
  canApprove,
  canOrchestrate,
  waiting,
  waitingAsk,
  onSubmit,
  onApprove,
  onOrchestrate,
  termCollapsed,
  termTabCount,
  termHasUnseen,
  onExpandTerminal,
  backend,
}: FooterProps) {
  const onCodex = backend === "codex";
  const pending = comments.filter(
    (c) => c.status === "draft" || c.status === "reopened",
  );
  const counts = countByType(pending);
  const total = pending.length;
  // "All resolutions handled" surfaces once the reviewer has dispatched every
  // Claude resolution in the current revision: nothing pending, nothing still
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
    ? "Claude is working — answering in the terminal…"
    : "Claude is working — revising in the terminal…";

  // No session open and nothing in flight — the app is waiting for a plan.
  // Surface the one piece of workflow knowledge a new user lacks: Redline
  // begins when Claude Code is in plan mode.
  const idle = !sessionReady && !waiting;

  // Semantic status dot for the footer: amber while you have pending work,
  // info-blue while Claude is in-flight, success-green when the tray is clear,
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
      <span className="flex items-center gap-2">
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
        ) : idle ? (
          <span>
            Waiting for a plan — work in plan mode (shift+tab) in Claude Code
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
      <span data-tour="footer" className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={onSubmit}
          disabled={!canSubmit || waiting}
          className="font-medium"
        >
          {/* One constant verb naming the destination — the real Claude Code
              session, never the per-comment Discuss fork. The caption carries
              the mode so the label can't be mistaken for the sidecar. */}
          <span className="flex flex-col items-center leading-tight">
            <span>{onCodex ? "Send to Codex" : "Send to Claude Code"}</span>
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
        {/* Visually subordinate sibling to Approve: same gating, but the plan
            is executed by a fresh orchestrated session (the original session
            is stood down read-only), so the label carries the mechanism.

            Execution is Claude-only, deliberately — the orchestrate launch
            depends on `--permission-mode acceptEdits`, the orchestrator seat's
            `--model` and the multi-agent Workflow opt-in, none of which have a
            Codex analogue. So a Codex-authored plan is BUILT by Claude. That is
            a real seam, and the caption names it rather than leaving it to be
            discovered mid-run. */}
        <Button
          size="sm"
          onClick={onOrchestrate}
          disabled={!canOrchestrate || waiting}
          className="font-medium"
          title={
            onCodex
              ? "Approve the plan and execute it as a multi-agent workflow in a new Claude Code terminal — Codex plans, Claude builds"
              : "Approve the plan and execute it as a multi-agent workflow in a new terminal"
          }
        >
          <span className="flex flex-col items-center leading-tight">
            <span>Orchestrate</span>
            <span
              style={{
                fontSize: "10px",
                fontWeight: 400,
                color: "var(--color-ink-muted)",
              }}
            >
              {onCodex
                ? "approve + execute on Claude"
                : "approve + multi-agent execute"}
            </span>
          </span>
        </Button>
        <Button
          size="sm"
          variant="success"
          onClick={onApprove}
          disabled={!canApprove || waiting}
          className="font-medium"
          label="Approve plan"
        />
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
