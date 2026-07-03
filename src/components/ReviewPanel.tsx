// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import type {
  DiffFile,
  DiffSource,
  ReviewAnnotation,
  ReviewBranches,
  ReviewFileContents,
} from "../types";
import { nextAnnotationId } from "../lib/reviewSelection";
import { ReviewAnnotationComposer } from "./ReviewAnnotationCard";
import type { ProjectOption } from "./ProjectPicker";
import type { UseReview } from "../hooks/useReview";
import { diffStats, displayPath, type DiffViewMode } from "../lib/flattenDiff";
import {
  augmentFile,
  contentConsistent,
  deltasReconcile,
  EXPAND_STEP,
  type ExpandSlot,
} from "../lib/expandContext";
import { groupMatches, searchDiff } from "../lib/searchDiff";
import { usePersistedState } from "../theme/usePersistedState";
import { useAiReview, type UseAiReview } from "../hooks/useAiReview";
import DiffView, { type DiffSearch, type DiffViewHandle } from "./DiffView";
import ReviewFileTree from "./ReviewFileTree";
import ReviewShortcutHelp from "./ReviewShortcutHelp";
import { PlanSearchBox } from "./PlanSearchBox";

// Code Review pane: pick a repo + diff source, read the annotatable diff.
// Read-only browsing shell in P2 — annotation entry (P3) and the blocking
// `/redline-review` loop (P4) mount into this same panel.

const SOURCE_LABEL: Record<DiffSource, string> = {
  uncommitted: "Uncommitted changes",
  staged: "Staged only",
  unstagedPlusUntracked: "Unstaged + untracked",
  lastCommit: "Last commit",
  vsBase: "Vs base branch…",
  commitSha: "A specific commit…",
};

interface ReviewPanelProps {
  review: UseReview;
  projectOptions: ProjectOption[];
  onClose: () => void;
}

export default function ReviewPanel({ review, projectOptions, onClose }: ReviewPanelProps) {
  const {
    activeReviewId,
    review: session,
    repo,
    source,
    base,
    sha,
    diff,
    commits,
    annotations,
    viewed,
    loading,
    error,
    setSource,
    setBase,
    setSha,
    openReview,
    refreshDiff,
    toggleViewed,
    addAnnotation,
    updateAnnotation,
    deleteAnnotation,
    holdActive,
    submitReview,
    dismissReview,
    questions,
    addQuestion,
    deleteQuestion,
  } = review;

  const ai = useAiReview(review.activeReviewId);
  const aiDraftCount = useMemo(
    () => annotations.filter((a) => a.source === "ai" && a.status === "draft").length,
    [annotations],
  );

  const liveCount = annotations.filter(
    (a) => a.status === "draft" || a.status === "carried",
  ).length;

  const orphans = annotations.filter((a) => a.status === "orphaned");
  const [showOrphans, setShowOrphans] = useState(false);
  const [hideViewed, setHideViewed] = usePersistedState(
    "redline.review.hideViewed",
    false,
  );
  // Configurable one-liner sent on Approve (stored like the other inject
  // prompts; empty = the backend default).
  const [approvePrompt] = usePersistedState("redline.review.approvePrompt", "");
  const [viewMode, setViewMode] = usePersistedState<DiffViewMode>(
    "redline.review.viewMode",
    "unified",
  );

  const { stale } = review;
  // Scroll resets when the diff *coordinates* change (see DiffView.diffKey) —
  // not when hide-viewed or an expansion recreates the files array.
  const diffKey = `${repo ?? ""}|${source}|${base ?? ""}|${sha ?? ""}|${session?.round ?? 1}`;

  const diffRef = useRef<DiffViewHandle | null>(null);
  const [showTree, setShowTree] = usePersistedState("redline.review.showTree", true);
  const [helpOpen, setHelpOpen] = useState(false);

  const shownFiles = useMemo(() => {
    if (!diff) return null;
    return hideViewed ? diff.filter((f) => !viewed.has(displayPath(f))) : diff;
  }, [diff, hideViewed, viewed]);

  // --- context expansion (per-file augmented copies + fetched contents) -----
  const contentsRef = useRef(new Map<string, ReviewFileContents>());
  const [augmented, setAugmented] = useState<Map<string, DiffFile>>(new Map());
  const [expandBlocked, setExpandBlocked] = useState(false);
  useEffect(() => {
    contentsRef.current.clear();
    setAugmented(new Map());
    setExpandBlocked(false);
  }, [diff]);

  const effectiveFiles = useMemo(
    () =>
      shownFiles
        ? shownFiles.map((f) => augmented.get(displayPath(f)) ?? f)
        : null,
    [shownFiles, augmented],
  );

  const handleExpand = useCallback(
    async (filePath: string, slot: ExpandSlot, all: boolean) => {
      if (!repo || !diff) return;
      const current =
        augmented.get(filePath) ?? diff.find((f) => displayPath(f) === filePath);
      if (!current) return;
      let contents = contentsRef.current.get(filePath);
      if (!contents) {
        try {
          contents = await invoke<ReviewFileContents>("review_file_contents", {
            repo,
            source,
            base,
            sha,
            filePath,
            oldPath: current.status === "renamed" ? current.oldPath : null,
          });
        } catch {
          return;
        }
        contentsRef.current.set(filePath, contents);
      }
      const { oldLines, newLines } = contents;
      // Consistency guards: NEVER augment with drifted content — stale line
      // math would corrupt every anchor. The banner takes over instead.
      if (
        !deltasReconcile(current, oldLines, newLines) ||
        (oldLines && !contentConsistent(current, "old", oldLines)) ||
        (newLines && !contentConsistent(current, "new", newLines))
      ) {
        setExpandBlocked(true);
        return;
      }
      const next = augmentFile(
        current,
        oldLines,
        newLines,
        slot.hunkIndex,
        slot.edge,
        all ? Number.POSITIVE_INFINITY : EXPAND_STEP,
      );
      setAugmented((m) => new Map(m).set(filePath, next));
    },
    [repo, diff, augmented, source, base, sha],
  );

  // --- in-diff search --------------------------------------------------------
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const searchResult = useMemo(
    () => (searchOpen && effectiveFiles ? searchDiff(effectiveFiles, query) : null),
    [searchOpen, effectiveFiles, query],
  );
  useEffect(() => setActiveIdx(0), [query, searchOpen]);
  const search: DiffSearch | null = useMemo(() => {
    if (!searchResult || searchResult.matches.length === 0) return null;
    return {
      grouped: groupMatches(searchResult.matches),
      list: searchResult.matches,
      activeIndex: Math.min(activeIdx, searchResult.matches.length - 1),
    };
  }, [searchResult, activeIdx]);
  const matchCount = searchResult?.matches.length ?? 0;
  const stepMatch = useCallback(
    (dir: 1 | -1) => {
      if (matchCount === 0) return;
      setActiveIdx((i) => (i + dir + matchCount) % matchCount);
    },
    [matchCount],
  );

  // --- branch picker ---------------------------------------------------------
  const [branches, setBranches] = useState<ReviewBranches | null>(null);
  const [customBase, setCustomBase] = useState(false);
  useEffect(() => {
    if (!repo) {
      setBranches(null);
      return;
    }
    let alive = true;
    void invoke<ReviewBranches>("review_branches", { repo })
      .then((b) => {
        if (alive) setBranches(b);
      })
      .catch(() => {
        if (alive) setBranches(null);
      });
    return () => {
      alive = false;
    };
  }, [repo]);

  // Live (non-orphaned) annotation counts per file for the tree badges.
  const annotationCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of annotations) {
      if (a.status === "orphaned") continue;
      m.set(a.filePath, (m.get(a.filePath) ?? 0) + 1);
    }
    return m;
  }, [annotations]);

  // --- review-wide (general) notes -------------------------------------------
  const generalNotes = useMemo(
    () => annotations.filter((a) => a.scope === "general" && a.status !== "orphaned"),
    [annotations],
  );
  const [generalEditing, setGeneralEditing] = useState<string | null>(null);
  const addGeneralNote = useCallback(() => {
    if (!activeReviewId) return;
    const annotation: ReviewAnnotation = {
      id: nextAnnotationId(annotations),
      reviewId: activeReviewId,
      round: session?.round ?? 1,
      filePath: "",
      side: "new",
      startLine: 0,
      endLine: 0,
      kind: "comment",
      body: "",
      quotedText: "",
      status: "draft",
      createdAt: Date.now(),
      scope: "general",
      source: "user",
    };
    void addAnnotation(annotation);
    setGeneralEditing(annotation.id);
  }, [activeReviewId, annotations, session, addAnnotation]);

  // Paths hidden by the hide-viewed filter (the tree dims them).
  const hiddenPaths = useMemo(
    () => (hideViewed ? new Set([...viewed]) : new Set<string>()),
    [hideViewed, viewed],
  );

  // Panel-level keys: ⌘F search, ⌘B tree, ⌘↩ submit, ? help.
  const handlePanelKeys = useCallback(
    (e: React.KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.tagName === "TEXTAREA" || target.tagName === "INPUT";
      if (e.metaKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (e.metaKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setShowTree((v: boolean) => !v);
        return;
      }
      if (e.metaKey && e.key === "Enter" && !typing) {
        if (holdActive && liveCount > 0) {
          e.preventDefault();
          void submitReview(false);
        }
        return;
      }
      if (e.key === "?" && !typing && !helpOpen) {
        e.preventDefault();
        setHelpOpen(true);
      }
    },
    [holdActive, liveCount, submitReview, setShowTree, helpOpen],
  );

  // First open with exactly one known project → pick it, no empty state.
  useEffect(() => {
    if (!repo && projectOptions.length === 1) {
      void openReview(projectOptions[0].path);
    }
  }, [repo, projectOptions, openReview]);

  const stats = diff ? diffStats(diff) : null;

  return (
    <section
      className="h-full flex flex-col"
      style={{ background: "var(--color-paper)" }}
      aria-label="Code review"
      onKeyDown={handlePanelKeys}
    >
      <div
        className="flex items-center gap-2 px-3 py-2 shrink-0 flex-wrap"
        style={{ borderBottom: "1px solid var(--color-rule)" }}
      >
        <span style={{ fontSize: "13px", fontWeight: 600 }}>Code Review</span>

        <select
          value={repo ?? ""}
          onChange={(e) => {
            if (e.target.value) void openReview(e.target.value);
          }}
          className="rl-review-select"
          aria-label="Repository"
        >
          <option value="" disabled>
            Choose a project…
          </option>
          {projectOptions.map((p) => (
            <option key={p.path} value={p.path}>
              {p.name}
            </option>
          ))}
        </select>

        <select
          value={source}
          onChange={(e) => setSource(e.target.value as DiffSource)}
          className="rl-review-select"
          aria-label="Diff source"
        >
          {(Object.keys(SOURCE_LABEL) as DiffSource[]).map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABEL[s]}
            </option>
          ))}
        </select>

        {source === "vsBase" &&
          (branches && !customBase ? (
            <select
              value={base ?? ""}
              onChange={(e) => {
                if (e.target.value === " custom") {
                  setCustomBase(true);
                  return;
                }
                setBase(e.target.value || null);
              }}
              className="rl-review-select"
              aria-label="Base branch"
              style={{ maxWidth: 200 }}
            >
              <option value="" disabled>
                Pick a base branch…
              </option>
              {branches.local.length > 0 && (
                <optgroup label="Local">
                  {branches.local.map((b) => (
                    <option key={`l:${b}`} value={b}>
                      {b}
                      {branches.head === b ? " (current)" : ""}
                    </option>
                  ))}
                </optgroup>
              )}
              {branches.remote.length > 0 && (
                <optgroup label="Remote">
                  {branches.remote.map((b) => (
                    <option key={`r:${b}`} value={b}>
                      {b}
                    </option>
                  ))}
                </optgroup>
              )}
              <option value=" custom">Custom ref…</option>
            </select>
          ) : (
            <input
              value={base ?? ""}
              onChange={(e) => setBase(e.target.value || null)}
              placeholder="base ref (e.g. main)"
              className="rl-review-select"
              style={{ width: 140 }}
              aria-label="Base ref"
              spellCheck={false}
              autoFocus={customBase}
              onBlur={() => {
                // An emptied custom field falls back to the picker.
                if (customBase && !base) setCustomBase(false);
              }}
            />
          ))}

        {source === "commitSha" && (
          <select
            value={sha ?? ""}
            onChange={(e) => setSha(e.target.value || null)}
            className="rl-review-select"
            aria-label="Commit"
            style={{ maxWidth: 260 }}
          >
            <option value="" disabled>
              Pick a commit…
            </option>
            {commits.map((c) => (
              <option key={c.sha} value={c.sha}>
                {c.shortSha} {c.subject}
              </option>
            ))}
          </select>
        )}

        <div className="rl-review-seg" role="group" aria-label="Diff layout">
          <button
            type="button"
            data-active={viewMode === "unified" ? "" : undefined}
            onClick={() => setViewMode("unified")}
          >
            Unified
          </button>
          <button
            type="button"
            data-active={viewMode === "split" ? "" : undefined}
            onClick={() => setViewMode("split")}
          >
            Split
          </button>
        </div>

        {stats && (
          <span style={{ fontSize: "11.5px", color: "var(--color-ink-muted)" }}>
            {stats.files} {stats.files === 1 ? "file" : "files"}{" "}
            <span style={{ color: "var(--color-success)" }}>+{stats.additions}</span>{" "}
            <span style={{ color: "var(--color-warning)" }}>−{stats.deletions}</span>
          </span>
        )}

        {activeReviewId && (
          <button
            type="button"
            className="rl-review-btn"
            style={{ fontSize: "11.5px" }}
            title="Comment on the whole change"
            onClick={addGeneralNote}
          >
            ＋ General note
          </button>
        )}

        {activeReviewId && (
          <button
            type="button"
            className="rl-review-btn"
            style={{ fontSize: "11.5px" }}
            disabled={ai.running}
            title="Run a read-only AI pre-review over this diff — findings land as draft annotations you curate"
            onClick={() => void ai.start()}
          >
            ✦ {ai.running ? "Reviewing…" : "AI review"}
          </button>
        )}
        {aiDraftCount > 0 && activeReviewId && (
          <button
            type="button"
            className="rl-review-btn"
            style={{ fontSize: "11.5px" }}
            title="Remove all AI draft findings"
            onClick={() => {
              void invoke("review_annotation_clear_source", {
                reviewId: activeReviewId,
                source: "ai",
              }).catch(() => {});
            }}
          >
            Clear AI ({aiDraftCount})
          </button>
        )}

        {viewed.size > 0 && (
          <label
            className="flex items-center gap-1"
            style={{ fontSize: "11px", color: "var(--color-ink-muted)", cursor: "pointer" }}
          >
            <input
              type="checkbox"
              checked={hideViewed}
              onChange={(e) => setHideViewed(e.target.checked)}
              style={{ accentColor: "var(--color-anchor-text)" }}
            />
            Hide viewed
          </label>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            className="rl-review-btn rl-review-btn-iconic"
            data-active={showTree ? "" : undefined}
            title="Toggle the changed-files tree (⌘B)"
            aria-label="Toggle file tree"
            onClick={() => setShowTree((v: boolean) => !v)}
          >
            ☰
          </button>
          <button
            type="button"
            className="rl-review-btn rl-review-btn-iconic"
            title="Find in diff (⌘F)"
            aria-label="Find in diff"
            onClick={() => setSearchOpen(true)}
          >
            ⌕
          </button>
          <button
            type="button"
            className="rl-review-btn rl-review-btn-iconic"
            title="Keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
            onClick={() => setHelpOpen(true)}
          >
            ?
          </button>
          {holdActive && (
            <span className="rl-review-holdbar">
              <span className="rl-review-hold-dot" title="The agent is waiting on this review" />
              <button
                type="button"
                className="rl-review-btn rl-review-btn-primary"
                disabled={liveCount === 0}
                title={
                  liveCount === 0
                    ? "Annotate the diff first — or Approve"
                    : "Send the annotations to the waiting agent"
                }
                onClick={() => void submitReview(false)}
              >
                Submit {liveCount > 0 ? `(${liveCount})` : ""}
              </button>
              <button
                type="button"
                className="rl-review-btn"
                title="Approve — no changes requested"
                onClick={() => void submitReview(true, approvePrompt || null)}
              >
                Approve
              </button>
              <button
                type="button"
                className="rl-review-btn"
                title="Unblock the agent without feedback"
                onClick={() => void dismissReview()}
              >
                Dismiss
              </button>
            </span>
          )}
          {!holdActive && (
            <button
              type="button"
              className="rl-review-btn rl-review-btn-iconic"
              title="Copy the /redline-review command for a terminal Claude session"
              aria-label="Copy the review command"
              onClick={() => {
                void navigator.clipboard.writeText(
                  'curl -s "http://127.0.0.1:7676/v1/reviews/start?repo=$PWD&source=uncommitted"',
                );
              }}
            >
              ⧉
            </button>
          )}
          <button
            type="button"
            onClick={() => void refreshDiff()}
            title="Refresh diff"
            aria-label="Refresh diff"
            className="rl-review-btn rl-review-btn-iconic"
          >
            ↻
          </button>
          <button
            type="button"
            onClick={onClose}
            title="Close code review"
            aria-label="Close code review"
            className="rl-review-btn rl-review-btn-iconic"
          >
            ✕
          </button>
        </div>
      </div>

      {!repo ? (
        <Empty>Choose a project to review its changes.</Empty>
      ) : error ? (
        <Empty>{error}</Empty>
      ) : source === "vsBase" && !base ? (
        <Empty>Enter the base ref to diff against (merge-base semantics, like a PR).</Empty>
      ) : source === "commitSha" && !sha ? (
        <Empty>Pick the commit to review.</Empty>
      ) : diff && diff.length === 0 ? (
        <Empty>No changes — this diff is empty.</Empty>
      ) : diff && effectiveFiles ? (
        <div className="flex-1 flex" style={{ minHeight: 0 }}>
          {showTree && diff.length > 0 && (
            <ReviewFileTree
              files={diff}
              viewed={viewed}
              annotationCounts={annotationCounts}
              searchCounts={searchResult?.perFile ?? null}
              hiddenPaths={hiddenPaths}
              onJump={(p) => diffRef.current?.scrollToFile(p)}
              onToggleViewed={(p) => void toggleViewed(p)}
            />
          )}
          <div className="flex-1 flex flex-col" style={{ minWidth: 0 }}>
            {searchOpen && (
              <div className="rl-review-search shrink-0">
                <PlanSearchBox
                  query={query}
                  onQueryChange={setQuery}
                  matchCount={matchCount}
                  activeIndex={matchCount > 0 ? Math.min(activeIdx, matchCount - 1) : -1}
                  onNext={() => stepMatch(1)}
                  onPrev={() => stepMatch(-1)}
                  onClose={() => {
                    setSearchOpen(false);
                    setQuery("");
                  }}
                  placeholder="Find in diff…"
                />
              </div>
            )}
            {!activeReviewId && (
              <div className="rl-review-readonly shrink-0">
                Read-only view — annotations need a review session. Re-pick the
                project above to start one.
              </div>
            )}
            {generalNotes.length > 0 && (
              <div className="rl-review-general shrink-0">
                {generalNotes.map((a) =>
                  generalEditing === a.id ? (
                    <ReviewAnnotationComposer
                      key={a.id}
                      annotation={a}
                      onChange={(x) => void updateAnnotation(x)}
                      onDone={() => setGeneralEditing(null)}
                      onDiscard={() => {
                        void deleteAnnotation(a.id);
                        setGeneralEditing(null);
                      }}
                    />
                  ) : (
                    <div key={a.id} className="rl-review-general-entry">
                      <span className="rl-review-general-tag">review-wide</span>
                      <span className="truncate" style={{ flex: 1, minWidth: 0 }}>
                        {a.body || <em style={{ color: "var(--color-ink-muted)" }}>(empty)</em>}
                      </span>
                      {a.label && (
                        <span className="rl-review-label-chip" data-active="">
                          {a.label}
                          {a.blocking ? ` · ${a.blocking}` : ""}
                        </span>
                      )}
                      <button
                        type="button"
                        className="rl-review-btn"
                        onClick={() => setGeneralEditing(a.id)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="rl-review-btn"
                        onClick={() => void deleteAnnotation(a.id)}
                      >
                        Delete
                      </button>
                    </div>
                  ),
                )}
              </div>
            )}
            {(stale || expandBlocked) && (
              <div className="rl-review-stale shrink-0">
                The code changed underneath this diff.
                <button
                  type="button"
                  className="rl-review-btn"
                  style={{ marginLeft: 8 }}
                  onClick={() => void refreshDiff()}
                >
                  Refresh
                </button>
              </div>
            )}
            {orphans.length > 0 && (
              <div className="rl-review-orphans shrink-0">
                <button
                  type="button"
                  className="rl-review-btn"
                  onClick={() => setShowOrphans((v) => !v)}
                  aria-expanded={showOrphans}
                >
                  {showOrphans ? "▾" : "▸"} {orphans.length}{" "}
                  {orphans.length === 1 ? "annotation" : "annotations"} no longer match — the
                  agent changed those lines
                </button>
                {showOrphans && (
                  <ul>
                    {orphans.map((a) => (
                      <li key={a.id}>
                        <span style={{ color: "var(--color-ink-muted)" }}>
                          {a.filePath} · {a.kind}
                        </span>{" "}
                        {a.body || <em>(no note)</em>}
                        <button
                          type="button"
                          className="rl-review-btn"
                          style={{ marginLeft: 8 }}
                          onClick={() => void deleteAnnotation(a.id)}
                        >
                          Dismiss
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <DiffView
              ref={diffRef}
              files={effectiveFiles}
              diffKey={diffKey}
              mode={viewMode}
              viewed={viewed}
              onToggleViewed={(p) => void toggleViewed(p)}
              reviewId={activeReviewId}
              round={session?.round ?? 1}
              annotations={annotations}
              onAddAnnotation={(a) => void addAnnotation(a)}
              onUpdateAnnotation={(a) => void updateAnnotation(a)}
              onDeleteAnnotation={(id) => void deleteAnnotation(id)}
              onExpandContext={handleExpand}
              search={search}
              questions={questions}
              onAddQuestion={(q) => void addQuestion(q)}
              onDeleteQuestion={(id) => void deleteQuestion(id)}
            />
            <AiDrawer ai={ai} />
          </div>
        </div>
      ) : (
        <Empty>{loading ? "Resolving diff…" : ""}</Empty>
      )}
      {helpOpen && <ReviewShortcutHelp onClose={() => setHelpOpen(false)} />}
    </section>
  );
}

/** Live AI pre-review drawer: streaming log while it runs, then a summary
 *  (or error) line. Autoscrolls unless the reviewer scrolled up. */
function AiDrawer({ ai }: { ai: UseAiReview }) {
  const logRef = useRef<HTMLPreElement | null>(null);
  const stickRef = useRef(true);
  useEffect(() => {
    const el = logRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [ai.log]);
  if (!ai.running && !ai.summary && !ai.error) return null;
  return (
    <div className="rl-review-ai shrink-0">
      <div className="rl-review-ai-head">
        <span>
          ✦{" "}
          {ai.running
            ? "AI pre-review running…"
            : ai.error
              ? "AI pre-review failed"
              : "AI pre-review done"}
        </span>
        {ai.summary && (
          <span style={{ color: "var(--color-ink-muted)" }}>
            {ai.summary.added} finding{ai.summary.added === 1 ? "" : "s"} added
            {" · "}
            {ai.summary.important} important · {ai.summary.nits} nit
            {ai.summary.nits === 1 ? "" : "s"} · {ai.summary.preExisting} pre-existing
          </span>
        )}
        {ai.error && <span className="rl-review-ai-error">{ai.error}</span>}
        <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6 }}>
          {ai.running ? (
            <button type="button" className="rl-review-btn" onClick={ai.cancel}>
              Cancel
            </button>
          ) : (
            <button type="button" className="rl-review-btn" onClick={ai.dismiss}>
              Dismiss
            </button>
          )}
        </span>
      </div>
      {(ai.running || ai.error) && ai.log && (
        <pre
          ref={logRef}
          className="rl-review-ai-log"
          onScroll={(e) => {
            const el = e.currentTarget;
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {ai.log}
        </pre>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex-1 flex items-center justify-center px-6 italic"
      style={{ fontSize: "13px", color: "var(--color-ink-muted)" }}
    >
      {children}
    </div>
  );
}
