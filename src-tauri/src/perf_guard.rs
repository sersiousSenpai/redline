// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Perf-budget regression guards (see `docs/perf-budget.md`).
//!
//! The governing rule: *the WebView main thread renders; it never computes or
//! buffers unboundedly.* These tests fail if a known regression sneaks back in —
//! a heavy command losing its `(async)` marker (freezes the UI on the main
//! thread), or the PTY output stream reverting to a per-read firehose. They are
//! cheap source-level invariants, not a substitute for the reviewer checklist in
//! the doc.

#[cfg(test)]
mod tests {
    /// A heavy `#[tauri::command]` (fs read / parse / encode) must declare
    /// `(async)` so its body runs on a worker thread, not the WebView main
    /// thread. We assert the attribute sits directly above the function.
    fn assert_async_command(src: &str, file: &str, func: &str) {
        let plain = format!("#[tauri::command(async)]\npub fn {func}");
        let already_async = format!("#[tauri::command(async)]\npub async fn {func}");
        assert!(
            src.contains(&plain) || src.contains(&already_async),
            "{file}: `{func}` must be `#[tauri::command(async)]` — heavy work must \
             not run on the WebView main thread (see docs/perf-budget.md)"
        );
    }

    #[test]
    fn heavy_highlight_commands_stay_async() {
        let src = include_str!("highlight.rs");
        assert_async_command(src, "highlight.rs", "open_doc");
        assert_async_command(src, "highlight.rs", "doc_highlight");
        assert_async_command(src, "highlight.rs", "doc_lines");
    }

    #[test]
    fn heavy_fsbrowse_commands_stay_async() {
        let src = include_str!("fsbrowse.rs");
        assert_async_command(src, "fsbrowse.rs", "list_dir");
        assert_async_command(src, "fsbrowse.rs", "read_text_file");
        assert_async_command(src, "fsbrowse.rs", "read_file_base64");
    }

    /// PTY output must stay batched over a per-terminal raw-byte Channel — never
    /// a per-read global event (`pty-output`), which is the firehose that froze
    /// the whole app. Guard the structural markers so a refactor can't silently
    /// restore it.
    #[test]
    fn pty_output_stays_batched_over_a_channel() {
        let src = include_str!("pty.rs");
        assert!(
            src.contains("on_output: Channel<Response>"),
            "pty.rs: PTY output must stream over a per-terminal raw-byte Channel"
        );
        assert!(
            src.contains("struct Coalescer"),
            "pty.rs: PTY reads must coalesce (batch) before reaching the frontend"
        );
        assert!(
            !src.contains("pty-output"),
            "pty.rs: the per-read `pty-output` event reintroduces the firehose \
             freeze — stream over the Channel instead"
        );
    }
}
