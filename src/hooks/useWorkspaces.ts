import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  Workspace,
  WorkspaceCreated,
  WorkspaceStatus,
} from "../components/guided/types";
import type { GitStatus } from "../types";
export function useWorkspaces(repo: string | null) {
  const [items, setItems] = useState<WorkspaceStatus[]>([]),
    [error, setError] = useState<string | null>(null);
  const epoch = useRef(0),
    repoRef = useRef(repo);
  repoRef.current = repo;
  const refresh = useCallback(async () => {
    if (!repo) return;
    const request = ++epoch.current;
    try {
      const workspaces = await invoke<Workspace[]>("workspace_list", { repo });
      const rows = await Promise.all(
        workspaces.map(async (workspace) => ({
          workspace,
          status: await invoke<GitStatus>("workspace_status", {
            id: workspace.id,
          }).catch(() => null),
        })),
      );
      if (epoch.current !== request || repoRef.current !== repo) return;
      setItems(rows);
      setError(null);
    } catch (e) {
      if (epoch.current === request && repoRef.current === repo)
        setError(String(e));
    }
  }, [repo]);
  useEffect(() => {
    setItems([]);
    setError(null);
    void refresh();
    return () => {
      epoch.current++;
    };
  }, [refresh]);
  const create = useCallback(
    (title: string, from?: string) =>
      invoke<WorkspaceCreated>("workspace_create", {
        repo,
        title,
        from: from ?? null,
      }),
    [repo],
  );
  return { items, error, refresh, create };
}
