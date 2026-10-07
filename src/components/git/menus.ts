// SPDX-License-Identifier: Apache-2.0
// Context menus shared by the sidebar, History and Branches.
import type { GitCommit, GitWorkingStatus } from "../../lib/git/types";
import { shortSha } from "./api";
import type { GitActions } from "./actions";
import type { MenuItem } from "./ui";

export function commitMenu(commit: GitCommit, actions: GitActions, status: GitWorkingStatus | null): MenuItem[] {
  return [
    { heading: `${shortSha(commit.sha)} ${commit.subject.slice(0, 48)}` },
    { label: "Check out (detached)", onSelect: () => void actions.checkoutCommit(commit.sha) },
    { label: "New branch here…", onSelect: () => void actions.newBranch(commit.sha, shortSha(commit.sha)) },
    { label: "Tag here…", onSelect: () => void actions.newTag(commit.sha) },
    { separator: true },
    { label: "Cherry-pick", disabled: commit.sha === status?.head, onSelect: () => void actions.cherryPick(commit.sha) },
    { label: "Revert commit", onSelect: () => void actions.revert(commit.sha) },
    { separator: true },
    { heading: `Reset ${status?.branch ?? "HEAD"} to here` },
    { label: "Soft — keep all changes staged", onSelect: () => void actions.reset(commit.sha, "soft") },
    { label: "Mixed — keep changes unstaged", onSelect: () => void actions.reset(commit.sha, "mixed") },
    { label: "Hard — discard all changes…", danger: true, onSelect: () => void actions.reset(commit.sha, "hard") },
    { separator: true },
    { label: "Copy SHA", onSelect: () => void navigator.clipboard?.writeText(commit.sha) },
  ];
}

export function branchMenu(name: string, sha: string, isCurrent: boolean, current: string | null, actions: GitActions, onReveal: (sha: string) => void): MenuItem[] {
  return [
    { label: `Check out ${name}`, disabled: isCurrent, onSelect: () => void actions.checkoutBranch(name) },
    { label: `Merge ${name} into ${current ?? "HEAD"}…`, disabled: isCurrent, onSelect: () => void actions.merge(name) },
    { label: `Rebase ${current ?? "HEAD"} onto ${name}…`, disabled: isCurrent, onSelect: () => void actions.rebase(name) },
    { separator: true },
    { label: `New branch from ${name}…`, onSelect: () => void actions.newBranch(name, name) },
    { label: `Push ${name}…`, onSelect: () => void actions.push(name) },
    { label: "Show in history", onSelect: () => onReveal(sha) },
    { separator: true },
    { label: `Delete ${name}…`, danger: true, disabled: isCurrent, onSelect: () => void actions.deleteBranch(name) },
  ];
}

export function remoteMenu(name: string, sha: string, current: string | null, actions: GitActions, onReveal: (sha: string) => void): MenuItem[] {
  return [
    { label: `Check out ${name} (track)`, onSelect: () => void actions.checkoutRemote(name) },
    { label: `Merge ${name} into ${current ?? "HEAD"}…`, onSelect: () => void actions.merge(name) },
    { label: `Rebase ${current ?? "HEAD"} onto ${name}…`, onSelect: () => void actions.rebase(name) },
    { separator: true },
    { label: `New branch from ${name}…`, onSelect: () => void actions.newBranch(name, name) },
    { label: "Show in history", onSelect: () => onReveal(sha) },
  ];
}

export function tagMenu(name: string, sha: string, actions: GitActions, onReveal: (sha: string) => void): MenuItem[] {
  return [
    { label: `Check out ${name} (detached)`, onSelect: () => void actions.checkoutCommit(name, name) },
    { label: `New branch from ${name}…`, onSelect: () => void actions.newBranch(name, name) },
    { label: "Show in history", onSelect: () => onReveal(sha) },
    { separator: true },
    { label: `Delete tag ${name}…`, danger: true, onSelect: () => void actions.deleteTag(name) },
  ];
}
