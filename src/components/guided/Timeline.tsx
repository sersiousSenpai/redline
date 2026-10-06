import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ChangeStory, HistoryVersion } from "./types";
import { Term } from "./Term";
export function Timeline({
  repo,
  onOpen,
  onRestore,
  onTry,
  busy,
}: {
  repo: string;
  onOpen: (sha: string) => void;
  onRestore: (
    sha: string,
    mode: "undo" | "project" | "file",
    path?: string,
  ) => void;
  onTry: (sha: string) => void;
  busy: boolean;
}) {
  const [rows, setRows] = useState<HistoryVersion[]>([]),
    [error, setError] = useState<string | null>(null),
    [hasMore, setHasMore] = useState(true),
    [summaries, setSummaries] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    setRows([]);
    setHasMore(true);
    void invoke<HistoryVersion[]>("history_list", { repo, n: 30, skip: 0 })
      .then((r) => {
        if (alive) {
          setRows(r);
          setHasMore(r.length === 30);
        }
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [repo]);
  return (
    <section className="guided-card">
      <h2>
        <Term term="log" />
      </h2>
      {error && <p role="alert">{error}</p>}
      <ol className="guided-timeline">
        {rows.map((row) => (
          <li key={row.sha}>
            <button
              type="button"
              className="guided-timeline-title"
              onClick={() => {
                onOpen(row.sha);
                if (!summaries[row.sha])
                  void invoke<ChangeStory>("narrate_commit", {
                    repo,
                    sha: row.sha,
                  })
                    .then((story) => {
                      if (!story.fallback)
                        setSummaries((s) => ({
                          ...s,
                          [row.sha]: story.summary,
                        }));
                    })
                    .catch(() => {});
              }}
            >
              {summaries[row.sha] ?? row.subject}
            </button>
            <p className="guided-help">
              {row.author} · {new Date(row.committedAt * 1000).toLocaleString()}{" "}
              · {row.filesChanged} files {row.shared && "· Shared"}{" "}
              {row.fromTeam && "· From your team"}
            </p>
            <details>
              <summary>Version actions</summary>
              <div className="guided-actions">
                <button
                  type="button"
                  className="rl-review-btn"
                  disabled={busy}
                  onClick={() => onRestore(row.sha, "undo")}
                >
                  Undo this version
                </button>
                <button
                  type="button"
                  className="rl-review-btn"
                  disabled={busy}
                  onClick={() => onRestore(row.sha, "project")}
                >
                  Restore the whole project
                </button>
                <button
                  type="button"
                  className="rl-review-btn"
                  disabled={busy}
                  onClick={() => onTry(row.sha)}
                >
                  Try this old version safely
                </button>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const path = String(
                    new FormData(e.currentTarget).get("path") ?? "",
                  ).trim();
                  if (path) onRestore(row.sha, "file", path);
                }}
              >
                <input
                  name="path"
                  aria-label="File path to restore"
                  placeholder="Path of the file to restore"
                  className="rl-review-card-input"
                  required
                />
                <button type="submit" className="rl-review-btn" disabled={busy}>
                  Restore one file to this version
                </button>
              </form>
            </details>
          </li>
        ))}
      </ol>
      {hasMore && (
        <button
          type="button"
          className="rl-review-btn"
          onClick={() => {
            void invoke<HistoryVersion[]>("history_list", {
              repo,
              n: 30,
              skip: rows.length,
            })
              .then((next) => {
                setRows((previous) => [...previous, ...next]);
                setHasMore(next.length === 30);
              })
              .catch((e) => setError(String(e)));
          }}
        >
          Show older versions
        </button>
      )}
    </section>
  );
}
