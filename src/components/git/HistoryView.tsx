// SPDX-License-Identifier: Apache-2.0
// History: a virtualized commit table (Graph | Description | Date | Author |
// Commit) paged 200 at a time, with the selected commit's detail, changed files
// and diff below.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePersistedState } from "../../theme/usePersistedState";
import { layoutGraph, type GraphRow } from "../../lib/git/graph";
import type { GitCommit, GitCommitDetail, GitDiffFile, GitRefDecoration } from "../../lib/git/types";
import { PAGE_SIZE, shortSha } from "./api";
import { ChangesPane } from "./ChangesPane";
import type { GitActions } from "./actions";
import type { GitRepository } from "./useGitRepository";
import type { useContextMenu } from "./ui";
import { commitMenu } from "./menus";

export const ROW_HEIGHT = 24;
const LANE_WIDTH = 12;
const MAX_LANES = 16;
const OVERSCAN = 12;

const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
export const formatDate = (seconds: number) => dateFormat.format(new Date(seconds * 1000));

export function HistoryView({
  git,
  actions,
  menu,
  reveal,
}: {
  git: GitRepository;
  actions: GitActions;
  menu: ReturnType<typeof useContextMenu>;
  /** A sha the sidebar asked to show; selected when it is loaded. */
  reveal: { sha: string; nonce: number } | null;
}) {
  const { api, status, refs } = git;
  const [all, setAll] = usePersistedState("redline.git.historyAll", true);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  const loading = useRef(false);
  const loaded = useRef(0);
  loaded.current = commits.length;

  // Reload when HEAD or any ref moves (not on every poll).
  const refsKey = useMemo(
    () =>
      JSON.stringify([
        status?.head ?? null,
        refs?.local.map((b) => [b.name, b.sha]),
        refs?.remote.map((b) => [b.name, b.sha]),
        refs?.tags.map((t) => [t.name, t.sha]),
      ]),
    [status?.head, refs],
  );
  useEffect(() => {
    let live = true;
    loading.current = true;
    const limit = Math.min(500, Math.max(PAGE_SIZE, loaded.current));
    api.log(0, limit, all).then(
      (page) => {
        if (!live) return;
        setCommits(page);
        setSettled(true);
        setExhausted(page.length < limit);
        setError(null);
        setSelected((current) => (current && page.some((c) => c.sha === current) ? current : page[0]?.sha ?? null));
      },
      (e) => live && setError(String(e)),
    ).finally(() => {
      if (live) loading.current = false;
    });
    return () => {
      live = false;
      loading.current = false;
    };
  }, [api, all, refsKey]);

  const loadMore = useCallback(() => {
    if (loading.current || exhausted) return;
    loading.current = true;
    const skip = loaded.current;
    api.log(skip, PAGE_SIZE, all).then(
      (page) => {
        setCommits((current) => (current.length === skip ? [...current, ...page] : current));
        if (page.length < PAGE_SIZE) setExhausted(true);
      },
      (e) => setError(String(e)),
    ).finally(() => {
      loading.current = false;
    });
  }, [api, all, exhausted]);

  useEffect(() => {
    if (reveal && commits.some((c) => c.sha === reveal.sha)) setSelected(reveal.sha);
  }, [reveal, commits]);

  const graph = useMemo(() => layoutGraph(commits), [commits]);
  const lanes = Math.min(Math.max(graph.width, 1), MAX_LANES);
  const graphWidth = lanes * LANE_WIDTH + 8;
  const headSha = status?.head ?? null;
  const selectedCommit = commits.find((c) => c.sha === selected) ?? null;

  return (
    <div className="rl-git-history">
      <div className="rl-git-history-top">
        <div className="rl-git-pane-head">
          <span className="rl-git-pane-title">History</span>
          <span className="rl-git-muted">{commits.length.toLocaleString()}{exhausted ? "" : "+"} commits</span>
          <span className="rl-git-spacer" />
          <label className="rl-git-toggle">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> All branches
          </label>
        </div>
        {error && <div className="rl-git-banner rl-git-banner-error">{error}</div>}
        {!error && commits.length === 0 && settled && <div className="rl-git-empty">No commits yet{status?.branch ? ` on ${status.branch}` : ""}.</div>}
        <CommitTable
          commits={commits}
          rows={graph.rows}
          graphWidth={graphWidth}
          lanes={lanes}
          headSha={headSha}
          selected={selected}
          onSelect={setSelected}
          onNearEnd={loadMore}
          onMenu={(event, commit) => {
            setSelected(commit.sha);
            menu.open(event, commitMenu(commit, actions, status));
          }}
        />
      </div>
      <CommitDetailPane git={git} commit={selectedCommit} onSelect={setSelected} />
    </div>
  );
}

const CommitTable = memo(function CommitTable({
  commits,
  rows,
  graphWidth,
  lanes,
  headSha,
  selected,
  onSelect,
  onNearEnd,
  onMenu,
}: {
  commits: GitCommit[];
  rows: GraphRow[];
  graphWidth: number;
  lanes: number;
  headSha: string | null;
  selected: string | null;
  onSelect: (sha: string) => void;
  onNearEnd: () => void;
  onMenu: (event: { clientX: number; clientY: number; preventDefault?: () => void }, commit: GitCommit) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setHeight(el.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const viewport = height || 600;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(commits.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN);
  useEffect(() => {
    if (commits.length > 0 && last >= commits.length - OVERSCAN) onNearEnd();
  }, [last, commits.length, onNearEnd]);

  const selectedIndex = selected ? commits.findIndex((c) => c.sha === selected) : -1;
  const reveal = (index: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const top = index * ROW_HEIGHT;
    const visible = el.clientHeight || viewport;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + visible) el.scrollTop = top + ROW_HEIGHT - visible;
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (commits.length === 0) return;
    const page = Math.max(1, Math.floor(viewport / ROW_HEIGHT) - 1);
    const at = selectedIndex;
    const target =
      event.key === "ArrowDown" ? at + 1 : event.key === "ArrowUp" ? at - 1 : event.key === "PageDown" ? at + page : event.key === "PageUp" ? at - page : event.key === "Home" ? 0 : event.key === "End" ? commits.length - 1 : null;
    if (target !== null) {
      event.preventDefault();
      const index = Math.max(0, Math.min(commits.length - 1, target));
      onSelect(commits[index].sha);
      reveal(index);
      return;
    }
    if ((event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) && at >= 0) {
      event.preventDefault();
      const rect = scrollRef.current!.getBoundingClientRect();
      onMenu({ clientX: rect.left + graphWidth + 40, clientY: rect.top + (at + 1) * ROW_HEIGHT - scrollRef.current!.scrollTop + 26 }, commits[at]);
    }
  };

  const columns = { gridTemplateColumns: `${graphWidth}px minmax(160px, 1fr) 150px 140px 70px` };
  return (
    <div className="rl-git-table">
      <div className="rl-git-table-head" style={columns} role="row">
        <span role="columnheader">Graph</span>
        <span role="columnheader">Description</span>
        <span role="columnheader">Date</span>
        <span role="columnheader">Author</span>
        <span role="columnheader">Commit</span>
      </div>
      <div
        ref={scrollRef}
        className="rl-git-table-body"
        role="grid"
        aria-label="Commits"
        aria-rowcount={commits.length}
        tabIndex={0}
        aria-activedescendant={selectedIndex >= 0 ? `rl-git-commit-${selectedIndex}` : undefined}
        onKeyDown={onKeyDown}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div style={{ height: commits.length * ROW_HEIGHT, position: "relative" }}>
          {commits.slice(first, last).map((commit, offset) => {
            const index = first + offset;
            return (
              <div
                key={commit.sha}
                id={`rl-git-commit-${index}`}
                role="row"
                aria-rowindex={index + 1}
                aria-selected={commit.sha === selected}
                className="rl-git-row"
                data-head={commit.sha === headSha ? "" : undefined}
                style={{ ...columns, top: index * ROW_HEIGHT }}
                onClick={() => {
                  onSelect(commit.sha);
                  scrollRef.current?.focus();
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onMenu(event, commit);
                }}
              >
                <span role="gridcell" className="rl-git-graph-cell">
                  {rows[index] && <GraphCell row={rows[index]} lanes={lanes} width={graphWidth} merge={commit.parents.length > 1} head={commit.sha === headSha} />}
                </span>
                <span role="gridcell" className="rl-git-desc">
                  <RefChips refs={commit.refs} />
                  <span className="rl-git-subject">{commit.subject}</span>
                </span>
                <span role="gridcell" className="rl-git-date">{formatDate(commit.date)}</span>
                <span role="gridcell" className="rl-git-author" title={commit.authorEmail}>{commit.authorName}</span>
                <span role="gridcell" className="rl-git-sha">{shortSha(commit.sha)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});

const laneX = (lane: number) => 8 + lane * LANE_WIDTH;

function GraphCell({ row, lanes, width, merge, head }: { row: GraphRow; lanes: number; width: number; merge: boolean; head: boolean }) {
  const h = ROW_HEIGHT;
  const mid = h / 2;
  const stroke = (color: number) => ({ stroke: `var(--rl-git-lane-${color})` });
  return (
    <svg width={width} height={h} viewBox={`0 0 ${width} ${h}`} aria-hidden className="rl-git-graph">
      {row.edges.map((edge, i) => {
        if (edge.from >= lanes || edge.to >= lanes) return null;
        const x1 = laneX(edge.from);
        const x2 = laneX(edge.to);
        const d =
          edge.kind === "pass"
            ? `M${x1} 0V${h}`
            : edge.kind === "top"
              ? x1 === x2 ? `M${x1} 0V${mid}` : `M${x1} 0C${x1} ${mid * 0.8} ${x2} ${mid * 0.4} ${x2} ${mid}`
              : x1 === x2 ? `M${x1} ${mid}V${h}` : `M${x1} ${mid}C${x1} ${mid + mid * 0.6} ${x2} ${mid + mid * 0.2} ${x2} ${h}`;
        return <path key={i} d={d} style={stroke(edge.color)} />;
      })}
      {row.lane < lanes && (
        <circle
          cx={laneX(row.lane)}
          cy={mid}
          r={head ? 4.5 : merge ? 3 : 3.5}
          className={head ? "rl-git-node-head" : merge ? "rl-git-node-merge" : "rl-git-node"}
          style={{ ["--lane" as string]: `var(--rl-git-lane-${row.color})` }}
        />
      )}
    </svg>
  );
}

/** Ref chips: the checked-out branch first and emphasized, then local branches,
 *  remotes and tags, each styled by kind. */
export function RefChips({ refs }: { refs: GitRefDecoration[] }) {
  if (refs.length === 0) return null;
  const head = refs.find((r) => r.kind === "head");
  const order = { head: 0, local: 1, remote: 2, tag: 3 } as const;
  const shown = refs
    .filter((r) => !(r.kind === "local" && head && r.name === head.name))
    .sort((a, b) => order[a.kind] - order[b.kind]);
  return (
    <span className="rl-git-chips">
      {shown.map((ref) => (
        <span key={`${ref.kind}:${ref.name}`} className="rl-git-chip" data-kind={ref.kind} title={ref.kind === "head" ? `HEAD → ${ref.name}` : ref.name}>
          {ref.kind === "tag" ? "◆ " : ref.kind === "head" ? "● " : ""}
          {ref.name}
        </span>
      ))}
    </span>
  );
}

export function CommitDetailPane({ git, commit, onSelect }: { git: GitRepository; commit: GitCommit | null; onSelect: (sha: string) => void }) {
  const { api } = git;
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [files, setFiles] = useState<GitDiffFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cache = useRef(new Map<string, [GitCommitDetail, GitDiffFile[]]>());
  useEffect(() => {
    cache.current.clear();
  }, [api]);
  const sha = commit?.sha ?? null;
  useEffect(() => {
    if (!sha) {
      setDetail(null);
      setFiles(null);
      return;
    }
    const hit = cache.current.get(sha);
    if (hit) {
      setDetail(hit[0]);
      setFiles(hit[1]);
      setError(null);
      return;
    }
    let live = true;
    setFiles(null);
    setError(null);
    // Debounce keyboard scrubbing through the table.
    const timer = window.setTimeout(() => {
      Promise.all([api.commitDetail(sha), api.commitFiles(sha)]).then(
        ([d, f]) => {
          cache.current.set(sha, [d, f]);
          if (cache.current.size > 64) cache.current.delete(cache.current.keys().next().value as string);
          if (!live) return;
          setDetail(d);
          setFiles(f);
        },
        (e) => live && setError(String(e)),
      );
    }, 60);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [api, sha]);

  if (!commit) return <div className="rl-git-detail rl-git-empty">Select a commit to see its changes.</div>;
  const d = detail && detail.sha === commit.sha ? detail : null;
  const header = (
    <div className="rl-git-commit-meta">
      <div className="rl-git-commit-subject">{commit.subject}</div>
      {d?.body && <pre className="rl-git-commit-body">{d.body.trim()}</pre>}
      <dl>
        <dt>Commit</dt>
        <dd className="rl-git-mono">
          {commit.sha}
          <button type="button" className="rl-git-link" onClick={() => void navigator.clipboard?.writeText(commit.sha)}>Copy</button>
        </dd>
        {commit.parents.length > 0 && (
          <>
            <dt>{commit.parents.length > 1 ? "Parents" : "Parent"}</dt>
            <dd className="rl-git-mono">
              {commit.parents.map((p) => (
                <button key={p} type="button" className="rl-git-link" onClick={() => onSelect(p)}>{shortSha(p)}</button>
              ))}
            </dd>
          </>
        )}
        <dt>Author</dt>
        <dd>{commit.authorName} <span className="rl-git-muted">&lt;{commit.authorEmail}&gt;</span></dd>
        <dt>Date</dt>
        <dd>{formatDate(commit.date)}</dd>
        {d && (d.committerName !== commit.authorName || Math.abs(d.committerDate - commit.date) > 60) && (
          <>
            <dt>Committer</dt>
            <dd>{d.committerName} <span className="rl-git-muted">{formatDate(d.committerDate)}</span></dd>
          </>
        )}
      </dl>
      {commit.refs.length > 0 && <RefChips refs={commit.refs} />}
    </div>
  );
  return (
    <div className="rl-git-detail">
      <ChangesPane files={files} header={header} error={error} label="Changed files" />
    </div>
  );
}
