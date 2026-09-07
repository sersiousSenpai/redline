// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useState } from "react";
import type { AllowCandidate, GitStatus, WorkflowAvailability } from "../types";

interface OrchestrateLaunchModalProps {
  /** The plan session's project — where the orchestrator terminal opens. */
  projectPath: string | null;
  /** `push_status` result; null when the project isn't a known repo (the git
   *  duty is skipped, the rest of the modal stands). */
  gitStatus: GitStatus | null;
  /** The workflows probe, whole — the modal reports what was actually read
   *  and what could not be, rather than collapsing both into one boolean. */
  availability: WorkflowAvailability | null;
  /** Inferred build/test Bash allow rules (repo markers, from Rust), each
   *  marked with whether the user already has it. */
  allowRules: AllowCandidate[];
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
  availability,
  allowRules,
  onLaunch,
  onCancel,
}: OrchestrateLaunchModalProps) {
  // Only the rules that would CHANGE something are offered as choices.
  // Pre-checking every candidate — including ones already in
  // `permissions.allow` — is what made this step read as ceremony: the user
  // re-confirmed rules they already had and got no signal about the rest.
  const missing = allowRules.filter((c) => !c.present);
  const present = allowRules.filter((c) => c.present);
  const [checked, setChecked] = useState<Set<string>>(
    new Set(missing.map((c) => c.rule)),
  );
  const workflowsDisabled = !!(
    availability &&
    (availability.disabledInSettings || availability.disabledInEnv)
  );
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

        {workflowsDisabled ? (
          <p
            style={{
              fontSize: "12px",
              lineHeight: 1.5,
              color: "var(--color-warning)",
              marginBottom: 12,
            }}
          >
            Workflows are disabled
            {availability?.settingsSource ? (
              <>
                {" "}
                by <code style={{ fontSize: "11px" }}>{availability.settingsSource}</code>
              </>
            ) : availability?.disabledInEnv ? (
              " by CLAUDE_CODE_DISABLE_WORKFLOWS in the environment"
            ) : null}
            ; this run will execute sequentially (enable via claude&rsquo;s
            /config).
          </p>
        ) : (
          availability && (
            /* Honesty about the blind spot rather than silence that reads as
               an all-clear: the run happens inside `$SHELL -l`, which sources
               rc files Redline never sees. An export in ~/.zshrc is fully
               active there and undetectable here — the run's own mode chip is
               the ground truth, which is why a sequential run is now marked. */
            <p
              style={{
                fontSize: "11.5px",
                lineHeight: 1.5,
                color: "var(--color-ink-muted)",
                marginBottom: 12,
              }}
            >
              Nothing in your settings files disables workflows. Redline
              can&rsquo;t read your login shell&rsquo;s rc files, though — if
              this run comes back marked &ldquo;sequential fallback&rdquo;,
              a shell <code style={{ fontSize: "11px" }}>export</code> is the
              usual reason.
            </p>
          )
        )}

        {allowRules.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            {missing.length > 0 && (
              <>
                <p
                  style={{
                    fontSize: "12px",
                    color: "var(--color-ink-muted)",
                    marginBottom: 6,
                  }}
                >
                  Pre-approve build/test commands so the run doesn&rsquo;t stall
                  on permission prompts while you&rsquo;re elsewhere:
                </p>
                {missing.map((c) => (
                  <label
                    key={c.rule}
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
                      checked={checked.has(c.rule)}
                      onChange={() => toggle(c.rule)}
                    />
                    <code>{c.rule}</code>
                  </label>
                ))}
              </>
            )}
            {present.length > 0 && (
              <p
                style={{
                  fontSize: "11.5px",
                  color: "var(--color-ink-muted)",
                  marginTop: missing.length > 0 ? 8 : 0,
                  lineHeight: 1.5,
                }}
              >
                Already allowed:{" "}
                {present.map((c, i) => (
                  <span key={c.rule}>
                    {i > 0 ? ", " : ""}
                    <code style={{ fontSize: "11px" }}>{c.rule}</code>
                  </span>
                ))}
              </p>
            )}
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
