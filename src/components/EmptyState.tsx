// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { ReactNode } from "react";

export interface EmptyStateAction {
  label: string;
  onAction: () => void;
}

// The document plate's quiet zero-state: a serif title over muted prose.
// Extracted from App.tsx so the landing surface can build on it without
// reaching into the 5,000-line component.
//
// The optional actions make it a place a real CHOICE can live — the crash
// recovery card uses them. That matters because the choice it replaces was a
// `window.confirm`, which WKWebView answers with a silent `false`: the prompt
// never appeared in the packaged app and the declined branch ran anyway.
export function EmptyState({
  title,
  body,
  action,
  secondary,
}: {
  title: string;
  body: ReactNode;
  action?: EmptyStateAction;
  secondary?: EmptyStateAction;
}) {
  return (
    <div className="font-sans" style={{ color: "var(--color-ink-muted)" }}>
      <div
        className="font-serif font-semibold mb-2"
        style={{ color: "var(--color-ink)", fontSize: "22px" }}
      >
        {title}
      </div>
      <p style={{ fontSize: "14px", lineHeight: 1.6, maxWidth: "60ch" }}>
        {body}
      </p>
      {(action || secondary) && (
        <div className="rl-fd-row">
          {action && (
            <button
              type="button"
              className="rl-fd-fix is-primary"
              onClick={action.onAction}
            >
              {action.label}
            </button>
          )}
          {secondary && (
            <button
              type="button"
              className="rl-fd-quiet"
              onClick={secondary.onAction}
            >
              {secondary.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
