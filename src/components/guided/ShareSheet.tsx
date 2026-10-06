import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useMenuOverlay } from "../menuOverlay";
import type { ActionResult, ChangeStory, WorkspaceCreated } from "./types";
export function ShareSheet({
  repo,
  inWorkspace,
  story,
  onDone,
  onClose,
  onWorkspace,
}: {
  repo: string;
  inWorkspace: boolean;
  story: ChangeStory | null;
  onDone: (action: ActionResult) => void;
  onClose: () => void;
  onWorkspace: (path: string) => void;
}) {
  const [title, setTitle] = useState(
      story && !story.fallback
        ? story.summary.slice(0, 100)
        : "Reviewed changes",
    ),
    [askReview, setAskReview] = useState(false),
    [createdWorkspace, setCreatedWorkspace] = useState<WorkspaceCreated | null>(
      null,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  useMenuOverlay(true);
  return (
    <div className="guided-backdrop">
      <form
        role="dialog"
        aria-modal="true"
        aria-label="Share with your team"
        className="guided-sheet"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          void (async () => {
            let target = repo;
            let created: WorkspaceCreated | null = createdWorkspace;
            if (!inWorkspace && !created) {
              created = await invoke<WorkspaceCreated>("workspace_create", {
                repo,
                title,
                from: null,
              });
              setCreatedWorkspace(created);
            }
            if (created) target = created.workspace.path;
            const body = story
              ? [
                  story.summary,
                  ...story.groups.map(
                    (g) =>
                      `### ${g.title}\n${g.plain}\n${g.files.map((f) => `- ${f}`).join("\n")}`,
                  ),
                ].join("\n\n")
              : "Saved changes are ready for review.";
            const action = await invoke<ActionResult>("guided_share", {
              repo: target,
              askReview,
              title,
              body,
            });
            if (created) {
              action.commands.unshift(...created.action.commands);
              onWorkspace(target);
            }
            onDone(action);
          })()
            .catch((e) => setError(String(e)))
            .finally(() => setBusy(false));
        }}
      >
        <h2>Share with your team</h2>
        <p>
          {inWorkspace
            ? "Send this workspace's saved versions to your team."
            : "Redline will create a separate workspace for these saved versions, then share it with your team."}
        </p>
        <label>
          Name this work
          <input
            autoFocus
            className="rl-review-card-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="guided-check">
          <input
            type="checkbox"
            checked={askReview}
            onChange={(e) => setAskReview(e.target.checked)}
          />{" "}
          Ask for review after sharing
        </label>
        {error && <p role="alert">{error}</p>}
        <div className="guided-actions">
          <button
            type="submit"
            className="rl-review-btn rl-review-btn-primary"
            disabled={busy || !title.trim()}
          >
            {busy ? "Sharing…" : "Share with your team"}
          </button>
          <button
            type="button"
            className="rl-review-btn"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
