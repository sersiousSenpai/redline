// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useState } from "react";
import type { GitStatus } from "../types";

interface OrchestrateLaunchModalProps {
  /** The plan session's project — where the orchestrator terminal opens. */
  projectPath: string | null;
  /** `push_status` result; null when the project isn't a known repo (the git
   *  duty is skipped, the rest of the modal stands). */
  gitStatus: GitStatus | null;
  /** Locally detected `disableWorkflows` / env kill-switch — the run would
   *  silently execute sequentially. */
  workflowsDisabled: boolean;
  /** Inferred build/test Bash allow rules (repo markers, from Rust). */
  allowRules: string[];
  /** Launch with the rules the user left checked. */
  onLaunch: (checkedRules: string[]) => void;
  onCancel: () => void;
}

// The Orchestrate preflight: one modal, three duties — warn on a dirty tree
// (other live sessions may own those edits; never suggest stashing), offer
// the inferred Bash allow rules (workflow subagents inherit the allowlist and
// run in acceptEdits — unallowlisted Bash queues permission prompts
// mid-fan-out), and warn when workflows are locally disabled. Mirrors
// CloseConfirmModal's overlay/elevated-card styling.
export function OrchestrateLaunchModal({
  projectPath,
  gitStatus,
  workflowsDisabled,
  allowRules,
  onLaunch,
  onCancel,
}: OrchestrateLaunchModalProps) {
  const [checked, setChecked] = useState<Set<string>>(new Set(allowRules));
  const dirty = gitStatus
    ? gitStatus.staged + gitStatus.unstaged + gitStatus.untracked
    : 0;

  const toggle = (rule: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(rule)) next.delete(rule);
      else next.add(rule);
      return next;
    });
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: "var(--color-overlay)" }}
      onClick={onCancel}
    >
      <div
        className="rounded-md shadow-xl border p-6"
        style={{
          maxWidth: "480px",
          borderColor: "var(--color-rule)",
          background: "var(--color-bg-elevated)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          className="font-serif font-semibold mb-3"
          style={{ fontSize: "20px", color: "var(--color-ink)" }}
        >
          Orchestrate this plan?
        </h2>
        <p
          style={{
            fontSize: "13px",
            lineHeight: 1.55,
            color: "var(--color-ink)",
            marginBottom: 12,
          }}
        >
          Approves the plan and hands it to a fresh session
          {projectPath ? (
            <>
              {" "}
              in <code style={{ fontSize: "12px" }}>{projectPath}</code>
            </>
          ) : null}{" "}
          that executes it as a multi-agent workflow. The original session
          stands down read-only.
        </p>

        {dirty > 0 && (
          <p
            style={{
              fontSize: "12px",
              lineHeight: 1.5,
              color: "var(--color-warning)",
              marginBottom: 12,
            }}
          >
            Working tree has {dirty} uncommitted change{dirty === 1 ? "" : "s"}.
            Multi-agent execution works best from a clean tree, and other live
            sessions may own these edits.
          </p>
        )}

        {workflowsDisabled && (
          <p
            style={{
              fontSize: "12px",
              lineHeight: 1.5,
              color: "var(--color-warning)",
              marginBottom: 12,
            }}
          >
            Workflows appear disabled; this run will execute sequentially
            (enable via claude&rsquo;s /config).
          </p>
        )}

        {allowRules.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <p
              style={{
                fontSize: "12px",
                color: "var(--color-ink-muted)",
                marginBottom: 6,
              }}
            >
              Pre-approve build/test commands so the run doesn&rsquo;t stall on
              permission prompts while you&rsquo;re elsewhere:
            </p>
            {allowRules.map((rule) => (
              <label
                key={rule}
                className="flex items-center gap-2"
                style={{
                  fontSize: "12px",
                  color: "var(--color-ink)",
                  padding: "2px 0",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={checked.has(rule)}
                  onChange={() => toggle(rule)}
                />
                <code>{rule}</code>
              </label>
            ))}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-3 py-1.5"
            style={{
              background: "var(--color-bg-elevated)",
              border: "1px solid var(--color-rule)",
              color: "var(--color-ink-muted)",
              fontSize: "12px",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onLaunch([...checked])}
            className="rounded px-3 py-1.5 font-medium"
            style={{
              background: "var(--color-success)",
              color: "var(--color-on-accent)",
              fontSize: "12px",
            }}
          >
            Launch
          </button>
        </div>
      </div>
    </div>
  );
}
