import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ChangeStory, SyncCheck } from "./types";
export function UpdatesCard({
  repo,
  check,
  busy,
  onBringIn,
  onCheck,
}: {
  repo: string;
  check: SyncCheck | null;
  busy: boolean;
  onBringIn: () => void;
  onCheck: () => void;
}) {
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  if (!check?.incomingCount) return null;
  return (
    <section className="guided-card">
      <h3>{check.incomingCount} new from your team</h3>
      {check.overlaps.length > 0 && (
        <p>
          Save your work first: your team's updates touch{" "}
          {check.overlaps.join(", ")}.
        </p>
      )}
      <ul>
        {check.incoming.map((version) => (
          <li key={version.sha}>
            <strong>{version.author}</strong> ·{" "}
            {summaries[version.sha] ?? version.subject}
            <span className="guided-help">
              {" "}
              {version.files.length} files ·{" "}
              {new Date(version.when * 1000).toLocaleDateString()}
            </span>
            <button
              type="button"
              className="rl-review-btn"
              onClick={() => {
                void invoke<ChangeStory>("narrate_commit", {
                  repo,
                  sha: version.sha,
                })
                  .then((story) =>
                    setSummaries((s) => ({
                      ...s,
                      [version.sha]: story.summary,
                    })),
                  )
                  .catch(() => {});
              }}
            >
              Explain this version
            </button>
          </li>
        ))}
      </ul>
      <div className="guided-actions">
        <button
          type="button"
          className="rl-review-btn rl-review-btn-primary"
          disabled={busy || check.overlaps.length > 0}
          onClick={onBringIn}
        >
          Bring in updates
        </button>
        <button
          type="button"
          className="rl-review-btn"
          disabled={busy}
          onClick={onCheck}
        >
          Check for updates
        </button>
      </div>
    </section>
  );
}
