import { useState } from "react";
import type { ConflictReport } from "./types";
import { Term } from "./Term";
export function ConflictCard({
  conflict,
  onHelp,
  busy,
}: {
  conflict: ConflictReport;
  onHelp: (brief: string) => void;
  busy: boolean;
}) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState<string | null>(null);
  const brief = `Please help combine these changes safely in this separate workspace. Redline cancelled the conflicting operation in the original project.\nMy work: ${conflict.oursSummary}\nThe other version: ${conflict.theirsSummary}\nFiles: ${conflict.files.join(", ")}\nKeep both sides' intent, review the result, and do not rewrite saved history.`;
  return (
    <section className="guided-card">
      <h3>
        <Term term="conflict" />
      </h3>
      <p>
        {conflict.oursSummary} {conflict.theirsSummary}
      </p>
      <ul>
        {conflict.files.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      <div className="guided-actions">
        <button
          type="button"
          className="rl-review-btn"
          disabled={busy}
          onClick={() => onHelp(brief)}
        >
          Ask Claude to combine them
        </button>
        <button
          type="button"
          className="rl-review-btn"
          onClick={() => {
            void navigator.clipboard
              .writeText(brief)
              .then(() => setCopied(true))
              .catch(() =>
                setError(
                  "The message could not be copied. Select and copy the details above.",
                ),
              );
          }}
        >
          {copied ? "Message copied" : "Ask a teammate"}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
