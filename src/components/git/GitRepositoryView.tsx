// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
// The Code Review surface's Repository pose: a full git client for one repo.
// Toolbar, sidebar (workspace, branches, remotes, tags, stashes), File status
// and History, with raw git output in a drawer. Loaded lazily by ReviewPanel.
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  Archive,
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  ChevronUp,
  CloudDownload,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  RefreshCw,
  SquareTerminal,
} from "lucide-react";
import { usePersistedState } from "../../theme/usePersistedState";
import type { GitDiffFile } from "../../lib/git/types";
import { useGitRepository, type GitRepository } from "./useGitRepository";
import { useGitActions, type GitActions } from "./actions";
import { useContextMenu, useDialogs } from "./ui";
import { GitSidebar, type GitView } from "./GitSidebar";
import { FileStatusView } from "./FileStatusView";
import { HistoryView, formatDate } from "./HistoryView";
import { ChangesPane } from "./ChangesPane";
import "./git.css";

const BranchGraphView = lazy(() => import("./BranchGraphView"));

export interface GitRepositoryViewProps {
  repo: string;
  onOpenTerminal?: (cwd: string, command?: string) => void;
}

export default function GitRepositoryView({ repo, onOpenTerminal }: GitRepositoryViewProps) {
  const git = useGitRepository(repo);
  const dialogs = useDialogs();
  const menu = useContextMenu();
  const actions = useGitActions(git, dialogs);
  const [stored, setView] = usePersistedState<GitView>("redline.git.view", "status");
  const [stashIndex, setStashIndex] = useState<number | null>(null);
  const [reveal, setReveal] = useState<{ sha: string; nonce: number } | null>(null);
  const [focusCommit, setFocusCommit] = useState(0);
  const { status, refs } = git;
  const view: GitView = stored === "stash" && (stashIndex === null || !refs?.stashes.some((s) => s.index === stashIndex)) ? "status" : stored;
  const changeCount = status ? status.staged.length + status.unstaged.length + status.conflicted.length : 0;
  const revealSha = (sha: string) => setReveal((r) => ({ sha, nonce: (r?.nonce ?? 0) + 1 }));
  const showInHistory = (sha: string) => {
    setView("history");
    revealSha(sha);
  };

  return (
    <div className="rl-git" aria-label="Repository">
      <Toolbar
        git={git}
        actions={actions}
        onCommit={() => {
          setView("status");
          setFocusCommit((n) => n + 1);
        }}
        onTerminal={onOpenTerminal ? () => onOpenTerminal(repo) : undefined}
      />
      {status?.inProgress && (
        <div className="rl-git-banner rl-git-banner-warn" role="status">
          <span>
            <strong>{status.inProgress === "cherry-pick" ? "Cherry-pick" : status.inProgress[0].toUpperCase() + status.inProgress.slice(1)} in progress.</strong>{" "}
            {status.conflicted.length > 0
              ? `${status.conflicted.length} conflicted file${status.conflicted.length === 1 ? "" : "s"} — resolve, stage, then continue.`
              : "No conflicts left — continue to finish."}
          </span>
          <span className="rl-git-spacer" />
          <button type="button" className="rl-git-btn rl-git-btn-sm" disabled={!!git.busy} onClick={() => void actions.abortOp()}>Abort</button>
          <button type="button" className="rl-git-btn rl-git-btn-sm rl-git-btn-primary" disabled={!!git.busy || status.conflicted.length > 0} onClick={() => void actions.continueOp()}>Continue</button>
        </div>
      )}
      {git.loadError && <div className="rl-git-banner rl-git-banner-error" role="alert">{git.loadError}</div>}
      <div className="rl-git-main">
        <GitSidebar
          refs={refs}
          changeCount={changeCount}
          view={view}
          stashIndex={stashIndex}
          onView={setView}
          onStash={(index) => {
            setStashIndex(index);
            setView("stash");
          }}
          onReveal={(sha) => {
            // The Branches view pans to the ref in place; anything else opens History.
            if (view !== "branches") setView("history");
            revealSha(sha);
          }}
          onShowInHistory={showInHistory}
          actions={actions}
          menu={menu}
        />
        <main className="rl-git-content">
          {view === "status" ? (
            <FileStatusView git={git} dialogs={dialogs} menu={menu} focusCommitToken={focusCommit} />
          ) : view === "branches" ? (
            <Suspense fallback={<div className="rl-git-empty">Loading branches…</div>}>
              <BranchGraphView git={git} actions={actions} menu={menu} reveal={reveal} onShowInHistory={showInHistory} />
            </Suspense>
          ) : view === "history" ? (
            <HistoryView git={git} actions={actions} menu={menu} reveal={reveal} />
          ) : (
            <StashView git={git} actions={actions} index={stashIndex!} />
          )}
        </main>
      </div>
      {git.notice && <Notice key={git.notice.at} text={git.notice.text} onClose={() => git.setNotice(null)} />}
      <OutputDrawer git={git} />
      {menu.node}
      {dialogs.node}
    </div>
  );
}

function Toolbar({ git, actions, onCommit, onTerminal }: { git: GitRepository; actions: GitActions; onCommit: () => void; onTerminal?: () => void }) {
  const { status, busy } = git;
  const detached = status ? status.branch === null : false;
  const button = (label: string, icon: React.ReactNode, onClick: () => void, opts: { badge?: number; title?: string; disabled?: boolean } = {}) => (
    <button type="button" className="rl-git-tool" title={opts.title ?? label} disabled={!!busy || opts.disabled} onClick={onClick}>
      <span className="rl-git-tool-icon">
        {icon}
        {opts.badge ? <span className="rl-git-tool-badge">{opts.badge}</span> : null}
      </span>
      <span>{label}</span>
    </button>
  );
  return (
    <div className="rl-git-toolbar" role="toolbar" aria-label="Git actions">
      {button("Commit", <GitCommitHorizontal size={18} />, onCommit, { title: "Commit staged changes" })}
      <span className="rl-git-tool-sep" />
      {button("Pull", <ArrowDownToLine size={18} />, () => void actions.pull(), {
        badge: status?.behind,
        disabled: detached || !status?.upstream,
        title: status?.upstream ? `Pull from ${status.upstream}${status.behind ? ` (${status.behind} behind)` : ""}` : "No upstream to pull from",
      })}
      {button("Push", <ArrowUpFromLine size={18} />, () => void actions.push(), {
        badge: status?.ahead,
        disabled: detached,
        title: status?.upstream ? `Push to ${status.upstream}${status.ahead ? ` (${status.ahead} ahead)` : ""}` : "Push",
      })}
      {button("Fetch", <CloudDownload size={18} />, () => void actions.fetch(), { title: "Fetch all remotes (--prune)" })}
      <span className="rl-git-tool-sep" />
      {button("Branch", <GitBranch size={18} />, () => void actions.newBranch(), { title: "Create a branch" })}
      {button("Merge", <GitMerge size={18} />, () => void actions.merge(), { title: "Merge a branch into the current one" })}
      {button("Stash", <Archive size={18} />, () => void actions.stash(), { title: "Stash working-tree changes" })}
      <span className="rl-git-spacer" />
      <div className="rl-git-head-info" title={status?.head ?? undefined}>
        {status ? (
          <>
            <GitBranch size={13} />
            <span className="rl-git-head-branch">{status.branch ?? `HEAD detached at ${status.head?.slice(0, 7) ?? "?"}`}</span>
            {status.upstream && <span className="rl-git-muted">→ {status.upstream}</span>}
          </>
        ) : (
          <span className="rl-git-muted">Reading repository…</span>
        )}
      </div>
      {busy && <span className="rl-git-busy" role="status">{busy}…</span>}
      {onTerminal && (
        <button type="button" className="rl-git-icon-btn" title="Open a terminal here" aria-label="Open a terminal here" onClick={onTerminal}>
          <SquareTerminal size={15} />
        </button>
      )}
      <button type="button" className="rl-git-icon-btn" title="Refresh" aria-label="Refresh" onClick={() => void git.refresh()}>
        <RefreshCw size={15} />
      </button>
    </div>
  );
}

function Notice({ text, onClose }: { text: string; onClose: () => void }) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const timer = window.setTimeout(() => close.current(), 8000);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className="rl-git-toast" role="status">
      <span>{text}</span>
      <button type="button" className="rl-git-link" onClick={() => void navigator.clipboard?.writeText(text.replace(/^Recovery copy saved to\s*/, ""))}>Copy path</button>
      <button type="button" className="rl-git-icon-btn" aria-label="Dismiss" onClick={onClose}>×</button>
    </div>
  );
}

function OutputDrawer({ git }: { git: GitRepository }) {
  const { lastOp, drawerOpen, setDrawerOpen } = git;
  return (
    <div className="rl-git-drawer" data-open={drawerOpen ? "" : undefined}>
      <button type="button" className="rl-git-drawer-bar" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(!drawerOpen)}>
        {drawerOpen ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
        <span>Output</span>
        {lastOp ? (
          <span className="rl-git-drawer-summary" data-ok={lastOp.ok ? "" : undefined}>
            {lastOp.label} — {lastOp.ok ? "done" : lastOp.conflicts.length ? `${lastOp.conflicts.length} conflict${lastOp.conflicts.length === 1 ? "" : "s"}` : "failed"}
          </span>
        ) : (
          <span className="rl-git-muted">No operations yet</span>
        )}
      </button>
      {drawerOpen && (
        <pre className="rl-git-drawer-body" aria-label="Git output">
          {lastOp
            ? `${lastOp.output.trim() || "(no output)"}${lastOp.conflicts.length ? `\n\nConflicts:\n${lastOp.conflicts.map((c) => `  ${c}`).join("\n")}` : ""}`
            : "Raw git output from the last operation appears here."}
        </pre>
      )}
    </div>
  );
}

function StashView({ git, actions, index }: { git: GitRepository; actions: GitActions; index: number }) {
  const stash = git.refs?.stashes.find((s) => s.index === index) ?? null;
  const [files, setFiles] = useState<GitDiffFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sha = stash?.sha;
  useEffect(() => {
    let live = true;
    setFiles(null);
    setError(null);
    git.api.stashFiles(index).then((f) => live && setFiles(f), (e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [git.api, index, sha]);
  if (!stash) return null;
  return (
    <div className="rl-git-detail rl-git-detail-full">
      <ChangesPane
        files={files}
        error={error}
        label="Stashed files"
        header={
          <div className="rl-git-commit-meta">
            <div className="rl-git-commit-subject">{stash.message || `stash@{${index}}`}</div>
            <div className="rl-git-muted rl-git-mono">stash@{`{${index}}`} · {stash.sha.slice(0, 7)} · {formatDate(stash.date)}</div>
            <div className="rl-git-row-actions">
              <button type="button" className="rl-git-btn rl-git-btn-sm" disabled={!!git.busy} onClick={() => void actions.stashApply(index, false)}>Apply</button>
              <button type="button" className="rl-git-btn rl-git-btn-sm" disabled={!!git.busy} onClick={() => void actions.stashApply(index, true)}>Pop</button>
              <button type="button" className="rl-git-btn rl-git-btn-sm rl-git-btn-danger-text" disabled={!!git.busy} onClick={() => void actions.stashDrop(index)}>Drop…</button>
            </div>
          </div>
        }
      />
    </div>
  );
}
