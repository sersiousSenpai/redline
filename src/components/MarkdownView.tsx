// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Fragment, memo, useMemo } from "react";
import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import hljs from "highlight.js";
import { MermaidView } from "../editor/extensions/MermaidView";

// html: false escapes any raw HTML in the source — safe for untrusted
// Claude/user input. breaks: true treats a single newline as <br>, which
// matches how people type in the comment box and how Claude streams replies.
// highlight: syntax-color fenced code via highlight.js (the output is escaped
// token HTML, so it stays safe with html:false). Mermaid fences are left to the
// segment renderer below, never highlighted.
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
  highlight: (str, lang) => {
    const language = lang?.trim().toLowerCase();
    if (language && language !== "mermaid" && hljs.getLanguage(language)) {
      try {
        const out = hljs.highlight(str, {
          language,
          ignoreIllegals: true,
        }).value;
        return `<pre class="hljs rl-md-pre"><code>${out}</code></pre>`;
      } catch {
        // fall through to the default escaped rendering
      }
    }
    return "";
  },
});

md.use(taskLists, { enabled: true, label: true });

// Wrap every fenced code block in a relative container carrying a copy button.
// The markdown is injected via dangerouslySetInnerHTML, so the button gets no
// inline handler — MarkdownView delegates the click (see `onClick` below) and
// copies the <pre>'s text. This removes the need to hand-select code in the
// narrow discussion pane (where selection is fiddly over the native webview).
const defaultFence =
  md.renderer.rules.fence ??
  ((tokens, idx, options, _env, self) =>
    self.renderToken(tokens, idx, options));
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const inner = defaultFence(tokens, idx, options, env, self);
  return `<div class="rl-codeblock">${inner}<button class="rl-copy-btn" type="button" title="Copy" aria-label="Copy code">⧉</button></div>\n`;
};

// GitHub-style callouts: a blockquote whose first line is `[!NOTE]` (or TIP,
// WARNING, IMPORTANT, CAUTION) becomes `<blockquote class="rl-callout
// rl-callout-note">` with the marker line stripped. A small core rule that runs
// after block parsing and rewrites the matched blockquote_open token.
const CALLOUT_RE = /^\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION)\]\s*$/i;
md.core.ruler.push("rl_callouts", (state) => {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== "blockquote_open") continue;
    // The first inline content of the blockquote is two tokens ahead:
    // blockquote_open, paragraph_open, inline.
    const inline = tokens[i + 2];
    if (!inline || inline.type !== "inline") continue;
    const firstLine = inline.content.split("\n", 1)[0];
    const m = firstLine.match(CALLOUT_RE);
    if (!m) continue;
    const kind = m[1].toLowerCase();
    tokens[i].attrJoin("class", `rl-callout rl-callout-${kind}`);
    // Strip the marker line from the rendered body (keep the rest).
    const nl = inline.content.indexOf("\n");
    inline.content = nl === -1 ? "" : inline.content.slice(nl + 1);
    if (inline.children?.length) {
      // Drop the leading marker text + its trailing softbreak from the inline
      // token tree so the rendered HTML matches the trimmed content.
      let drop = 0;
      while (
        drop < inline.children.length &&
        inline.children[drop].type !== "softbreak"
      ) {
        drop++;
      }
      inline.children = inline.children.slice(drop + 1);
    }
  }
  return true;
});

interface MarkdownViewProps {
  body: string;
  /** Adds extra-tight vertical rhythm for inline chat-style bubbles. */
  compact?: boolean;
  /** Render ```mermaid fences as live diagrams (interleaved React components).
   *  Off by default — enabled for settled discussion replies. */
  rich?: boolean;
  /** When set, intercept clicks on http(s) links and route the URL here instead
   *  of letting the anchor navigate the host webview. The browser pane wires
   *  this to `openTab`, so links in a page-discussion reply open as a Redline
   *  browser tab rather than escaping to the OS / blowing away the app. */
  onLinkClick?: (url: string) => void;
}

/** Resolve a click landing inside rendered markdown to the http(s) URL of the
 *  anchor it occurred in, or null if it wasn't an external-link click. */
function externalHref(target: EventTarget | null): string | null {
  const el = target instanceof Element ? target.closest("a[href]") : null;
  const href = el?.getAttribute("href");
  return href && /^https?:\/\//i.test(href) ? href : null;
}

type Segment =
  | { kind: "md"; text: string }
  | { kind: "mermaid"; code: string };

/** Split a markdown body into renderable segments: plain-markdown chunks
 *  interleaved with mermaid diagrams. Uses markdown-it's block parser line map
 *  (not a regex) so fence boundaries are exact. A body with no mermaid fence
 *  yields a single `md` segment. */
export function splitMermaidSegments(body: string): Segment[] {
  const tokens = md.parse(body, {});
  const fences = tokens.filter(
    (t) =>
      t.type === "fence" &&
      t.map != null &&
      t.info.trim().toLowerCase() === "mermaid",
  );
  if (fences.length === 0) return [{ kind: "md", text: body }];

  const lines = body.split("\n");
  const segments: Segment[] = [];
  let cursor = 0; // next unconsumed source line
  for (const fence of fences) {
    const [start, end] = fence.map as [number, number];
    if (start > cursor) {
      const text = lines.slice(cursor, start).join("\n").trim();
      if (text) segments.push({ kind: "md", text });
    }
    segments.push({ kind: "mermaid", code: fence.content });
    cursor = end;
  }
  if (cursor < lines.length) {
    const text = lines.slice(cursor).join("\n").trim();
    if (text) segments.push({ kind: "md", text });
  }
  return segments;
}

// `React.memo` + the parse memos below mean a parent re-render (e.g. a focus
// or layout change rippling through the comment pane) never re-runs the
// markdown parser — `md.render` only fires when `body` actually changes. With
// many comment cards / discussion bubbles on screen this turns an O(cards ×
// segments) re-parse on every render into zero work.
export const MarkdownView = memo(function MarkdownView({
  body,
  compact = false,
  rich = false,
  onLinkClick,
}: MarkdownViewProps) {
  // `rl-md-own-links` tells the global external-link handler (installExternal-
  // LinkHandler) to leave web links inside this view alone — the bubble-phase
  // onClick below owns them, so the link opens in a Redline tab instead of also
  // being handed to the OS browser by that capture-phase handler.
  const cls =
    (compact ? "rl-md rl-md-compact" : "rl-md") +
    (onLinkClick ? " rl-md-own-links" : "");
  // Event-delegated handling for the raw-HTML body (no React handlers on the
  // injected nodes): a click on a fenced-block copy button copies that block,
  // and — when onLinkClick is set — an external link is rerouted instead of
  // navigating the host webview.
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const btn =
      e.target instanceof Element
        ? e.target.closest(".rl-copy-btn")
        : null;
    if (btn) {
      e.preventDefault();
      const pre = btn.closest(".rl-codeblock")?.querySelector("pre");
      const text = pre?.textContent ?? "";
      void navigator.clipboard?.writeText(text).then(() => {
        btn.classList.add("rl-copied");
        window.setTimeout(() => btn.classList.remove("rl-copied"), 1200);
      });
      return;
    }
    if (onLinkClick) {
      const url = externalHref(e.target);
      if (url) {
        e.preventDefault();
        onLinkClick(url);
      }
    }
  };
  const segments = useMemo(
    () => (rich ? splitMermaidSegments(body) : null),
    [rich, body],
  );
  // Plain path: one cached parse keyed on the source.
  const html = useMemo(
    () => (segments ? null : md.render(body)),
    [segments, body],
  );
  // Rich path: each markdown segment rendered once and cached together; mermaid
  // segments are left to MermaidView (null placeholder keeps indices aligned).
  const segmentHtml = useMemo(
    () =>
      segments
        ? segments.map((seg) =>
            seg.kind === "mermaid" ? null : md.render(seg.text),
          )
        : null,
    [segments],
  );

  if (!segments || !segmentHtml) {
    return (
      <div
        className={cls}
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: html ?? "" }}
      />
    );
  }

  return (
    <div className={cls} onClick={onClick}>
      {segments.map((seg, i) =>
        seg.kind === "mermaid" ? (
          <MermaidView key={i} code={seg.code} />
        ) : (
          <Fragment key={i}>
            <div dangerouslySetInnerHTML={{ __html: segmentHtml[i] ?? "" }} />
          </Fragment>
        ),
      )}
    </div>
  );
});
