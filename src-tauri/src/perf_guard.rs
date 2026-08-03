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
        assert_async_command(src, "highlight.rs", "doc_lines");
    }

    #[test]
    fn heavy_fsbrowse_commands_stay_async() {
        let src = include_str!("fsbrowse.rs");
        assert_async_command(src, "fsbrowse.rs", "list_dir");
        assert_async_command(src, "fsbrowse.rs", "read_text_file");
        assert_async_command(src, "fsbrowse.rs", "read_file_base64");
        assert_async_command(src, "fsbrowse.rs", "save_text_file");
        assert_async_command(src, "fsbrowse.rs", "ensure_dir");
    }

    /// A tab's repo mark walks ancestors looking for `.git`, then reads and
    /// hashes candidate image files — per terminal, on the poll that follows
    /// the shell's `cd`. Squarely the shape that must never run on the WebView
    /// main thread.
    #[test]
    fn heavy_repoicon_commands_stay_async() {
        let src = include_str!("repoicon.rs");
        assert_async_command(src, "repoicon.rs", "repo_icon");
    }

    /// The Localhost dashboard's scan forks three subprocesses and reads
    /// project roots off disk, on a poll — squarely the shape that must never
    /// run on the WebView main thread.
    #[test]
    fn heavy_devmap_commands_stay_async() {
        let src = include_str!("devmap.rs");
        assert_async_command(src, "devmap.rs", "dev_servers_scan");
        assert_async_command(src, "devmap.rs", "dev_server_stop");
    }

    /// Thumbnail capture waits on WebKit's completion handler and then encodes
    /// and writes a PNG. Blocking the WebView thread on any of that would
    /// freeze the app for the length of every capture.
    #[test]
    fn heavy_thumbs_commands_stay_async() {
        let src = include_str!("thumbs.rs");
        assert_async_command(src, "thumbs.rs", "browser_take_thumbnail");
        assert_async_command(src, "thumbs.rs", "thumbs_list");
        assert_async_command(src, "thumbs.rs", "thumbs_prune");
    }

    /// A private `fn` variant of `assert_async_command` — commands defined in
    /// `lib.rs` are module-private, not `pub`.
    fn assert_async_private_command(src: &str, file: &str, func: &str) {
        let plain = format!("#[tauri::command(async)]\nfn {func}");
        let already_async = format!("#[tauri::command(async)]\nasync fn {func}");
        assert!(
            src.contains(&plain) || src.contains(&already_async),
            "{file}: `{func}` must be `#[tauri::command(async)]` — heavy work must \
             not run on the WebView main thread (see docs/perf-budget.md)"
        );
    }

    /// The Bookshelf writes the document itself on the drafter's 400ms persist
    /// debounce — a full TipTap JSON serialize plus a SQLite upsert, per pause in
    /// typing. Squarely perf-budget rule 4, and the reason `drafter_set_doc` went
    /// `(async)` when the fidelity source moved out of localStorage. The digest
    /// probe in `codehealth::probe_command_hygiene` would flag a regression here
    /// too; this fails the build, which is faster.
    #[test]
    fn bookshelf_document_writes_stay_async() {
        let src = include_str!("lib.rs");
        assert_async_private_command(src, "lib.rs", "drafter_set_doc");
        assert_async_private_command(src, "lib.rs", "drafter_get_doc");
        // The Shipwright walks the repo and shells out to git before it spawns
        // anything — never on the main thread.
        assert_async_private_command(src, "lib.rs", "shipwright_agent");
    }

    /// Every Bookshelf command touches SQLite, and the two delete commands
    /// cascade across five tables. None may run on the WebView main thread.
    #[test]
    fn bookshelf_commands_stay_async() {
        let src = include_str!("bookshelf.rs");
        for func in [
            "bookshelf_list",
            "bookshelf_migrate_local",
            "bookshelf_new_draft",
            "bookshelf_delete_draft",
            "bookshelf_delete_folder",
            "draft_source_import_file",
        ] {
            assert_async_command(src, "bookshelf.rs", func);
        }
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
