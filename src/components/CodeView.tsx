// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useMemo } from "react";
import hljs from "highlight.js/lib/common";

// Map file extensions to highlight.js language ids. Only languages bundled in
// highlight.js/lib/common are listed; anything else falls back to auto-detect,
// so an unmapped extension still highlights, just less precisely.
const EXT_LANG: Record<string, string> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  py: "python", rb: "ruby", rs: "rust", go: "go",
  java: "java", kt: "kotlin", kts: "kotlin", scala: "scala",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  cs: "csharp", php: "php", swift: "swift", dart: "dart",
  sh: "bash", bash: "bash", zsh: "bash",
  json: "json", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini",
  xml: "xml", html: "xml", htm: "xml", svg: "xml", vue: "xml",
  css: "css", scss: "scss", less: "less",
  md: "markdown", markdown: "markdown",
  sql: "sql", lua: "lua", r: "r", pl: "perl", pm: "perl",
  dockerfile: "dockerfile", makefile: "makefile",
};

function languageFor(filename: string): string | null {
  const lower = filename.toLowerCase();
  if (lower === "dockerfile") return "dockerfile";
  if (lower === "makefile") return "makefile";
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return null;
  return EXT_LANG[lower.slice(dot + 1)] ?? null;
}

interface CodeViewProps {
  content: string;
  filename: string;
}

// Read-only syntax-highlighted source. Reuses the app's existing highlight.js
// dependency (lowlight powers the in-plan code blocks); token colors come from
// the shared `.hljs-*` palette in styles.css.
export default function CodeView({ content, filename }: CodeViewProps) {
  const html = useMemo(() => {
    const language = languageFor(filename);
    try {
      if (language && hljs.getLanguage(language)) {
        return hljs.highlight(content, { language }).value;
      }
      return hljs.highlightAuto(content).value;
    } catch {
      // Never let a highlighter edge case blank the viewer — fall back to the
      // raw text (the <code> below preserves whitespace either way).
      return escapeHtml(content);
    }
  }, [content, filename]);

  return (
    <pre className="rl-code-view">
      <code
        className="hljs"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </pre>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
