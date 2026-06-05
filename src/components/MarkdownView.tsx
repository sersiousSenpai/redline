// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useMemo } from "react";
import MarkdownIt from "markdown-it";

// html: false escapes any raw HTML in the source — safe for untrusted
// Claude/user input. breaks: true treats a single newline as <br>, which
// matches how people type in the comment box and how Claude streams replies.
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});

interface MarkdownViewProps {
  body: string;
  /** Adds extra-tight vertical rhythm for inline chat-style bubbles. */
  compact?: boolean;
}

export function MarkdownView({ body, compact = false }: MarkdownViewProps) {
  const html = useMemo(() => md.render(body), [body]);
  return (
    <div
      className={compact ? "rl-md rl-md-compact" : "rl-md"}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
