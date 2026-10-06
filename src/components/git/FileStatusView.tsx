// SPDX-License-Identifier: Apache-2.0
// File status: staged and unstaged lists with checkboxes, the selected file's
// hunks (stage / unstage / discard by hunk or by line), and the commit box.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePersistedState } from "../../theme/usePersistedState";
import { buildPatch } from "../../lib/git/patch";
import type { GitArea, GitDiffFile, GitFileEntry } from "../../lib/git/types";
import { HunkDiff, type HunkAction } from "./HunkDiff";
import { FileRow, fileName } from "./FileRow";
import type { GitRepository } from "./useGitRepository";
import type { MenuItem, useContextMenu, useDialogs } from "./ui";
import { pushTarget } from "./pushTarget";

interface Selected {
  path: string;
  area: GitArea;
}

export function FileStatusView({
  git,
  dialogs,
  menu,
  focusCommitToken,
}: {
  git: GitRepository;
  dialogs: ReturnType<typeof useDialogs>;
  menu: ReturnType<typeof useContextMenu>;
  focusCommitToken: number;
}) {
  const { api, status, refs, run, busy } = git;
  const staged = status?.staged ?? [];
  const unstaged = useMemo(() => {
    const conflicted = status?.conflicted ?? [];
    const seen = new Set(conflicted.map((f) => f.path));
    return [...conflicted, ...(status?.unstaged ?? []).filter((f) => !seen.has(f.path))];
  }, [status]);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [diff, setDiff] = useState<{ file: GitDiffFile | null; rev: number; error?: string } | null>(null);
  const [wordDiffOn, setWordDiffOn] = usePersistedState("redline.git.wordDiff", false);

  // Keep the selection valid as files move between lists; default to the first file.
  useEffect(() => {
    if (!status) return;
    const list = (area: GitArea) => (area === "staged" ? staged : unstaged);
    if (selected && list(selected.area).some((f) => f.path === selected.path)) return;
    if (selected) {
      const other: GitArea = selected.area === "staged" ? "unstaged" : "staged";
      if (list(other).some((f) => f.path === selected.path)) return setSelected({ path: selected.path, area: other });
    }
    const first = unstaged[0] ? { path: unstaged[0].path, area: "unstaged" as const } : staged[0] ? { path: staged[0].path, area: "staged" as const } : null;
    setSelected(first);
  }, [status, staged, unstaged, selected]);

  // Re-read the selected file's diff on selection, every status refresh and
  // every op; replace it only when the content changed so polls never flicker.
  const lastJson = useRef("");
  useEffect(() => {
    if (!selected) {
      setDiff(null);
      lastJson.current = "";
      return;
    }
    let live = true;
    api.fileDiff(selected.path, selected.area).then(
      (file) => {
        if (!live) return;
        const json = JSON.stringify([selected, file]);
        if (json === lastJson.current) return;
        lastJson.current = json;
        setDiff((current) => ({ file, rev: (current?.rev ?? 0) + 1 }));
      },
      (error) => {
        if (!live) return;
        lastJson.current = "";
        setDiff((current) => ({ file: null, rev: (current?.rev ?? 0) + 1, error: String(error) }));
      },
    );
    return () => {
      live = false;
    };
  }, [api, selected, status, git.version]);

  const toggle = useCallback(
    (entry: GitFileEntry, area: GitArea) => {
      const paths = [entry.path];
      // Moving the selected file: select its neighbour so Space walks the list.
      if (selected?.path === entry.path && selected.area === area) {
        const list = area === "staged" ? staged : unstaged;
        const index = list.findIndex((f) => f.path === entry.path);
        const next = list[index + 1] ?? list[index - 1];
        if (next) setSelected({ path: next.path, area });
      }
      if (area === "staged") void run(`Unstage ${entry.path}`, () => api.unstage(paths));
      else void run(entry.status === "U" ? `Mark ${entry.path} resolved` : `Stage ${entry.path}`, () => api.stage(paths));
    },
    [api, run, selected, staged, unstaged],
  );

  const discard = useCallback(
    async (entries: GitFileEntry[]) => {
      if (entries.length === 0) return;
      const untracked = entries.filter((e) => e.status === "?").length;
      const ok = await dialogs.confirm({
        title: entries.length === 1 ? `Discard changes to ${fileName(entries[0].path)}?` : `Discard changes to ${entries.length} files?`,
        body: (
          <>
            <p>
              Working-tree changes are thrown away{untracked ? "; untracked files are deleted" : ""}. A recovery copy is kept in{" "}
              <code>.git/redline-undo/</code>.
            </p>
            {entries.length > 1 && <ul className="rl-git-dialog-list">{entries.slice(0, 8).map((e) => <li key={e.path}>{e.path}</li>)}</ul>}
          </>
        ),
        confirmLabel: "Discard",
        danger: true,
      });
      if (ok) void run(entries.length === 1 ? `Discard ${entries[0].path}` : `Discard ${entries.length} files`, () => api.discard(entries.map((e) => e.path)));
    },
    [api, dialogs, run],
  );

  const applyHunk = useCallback(
    async (action: HunkAction, keys: Set<string>) => {
      const file = diff?.file;
      if (!file) return;
      const patch = buildPatch(file, keys, action === "stage" ? "stage" : "reverse");
      if (!patch) return;
      const path = file.newPath !== "/dev/null" ? file.newPath : file.oldPath;
      if (action === "discard") {
        const ok = await dialogs.confirm({
          title: "Discard the selected changes?",
          body: <p>The selected lines in <code>{path}</code> are reverted in the working tree. A recovery copy is kept in <code>.git/redline-undo/</code>.</p>,
          confirmLabel: "Discard",
          danger: true,
        });
        if (!ok) return;
      }
      const label = `${action === "stage" ? "Stage" : action === "unstage" ? "Unstage" : "Discard"} lines in ${path}`;
      void run(label, () => api.applyPatch(patch, action === "discard" ? "worktree" : "index", action !== "stage"));
    },
    [api, diff, dialogs, run],
  );

  const fileMenu = (entry: GitFileEntry, area: GitArea): MenuItem[] => [
    area === "unstaged"
      ? { label: entry.status === "U" ? "Mark resolved" : "Stage", onSelect: () => toggle(entry, area) }
      : { label: "Unstage", onSelect: () => toggle(entry, area) },
    ...(area === "unstaged" ? [{ label: "Discard changes…", danger: true, onSelect: () => void discard([entry]) }] : []),
    { separator: true },
    { label: "Copy path", onSelect: () => void navigator.clipboard?.writeText(entry.path) },
  ];

  const selectedEntry = selected ? (selected.area === "staged" ? staged : unstaged).find((f) => f.path === selected.path) : undefined;
  // A conflicted path diffs against HEAD with its markers as added lines; it
  // gets Mark resolved and Discard, never hunk or line actions.
  const conflicted = selected?.area === "unstaged" && selectedEntry?.status === "U";

  return (
    <div className="rl-git-status">
      <div className="rl-git-lists">
        <FileList
          title="Staged files"
          area="staged"
          entries={staged}
          selected={selected}
          busy={!!busy}
          bulkLabel="Unstage all"
          onBulk={() => void run("Unstage all", () => api.unstage(staged.map((f) => f.path)))}
          onSelect={setSelected}
          onToggle={toggle}
          onDiscard={() => {}}
          onMenu={(event, entry) => menu.open(event, fileMenu(entry, "staged"))}
        />
        <FileList
          title="Unstaged files"
          area="unstaged"
          entries={unstaged}
          selected={selected}
          busy={!!busy}
          bulkLabel="Stage all"
          onBulk={() => void run("Stage all", () => api.stage(unstaged.map((f) => f.path)))}
          onSelect={setSelected}
          onToggle={toggle}
          onDiscard={(entry) => void discard([entry])}
          onMenu={(event, entry) => menu.open(event, fileMenu(entry, "unstaged"))}
        />
      </div>
      <div className="rl-git-diffpane">
        {selected && selectedEntry ? (
          <>
            <div className="rl-git-pane-head">
              <span className="rl-git-pane-path" title={selected.path}>
                {selectedEntry.oldPath && <span className="rl-git-muted">{selectedEntry.oldPath} → </span>}
                {selected.path}
              </span>
              <label className="rl-git-toggle">
                <input type="checkbox" checked={wordDiffOn} onChange={(e) => setWordDiffOn(e.target.checked)} /> Word diff
              </label>
              {selected.area === "unstaged" ? (
                <>
                  <button type="button" className="rl-git-btn rl-git-btn-sm" disabled={!!busy} onClick={() => void discard([selectedEntry])}>Discard file</button>
                  <button type="button" className="rl-git-btn rl-git-btn-sm" disabled={!!busy} onClick={() => toggle(selectedEntry, "unstaged")}>
                    {conflicted ? "Mark resolved" : "Stage file"}
                  </button>
                </>
              ) : (
                <button type="button" className="rl-git-btn rl-git-btn-sm" disabled={!!busy} onClick={() => toggle(selectedEntry, "staged")}>Unstage file</button>
              )}
            </div>
            <div className="rl-git-diff-scroll">
              {conflicted && <div className="rl-git-banner rl-git-banner-warn">Conflicted — edit the file to resolve the markers, then Mark resolved.</div>}
              {diff?.error ? (
                <div className="rl-git-diff-note rl-git-error">{diff.error}</div>
              ) : diff?.file ? (
                <HunkDiff
                  key={`${selected.area}:${selected.path}:${diff.rev}`}
                  file={diff.file}
                  wordDiffOn={wordDiffOn}
                  actions={conflicted ? undefined : { area: selected.area, busy: !!busy, onApply: (action, keys) => void applyHunk(action, keys) }}
                />
              ) : diff ? (
                <div className="rl-git-diff-note">No diff for this file.</div>
              ) : null}
            </div>
          </>
        ) : (
          <div className="rl-git-empty">{status ? "Nothing to commit — the working tree is clean." : "Reading status…"}</div>
        )}
      </div>
      <CommitBox git={git} focusToken={focusCommitToken} stagedCount={staged.length} pushLabel={pushTarget(status, refs)?.label ?? null} />
    </div>
  );
}

function FileList({
  title,
  area,
  entries,
  selected,
  busy,
  bulkLabel,
  onBulk,
  onSelect,
  onToggle,
  onDiscard,
  onMenu,
}: {
  title: string;
  area: GitArea;
  entries: GitFileEntry[];
  selected: Selected | null;
  busy: boolean;
  bulkLabel: string;
  onBulk: () => void;
  onSelect: (selected: Selected) => void;
  onToggle: (entry: GitFileEntry, area: GitArea) => void;
  onDiscard: (entry: GitFileEntry) => void;
  onMenu: (event: React.MouseEvent | { clientX: number; clientY: number }, entry: GitFileEntry) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const activeIndex = selected?.area === area ? entries.findIndex((e) => e.path === selected.path) : -1;
  const id = (index: number) => `rl-git-${area}-${index}`;
  useEffect(() => {
    if (activeIndex >= 0) document.getElementById(id(activeIndex))?.scrollIntoView?.({ block: "nearest" });
  });
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (entries.length === 0) return;
    const at = activeIndex < 0 ? -1 : activeIndex;
    const move = (index: number) => {
      event.preventDefault();
      const next = entries[Math.max(0, Math.min(entries.length - 1, index))];
      onSelect({ path: next.path, area });
    };
    if (event.key === "ArrowDown") move(at + 1);
    else if (event.key === "ArrowUp") move(at < 0 ? 0 : at - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(entries.length - 1);
    else if ((event.key === " " || event.key === "Enter") && at >= 0) {
      event.preventDefault();
      onToggle(entries[at], area);
    } else if ((event.key === "Backspace" || event.key === "Delete") && at >= 0 && area === "unstaged") {
      event.preventDefault();
      onDiscard(entries[at]);
    } else if ((event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) && at >= 0) {
      event.preventDefault();
      const row = document.getElementById(id(at));
      const rect = row?.getBoundingClientRect();
      if (rect) onMenu({ clientX: rect.left + 24, clientY: rect.bottom }, entries[at]);
    }
  };
  return (
    <section className="rl-git-list" aria-label={title}>
      <header className="rl-git-list-head">
        <span>
          {title} <span className="rl-git-count">{entries.length}</span>
        </span>
        <button type="button" className="rl-git-link" disabled={busy || entries.length === 0} onClick={onBulk}>
          {bulkLabel}
        </button>
      </header>
      <div
        ref={listRef}
        className="rl-git-list-body"
        role="listbox"
        aria-label={title}
        tabIndex={0}
        aria-activedescendant={activeIndex >= 0 ? id(activeIndex) : undefined}
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (activeIndex < 0 && entries[0]) onSelect({ path: entries[0].path, area });
        }}
      >
        {entries.length === 0 && <div className="rl-git-list-empty">{area === "staged" ? "Nothing staged" : "No changes"}</div>}
        {entries.map((entry, index) => (
          <FileRow
            key={entry.path}
            id={id(index)}
            entry={entry}
            selected={index === activeIndex}
            checkbox={{
              checked: area === "staged",
              label: area === "staged" ? `Unstage ${entry.path}` : entry.status === "U" ? `Mark ${entry.path} resolved` : `Stage ${entry.path}`,
              disabled: busy,
              onChange: () => onToggle(entry, area),
            }}
            onClick={() => {
              onSelect({ path: entry.path, area });
              listRef.current?.focus();
            }}
            onContextMenu={(event) => {
              onSelect({ path: entry.path, area });
              onMenu(event, entry);
            }}
          />
        ))}
      </div>
    </section>
  );
}

function CommitBox({ git, focusToken, stagedCount, pushLabel }: { git: GitRepository; focusToken: number; stagedCount: number; pushLabel: string | null }) {
  const { api, run, busy, status, refs } = git;
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [pushAfter, setPushAfter] = usePersistedState("redline.git.pushAfterCommit", false);
  const draft = useRef("");
  const textRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusToken > 0) textRef.current?.focus();
  }, [focusToken]);

  const toggleAmend = async (on: boolean) => {
    setAmend(on);
    if (on) {
      draft.current = message;
      try {
        const last = await api.lastMessage();
        setMessage(last.replace(/\s+$/, ""));
      } catch {
        /* keep the draft; the commit will report the problem */
      }
    } else {
      setMessage(draft.current);
    }
  };

  const canCommit = !busy && message.trim().length > 0 && (stagedCount > 0 || amend);
  const commit = async () => {
    if (!canCommit) return;
    const result = await run(amend ? "Amend commit" : "Commit", () => api.commit(message, amend));
    if (!result) return;
    setMessage("");
    draft.current = "";
    setAmend(false);
    if (pushAfter) {
      const target = pushTarget(status, refs);
      if (target) await run(`Push to ${target.label}`, () => api.push(target.remote, target.branch, target.setUpstream, false));
    }
  };
  const subject = message.split("\n")[0] ?? "";
  return (
    <div className="rl-git-commit">
      <textarea
        ref={textRef}
        aria-label="Commit message"
        placeholder={stagedCount > 0 || amend ? "Commit message" : "Stage changes to commit"}
        value={message}
        spellCheck
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void commit();
          }
        }}
      />
      <div className="rl-git-commit-bar">
        <label className="rl-git-toggle">
          <input type="checkbox" checked={amend} disabled={!status?.head} onChange={(e) => void toggleAmend(e.target.checked)} /> Amend last commit
        </label>
        <label className="rl-git-toggle" title={pushLabel ? `Push to ${pushLabel} after committing` : "No remote to push to"}>
          <input type="checkbox" checked={pushAfter} disabled={!pushLabel} onChange={(e) => setPushAfter(e.target.checked)} /> Push changes immediately
          {pushLabel && <span className="rl-git-muted"> to {pushLabel}</span>}
        </label>
        <span className="rl-git-spacer" />
        {subject.length > 72 && <span className="rl-git-warn">Subject is {subject.length} characters</span>}
        <span className="rl-git-muted">{stagedCount} staged</span>
        <button type="button" className="rl-git-btn rl-git-btn-primary" disabled={!canCommit} title="Commit (⌘↩)" onClick={() => void commit()}>
          {amend ? "Amend" : "Commit"}
        </button>
      </div>
    </div>
  );
}
