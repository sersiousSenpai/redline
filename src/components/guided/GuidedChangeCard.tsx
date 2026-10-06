import { useState } from "react";
import type { ChangeGroup } from "./types";
import type { ReviewAnnotation } from "../../types";
import type { ChangeRisk } from "../../lib/changeRisks";
export function GuidedChangeCard({
  group,
  viewed,
  risks,
  findings,
  canUndo,
  busy,
  onGood,
  onNote,
  onUndo,
  onCode,
}: {
  group: ChangeGroup;
  viewed: Set<string>;
  risks: ChangeRisk[];
  findings: ReviewAnnotation[];
  canUndo: boolean;
  busy: boolean;
  onGood: (files: string[]) => void;
  onNote: (
    file: string,
    text: string,
    label: "suggestion" | "question",
  ) => Promise<void>;
  onUndo: (file: string) => void;
  onCode: (file: string) => void;
}) {
  const [mode, setMode] = useState<"suggestion" | "question" | null>(null),
    [text, setText] = useState(""),
    [file, setFile] = useState(group.files[0] ?? "");
  return (
    <article className="guided-card">
      <div className="guided-eyebrow">
        {group.kind}
        {group.files.every((f) => viewed.has(f)) && " · Reviewed"}
      </div>
      <h3>{group.title}</h3>
      <p>{group.plain}</p>
      <ul className="guided-files">
        {group.files.map((path) => (
          <li key={path}>
            <span title={path}>{path.split("/").pop()}</span>
            {viewed.has(path) && <span aria-label="Reviewed"> ✓</span>}
            {canUndo && (
              <button
                className="rl-review-btn"
                type="button"
                disabled={busy}
                onClick={() => onUndo(path)}
              >
                Undo this change
              </button>
            )}
            <button
              className="rl-review-btn"
              type="button"
              onClick={() => onCode(path)}
            >
              Show me the code
            </button>
          </li>
        ))}
      </ul>
      {risks.length > 0 && (
        <ul className="guided-risks">
          {risks.map((r) => (
            <li key={`${r.kind}:${r.file}`}>{r.message}</li>
          ))}
        </ul>
      )}
      {findings.length > 0 && (
        <div className="guided-notes">
          <strong>Claude's notes</strong>
          {findings.map((f) => (
            <p key={f.id}>{f.body}</p>
          ))}
        </div>
      )}
      <div className="guided-actions">
        <button
          type="button"
          className="rl-review-btn"
          disabled={busy || group.files.every((f) => viewed.has(f))}
          onClick={() => onGood(group.files)}
        >
          Looks good
        </button>
        <button
          type="button"
          className="rl-review-btn"
          onClick={() => setMode("suggestion")}
        >
          Change this
        </button>
        <button
          type="button"
          className="rl-review-btn"
          onClick={() => setMode("question")}
        >
          I have a question
        </button>
      </div>
      {mode && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onNote(file, text, mode).then(() => {
              setMode(null);
              setText("");
            });
          }}
        >
          <label>
            About{" "}
            <select
              className="rl-review-select"
              value={file}
              onChange={(e) => setFile(e.target.value)}
            >
              <option value="">The whole change</option>
              {group.files.map((path) => (
                <option key={path}>{path}</option>
              ))}
            </select>
          </label>
          <textarea
            autoFocus
            className="rl-review-card-input"
            aria-label={
              mode === "question" ? "Your question" : "What should change"
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              mode === "question"
                ? "What would you like to understand?"
                : "Describe what you would like changed…"
            }
          />
          <div className="guided-actions">
            <button
              type="submit"
              className="rl-review-btn"
              disabled={!text.trim()}
            >
              Add note
            </button>
            <button
              type="button"
              className="rl-review-btn"
              onClick={() => setMode(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </article>
  );
}
