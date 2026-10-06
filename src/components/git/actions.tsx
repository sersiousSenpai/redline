// SPDX-License-Identifier: Apache-2.0
// Every write the git client offers, with the dialogs and confirmations around
// it. Toolbar, sidebar and history menus all call through here.
import { useMemo } from "react";
import type { GitResetMode } from "../../lib/git/types";
import { shortSha } from "./api";
import { pushTarget } from "./pushTarget";
import type { GitRepository } from "./useGitRepository";
import type { useDialogs } from "./ui";

const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock$)(?!.*\/$)(?!.*\.$)[^\s~^:?*[\\\x00-\x1f\x7f]+$/;
const checkName = (kind: string) => (values: Record<string, string | boolean>) =>
  BRANCH_NAME.test(String(values.name).trim()) ? null : `That is not a valid ${kind} name.`;

export function useGitActions(git: GitRepository, dialogs: ReturnType<typeof useDialogs>) {
  const { api, run, status, refs } = git;
  const { ask, confirm } = dialogs;
  return useMemo(() => {
    const current = status?.branch ?? null;
    const branchOptions = () => [
      ...(refs?.local ?? []).filter((b) => !b.current).map((b) => ({ value: b.name, label: b.name })),
      ...(refs?.remote ?? []).filter((b) => !b.name.endsWith("/HEAD")).map((b) => ({ value: b.name, label: b.name })),
    ];
    return {
      fetch: () => run("Fetch", () => api.fetch()),

      async pull() {
        const values = await ask({
          title: "Pull",
          body: <p>Pull {status?.upstream ? <code>{status.upstream}</code> : "the upstream"} into <code>{current ?? "HEAD"}</code>.</p>,
          fields: [{ kind: "checkbox", name: "rebase", label: "Rebase instead of merge", initial: false }],
          confirmLabel: "Pull",
        });
        if (values) await run("Pull", () => api.pull(!!values.rebase));
      },

      async push(branch?: string) {
        const target = pushTarget(status, refs);
        const remotes = refs?.remotes ?? [];
        if (remotes.length === 0) {
          await confirm({ title: "No remote", body: <p>This repository has no remote to push to.</p>, confirmLabel: "OK" });
          return;
        }
        const name = branch ?? current;
        if (!name) {
          await confirm({ title: "Detached HEAD", body: <p>Check out a branch before pushing.</p>, confirmLabel: "OK" });
          return;
        }
        const local = refs?.local.find((b) => b.name === name);
        const values = await ask({
          title: "Push",
          fields: [
            { kind: "select", name: "remote", label: "Remote", options: remotes.map((r) => ({ value: r, label: r })), initial: target?.remote ?? remotes[0] },
            { kind: "select", name: "branch", label: "Branch", options: (refs?.local ?? []).map((b) => ({ value: b.name, label: b.name })), initial: name },
            { kind: "checkbox", name: "setUpstream", label: "Track as upstream (--set-upstream)", initial: !(local?.upstream ?? (name === current ? status?.upstream : null)) },
            { kind: "checkbox", name: "force", label: "Force push (--force-with-lease)", initial: false, hint: "Overwrites the remote branch if nobody else pushed since your last fetch." },
          ],
          confirmLabel: "Push",
        });
        if (!values) return;
        const remote = String(values.remote);
        const pushBranch = String(values.branch);
        if (values.force) {
          const ok = await confirm({
            title: `Force push ${pushBranch}?`,
            body: <p>This rewrites <code>{remote}/{pushBranch}</code> to match your local branch. Commits on the remote that you do not have are lost (the push is refused if the remote moved since your last fetch).</p>,
            confirmLabel: "Force push",
            danger: true,
          });
          if (!ok) return;
        }
        await run(`Push ${pushBranch} to ${remote}`, () => api.push(remote, pushBranch, !!values.setUpstream, !!values.force));
      },

      async newBranch(startPoint?: string, startLabel?: string) {
        const values = await ask({
          title: "New branch",
          body: <p>Starting at <code>{startLabel ?? startPoint ?? current ?? "HEAD"}</code>.</p>,
          fields: [
            { kind: "text", name: "name", label: "Branch name", required: true, mono: true, placeholder: "feature/name" },
            { kind: "checkbox", name: "checkout", label: "Check out the new branch", initial: true },
          ],
          confirmLabel: "Create branch",
          validate: checkName("branch"),
        });
        if (values) await run(`Create branch ${String(values.name).trim()}`, () => api.branchCreate(String(values.name).trim(), startPoint ?? "HEAD", !!values.checkout));
      },

      async merge(target?: string) {
        const options = branchOptions();
        if (!target && options.length === 0) return;
        const values = await ask({
          title: target ? `Merge ${target}` : "Merge",
          body: <p>Merge into <code>{current ?? "HEAD"}</code>.</p>,
          fields: [
            ...(target ? [] : [{ kind: "select" as const, name: "target", label: "Branch to merge", options }]),
            { kind: "checkbox", name: "noFf", label: "Always create a merge commit (--no-ff)", initial: false },
          ],
          confirmLabel: "Merge",
        });
        if (!values) return;
        const what = target ?? String(values.target);
        await run(`Merge ${what}`, () => api.merge(what, !!values.noFf));
      },

      async rebase(onto: string) {
        const ok = await confirm({
          title: `Rebase ${current ?? "HEAD"} onto ${onto}?`,
          body: <p>Your commits on <code>{current ?? "HEAD"}</code> are replayed on top of <code>{onto}</code>, rewriting them.</p>,
          confirmLabel: "Rebase",
        });
        if (ok) await run(`Rebase onto ${onto}`, () => api.rebase(onto));
      },

      checkoutBranch: (name: string) => run(`Check out ${name}`, () => api.checkout(name, "branch")),
      checkoutRemote: (name: string) => run(`Check out ${name}`, () => api.checkout(name, "remote")),
      checkoutCommit: (target: string, label?: string) => run(`Check out ${label ?? shortSha(target)} (detached)`, () => api.checkout(target, "commit")),

      async deleteBranch(name: string) {
        const values = await ask({
          title: `Delete branch ${name}?`,
          body: <p>The local branch <code>{name}</code> is deleted. Its commits stay reachable from the reflog for a while.</p>,
          fields: [{ kind: "checkbox", name: "force", label: "Delete even if it is not merged (-D)", initial: false }],
          confirmLabel: "Delete branch",
          danger: true,
        });
        if (values) await run(`Delete branch ${name}`, () => api.branchDelete(name, !!values.force));
      },

      async newTag(sha: string) {
        const values = await ask({
          title: "New tag",
          body: <p>At commit <code>{shortSha(sha)}</code>.</p>,
          fields: [
            { kind: "text", name: "name", label: "Tag name", required: true, mono: true, placeholder: "v1.0.0" },
            { kind: "textarea", name: "message", label: "Message (makes an annotated tag)", placeholder: "Optional" },
          ],
          confirmLabel: "Create tag",
          validate: checkName("tag"),
        });
        if (values) await run(`Tag ${String(values.name).trim()}`, () => api.tagCreate(String(values.name).trim(), sha, String(values.message ?? "").trim() || undefined));
      },

      async deleteTag(name: string) {
        const ok = await confirm({ title: `Delete tag ${name}?`, body: <p>Deletes the local tag only.</p>, confirmLabel: "Delete tag", danger: true });
        if (ok) await run(`Delete tag ${name}`, () => api.tagDelete(name));
      },

      async stash() {
        const values = await ask({
          title: "Stash changes",
          fields: [
            { kind: "text", name: "message", label: "Message", placeholder: "Optional" },
            { kind: "checkbox", name: "untracked", label: "Include untracked files", initial: false },
          ],
          confirmLabel: "Stash",
        });
        if (values) await run("Stash", () => api.stashSave(String(values.message ?? "").trim(), !!values.untracked));
      },
      stashApply: (index: number, pop: boolean) => run(`${pop ? "Pop" : "Apply"} stash@{${index}}`, () => api.stashApply(index, pop)),
      async stashDrop(index: number) {
        const ok = await confirm({ title: `Drop stash@{${index}}?`, body: <p>The stashed changes are deleted.</p>, confirmLabel: "Drop", danger: true });
        if (ok) await run(`Drop stash@{${index}}`, () => api.stashDrop(index));
      },

      cherryPick: (sha: string) => run(`Cherry-pick ${shortSha(sha)}`, () => api.cherryPick(sha)),
      revert: (sha: string) => run(`Revert ${shortSha(sha)}`, () => api.revertCommit(sha)),
      async reset(sha: string, mode: GitResetMode) {
        if (mode === "hard") {
          const ok = await confirm({
            title: `Hard reset ${current ?? "HEAD"} to ${shortSha(sha)}?`,
            body: <p>The branch moves to <code>{shortSha(sha)}</code> and <strong>all uncommitted changes are discarded</strong>. A recovery copy is kept in <code>.git/redline-undo/</code>.</p>,
            confirmLabel: "Hard reset",
            danger: true,
          });
          if (!ok) return;
        }
        await run(`Reset (${mode}) to ${shortSha(sha)}`, () => api.reset(sha, mode));
      },

      continueOp: () => run("Continue", () => api.continueOp()),
      async abortOp() {
        const ok = await confirm({
          title: `Abort the ${status?.inProgress ?? "operation"}?`,
          body: <p>The repository returns to where it was before the {status?.inProgress ?? "operation"} started.</p>,
          confirmLabel: "Abort",
          danger: true,
        });
        if (ok) await run("Abort", () => api.abortOp());
      },
    };
  }, [api, run, status, refs, ask, confirm]);
}

export type GitActions = ReturnType<typeof useGitActions>;
