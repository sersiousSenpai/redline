// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Off-the-UI-thread syntax highlighting for the read-only file viewer.
//!
//! The whole-app freezes that motivated this module came from highlighting a
//! 1.15 MB / 57k-line file *synchronously in the WebView main thread* and then
//! rendering one `<span>` per token for the entire file. The fix splits the work
//! the way VS Code does:
//!
//! - **Tokenize in Rust** (`syntect`), once per file, off the UI thread, and
//!   cache the per-line result keyed by path + mtime.
//! - **Serve lines by range** (`doc_lines`) so the frontend only ever pulls the
//!   visible window (plus a little overscan) — it never holds or renders the
//!   whole file.
//!
//! Tokens are tagged with `highlight.js`-style classes (`hljs-keyword`, …) so the
//! viewer reuses the app's existing `.hljs-*` palette and themes unchanged.

use std::collections::HashMap;
use std::fs;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use serde::Serialize;
use syntect::parsing::{ParseState, ScopeStack, SyntaxReference, SyntaxSet};

/// Files larger than this are paged as plain text (no tokenization) — syntect
/// over many megabytes is slow and the token cache would balloon. The viewer
/// still scrolls them fine; they just aren't colored.
const MAX_HIGHLIGHT_BYTES: u64 = 8 * 1024 * 1024;

/// Hard ceiling on what the viewer will load at all. Above this we report
/// `too_large` and render a notice instead — paging arbitrarily huge files would
/// need memory-mapping, which is out of scope.
const MAX_DOC_BYTES: u64 = 64 * 1024 * 1024;

/// At or below this line count, `open_doc` returns the *whole* document inline
/// (every line in one shot) so the viewer paints in a single round-trip with no
/// blank frame — the common case. Above it the viewer pages the visible window
/// via `doc_lines`, keeping the DOM and IPC bounded for genuinely huge files.
const INLINE_MAX_LINES: usize = 5_000;

/// Metadata for an opened document — enough for the viewer to size its scroll
/// area and decide how to render, without shipping any line content.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocMeta {
    pub line_count: usize,
    /// True when tokens *can* be produced for this doc (it's text within the
    /// highlight size cap) — i.e. the viewer should request highlighting via
    /// `doc_highlight`. A matching grammar might still not exist, in which case
    /// highlighting resolves to plain text. False for too-large / binary docs.
    pub highlightable: bool,
    pub too_large: bool,
    pub is_binary: bool,
    pub size: u64,
}

/// One colored run within a line. `class` is a `highlight.js` class (without a
/// value means "no class" — render as plain text).
#[derive(Clone, Serialize)]
pub struct Token {
    #[serde(rename = "c", skip_serializing_if = "Option::is_none")]
    pub class: Option<&'static str>,
    #[serde(rename = "t")]
    pub text: String,
}

/// One line for the viewer: `tokens` when the doc is highlighted, else raw
/// `text`. Exactly one is set.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocLine {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<Vec<Token>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// `open_doc` result: metadata, plus — for normal-sized text docs — every line
/// inline so the viewer paints in one round-trip. `lines` is `None` for docs the
/// viewer pages instead (over `INLINE_MAX_LINES`) and for binary / too-large docs
/// (nothing to show).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocOpen {
    pub meta: DocMeta,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines: Option<Vec<DocLine>>,
}

struct CachedDoc {
    mtime: Option<SystemTime>,
    size: u64,
    is_binary: bool,
    too_large: bool,
    /// True when tokens can be produced (text, within the highlight size cap). A
    /// matching grammar may still not exist — then `tokens` resolves to `None`.
    highlightable: bool,
    /// Raw display lines (newline stripped). Empty for binary / too-large.
    lines: Vec<String>,
    /// Original text, kept only for highlightable docs so tokenization can run
    /// *lazily* — off the `open_doc` hot path, on first highlight request. Empty
    /// otherwise. This is what makes a normal file paint instantly: `open_doc`
    /// only splits lines; the expensive syntect parse happens after first paint.
    content: String,
    /// Per-line tokens, parallel to `lines`, computed once on first highlight
    /// request and cached. `Some(None)` means "computed: no grammar matched".
    tokens: OnceLock<Option<Vec<Vec<Token>>>>,
}

impl CachedDoc {
    fn meta(&self) -> DocMeta {
        DocMeta {
            line_count: self.lines.len(),
            highlightable: self.highlightable,
            too_large: self.too_large,
            is_binary: self.is_binary,
            size: self.size,
        }
    }

    fn clamp(&self, start: usize, end: usize, len: usize) -> (usize, usize) {
        let n = len.min(self.lines.len());
        let start = start.min(n);
        (start, end.min(n).max(start))
    }

    /// Plain (uncolored) display lines for `[start, end)` — instant, no
    /// tokenization. Used by `open_doc` for the first paint and as the fallback
    /// when a doc has no grammar.
    fn plain_range(&self, start: usize, end: usize) -> Vec<DocLine> {
        let (start, end) = self.clamp(start, end, self.lines.len());
        self.lines[start..end]
            .iter()
            .map(|l| DocLine {
                tokens: None,
                text: Some(l.clone()),
            })
            .collect()
    }
}

/// Tokenizer + cache, managed as Tauri state. The `SyntaxSet` is built once
/// (it's expensive) and shared; the cache is keyed by absolute path.
pub struct Highlighter {
    syntaxes: SyntaxSet,
    cache: Mutex<HashMap<String, Arc<CachedDoc>>>,
}

impl Highlighter {
    pub fn new() -> Self {
        Self {
            // `two_face`'s extended set (bat's curated, permissive-only grammars)
            // rather than `SyntaxSet::load_defaults_newlines()`: the bundled
            // syntect defaults omit TypeScript/TSX/JSX, so .ts/.tsx files matched
            // no grammar and rendered as plain text (a uniform wall of the theme's
            // foreground color). The extended set carries those grammars, and is
            // also `_newlines` so `ParseState` still gets its trailing '\n'.
            syntaxes: two_face::syntax::extra_newlines(),
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// Fetch the cached doc if its mtime still matches, else `None`.
    fn cached_fresh(&self, path: &str, mtime: Option<SystemTime>) -> Option<Arc<CachedDoc>> {
        let cache = self.cache.lock().unwrap();
        cache.get(path).cloned().filter(|d| d.mtime == mtime)
    }

    /// Build (or rebuild) the cache entry for `path` and return it. Reads and
    /// tokenizes *outside* the cache lock so concurrent opens of other files
    /// aren't serialized behind a large tokenization.
    fn load(&self, path: &str) -> Result<Arc<CachedDoc>, String> {
        let meta = fs::metadata(path).map_err(|e| format!("{path}: {e}"))?;
        let size = meta.len();
        let mtime = meta.modified().ok();

        if let Some(doc) = self.cached_fresh(path, mtime) {
            return Ok(doc);
        }

        let doc = self.build(path, size, mtime)?;
        let arc = Arc::new(doc);
        self.cache
            .lock()
            .unwrap()
            .insert(path.to_string(), arc.clone());
        Ok(arc)
    }

    /// Read + split a file into display lines. Deliberately does **not** tokenize
    /// here (that's the syntect parse); tokens are produced lazily by `tokens()`
    /// on the first highlight request, then cached. With warmed grammars under the
    /// oniguruma backend that first parse is fast enough that `open_doc` runs it
    /// inline (off the UI thread) and returns colored lines, so the viewer never
    /// shows an uncolored frame.
    fn build(&self, path: &str, size: u64, mtime: Option<SystemTime>) -> Result<CachedDoc, String> {
        let base = CachedDoc {
            mtime,
            size,
            is_binary: false,
            too_large: false,
            highlightable: false,
            lines: Vec::new(),
            content: String::new(),
            tokens: OnceLock::new(),
        };

        if size > MAX_DOC_BYTES {
            return Ok(CachedDoc {
                too_large: true,
                ..base
            });
        }

        let bytes = fs::read(path).map_err(|e| format!("{path}: {e}"))?;
        // A NUL byte is the cheap, reliable "not text" signal editors use.
        if bytes.contains(&0) {
            return Ok(CachedDoc {
                is_binary: true,
                ..base
            });
        }
        let content = match String::from_utf8(bytes) {
            Ok(s) => s,
            // Non-UTF-8 → treat as binary rather than mangling it.
            Err(_) => {
                return Ok(CachedDoc {
                    is_binary: true,
                    ..base
                })
            }
        };

        let lines = split_display_lines(&content);
        // Highlightable iff it's text within the size cap; a matching grammar is
        // checked lazily. Keep `content` only when highlightable (for the lazy
        // tokenize); drop it otherwise so a huge plain file isn't held twice.
        let highlightable = size <= MAX_HIGHLIGHT_BYTES;
        Ok(CachedDoc {
            highlightable,
            content: if highlightable { content } else { String::new() },
            lines,
            ..base
        })
    }

    /// The doc's per-line tokens, computed once on first call and cached. `None`
    /// when the doc isn't highlightable or no grammar matched (caller renders
    /// plain text). Heavy (syntect parse) — only ever reached off the UI thread
    /// via the `(async)` `doc_highlight` / `doc_lines` commands.
    fn tokens<'a>(&self, path: &str, doc: &'a CachedDoc) -> Option<&'a Vec<Vec<Token>>> {
        doc.tokens
            .get_or_init(|| {
                if !doc.highlightable {
                    return None;
                }
                self.tokenize(path, &doc.content)
            })
            .as_ref()
    }

    /// Highlighted display lines for `[start, end)`, or `None` if the doc can't
    /// be highlighted (no grammar / too large) — caller falls back to plain.
    fn highlighted_range(
        &self,
        path: &str,
        doc: &CachedDoc,
        start: usize,
        end: usize,
    ) -> Option<Vec<DocLine>> {
        let toks = self.tokens(path, doc)?;
        let (start, end) = doc.clamp(start, end, toks.len());
        Some(
            toks[start..end]
                .iter()
                .map(|t| DocLine {
                    tokens: Some(t.clone()),
                    text: None,
                })
                .collect(),
        )
    }

    /// Tokenize `content` line-by-line into `highlight.js`-classed runs. Returns
    /// `None` if no syntax matches (caller falls back to plain text). The result
    /// is parallel to `split_display_lines(content)`.
    fn tokenize(&self, path: &str, content: &str) -> Option<Vec<Vec<Token>>> {
        let syntax = self
            .syntaxes
            .find_syntax_for_file(path)
            .ok()
            .flatten()
            .or_else(|| self.syntax_for_alias(path))
            .or_else(|| self.syntaxes.find_syntax_by_first_line(content))?;
        // The plain-text syntax produces no useful classes — treat as unhighlighted.
        if syntax.name == self.syntaxes.find_syntax_plain_text().name {
            return None;
        }

        let mut state = ParseState::new(syntax);
        let mut stack = ScopeStack::new();
        let mut out: Vec<Vec<Token>> = Vec::new();

        // `_newlines` syntaxes expect a trailing '\n'; feed it but strip it from
        // emitted text so the renderer controls line breaks.
        for line in content.split_inclusive('\n') {
            let ops = match state.parse_line(line, &self.syntaxes) {
                Ok(ops) => ops,
                // A grammar error shouldn't blank the file — emit the line plain.
                Err(_) => {
                    out.push(vec![Token {
                        class: None,
                        text: strip_newline(line).to_string(),
                    }]);
                    continue;
                }
            };

            let mut tokens: Vec<Token> = Vec::new();
            let mut last = 0usize;
            for (idx, op) in ops {
                if idx > last {
                    push_run(&mut tokens, class_for(&stack), &line[last..idx]);
                }
                let _ = stack.apply(&op);
                last = idx;
            }
            if last < line.len() {
                push_run(&mut tokens, class_for(&stack), &line[last..]);
            }
            if tokens.is_empty() {
                tokens.push(Token {
                    class: None,
                    text: String::new(),
                });
            }
            out.push(tokens);
        }
        Some(out)
    }

    /// Extension aliases the bundled grammars don't claim themselves. The TS/JS
    /// grammars list only their canonical extensions (`tsx`, `ts`, `js`), so
    /// common variants would match no grammar and fall back to plain text. `.jsx`
    /// uses the React grammar — it handles both JSX tags and plain JS — and the
    /// ESM/CJS module extensions reuse the JavaScript grammar.
    fn syntax_for_alias(&self, path: &str) -> Option<&SyntaxReference> {
        let ext = std::path::Path::new(path).extension()?.to_str()?;
        let name = match ext {
            "jsx" => "TypeScriptReact",
            "mjs" | "cjs" => "JavaScript",
            _ => return None,
        };
        self.syntaxes.find_syntax_by_name(name)
    }

    /// Pre-compile the per-grammar regexes off the hot path so the first real
    /// open of a language is as fast as possible.
    ///
    /// syntect compiles each grammar pattern *lazily, the first time that
    /// construct is encountered*, so a trivial one-liner warms only a fraction of
    /// a grammar — the real file then pays the rest. The hot samples below are
    /// therefore deliberately rich (JSX, generics, hooks, strings, template
    /// literals, regex literals, comments) so the whole grammar compiles up front.
    /// With the oniguruma backend the difference is small but real (measured
    /// TypeScriptReact, debug: ~41 ms cold → ~10 ms warmed), and warming costs
    /// little (~100 ms total), so it's worth doing — and it was load-bearing under
    /// the old fancy-regex backend, where cold was ~2.4 s.
    ///
    /// Safe on a background thread: `tokenize` is `&self`, and the compiled-regex
    /// cache lives in the shared, `Sync` `SyntaxSet` (already used concurrently by
    /// the async commands), so warming the managed instance is visible to — and
    /// safe to race with — later command calls.
    pub fn warm_common(&self) {
        // The hot grammars: by far the most expensive compile and the most-opened
        // here. `.tsx`/`.jsx` share one grammar (TypeScriptReact) and
        // `.js`/`.mjs`/`.cjs` share JavaScript, so these three samples cover the
        // whole TS/JS family. Each sample is rich enough to compile essentially
        // the entire grammar (see above).
        const HOT: &[(&str, &str)] = &[
            ("warm.tsx", RICH_TSX),
            ("warm.ts", RICH_TS),
            ("warm.js", RICH_JS),
        ];
        // Compile the hot grammars in parallel so *all* of them are ready as fast
        // as possible (not serialized behind one another), shrinking the window in
        // which an early open could still pay a compile. Scoped threads let the
        // closures borrow `&self`; they all join before `warm_common` returns.
        std::thread::scope(|s| {
            for (path, body) in HOT {
                s.spawn(move || {
                    let _ = self.tokenize(path, body);
                });
            }
        });

        // The rest compile cheaply; a one-liner is plenty and keeps startup work
        // small. Best-effort — a sample that matches no grammar is simply skipped.
        const REST: &[(&str, &str)] = &[
            ("a.json", "{\"k\":1}\n"),
            ("a.rs", "fn main() {}\n"),
            ("a.py", "x = 1\n"),
            ("a.md", "# h\n"),
            ("a.html", "<a href=\"#\">x</a>\n"),
            ("a.css", "a { color: red; }\n"),
            ("a.toml", "k = 1\n"),
            ("a.yaml", "k: 1\n"),
            ("a.sh", "echo hi\n"),
        ];
        for (path, content) in REST {
            let _ = self.tokenize(path, content);
        }
    }
}

impl Default for Highlighter {
    fn default() -> Self {
        Self::new()
    }
}

// Representative warm samples for the hot grammars (see `warm_common`). They
// only need to *exercise* each grammar's common constructs so its regexes
// compile — they don't need to be meaningful or even fully valid code.
const RICH_TSX: &str = r#"// warm
import React, { useState, useEffect } from "react";
import type { Foo } from "./foo";
interface Props<T> { items: readonly T[]; onSelect?: (x: T) => void; label: string; }
const RE = /^[a-z]+\d*$/gi;
export function List<T extends { id: string }>({ items, onSelect, label }: Props<T>) {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => { console.log(`mounted ${items.length} for ${label}`); }, [items]);
  return (
    <div className="list" data-count={items.length}>
      <h2>{label}</h2>
      {items.map((it) => (
        <button key={it.id} onClick={() => { setActive(it.id); onSelect?.(it); }}>
          {it.id === active ? "* " : ""}{String(it.id)}
        </button>
      ))}
    </div>
  );
}
"#;

const RICH_TS: &str = r#"// warm
import type { Foo } from "./foo";
type Id = string | number;
enum Kind { A, B, C }
interface Box<T> { id: Id; items: readonly T[]; load?: (x: T) => Promise<void>; }
const RE = /^\d+(\.\d+)?$/g;
export async function find<T extends { id: Id }>(b: Box<T>, id: Id): Promise<T | null> {
  const label = `box ${b.id} has ${b.items.length}`;
  for (const it of b.items) { if (it.id === id) return it; }
  return null;
}
"#;

const RICH_JS: &str = r#"// warm
import { x } from "./mod";
const RE = /^[a-z]+$/gi;
export function build(a, b = 1, ...rest) {
  const label = `v ${a} ${b} ${rest.length}`;
  const obj = { a, b, sum() { return [a, b, ...rest].reduce((s, n) => s + n, 0); } };
  return [a, b].map((v) => v * 2).filter((v) => v > 0 && obj.sum() > 0);
}
"#;

/// Split into the lines a viewer displays: newline-delimited, with no phantom
/// trailing blank line for a file that ends in '\n'. Mirrors `split_inclusive`'s
/// line count so token rows stay parallel to display rows.
fn split_display_lines(content: &str) -> Vec<String> {
    content
        .split_inclusive('\n')
        .map(|l| strip_newline(l).to_string())
        .collect()
}

fn strip_newline(s: &str) -> &str {
    s.strip_suffix('\n')
        .map(|s| s.strip_suffix('\r').unwrap_or(s))
        .unwrap_or(s)
}

/// Append `text` (newline trimmed) to `tokens`, coalescing with the previous run
/// when it carries the same class — fewer, larger runs mean fewer DOM nodes.
fn push_run(tokens: &mut Vec<Token>, class: Option<&'static str>, text: &str) {
    let text = strip_newline(text);
    if text.is_empty() {
        return;
    }
    if let Some(last) = tokens.last_mut() {
        if last.class == class {
            last.text.push_str(text);
            return;
        }
    }
    tokens.push(Token {
        class,
        text: text.to_string(),
    });
}

/// Map the current scope stack to a `highlight.js` class. Walks the stack from
/// the most-specific (top) scope down, returning the first that maps to a class.
fn class_for(stack: &ScopeStack) -> Option<&'static str> {
    for scope in stack.as_slice().iter().rev() {
        if let Some(class) = scope_class(&scope.build_string()) {
            return Some(class);
        }
    }
    None
}

/// TextMate-style scope name → `highlight.js` class. Prefix-matched, most
/// specific first. Covers the common scopes; anything unmapped renders plain.
fn scope_class(scope: &str) -> Option<&'static str> {
    let m = |p: &str| scope == p || scope.starts_with(&format!("{p}."));
    if m("comment") || m("punctuation.definition.comment") {
        Some("hljs-comment")
    } else if m("constant.numeric") {
        Some("hljs-number")
    } else if m("constant.language") || m("support.constant") {
        Some("hljs-literal")
    } else if m("string") || m("constant.character.escape") {
        Some("hljs-string")
    } else if m("constant") {
        Some("hljs-literal")
    } else if m("entity.other.attribute-name") || m("support.type.property-name") {
        Some("hljs-attr")
    } else if m("keyword") || m("storage") {
        Some("hljs-keyword")
    } else if m("entity.name.function") || m("support.function") {
        Some("hljs-title")
    } else if m("entity.name.tag") {
        Some("hljs-name")
    } else if m("entity.name") || m("support.type") || m("support.class") {
        Some("hljs-type")
    } else if m("variable.language") {
        Some("hljs-keyword")
    } else if m("variable") {
        Some("hljs-variable")
    } else if m("meta.tag") {
        Some("hljs-tag")
    } else {
        None
    }
}

/// Open a document for the viewer: reads, splits lines, and — for normal-sized
/// docs (≤ `INLINE_MAX_LINES`) — returns every line inline, already **colored**,
/// so the viewer paints the highlighted file in a single round-trip. It never
/// ships an uncolored frame: the old "plain now, swap colors in later" path made
/// a file flash in the theme's flat foreground for however long the (cold) grammar
/// took to compile. Huge docs return `lines: None` and are paged via `doc_lines`.
///
/// `(async)` is load-bearing: reading a large file off disk *and* tokenizing it
/// must not land on the **main thread** (a plain `#[tauri::command]` would), which
/// would beach-ball the UI. `(async)` runs the body on a worker thread; the viewer
/// shows a brief "Loading…" only if the tokenize is slow (a cold grammar's
/// one-time regex compile), never a plain placeholder.
#[tauri::command(async)]
pub fn open_doc(
    path: String,
    hl: tauri::State<'_, Arc<Highlighter>>,
) -> Result<DocOpen, String> {
    let doc = hl.load(&path)?;
    let meta = doc.meta();
    // Inline the whole file, colored, for normal-sized text docs. Binary/too-large
    // have no displayable lines; docs past the cap page via `doc_lines` instead.
    // A doc with no matching grammar has nothing to color, so plain *is* its final
    // form (not a placeholder) — `highlighted_range` returns `None` and we page it
    // plain.
    let lines = if !meta.is_binary && !meta.too_large && meta.line_count <= INLINE_MAX_LINES {
        Some(
            hl.highlighted_range(&path, &doc, 0, meta.line_count)
                .unwrap_or_else(|| doc.plain_range(0, meta.line_count)),
        )
    } else {
        None
    };
    Ok(DocOpen { meta, lines })
}

/// Return display lines for `[start, end)` (clamped) — the paging path for docs
/// too large to inline. Lines carry `tokens` when the doc is highlightable, else
/// raw `text`. `(async)` so a first-window tokenize never lands on the main
/// thread.
#[tauri::command(async)]
pub fn doc_lines(
    path: String,
    start: usize,
    end: usize,
    hl: tauri::State<'_, Arc<Highlighter>>,
) -> Result<Vec<DocLine>, String> {
    let doc = hl.load(&path)?;
    Ok(hl
        .highlighted_range(&path, &doc, start, end)
        .unwrap_or_else(|| doc.plain_range(start, end)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_display_lines_has_no_phantom_trailing_blank() {
        assert_eq!(split_display_lines("a\nb\n"), vec!["a", "b"]);
        assert_eq!(split_display_lines("a\nb"), vec!["a", "b"]);
        assert_eq!(split_display_lines(""), Vec::<String>::new());
        assert_eq!(split_display_lines("\n"), vec![""]);
    }

    #[test]
    fn strip_newline_handles_crlf() {
        assert_eq!(strip_newline("x\r\n"), "x");
        assert_eq!(strip_newline("x\n"), "x");
        assert_eq!(strip_newline("x"), "x");
    }

    #[test]
    fn push_run_coalesces_same_class() {
        let mut t = Vec::new();
        push_run(&mut t, Some("hljs-string"), "foo");
        push_run(&mut t, Some("hljs-string"), "bar");
        push_run(&mut t, None, "baz");
        assert_eq!(t.len(), 2);
        assert_eq!(t[0].text, "foobar");
        assert_eq!(t[1].text, "baz");
    }

    #[test]
    fn push_run_skips_empty() {
        let mut t = Vec::new();
        push_run(&mut t, Some("hljs-keyword"), "");
        push_run(&mut t, Some("hljs-keyword"), "\n");
        assert!(t.is_empty());
    }

    #[test]
    fn scope_class_maps_common_scopes() {
        assert_eq!(scope_class("comment.line.double-slash.js"), Some("hljs-comment"));
        assert_eq!(scope_class("string.quoted.double.json"), Some("hljs-string"));
        assert_eq!(scope_class("constant.numeric.json"), Some("hljs-number"));
        assert_eq!(scope_class("constant.language.json"), Some("hljs-literal"));
        assert_eq!(scope_class("keyword.control.rust"), Some("hljs-keyword"));
        assert_eq!(scope_class("source.json"), None);
    }

    #[test]
    fn tokenizes_json_into_classed_runs() {
        let hl = Highlighter::new();
        let tokens = hl
            .tokenize("data.json", "{\"n\": 42}\n")
            .expect("json grammar should match");
        assert_eq!(tokens.len(), 1, "one display line");
        let classes: Vec<Option<&str>> = tokens[0].iter().map(|t| t.class).collect();
        // The number must be classed; reconstructed text must be lossless.
        let text: String = tokens[0].iter().map(|t| t.text.as_str()).collect();
        assert_eq!(text, "{\"n\": 42}");
        assert!(
            classes.contains(&Some("hljs-number")),
            "expected a number token, got {classes:?}"
        );
    }

    #[test]
    fn warm_common_runs_and_warms_the_hot_grammars() {
        // Exercises the parallel (scoped-thread) warm path: it must not panic, and
        // the hot grammars must tokenize into classed runs afterward.
        let hl = Highlighter::new();
        hl.warm_common();
        let toks = hl
            .tokenize("after_warm.tsx", "const App = () => <div>hi</div>;\n")
            .expect("tsx grammar after warm");
        assert!(toks.iter().flatten().any(|t| t.class.is_some()));
    }

    #[test]
    fn tokenizes_typescript_family_into_classed_runs() {
        // Regression guard: syntect's bundled defaults lack TS/TSX/JSX grammars,
        // so these used to match nothing and render as uniform plain text. The
        // extended `two_face` set must color them. Assert each yields a keyword.
        let hl = Highlighter::new();
        for (path, src) in [
            ("a.ts", "const x: number = 1;\n"),
            ("a.tsx", "const App = () => <div>hi</div>;\n"),
            ("a.jsx", "const App = () => <div>hi</div>;\n"),
        ] {
            let tokens = hl
                .tokenize(path, src)
                .unwrap_or_else(|| panic!("{path}: expected a grammar match, got plain text"));
            let classes: Vec<Option<&str>> =
                tokens.iter().flatten().map(|t| t.class).collect();
            assert!(
                classes.iter().any(|c| c.is_some()),
                "{path}: expected classed tokens, got all-plain {classes:?}"
            );
            // Reconstructed text must be lossless (line-joined).
            let text: String = tokens
                .iter()
                .map(|line| line.iter().map(|t| t.text.as_str()).collect::<String>())
                .collect::<Vec<_>>()
                .join("\n");
            assert_eq!(text, strip_newline(src));
        }
    }

    #[test]
    fn open_doc_inlines_small_file_and_pages_large() {
        use std::io::Write;
        let dir = std::env::temp_dir();
        let hl = Highlighter::new();

        // Normal-sized file: open_doc inlines every line (one round-trip) and —
        // since this is the path open_doc takes — they arrive already COLORED, so
        // the viewer never paints an uncolored frame.
        let small = dir.join("redline_hl_inline_small.json");
        std::fs::write(&small, b"{\n  \"a\": 1\n}\n").unwrap();
        let doc = hl.load(small.to_str().unwrap()).unwrap();
        let meta = doc.meta();
        assert!(meta.line_count <= INLINE_MAX_LINES);
        assert!(meta.highlightable, "a small json is highlightable");
        let lines = hl
            .highlighted_range(small.to_str().unwrap(), &doc, 0, meta.line_count)
            .expect("a grammar matches → open_doc returns colored inline lines");
        assert_eq!(lines.len(), meta.line_count, "inline lines cover the whole doc");
        assert!(
            lines.iter().any(|l| l.tokens.is_some()),
            "inline lines carry tokens (colored), not plain text"
        );

        // Past the cap: open_doc returns no inline lines; the viewer pages it.
        let big = dir.join("redline_hl_inline_big.txt");
        let mut f = std::fs::File::create(&big).unwrap();
        for _ in 0..(INLINE_MAX_LINES + 10) {
            writeln!(f, "x").unwrap();
        }
        drop(f);
        let big_doc = hl.load(big.to_str().unwrap()).unwrap();
        assert!(big_doc.meta().line_count > INLINE_MAX_LINES);

        let _ = std::fs::remove_file(&small);
        let _ = std::fs::remove_file(&big);
    }

    fn doc_of(lines: &[&str]) -> CachedDoc {
        CachedDoc {
            mtime: None,
            size: 0,
            is_binary: false,
            too_large: false,
            highlightable: false,
            lines: lines.iter().map(|s| s.to_string()).collect(),
            content: String::new(),
            tokens: OnceLock::new(),
        }
    }

    #[test]
    fn plain_range_clamps_out_of_range() {
        let doc = doc_of(&["a", "b"]);
        // Out-of-range window clamps to empty without panicking.
        assert!(doc.plain_range(5, 9).is_empty());
        // A partial window returns only the in-bounds lines, as plain text.
        let got = doc.plain_range(1, 9);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].text.as_deref(), Some("b"));
        assert!(got[0].tokens.is_none());
    }

    #[test]
    fn highlight_is_lazy_and_falls_back_to_plain_without_a_grammar() {
        let hl = Highlighter::new();
        let dir = std::env::temp_dir();

        // A real grammar → highlighted_range yields classed tokens.
        let json = dir.join("redline_hl_lazy.json");
        std::fs::write(&json, b"{\"n\": 42}\n").unwrap();
        let doc = hl.load(json.to_str().unwrap()).unwrap();
        let hi = hl
            .highlighted_range(json.to_str().unwrap(), &doc, 0, doc.lines.len())
            .expect("json is highlightable");
        assert!(hi[0].tokens.is_some());

        // No grammar (unknown extension) → None, so the viewer keeps plain text.
        let unknown = dir.join("redline_hl_lazy.zzz");
        std::fs::write(&unknown, b"just some text\n").unwrap();
        let udoc = hl.load(unknown.to_str().unwrap()).unwrap();
        assert!(udoc.meta().highlightable, "small text file is highlightable");
        assert!(
            hl.highlighted_range(unknown.to_str().unwrap(), &udoc, 0, udoc.lines.len())
                .is_none(),
            "no grammar → no tokens → plain fallback"
        );

        let _ = std::fs::remove_file(&json);
        let _ = std::fs::remove_file(&unknown);
    }
}
