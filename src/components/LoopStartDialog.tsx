// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ProjectPicker, type ProjectOption } from "./ProjectPicker";
import type { LoopStartArgs } from "../hooks/useLoop";

interface RepoStatus {
  isGit: boolean;
  clean: boolean;
  currentBranch: string | null;
  dirtyCount: number;
}

interface LoopStartDialogProps {
  /** The approved plan, pre-filled and read-only — the run's north star. */
  planMd: string;
  /** The review session this plan came from. */
  sessionId: string;
  /** Suggested title (e.g. the plan's first heading). */
  defaultTitle?: string;
  /** Suggested repo path (the session's project dir). */
  defaultRepoPath?: string | null;
  /** Suggested base ref — the caller passes e.g. "main". */
  defaultBaseRef?: string;
  /** Candidate project dirs for the repo picker (reused from the drafter). */
  projectOptions: ProjectOption[];
  onStart: (args: LoopStartArgs) => void;
  onCancel: () => void;
}

/** "Hand this plan to the Loop Orchestrator." Pre-filled with the approved plan
 *  and the session's project path; captures the base ref and the run caps up
 *  front so the orchestrator starts grounded. Cloned from MissionStartDialog. */
export function LoopStartDialog({
  planMd,
  sessionId,
  defaultTitle,
  defaultRepoPath,
  defaultBaseRef,
  projectOptions,
  onStart,
  onCancel,
}: LoopStartDialogProps) {
  // Seed the title from the plan's own first heading when the caller doesn't
  // pass one — never from a project/folder name.
  const [title, setTitle] = useState(
    defaultTitle?.trim() ? defaultTitle : firstHeading(planMd) ?? "",
  );
  const [repoPath, setRepoPath] = useState<string | null>(
    defaultRepoPath ?? null,
  );
  const [baseRef, setBaseRef] = useState(defaultBaseRef ?? "main");
  const [maxParallel, setMaxParallel] = useState(3);
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [turnBudget, setTurnBudget] = useState(40);
  const [repoStatus, setRepoStatus] = useState<RepoStatus | null>(null);
  const [checking, setChecking] = useState(false);
  // Don't clobber a base ref the user has typed with the auto-detected branch.
  const baseRefTouched = useRef(false);

  // Check the target repo's git state: prefill the base ref with the repo's
  // actual branch (not a hard-coded "main"), and learn whether it's clean so we
  // can warn about uncommitted work. Git state is external and mutable (the user
  // may commit in a terminal), so this must be re-run — not cached from the
  // first open. `staleGuard` drops results from a superseded scan.
  const staleGuard = useRef(0);
  const scanRepo = useCallback(() => {
    if (!repoPath) {
      setRepoStatus(null);
      return;
    }
    const ticket = ++staleGuard.current;
    setChecking(true);
    invoke<RepoStatus>("loop_repo_status", { repoPath })
      .then((s) => {
        if (ticket !== staleGuard.current) return; // a newer scan superseded this
        setRepoStatus(s);
        if (s.currentBranch && !baseRefTouched.current) {
          setBaseRef(s.currentBranch);
        }
      })
      .catch(() => ticket === staleGuard.current && setRepoStatus(null))
      .finally(() => ticket === staleGuard.current && setChecking(false));
  }, [repoPath]);

  // Re-scan on mount/repo-change AND every time the window regains focus — so a
  // commit made in a terminal while this dialog is open is reflected when you
  // come back, instead of showing a stale count.
  useEffect(() => {
    scanRepo();
    const onFocus = () => scanRepo();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [scanRepo]);

  // Only a non-git target is a hard block. A dirty tree is a soft warning: the
  // run works off committed code in isolated worktrees, so uncommitted work is
  // simply not included (it isn't touched either).
  const repoBlocked = !!repoStatus && !repoStatus.isGit;
  const repoDirty = !!repoStatus && repoStatus.isGit && !repoStatus.clean;
  const canStart =
    !!repoPath &&
    baseRef.trim().length > 0 &&
    planMd.trim().length > 0 &&
    !repoBlocked &&
    !checking;

  const start = () => {
    if (!canStart || !repoPath) return;
    onStart({
      sessionId,
      title: title.trim() || firstHeading(planMd) || "Loop run",
      planMd,
      repoPath,
      baseRef: baseRef.trim(),
      maxParallel,
      maxAttempts,
      turnBudget,
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={onCancel}
    >
      <div
        className="rounded-lg flex flex-col gap-3 p-5"
        style={{
          width: "min(30rem, 92vw)",
          maxHeight: "90vh",
          overflowY: "auto",
          background: "var(--color-paper)",
          border: "1px solid var(--color-rule)",
          boxShadow: "0 12px 40px rgba(0,0,0,0.3)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <span style={{ fontSize: "16px" }}>🔁</span>
          <span style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-ink)" }}>
            Run with Loop Orchestrator
          </span>
        </div>
        <p style={{ fontSize: "12px", color: "var(--color-ink-muted)", lineHeight: 1.5 }}>
          The orchestrator decomposes this plan into a DAG of subtasks, drives
          each in its own git worktree (executor → reviewer), and pauses at
          checkpoints for you to approve merges and land the result.
        </p>

        <label style={{ fontSize: "11px", color: "var(--color-ink-muted)", fontWeight: 600 }}>
          Title <span style={{ fontWeight: 400 }}>(optional)</span>
        </label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Defaults to the plan's first heading"
          className="rounded px-2 py-1.5"
          style={{
            fontSize: "13px",
            border: "1px solid var(--color-rule)",
            background: "var(--color-paper)",
            color: "var(--color-ink)",
          }}
        />

        <label style={{ fontSize: "11px", color: "var(--color-ink-muted)", fontWeight: 600 }}>
          Approved plan
        </label>
        <textarea
          value={planMd}
          readOnly
          rows={5}
          className="rounded px-2 py-1.5 rl-thin-scroll-y"
          style={{
            fontSize: "11.5px",
            border: "1px solid var(--color-rule)",
            background: "var(--color-bg-elevated)",
            color: "var(--color-ink-muted)",
            resize: "vertical",
            fontFamily: "var(--font-mono)",
            lineHeight: 1.45,
          }}
        />

        <div className="flex items-center gap-3">
          <div className="flex flex-col gap-1 flex-1 min-w-0">
            <label style={{ fontSize: "11px", color: "var(--color-ink-muted)", fontWeight: 600 }}>
              Repository
            </label>
            <ProjectPicker
              options={projectOptions}
              value={repoPath}
              onChange={setRepoPath}
            />
            <span style={{ fontSize: "9.5px", color: "var(--color-ink-muted)", opacity: 0.85 }}>
              The project this plan was reviewed in — change it if the work
              targets a different repo.
            </span>
          </div>
          <div className="flex flex-col gap-1" style={{ width: "8rem" }}>
            <label style={{ fontSize: "11px", color: "var(--color-ink-muted)", fontWeight: 600 }}>
              Base ref
            </label>
            <input
              value={baseRef}
              onChange={(e) => {
                baseRefTouched.current = true;
                setBaseRef(e.target.value);
              }}
              placeholder="main"
              className="rounded px-2 py-1.5"
              style={{
                fontSize: "13px",
                border: "1px solid var(--color-rule)",
                background: "var(--color-paper)",
                color: "var(--color-ink)",
              }}
            />
          </div>
        </div>

        {/* Sensible defaults are set — most runs never need to touch these, so
            they're tucked away with plain-language guidance for when you do. */}
        <details style={{ marginTop: "2px" }}>
          <summary
            style={{
              fontSize: "11px",
              color: "var(--color-ink-muted)",
              fontWeight: 600,
              cursor: "pointer",
              userSelect: "none",
            }}
          >
            Advanced — run limits{" "}
            <span style={{ fontWeight: 400 }}>(defaults are fine to leave)</span>
          </summary>
          <div className="flex items-start gap-3" style={{ marginTop: "8px" }}>
            <NumberField
              label="Max parallel"
              value={maxParallel}
              min={1}
              onChange={setMaxParallel}
              hint="Subtasks running at once. Higher finishes sooner but is heavier on your machine and API usage. 3 is a good default."
            />
            <NumberField
              label="Max attempts"
              value={maxAttempts}
              min={1}
              onChange={setMaxAttempts}
              hint="Executor → reviewer retries before a subtask pauses and asks you what to do. 3 is plenty; raise it only for finicky work."
            />
            <NumberField
              label="Turn budget"
              value={turnBudget}
              min={1}
              onChange={setTurnBudget}
              hint="Minutes an agent turn may run before it's killed as stuck. 40 suits most tasks; raise it for large ones."
            />
          </div>
        </details>

        {repoBlocked && (
          <div
            className="rounded px-3 py-2"
            style={{
              fontSize: "11.5px",
              lineHeight: 1.45,
              border: "1px solid var(--color-danger, #b4442e)",
              background: "color-mix(in srgb, var(--color-danger, #b4442e) 12%, transparent)",
              color: "var(--color-ink)",
            }}
          >
            <strong>Not a git repository.</strong> The Loop Orchestrator runs each
            subtask in an isolated git worktree, so the target must be a git repo.
            Pick a different directory.
          </div>
        )}
        {repoDirty && (
          <div
            className="rounded px-3 py-2"
            style={{
              fontSize: "11.5px",
              lineHeight: 1.45,
              border: "1px solid var(--color-warning, #b8860b)",
              background: "color-mix(in srgb, var(--color-warning, #b8860b) 12%, transparent)",
              color: "var(--color-ink)",
            }}
          >
            <strong>
              {repoStatus?.dirtyCount} uncommitted change
              {repoStatus && repoStatus.dirtyCount === 1 ? "" : "s"} won't be
              included.
            </strong>{" "}
            The run works off committed code on <code>{baseRef || "the base ref"}</code>{" "}
            in isolated worktrees — your uncommitted work is left untouched, just
            not part of the run. Commit it first if you want it included. (You'll
            need a clean tree at the end to land the result.){" "}
            <button
              type="button"
              onClick={scanRepo}
              disabled={checking}
              style={{
                fontSize: "11px",
                textDecoration: "underline",
                background: "none",
                border: "none",
                color: "var(--color-ink)",
                cursor: checking ? "default" : "pointer",
                padding: 0,
              }}
            >
              {checking ? "Re-checking…" : "Re-check"}
            </button>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 mt-1">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-3 py-1.5 font-medium"
            style={{
              fontSize: "12px",
              border: "1px solid var(--color-rule)",
              background: "var(--color-bg-elevated)",
              color: "var(--color-ink)",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={start}
            disabled={!canStart}
            className="rounded px-3 py-1.5 font-medium"
            style={{
              fontSize: "12px",
              background: "var(--color-info)",
              color: "var(--color-on-accent)",
              opacity: canStart ? 1 : 0.5,
              cursor: canStart ? "pointer" : "default",
            }}
          >
            Start run 🔁
          </button>
        </div>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  onChange: (n: number) => void;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1 flex-1 min-w-0">
      <span style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}>{label}</span>
      <input
        type="number"
        min={min}
        value={value}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (!Number.isNaN(n)) onChange(Math.max(min, n));
        }}
        className="rounded px-2 py-1.5"
        style={{
          fontSize: "13px",
          border: "1px solid var(--color-rule)",
          background: "var(--color-paper)",
          color: "var(--color-ink)",
        }}
      />
      {hint && (
        <span style={{ fontSize: "9.5px", color: "var(--color-ink-muted)", lineHeight: 1.35, opacity: 0.85 }}>
          {hint}
        </span>
      )}
    </div>
  );
}

/** First ATX/setext-ish heading text, used as the fallback run title. */
function firstHeading(md: string): string | null {
  for (const line of md.split("\n")) {
    const m = /^#{1,6}\s+(.*)$/.exec(line.trim());
    if (m) return m[1].trim();
  }
  return null;
}
