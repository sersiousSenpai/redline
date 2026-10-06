import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ChangeStory } from "../components/guided/types";
import type { DiffFile } from "../types";
import { displayPath } from "../lib/flattenDiff";
export function fallbackNarration(files: DiffFile[]): ChangeStory {
  const folders = new Map<string, DiffFile[]>();
  for (const file of files) {
    const path = displayPath(file);
    const folder = path.includes("/")
      ? path.slice(0, path.lastIndexOf("/"))
      : "Project files";
    folders.set(folder, [...(folders.get(folder) ?? []), file]);
  }
  return {
    summary:
      "A summary isn't available right now. Here are the files that changed.",
    fallback: true,
    risks: [],
    groups: [...folders].map(([title, group]) => ({
      title,
      plain: `${group.filter((f) => f.status === "added").length} added, ${group.filter((f) => f.status !== "added" && f.status !== "deleted").length} changed, ${group.filter((f) => f.status === "deleted").length} removed.`,
      files: group.map(displayPath),
      kind: "cleanup",
    })),
  };
}
export function useNarration(
  reviewId: string | null,
  files: DiffFile[] | null,
) {
  const [story, setStory] = useState<ChangeStory | null>(null),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    let alive = true;
    setStory(fallbackNarration(files ?? []));
    setLoading(false);
    if (!reviewId || !files?.length) return;
    setLoading(true);
    void invoke<ChangeStory>("narrate_changes", { reviewId })
      .then((value) => {
        if (alive) setStory(value);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [reviewId, files]);
  return { story, loading };
}
