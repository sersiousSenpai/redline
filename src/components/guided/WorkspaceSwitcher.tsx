import type { WorkspaceStatus } from "./types";
export function WorkspaceSwitcher({
  repo,
  items,
  busy,
  onOpen,
  onLaunch,
  onArchive,
  onBringIn,
}: {
  repo: string;
  items: WorkspaceStatus[];
  busy: boolean;
  onOpen: (path: string) => void;
  onLaunch: (path: string) => void;
  onArchive: (id: string) => void;
  onBringIn: (id: string) => void;
}) {
  const active = items.find((row) => row.workspace.path === repo)?.workspace;
  return (
    <div className="guided-workspaces">
      <label>
        Workspace{" "}
        <select
          className="rl-review-select"
          value={repo}
          onChange={(e) => onOpen(e.target.value)}
        >
          <option value={active?.repo ?? repo}>Main project folder</option>
          {items.map(({ workspace, status }) => (
            <option key={workspace.id} value={workspace.path}>
              {workspace.title}
              {status
                ? ` · ${status.staged + status.unstaged + status.untracked} unsaved · ${status.ahead} not shared · ${status.behind} new`
                : ""}
            </option>
          ))}
        </select>
      </label>
      {active && (
        <div className="guided-actions">
          <button
            type="button"
            className="rl-review-btn"
            onClick={() => onLaunch(active.path)}
          >
            Open workspace
          </button>
          <button
            type="button"
            className="rl-review-btn"
            disabled={busy}
            onClick={() => onBringIn(active.id)}
          >
            Bring into main version locally
          </button>
          <button
            type="button"
            className="rl-review-btn"
            disabled={busy}
            onClick={() => onArchive(active.id)}
          >
            Archive workspace
          </button>
        </div>
      )}
    </div>
  );
}
