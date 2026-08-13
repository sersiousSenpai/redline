// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import ReviewPanel from "./ReviewPanel";
import type { UseReview } from "../hooks/useReview";
import type { ProjectOption } from "./ProjectPicker";
import type { GitStatus, PlanRun } from "../types";

interface RunReportProps {
  planSessionId: string;
  planTitle: string | null;
  /** The plan session's repo — ground-truth probes run against it. */
  repoPath: string | null;
  /** The shared Code Review hook — the line-by-line review happens INSIDE
   *  this container (embedded pane), not beside it. */
  review: UseReview;
  projectOptions: ProjectOption[];
  onClose: () => void;
  /** Fired after a resolution mark lands, so App refreshes the chip. */
  onResolved: () => void;
  /** Re-launch is only offered while the plan is still approved (recovery is
   *  the chip's job — the Footer's Orchestrate button stays disabled). */
  canRelaunch: boolean;
  /** Run the approved plan again — reset + a fresh verified handoff. */
  onRelaunch: (planSessionId: string) => void;
  /** Abort the live run (`abandoned`); never kills the orchestrator. */
  onStandDown: (planSessionId: string) => void;
}

/** One claimed subtask from the orchestrator's exit report. */
interface ReportSubtask {
  title: string;
  planSection?: string;
  verified?: boolean;
  skipped?: boolean;
  notes?: string;
}

interface ParsedReport {
  summary: string;
  subtasks: ReportSubtask[];
}

/** The agent's claims, parsed defensively — a malformed report renders as
 *  "no structured claims" rather than crashing the container. */
function parseReport(reportJson: string): ParsedReport {
  try {
    const v = JSON.parse(reportJson) as Record<string, unknown>;
    const subtasks = Array.isArray(v.subtasks)
      ? (v.subtasks as ReportSubtask[]).filter(
          (s) => s && typeof s.title === "string",
        )
      : [];
    return {
      summary: typeof v.summary === "string" ? v.summary : "",
      subtasks,
    };
  } catch {
    return { summary: "", subtasks: [] };
  }
}

const RESOLUTIONS: { key: string; label: string; color: string }[] = [
  { key: "resolved", label: "Resolved", color: "var(--color-success)" },
  {
    key: "needs_follow_up",
    label: "Needs follow-up",
    color: "var(--color-warning)",
  },
  { key: "abandoned", label: "Abandoned", color: "var(--color-ink-muted)" },
];

// The RunReport container: claims-vs-ground-truth on top (the orchestrator's
// exit report paired against what Redline observed independently), the
// embedded line-by-line review in the middle, and the human resolution bar
// at the bottom. The resolution is a deliberate act — never inferred from
// dismissing the review — and `Resolved` is the only mark that walks the run
// chip to `landed`; the other two stay visibly unresolved.
export function RunReport({
  planSessionId,
  planTitle,
  repoPath,
  review,
  projectOptions,
  onClose,
  onResolved,
  canRelaunch,
  onRelaunch,
  onStandDown,
}: RunReportProps) {
  const [run, setRun] = useState<PlanRun | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    void invoke<PlanRun | null>("get_plan_run", { planSessionId })
      .then((r) => setRun(r))
      .catch(() => setRun(null))
      .finally(() => setLoaded(true));
    if (repoPath) {
      void invoke<GitStatus>("push_status", { repo: repoPath })
        .then(setGit)
        .catch(() => setGit(null));
    }
  };
  // Re-fetch when the target run changes (and on mount).
  useEffect(refresh, [planSessionId, repoPath]);

  const report = useMemo(
    () => (run ? parseReport(run.reportJson) : null),
    [run],
  );
  const dirty = git ? git.staged + git.unstaged + git.untracked : null;

  const resolve = (key: string) => {
    if (busy) return;
    setBusy(true);
    void invoke<boolean>("resolve_plan_run", {
      planSessionId,
      resolution: key,
      note: note.trim() || null,
    })
      .then(() => {
        refresh();
        onResolved();
      })
      .catch((err) => console.error("resolve_plan_run failed", err))
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Claims vs ground truth */}
      <div
        className="border-b px-4 py-3 overflow-y-auto rl-thin-scroll-y"
        style={{
          borderColor: "var(--color-rule)",
          background: "var(--color-bg-elevated)",
          maxHeight: "40%",
        }}
      >
        <div className="flex items-center justify-between mb-2">
          <h2
            className="font-serif font-semibold"
            style={{ fontSize: "16px", color: "var(--color-ink)" }}
          >
            Run report{planTitle ? ` — ${planTitle}` : ""}
          </h2>
          <button
            type="button"
            onClick={onClose}
            title="Close the run report"
            style={{
              color: "var(--color-ink-muted)",
              fontSize: "12px",
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>

        {!loaded ? null : !run ? (
          <p style={{ fontSize: "12px", color: "var(--color-ink-muted)" }}>
            No exit report has been filed for this run yet — it arrives when
            the orchestrator's workflow ends.
          </p>
        ) : (
          <>
            {/* Ground truth Redline observed, beside the agent's claims. */}
            <div
              className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-2"
              style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}
            >
              <span>
                {run.workflowRan
                  ? "multi-agent workflow"
                  : "sequential execution"}
              </span>
              <span>
                report filed{" "}
                {new Date(run.createdAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              {review.diff && (
                <span>{review.diff.length} file(s) in the review diff</span>
              )}
              {review.review && <span>review round {review.review.round}</span>}
              {dirty !== null && (
                <span>{dirty} uncommitted change(s) in the tree</span>
              )}
              {run.scriptPath && (
                <span title={run.scriptPath}>
                  script: <code>{run.scriptPath.split("/").pop()}</code>
                </span>
              )}
              {run.resolution && (
                <span
                  style={{
                    color:
                      RESOLUTIONS.find((r) => r.key === run.resolution)
                        ?.color ?? "var(--color-ink-muted)",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                  }}
                >
                  {run.resolution.replace(/_/g, " ")}
                </span>
              )}
            </div>

            {report?.summary && (
              <p
                style={{
                  fontSize: "12px",
                  color: "var(--color-ink)",
                  lineHeight: 1.5,
                  marginBottom: 8,
                }}
              >
                {report.summary}
              </p>
            )}

            {report && report.subtasks.length > 0 ? (
              <table style={{ fontSize: "11px", width: "100%" }}>
                <thead>
                  <tr
                    style={{
                      color: "var(--color-ink-muted)",
                      textAlign: "left",
                    }}
                  >
                    <th style={{ paddingRight: 12 }}>Claimed subtask</th>
                    <th style={{ paddingRight: 12 }}>Plan section</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody style={{ color: "var(--color-ink)" }}>
                  {report.subtasks.map((s, i) => (
                    <tr key={i}>
                      <td style={{ paddingRight: 12 }}>{s.title}</td>
                      <td
                        style={{
                          paddingRight: 12,
                          color: "var(--color-ink-muted)",
                        }}
                      >
                        {s.planSection ?? "—"}
                      </td>
                      <td
                        title={s.notes || undefined}
                        style={{
                          color: s.skipped
                            ? "var(--color-warning)"
                            : s.verified
                              ? "var(--color-success)"
                              : "var(--color-ink-muted)",
                        }}
                      >
                        {s.skipped
                          ? "skipped"
                          : s.verified
                            ? "verified"
                            : "unverified"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}>
                The report carried no structured subtask claims.
              </p>
            )}
          </>
        )}
      </div>

      {/* The line-by-line review, embedded — the container owns it. */}
      <div className="flex-1 min-h-0">
        <ReviewPanel
          review={review}
          projectOptions={projectOptions}
          onClose={onClose}
        />
      </div>

      {/* Resolution bar — the human verdict that closes the run. */}
      <div
        className="border-t px-4 py-2 flex items-center gap-2"
        style={{
          borderColor: "var(--color-rule)",
          background: "var(--color-bg-elevated)",
        }}
      >
        <span
          style={{
            fontSize: "11px",
            color: "var(--color-ink-muted)",
            marginRight: 4,
          }}
        >
          {run?.resolution
            ? "Marked — you can re-mark it:"
            : "Close out this run:"}
        </span>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="note (optional)"
          className="flex-1 rounded px-2 py-1"
          style={{
            fontSize: "11px",
            border: "1px solid var(--color-rule)",
            background: "var(--color-paper)",
            color: "var(--color-ink)",
          }}
        />
        {RESOLUTIONS.map((r) => (
          <button
            key={r.key}
            type="button"
            disabled={busy || !run}
            onClick={() => resolve(r.key)}
            className="rounded px-2 py-1"
            title={
              r.key === "resolved"
                ? "The run landed — the chip walks to `landed`"
                : "Recorded; the run stays visibly unresolved"
            }
            style={{
              fontSize: "11px",
              fontWeight: 600,
              border: `1px solid ${r.color}`,
              color: r.color,
              background: "transparent",
              cursor: busy || !run ? "default" : "pointer",
              opacity: busy || !run ? 0.5 : 1,
            }}
          >
            {r.label}
          </button>
        ))}
        {/* Recovery actions (Part C): run it again, or abort the live run.
            These act on the run lifecycle, not the report row, so they stay
            enabled even before an exit report exists. */}
        <span
          aria-hidden
          style={{
            width: 1,
            alignSelf: "stretch",
            background: "var(--color-rule)",
            margin: "0 2px",
          }}
        />
        {canRelaunch && (
          <button
            type="button"
            onClick={() => onRelaunch(planSessionId)}
            className="rounded px-2 py-1"
            title="Reset this run and deliver the orchestrator again — no re-approval needed"
            style={{
              fontSize: "11px",
              fontWeight: 600,
              border: "1px solid var(--color-info)",
              color: "var(--color-info)",
              background: "transparent",
              cursor: "pointer",
            }}
          >
            Re-launch
          </button>
        )}
        <button
          type="button"
          onClick={() => onStandDown(planSessionId)}
          className="rounded px-2 py-1"
          title="Mark the run abandoned and stop watching it (the orchestrator process is not killed — close its terminal tab)"
          style={{
            fontSize: "11px",
            fontWeight: 600,
            border: "1px solid var(--color-ink-muted)",
            color: "var(--color-ink-muted)",
            background: "transparent",
            cursor: "pointer",
          }}
        >
          Stand down
        </button>
      </div>
    </div>
  );
}
