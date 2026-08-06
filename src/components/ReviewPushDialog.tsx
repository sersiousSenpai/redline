// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useMemo, useState } from "react";
import { GitBranch } from "lucide-react";

import type { ReviewBranches } from "../types";
import type { UsePush } from "../hooks/usePush";
import {
  DEFAULT_PUSH_FORM,
  planPush,
  toPushRequest,
  type PushFormState,
} from "../lib/pushPlan";
import { useMenuOverlay } from "./menuOverlay";
import BranchPicker from "./BranchPicker";

// The push dialog: commit the reviewed work, push it to a branch of the
// user's choosing, optionally open a PR — without ever switching the
// checkout. Modal pattern per MissionStartDialog (fixed overlay, CSS vars);
// `useMenuOverlay` + data-no-drag because the embedded browser is a native
// child webview composited above all React DOM — a z-index cannot lift the
// dialog over it, so the webview hides while the dialog is open.

interface ReviewPushDialogProps {
  open: boolean;
  onClose: () => void;
  repo: string;
  reviewId: string;
  push: UsePush;
  branches: ReviewBranches | null;
  /** The review diff's own file list — the default staging scope. */
  reviewedPaths: string[];
  /** Called after a successful push so the panel refreshes its diff. */
  onPushed?: () => void;
}

export default function ReviewPushDialog({
  open,
  onClose,
  repo,
  reviewId,
  push,
  branches,
  reviewedPaths,
  onPushed,
}: ReviewPushDialogProps) {
  useMenuOverlay(open);
  const { status, pushing, log, outcome, error, drafting } = push;

  const [form, setForm] = useState<PushFormState>(DEFAULT_PUSH_FORM);
  const [stageReviewedOnly, setStageReviewedOnly] = useState(true);
  const [confirmingProtected, setConfirmingProtected] = useState(false);

  const set = useCallback(
    (patch: Partial<PushFormState>) => {
      setForm((f) => ({ ...f, ...patch }));
      setConfirmingProtected(false);
    },
    [],
  );

  // Fresh open → fresh form, seeded from the live status once it exists.
  useEffect(() => {
    if (!open) return;
    setForm(DEFAULT_PUSH_FORM);
    setStageReviewedOnly(true);
    setConfirmingProtected(false);
    push.clearResult();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!open || !status) return;
    setForm((f) => ({
      ...f,
      remote: f.remote || status.defaultRemote || status.remotes[0] || "",
      prBase: f.prBase || status.defaultBranch || "",
    }));
  }, [open, status]);

  const paths = stageReviewedOnly && reviewedPaths.length > 0 ? reviewedPaths : null;
  const plan = useMemo(() => planPush(status, form, paths), [status, form, paths]);

  const canPush = plan.errors.length === 0 && !pushing;

  const doPush = useCallback(async () => {
    if (!status || plan.errors.length > 0 || pushing) return;
    if (plan.isProtected && !confirmingProtected) {
      setConfirmingProtected(true);
      return;
    }
    const req = toPushRequest(repo, reviewId, status, form, paths, plan.isProtected);
    const out = await push.push(req);
    if (out) onPushed?.();
  }, [status, plan, pushing, confirmingProtected, repo, reviewId, form, paths, push, onPushed]);

  const doDraft = useCallback(async () => {
    const d = await push.draft();
    if (!d) return;
    setForm((f) => ({
      ...f,
      message: d.body.trim() ? `${d.subject}\n\n${d.body}` : d.subject,
      targetName:
        f.targetMode === "new" && !f.targetName.trim() ? d.branch : f.targetName,
      prTitle: f.prTitle.trim() ? f.prTitle : d.prTitle,
      prBody: f.prBody.trim() ? f.prBody : d.prBody,
    }));
  }, [push]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pushing) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, pushing, onClose]);

  if (!open) return null;

  const label = (text: string) => (
    <label style={{ fontSize: "11px", color: "var(--color-ink-muted)", fontWeight: 600 }}>
      {text}
    </label>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={() => {
        if (!pushing) onClose();
      }}
      data-no-drag="true"
    >
      <div
        className="rl-push-dialog rounded-lg flex flex-col gap-2.5 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <GitBranch size={16} strokeWidth={2} style={{ color: "var(--color-ink)" }} />
          <span style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-ink)" }}>
            Commit &amp; push
          </span>
          <button
            type="button"
            className="rl-review-btn rl-review-btn-iconic"
            style={{ marginLeft: "auto" }}
            aria-label="Close"
            onClick={onClose}
            disabled={pushing}
          >
            ✕
          </button>
        </div>

        {outcome ? (
          <div className="rl-push-result">
            <div style={{ fontWeight: 600 }}>
              ✓ Pushed to {outcome.pushedRef}
              {outcome.committedShort ? ` (${outcome.committedShort})` : ""}
            </div>
            {outcome.prUrl && (
              <div>
                Pull request:{" "}
                <a href={outcome.prUrl}>
                  {outcome.prNumber != null ? `#${outcome.prNumber}` : outcome.prUrl}
                </a>
              </div>
            )}
            {outcome.steps.filter((s) => !s.ok).map((s) => (
              <div key={s.name} className="rl-push-warn">
                ⚠ {s.name}: {s.detail}
              </div>
            ))}
            <div style={{ fontSize: "11.5px", color: "var(--color-ink-muted)" }}>
              The commit is on your current branch{status?.branch ? ` (${status.branch})` : ""};
              the target branch received it on the remote.
            </div>
            <div className="flex justify-end">
              <button type="button" className="rl-review-btn rl-review-btn-primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Target */}
            {label("Push to")}
            <div className="flex items-center gap-3 flex-wrap" style={{ fontSize: "12.5px" }}>
              <label className="flex items-center gap-1" style={{ cursor: "pointer" }}>
                <input
                  type="radio"
                  name="rl-push-target"
                  checked={form.targetMode === "current"}
                  onChange={() => set({ targetMode: "current" })}
                />
                Current branch{status?.branch ? ` (${status.branch})` : ""}
              </label>
              <label className="flex items-center gap-1" style={{ cursor: "pointer" }}>
                <input
                  type="radio"
                  name="rl-push-target"
                  checked={form.targetMode === "existing"}
                  onChange={() => set({ targetMode: "existing" })}
                />
                Existing
              </label>
              {form.targetMode === "existing" && (
                <BranchPicker
                  branches={branches}
                  value={form.targetName || null}
                  onChange={(v) => set({ targetName: v ?? "" })}
                  ariaLabel="Target branch"
                  includeRemote={false}
                  placeholder="Pick the target…"
                />
              )}
              <label className="flex items-center gap-1" style={{ cursor: "pointer" }}>
                <input
                  type="radio"
                  name="rl-push-target"
                  checked={form.targetMode === "new"}
                  onChange={() => set({ targetMode: "new" })}
                />
                New branch
              </label>
              {form.targetMode === "new" && (
                <input
                  value={form.targetName}
                  onChange={(e) => set({ targetName: e.target.value })}
                  placeholder="e.g. fix/review-notes"
                  className="rl-review-select"
                  style={{ width: 180 }}
                  aria-label="New branch name"
                  spellCheck={false}
                />
              )}
              <span style={{ color: "var(--color-ink-muted)" }}>on</span>
              <select
                value={form.remote}
                onChange={(e) => set({ remote: e.target.value })}
                className="rl-review-select"
                aria-label="Remote"
              >
                {(status?.remotes ?? []).map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            {form.targetMode !== "current" && status?.branch && (
              <div style={{ fontSize: "11px", color: "var(--color-ink-muted)", lineHeight: 1.4 }}>
                The commit still lands on <b>{status.branch}</b> — pushing to{" "}
                <b>{plan.target || "the target"}</b> publishes it there but does not remove it
                from {status.branch} locally. Your checkout is never switched.
              </div>
            )}

            {/* Message */}
            {!form.skipCommit && (
              <>
                <div className="flex items-center gap-2">
                  {label("Commit message")}
                  <button
                    type="button"
                    className="rl-review-btn"
                    style={{ fontSize: "11px", marginLeft: "auto" }}
                    disabled={drafting}
                    title="Draft the message, branch name and PR text with AI — always editable"
                    onClick={() => void doDraft()}
                  >
                    ✦ {drafting ? "Drafting…" : "Draft"}
                  </button>
                </div>
                <textarea
                  value={form.message}
                  onChange={(e) => set({ message: e.target.value })}
                  rows={4}
                  placeholder={"subject\n\nbody (optional)"}
                  className="rl-push-textarea"
                  spellCheck={false}
                />
              </>
            )}

            {/* Options */}
            <div className="flex items-center gap-3 flex-wrap" style={{ fontSize: "11.5px" }}>
              {reviewedPaths.length > 0 && (
                <label className="flex items-center gap-1" style={{ cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={stageReviewedOnly}
                    disabled={form.skipCommit}
                    onChange={(e) => setStageReviewedOnly(e.target.checked)}
                  />
                  Stage only the {reviewedPaths.length} reviewed file
                  {reviewedPaths.length === 1 ? "" : "s"}
                </label>
              )}
              <label
                className="flex items-center gap-1"
                style={{ cursor: "pointer" }}
                title="git push -u — sets the current branch's upstream; only offered when pushing the current branch"
              >
                <input
                  type="checkbox"
                  checked={form.setUpstream && plan.upstreamAllowed}
                  disabled={!plan.upstreamAllowed}
                  onChange={(e) => set({ setUpstream: e.target.checked })}
                />
                Set upstream (-u)
              </label>
              <label
                className="flex items-center gap-1"
                style={{ cursor: "pointer" }}
                title="git branch <target> HEAD — additive, never switches"
              >
                <input
                  type="checkbox"
                  checked={form.createLocalBranch}
                  onChange={(e) => set({ createLocalBranch: e.target.checked })}
                />
                Also create the local branch here
              </label>
              <label className="flex items-center gap-1" style={{ cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={form.noVerify}
                  onChange={(e) => set({ noVerify: e.target.checked })}
                />
                Skip hooks (--no-verify)
              </label>
              <label
                className="flex items-center gap-1"
                style={{ cursor: "pointer" }}
                title="Push the current HEAD as-is — no stage, no commit"
              >
                <input
                  type="checkbox"
                  checked={form.skipCommit}
                  onChange={(e) => set({ skipCommit: e.target.checked })}
                />
                Push only
              </label>
            </div>

            {/* PR */}
            <div className="flex items-center gap-2" style={{ fontSize: "11.5px" }}>
              <label className="flex items-center gap-1" style={{ cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={form.prEnabled}
                  onChange={(e) => set({ prEnabled: e.target.checked })}
                />
                Open a pull request
              </label>
              {form.prEnabled && status && !status.ghAvailable && (
                <span className="rl-push-warn">`gh` is not installed</span>
              )}
              {form.prEnabled && status?.ghAvailable && !status.ghAuthed && (
                <span className="rl-push-warn">`gh` isn't authenticated</span>
              )}
            </div>
            {form.prEnabled && (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <input
                    value={form.prTitle}
                    onChange={(e) => set({ prTitle: e.target.value })}
                    placeholder="PR title"
                    className="rl-review-select"
                    style={{ flex: 1 }}
                    aria-label="PR title"
                  />
                  <span style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}>into</span>
                  <BranchPicker
                    branches={branches}
                    value={form.prBase || null}
                    onChange={(v) => set({ prBase: v ?? "" })}
                    ariaLabel="PR base branch"
                    includeRemote={false}
                    placeholder="base…"
                    maxWidth={140}
                  />
                </div>
                <textarea
                  value={form.prBody}
                  onChange={(e) => set({ prBody: e.target.value })}
                  rows={3}
                  placeholder="PR description (optional)"
                  className="rl-push-textarea"
                  spellCheck={false}
                />
              </div>
            )}

            {/* What will run */}
            {plan.commands.length > 0 && (
              <pre className="rl-push-preview" aria-label="What will run">
                {plan.commands.join("\n")}
              </pre>
            )}
            {plan.warnings.map((w) => (
              <div key={w} className="rl-push-warn">
                ⚠ {w}
              </div>
            ))}
            {plan.errors.length > 0 && (
              <div style={{ fontSize: "11.5px", color: "var(--color-ink-muted)" }}>
                {plan.errors.join(" · ")}
              </div>
            )}
            {error && <div className="rl-push-error">✗ {error}</div>}
            {(pushing || log.length > 0) && (
              <pre className="rl-push-log">{log.join("\n")}</pre>
            )}

            {/* Actions */}
            {confirmingProtected && (
              <div className="rl-push-protected">
                ⚠ <b>{plan.target}</b> is a protected branch. Push anyway?
              </div>
            )}
            <div className="flex items-center justify-end gap-2 mt-1">
              <button type="button" className="rl-review-btn" onClick={onClose} disabled={pushing}>
                Cancel
              </button>
              <button
                type="button"
                className="rl-review-btn rl-review-btn-primary"
                disabled={!canPush}
                onClick={() => void doPush()}
              >
                {pushing
                  ? "Pushing…"
                  : confirmingProtected
                    ? `Yes, push to ${plan.target}`
                    : plan.isProtected
                      ? `Push to ${plan.target}…`
                      : "Push"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
