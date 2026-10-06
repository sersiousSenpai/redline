import type { ReactNode } from "react";
import type { GitStory } from "../../lib/gitStory";
import { gitActions, type GitAction } from "../../lib/gitWords";
import { Term } from "./Term";
export function WhereYouAre({
  story,
  name,
  busy,
  onAction,
  children,
}: {
  story: GitStory;
  name: string;
  busy: boolean;
  onAction: (action: GitAction) => void;
  children?: ReactNode;
}) {
  return (
    <section className="guided-card guided-where" data-tour="guided-where">
      <div className="guided-eyebrow">Where you are · {name}</div>
      <h2>{story.headline}</h2>
      <p>{story.detail}</p>
      {children}
      <div className="guided-actions" data-tour="guided-save">
        <button
          type="button"
          className="rl-review-btn rl-review-btn-primary"
          disabled={busy}
          onClick={() => onAction(story.primary)}
        >
          {gitActions[story.primary].label}
        </button>
        <details>
          <summary>More</summary>
          <div className="guided-actions">
            {story.secondary.map((action) => (
              <button
                type="button"
                className="rl-review-btn"
                key={action}
                disabled={busy}
                onClick={() => onAction(action)}
              >
                {gitActions[action].label}
              </button>
            ))}
          </div>
        </details>
        <span className="guided-help">
          Learn the terms: <Term term="branch" /> · <Term term="commit" />
        </span>
      </div>
    </section>
  );
}
