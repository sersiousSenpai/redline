import type { ActionResult } from "./types";
export function WhatRedlineDid({ action }: { action: ActionResult | null }) {
  if (!action) return null;
  return (
    <div className="guided-result" role="status">
      <p>{action.message}</p>
      {action.commands.length > 0 && (
        <details>
          <summary>What Redline did</summary>
          <ol>
            {action.commands.map((step, i) => (
              <li key={i}>
                <p>
                  {step.meaning} {!step.ok && "This step did not finish."}
                </p>
                <code>{step.command}</code>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
