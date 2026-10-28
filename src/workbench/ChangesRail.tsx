// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The rail's Changes tab (W4): the working tree at a glance — branch,
// ahead/behind, +/− totals — staged and unstaged files with their line
// stats and a checkbox that stages or unstages, a click that opens the
// file's diff in the Review pane, and the commit box: Commit for what is
// staged, and Commit & Push… for the push dialog the Review pane already
// uses (push to a branch, open a PR). The dense Repository client stays in
// Review. Mounted only while the tab shows, so nothing here polls behind it.

import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { GitBranch, GitPullRequest } from "lucide-react";

import { gitApi } from "../components/git/api";
import { usePush } from "../hooks/usePush";
import ReviewPushDialog from "../components/ReviewPushDialog";
import type { DiffFile, ReviewBranches } from "../types";
import type { FileCode, GitFileEntry } from "../lib/git/types";
import { useRepoStatus } from "./useRepoStatus";
import { diffStats, type LineStats } from "./changeStats";
import "./rail.css";

export interface ChangesRailProps {
  repo: string | null;
  /** A row clicked: its diff, in the Review pane. */
  onOpenDiff: (repo: string, path: string) => void;
  /** Something to say in the app's toast (a failed git step). */
  onNotice?: (message: string) => void;
}

function tone(code: FileCode): string {
  if (code === "A") return "var(--color-success)";
  if (code === "M" || code === "R" || code === "T" || code === "U" || code === "C") return "var(--color-warning-text, var(--color-warning))";
  return "var(--color-ink-muted)";
}

function ChangesRailBase({ repo, onOpenDiff, onNotice }: ChangesRailProps) {
  const { status, error, refresh } = useRepoStatus(repo);
  const api = useMemo(() => (repo ? gitApi(repo) : null), [repo]);
  const staged = status?.staged ?? [];
  const unstaged = useMemo(() => [...(status?.conflicted ?? []), ...(status?.unstaged ?? []).filter((f) => !(status?.conflicted ?? []).some((c) => c.path === f.path))], [status]);
  const statusKey = useMemo(() => JSON.stringify(status ? [status.head, status.staged, status.unstaged] : null), [status]);

  // Line stats per area, re-read whenever the status changes.
  const [stats, setStats] = useState<{ staged: Map<string, LineStats>; unstaged: Map<string, LineStats> }>({ staged: new Map(), unstaged: new Map() });
  useEffect(() => {
    if (!repo || !status) return;
    let live = true;
    const read = (source: "staged" | "unstagedPlusUntracked") =>
      invoke<DiffFile[]>("review_diff", { repo, source, base: null, sha: null }).then(diffStats, () => new Map<string, LineStats>());
    void Promise.all([read("staged"), read("unstagedPlusUntracked")]).then(([s, u]) => {
      if (live) setStats({ staged: s, unstaged: u });
    });
    return () => {
      live = false;
    };
    // statusKey stands for the status's content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, statusKey]);

  const totals = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const m of [stats.staged, stats.unstaged]) for (const s of m.values()) ((add += s.add), (del += s.del));
    return { add, del };
  }, [stats]);

  const [busy, setBusy] = useState(false);
  const run = async (label: string, op: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await op();
    } catch (e) {
      onNotice?.(`${label} failed: ${String(e)}`);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const [message, setMessage] = useState("");
  const [pushOpen, setPushOpen] = useState(false);
  const push = usePush(pushOpen ? repo : null, repo ? `rail:${repo}` : null);
  const [branches, setBranches] = useState<ReviewBranches | null>(null);
  useEffect(() => {
    if (!pushOpen || !repo) return;
    let alive = true;
    void invoke<ReviewBranches>("review_branches", { repo }).then(
      (b) => alive && setBranches(b),
      () => alive && setBranches(null),
    );
    return () => {
      alive = false;
    };
  }, [pushOpen, repo]);

  if (!repo) return <div className="rl-rail-empty">No project folder here yet: changes show for a session's project, or a folder picked in Files.</div>;
  if (error && !status) return <div className="rl-rail-empty">Not a git repository Redline knows: {repo}</div>;

  const files = staged.length + unstaged.length;
  const commit = () => {
    if (!api || !message.trim() || staged.length === 0) return;
    void run("Commit", async () => {
      await api.commit(message, false);
      setMessage("");
    });
  };
  const section = (title: string, area: "staged" | "unstaged", rows: GitFileEntry[], bulk: ReactNode) => (
    <section className="rl-ch-section" aria-label={title}>
      <header className="rl-ch-head">
        <span>
          {title} · {rows.length}
        </span>
        {rows.length > 0 && bulk}
      </header>
      {rows.map((f) => {
        const s = (area === "staged" ? stats.staged : stats.unstaged).get(f.path);
        return (
          <div key={`${area}:${f.path}`} className="rl-ch-row" role="button" tabIndex={0} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path} onClick={() => onOpenDiff(repo, f.path)} onKeyDown={(e) => e.key === "Enter" && onOpenDiff(repo, f.path)}>
            <input
              type="checkbox"
              checked={area === "staged"}
              disabled={busy}
              aria-label={area === "staged" ? `Unstage ${f.path}` : f.status === "U" ? `Mark ${f.path} resolved` : `Stage ${f.path}`}
              onClick={(e) => e.stopPropagation()}
              onChange={() => api && void run(area === "staged" ? "Unstage" : "Stage", () => (area === "staged" ? api.unstage([f.path]) : api.stage([f.path])))}
            />
            <span className="rl-ch-code" style={{ color: tone(f.status) }}>
              {f.status}
            </span>
            <span className="rl-ch-path">{f.path}</span>
            {s && (
              <>
                <span className="rl-ch-add">+{s.add}</span>
                <span className="rl-ch-del">−{s.del}</span>
              </>
            )}
          </div>
        );
      })}
    </section>
  );

  return (
    <>
      <div className="rl-rail-head">
        <GitBranch size={14} aria-hidden />
        <span className="truncate" style={{ color: "var(--color-ink)" }} title={status?.upstream ? `${status.branch} → ${status.upstream}` : undefined}>
          {status ? status.branch ?? "detached HEAD" : "…"}
        </span>
        {status && (status.ahead > 0 || status.behind > 0) && (
          <span title={`${status.ahead} ahead, ${status.behind} behind`}>
            ↑{status.ahead} ↓{status.behind}
          </span>
        )}
        <span className="rl-rail-spacer" />
        {files > 0 && (
          <>
            <span className="rl-ch-add">+{totals.add}</span>
            <span className="rl-ch-del">−{totals.del}</span>
            <span>{files} {files === 1 ? "file" : "files"}</span>
          </>
        )}
      </div>
      <div className="rl-rail-scroll rl-thin-scroll-y">
        {status && files === 0 && <div className="rl-rail-empty">Nothing to commit: the working tree is clean.</div>}
        {staged.length > 0 &&
          section("Staged", "staged", staged, (
            <button type="button" className="rl-ch-link" disabled={busy} onClick={() => api && void run("Unstage all", () => api.unstage(staged.map((f) => f.path)))}>
              Unstage all
            </button>
          ))}
        {unstaged.length > 0 &&
          section("Changes", "unstaged", unstaged, (
            <button type="button" className="rl-ch-link" disabled={busy} onClick={() => api && void run("Stage all", () => api.stage(unstaged.map((f) => f.path)))}>
              Stage all
            </button>
          ))}
      </div>
      <div className="rl-ch-commit">
        <textarea
          aria-label="Commit message"
          placeholder={staged.length > 0 ? "Commit message" : "Stage changes to commit, or Commit & Push… to take them all"}
          value={message}
          rows={2}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              commit();
            }
          }}
        />
        <div className="rl-ch-actions">
          <button type="button" className="rl-ch-btn" disabled={busy || !message.trim() || staged.length === 0} title="Commit what is staged (⌘↩)" onClick={commit}>
            Commit
          </button>
          <span className="rl-rail-spacer" />
          <button type="button" className="rl-ch-btn" data-primary="" disabled={busy || (files === 0 && !(status && status.ahead > 0))} title="Commit, push to a branch, and open a PR" onClick={() => setPushOpen(true)}>
            <GitPullRequest size={13} aria-hidden /> Commit &amp; Push…
          </button>
        </div>
      </div>
      <ReviewPushDialog
        open={pushOpen}
        onClose={() => setPushOpen(false)}
        repo={repo}
        reviewId={`rail:${repo}`}
        push={push}
        branches={branches}
        reviewedPaths={staged.length > 0 ? staged.map((f) => f.path) : []}
        onPushed={() => {
          setMessage("");
          refresh();
        }}
        canDraft={false}
        initialMessage={message}
      />
    </>
  );
}

export const ChangesRail = memo(ChangesRailBase);
export default ChangesRail;
