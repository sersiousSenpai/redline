// SPDX-License-Identifier: Apache-2.0
// Left sidebar: WORKSPACE, BRANCHES, REMOTES, TAGS, STASHES.
import { useMemo } from "react";
import { Archive, ChevronDown, ChevronRight, Cloud, FolderGit2, GitBranch, GitGraph, History, ListChecks, Tag } from "lucide-react";
import { usePersistedState } from "../../theme/usePersistedState";
import type { GitRefs } from "../../lib/git/types";
import type { GitActions } from "./actions";
import type { MenuItem, useContextMenu } from "./ui";
import { branchMenu, remoteMenu, tagMenu } from "./menus";

export type GitView = "status" | "branches" | "history" | "stash";

interface Props {
  refs: GitRefs | null;
  changeCount: number;
  view: GitView;
  stashIndex: number | null;
  onView: (view: GitView) => void;
  onStash: (index: number) => void;
  /** A ref was clicked: show its tip in the current graph view. */
  onReveal: (sha: string) => void;
  /** "Show in history" from a ref's menu. */
  onShowInHistory: (sha: string) => void;
  actions: GitActions;
  menu: ReturnType<typeof useContextMenu>;
}

export function GitSidebar({ refs, changeCount, view, stashIndex, onView, onStash, onReveal, onShowInHistory, actions, menu }: Props) {
  const [collapsed, setCollapsed] = usePersistedState<Record<string, boolean>>("redline.git.sidebarCollapsed", {});
  const toggle = (key: string) => setCollapsed((c: Record<string, boolean>) => ({ ...c, [key]: !c[key] }));
  const current = refs?.current ?? null;

  const remotes = useMemo(() => {
    const byRemote = new Map<string, { name: string; short: string; sha: string }[]>();
    for (const remote of refs?.remotes ?? []) byRemote.set(remote, []);
    for (const branch of refs?.remote ?? []) {
      const short = branch.name.startsWith(`${branch.remote}/`) ? branch.name.slice(branch.remote.length + 1) : branch.name;
      if (short === "HEAD") continue;
      if (!byRemote.has(branch.remote)) byRemote.set(branch.remote, []);
      byRemote.get(branch.remote)!.push({ name: branch.name, short, sha: branch.sha });
    }
    return [...byRemote.entries()];
  }, [refs]);

  const keyNav = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-nav]")];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = items[at + (event.key === "ArrowDown" ? 1 : -1)];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };

  const item = (
    key: string,
    label: React.ReactNode,
    opts: {
      icon?: React.ReactNode;
      active?: boolean;
      strong?: boolean;
      title?: string;
      extra?: React.ReactNode;
      onClick?: () => void;
      onDouble?: () => void;
      menu?: () => MenuItem[];
      depth?: number;
    },
  ) => (
    <button
      key={key}
      type="button"
      data-nav=""
      className="rl-git-side-item"
      data-active={opts.active ? "" : undefined}
      data-strong={opts.strong ? "" : undefined}
      style={opts.depth ? { paddingLeft: 22 + opts.depth * 16 } : undefined}
      title={opts.title}
      onClick={opts.onClick}
      onDoubleClick={opts.onDouble}
      onContextMenu={opts.menu ? (event) => menu.open(event, opts.menu!()) : undefined}
      onKeyDown={(event) => {
        if (opts.menu && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
          event.preventDefault();
          menu.openAt(event.currentTarget, opts.menu());
        }
      }}
    >
      {opts.icon}
      <span className="rl-git-side-label">{label}</span>
      {opts.extra}
    </button>
  );

  const section = (key: string, title: string, children: React.ReactNode, count?: number) => (
    <div className="rl-git-side-section" key={key}>
      <button type="button" data-nav="" className="rl-git-side-head" aria-expanded={!collapsed[key]} onClick={() => toggle(key)}>
        {collapsed[key] ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <span>{title}</span>
        {count !== undefined && count > 0 && <span className="rl-git-side-count">{count}</span>}
      </button>
      {!collapsed[key] && <div role="group" aria-label={title}>{children}</div>}
    </div>
  );

  return (
    <nav className="rl-git-sidebar" aria-label="Repository" onKeyDown={keyNav}>
      {section(
        "workspace",
        "WORKSPACE",
        <>
          {item("status", "File status", {
            icon: <ListChecks size={14} />,
            active: view === "status",
            onClick: () => onView("status"),
            extra: changeCount > 0 ? <span className="rl-git-side-count">{changeCount}</span> : undefined,
          })}
          {item("branches", "Branches", { icon: <GitGraph size={14} />, active: view === "branches", onClick: () => onView("branches") })}
          {item("history", "History", { icon: <History size={14} />, active: view === "history", onClick: () => onView("history") })}
        </>,
      )}
      {section(
        "branches",
        "BRANCHES",
        (refs?.local ?? []).map((b) =>
          item(`b:${b.name}`, b.name, {
            icon: <GitBranch size={13} />,
            strong: b.current,
            title: b.upstream ? `${b.name} → ${b.upstream}${b.gone ? " (gone)" : ""}` : b.name,
            onClick: () => onReveal(b.sha),
            onDouble: b.current ? undefined : () => void actions.checkoutBranch(b.name),
            menu: () => branchMenu(b.name, b.sha, b.current, current, actions, onShowInHistory),
            extra: (
              <span className="rl-git-side-ab">
                {b.gone && <span className="rl-git-muted">gone</span>}
                {b.ahead > 0 && <span title={`${b.ahead} ahead of ${b.upstream}`}>↑{b.ahead}</span>}
                {b.behind > 0 && <span title={`${b.behind} behind ${b.upstream}`}>↓{b.behind}</span>}
              </span>
            ),
          }),
        ),
      )}
      {section(
        "remotes",
        "REMOTES",
        remotes.map(([remote, branches]) => (
          <div key={remote}>
            {item(`r:${remote}`, remote, {
              icon: collapsed[`remote:${remote}`] ? <ChevronRight size={12} /> : <Cloud size={13} />,
              onClick: () => toggle(`remote:${remote}`),
            })}
            {!collapsed[`remote:${remote}`] &&
              branches.map((b) =>
                item(`rb:${b.name}`, b.short, {
                  depth: 1,
                  icon: <GitBranch size={12} />,
                  title: b.name,
                  onClick: () => onReveal(b.sha),
                  onDouble: () => void actions.checkoutRemote(b.name),
                  menu: () => remoteMenu(b.name, b.sha, current, actions, onShowInHistory),
                }),
              )}
          </div>
        )),
      )}
      {section(
        "tags",
        "TAGS",
        (refs?.tags ?? []).map((t) =>
          item(`t:${t.name}`, t.name, {
            icon: <Tag size={12} />,
            onClick: () => onReveal(t.sha),
            onDouble: () => void actions.checkoutCommit(t.name, t.name),
            menu: () => tagMenu(t.name, t.sha, actions, onShowInHistory),
          }),
        ),
        refs?.tags.length,
      )}
      {section(
        "stashes",
        "STASHES",
        (refs?.stashes ?? []).map((s) =>
          item(`s:${s.index}`, s.message || `stash@{${s.index}}`, {
            icon: <Archive size={12} />,
            title: `stash@{${s.index}}: ${s.message}`,
            active: view === "stash" && stashIndex === s.index,
            onClick: () => onStash(s.index),
            onDouble: () => void actions.stashApply(s.index, false),
            menu: () => [
              { label: "Apply stash", onSelect: () => void actions.stashApply(s.index, false) },
              { label: "Pop stash", onSelect: () => void actions.stashApply(s.index, true) },
              { separator: true },
              { label: "Drop stash…", danger: true, onSelect: () => void actions.stashDrop(s.index) },
            ],
          }),
        ),
        refs?.stashes.length,
      )}
      {!refs && <div className="rl-git-side-loading"><FolderGit2 size={14} /> Reading refs…</div>}
    </nav>
  );
}
