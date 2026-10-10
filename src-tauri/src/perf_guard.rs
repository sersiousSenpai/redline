// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Perf-budget regression guards (see `docs/perf-budget.md`).
//!
//! The governing rule: *the WebView main thread renders; it never computes or
//! buffers unboundedly.* These tests fail if a known regression sneaks back in —
//! a heavy command losing its `(async)` marker (freezes the UI on the main
//! thread), or the PTY output stream or a streamed reply's deltas reverting to
//! a per-read firehose. They are
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
    fn browser_persistence_and_hook_watches_stay_off_the_ui_thread() {
        let workspace = include_str!("browser_workspace.rs");
        for command in ["browser_workspace_read", "browser_workspace_write", "browser_workspace_list", "browser_workspace_delete"] {
            assert_async_command(workspace, "browser_workspace.rs", command);
        }
        assert_async_command(include_str!("mission.rs"), "mission.rs", "mission_add_finding");
        for command in ["watch_hook_conflicts", "unwatch_hook_conflicts"] {
            assert_async_command(include_str!("hook_conflicts.rs"), "hook_conflicts.rs", command);
        }
    }

    #[test]
    fn capture_recovery_stays_after_the_first_actionable_frame() {
        let startup = include_str!("lib.rs");
        assert!(!startup.contains("mission_capture::resume("), "OCR recovery must not run in setup");
        let postboot = include_str!("postboot.rs");
        let ready = postboot.find("boot_trace::mark(boot_trace::POST_BOOT_DONE)").unwrap();
        let recovery = postboot.find("crate::mission_capture::resume(").unwrap();
        assert!(recovery > ready, "OCR recovery starts after boot readiness and the window reveal");
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

    /// The cwd polls fork `lsof` — per call for `pty_cwd`, once for the whole
    /// fleet for `pty_cwds` (the batched twin the tile grid polls every tick).
    /// `pty_procs` (the wall's foreground program and ports) forks one `ps`
    /// and one `lsof` for the whole fleet. A subprocess fork on the WebView
    /// main thread is exactly perf-budget rule 4.
    #[test]
    fn heavy_pty_cwd_commands_stay_async() {
        let src = include_str!("pty.rs");
        assert_async_command(src, "pty.rs", "pty_cwd");
        assert_async_command(src, "pty.rs", "pty_cwds");
        assert_async_command(src, "pty.rs", "pty_procs");
    }

    /// Rule 5: what the wall polls scales per call, never per terminal. One
    /// `ps` table and one `lsof` for every terminal, and the ancestry walk
    /// reads that table instead of forking `ps` per hop (`ppid_of`).
    #[test]
    fn pty_procs_forks_twice_for_the_whole_fleet() {
        let src = include_str!("pty.rs");
        let start = src.find("pub fn pty_procs(").unwrap();
        let body = &src[start..start + src[start..].find("\n}\n").unwrap()];
        assert_eq!(body.matches("Command::new(").count(), 2, "{body}");
        assert!(!body.contains("ppid_of"), "the walk must read the snapshot, not fork per hop");
        let assemble = &src[src.find("fn term_procs(").unwrap()..];
        assert!(!assemble[..assemble.find("\n}\n").unwrap()].contains("Command::new("));
    }

    /// The Localhost dashboard's scan forks three subprocesses and reads
    /// project roots off disk, on a poll — squarely the shape that must never
    /// run on the WebView main thread.
    #[test]
    fn heavy_devmap_commands_stay_async() {
        let src = include_str!("devmap.rs");
        assert_async_command(src, "devmap.rs", "dev_servers_scan");
        assert_async_command(src, "devmap.rs", "dev_server_stop");
        assert_async_command(src, "devmap.rs", "dev_server_stop_plan");
        assert_async_command(src, "devmap.rs", "dev_server_probe");
    }

    /// Uninstalling an extension deletes its directory tree from disk —
    /// filesystem work that must not run on the WebView main thread. (The
    /// command lives in lib.rs as a private fn, so the assertion is spelled
    /// inline rather than through `assert_async_command`'s `pub fn` shape.)
    #[test]
    fn extension_uninstall_stays_async() {
        let src = include_str!("lib.rs");
        assert!(
            src.contains("#[tauri::command(async)]\nfn extension_uninstall"),
            "lib.rs: `extension_uninstall` must be `#[tauri::command(async)]` — \
             fs::remove_dir_all must not run on the WebView main thread \
             (see docs/perf-budget.md)"
        );
    }

    /// The marketplace commands fetch over the network, hash artifacts, and
    /// write extension dirs — none of it may run on the WebView main thread.
    /// (lib.rs-root commands are private `fn`, so the shapes are spelled
    /// inline, like `extension_uninstall` above.)
    #[test]
    fn marketplace_commands_stay_async() {
        let src = include_str!("lib.rs");
        for func in ["marketplace_index", "marketplace_install"] {
            assert!(
                src.contains(&format!("#[tauri::command(async)]\nasync fn {func}")),
                "lib.rs: `{func}` must be `#[tauri::command(async)]` — network \
                 fetch + sha256 + fs writes must not run on the WebView main \
                 thread (see docs/perf-budget.md)"
            );
        }
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
            "bookshelf_set_template",
            "bookshelf_touch_draft",
            "bookshelf_delete_draft",
            "bookshelf_delete_folder",
            "draft_source_import_file",
        ] {
            assert_async_command(src, "bookshelf.rs", func);
        }
    }

    /// `memory_status` backs the memory pill: a 60s poll, plus a re-read on
    /// every browse capture. It walks the ledger to verify the hash chain and
    /// aggregates compaction stats — on the main thread it froze the UI for the
    /// length of the walk, once a minute, forever.
    #[test]
    fn memory_status_stays_async() {
        let src = include_str!("lib.rs");
        assert_async_private_command(src, "lib.rs", "memory_status");
        // …and it must stay INCREMENTAL. The full re-hash belongs on the 6h
        // keeper watch, not on a poll.
        assert!(
            src.contains("verify_ledger_chain_incremental"),
            "lib.rs: `memory_status` must use the incremental chain verify — a \
             full re-hash per poll is the regression this guards \
             (see docs/perf-budget.md)"
        );
    }

    /// Every command a memory surface (pill, Memory inspector, Health, Catalog,
    /// Cosmos, Ask) calls takes the ONE shared `Mutex<Connection>` — the same
    /// lock a `VACUUM INTO` backup, the canary and embedding ticks hold for
    /// seconds. A sync command waits for it on the macOS main thread, and the
    /// app beach-balls (the 2026-09-29 diag: main thread inside
    /// `get_work_graph` → SQLite `pagerStress`). Pinned by name, so a refactor
    /// that drops one `(async)` fails here.
    #[test]
    fn memory_surface_commands_stay_async() {
        let lib = include_str!("lib.rs");
        for func in [
            "memory_catalog_health",
            "ledger_verify",
            "ledger_get_capture_external",
            "ledger_set_capture_external",
            "memory_embed_settings",
            "classmem_tree",
            "classmem_node",
            "classmem_proposals",
            "classmem_latest_run",
            "classmem_runs",
            "classmem_run",
            "classmem_revert_run",
            "ledger_list_events",
            "ledger_prompt_body",
            "mirror_status",
            "memory_forget",
            "memory_note_write",
        ] {
            assert_async_private_command(lib, "lib.rs", func);
        }
        let work = include_str!("work.rs");
        assert_async_command(work, "work.rs", "get_work_graph");
        assert_async_command(work, "work.rs", "work_ready_count");
        let memchat = include_str!("memchat.rs");
        assert_async_command(memchat, "memchat.rs", "memchat_thread");
        assert_async_command(memchat, "memchat.rs", "memchat_clear");
    }

    /// `memory_catalog_health` must not route through `MemoryApi::health()`,
    /// which re-hashes the whole ledger chain under the shared lock before it
    /// builds the catalog half the Health tab actually reads. And backups must
    /// vacuum off the shared lock.
    #[test]
    fn memory_health_and_backups_skip_the_shared_lock() {
        let lib = include_str!("lib.rs");
        let start = lib
            .find("fn memory_catalog_health")
            .expect("lib.rs: memory_catalog_health must exist");
        let body = &lib[start..start + lib[start..].find("\n}\n").unwrap()];
        assert!(
            !body.contains(".health()"),
            "memory_catalog_health must not call MemoryApi::health() — it walks the full chain"
        );
        let snap = lib.find("fn snapshot_database").expect("snapshot_database");
        let snap_body = &lib[snap..snap + lib[snap..].find("\n}\n").unwrap()];
        assert!(
            snap_body.contains("snapshot_off_lock") && !snap_body.contains(".snapshot_to("),
            "snapshot_database must VACUUM on its own connection (snapshot_off_lock)"
        );
    }

    /// The commands a surface polls or a click waits on, each of which reads
    /// SQLite (the Runs canvas and list, the orchestration drawer, a chat's
    /// build probe and meters, a browser chat's model pick, session reads) or
    /// the disk (an agent transcript tail, a restore's transcript scan, the
    /// install steps, the workspace and harness manifests). On the main
    /// thread every one of them waits behind whatever holds the database or
    /// the disk, and the UI waits with it. They run off it by name
    /// (`OFF_MAIN_COMMANDS`, or `IN_ORDER_COMMANDS` when their calls must
    /// keep their order), which costs no binary, where `(async)` costs ~11 KB
    /// a command.
    #[test]
    fn polled_and_db_commands_stay_off_the_main_thread() {
        let off_main = crate::codehealth::off_main_commands(include_str!("lib.rs"));
        for func in [
            "runner_list",
            "runner_get",
            "runner_graph_view",
            "runner_report",
            "runner_review",
            // The Runs list re-reads on every `orchestration-live` event.
            "list_orchestrations",
            "orchestration_snapshot",
            "orchestration_agent_tail",
            "companion_build_activity",
            "thread_meters",
            "plan_session_meter",
            "browse_thread_harness",
            "browse_thread_set_harness",
            // Polled through a launch handoff.
            "get_run_state",
            // Re-read on every turn while the activity panel is open; its
            // lazy schema check takes the writer.
            "monochat_traces",
            // Its liveness check takes each terminal's session lock, which PTY
            // I/O can hold.
            "term_attention_snapshot",
            "get_workspace",
            "save_workspace",
            "list_harnesses",
            "get_ui_prefs",
            "list_sessions",
            "get_session",
            "build_plan_snapshot",
            "prepare_restore",
            "memory_note_get",
            "memory_notes_list",
            "install_hook",
            "install_codex_hook",
            "install_codex_profile",
            "install_codex_skill",
            "install_skill",
        ] {
            assert!(
                off_main.iter().any(|name| name == func),
                "lib.rs: `{func}` must be in OFF_MAIN_COMMANDS — it must not run on \
                 the WebView main thread (see docs/perf-budget.md)"
            );
        }
    }

    /// Every customization gesture saves the workspace manifest without
    /// waiting for the last save, and the file is what the next launch loads.
    /// On the blocking pool two quick saves could land newest-first and leave
    /// the older layout on disk; taking turns by arrival ticket they can't. A
    /// command whose calls must keep their order is in that list and only
    /// that list.
    #[test]
    fn workspace_saves_keep_their_order_off_the_main_thread() {
        let lib = include_str!("lib.rs");
        let in_order = crate::codehealth::command_list(lib, "IN_ORDER_COMMANDS");
        let pool = crate::codehealth::command_list(lib, "OFF_MAIN_COMMANDS");
        assert!(in_order.iter().any(|name| name == "save_workspace"), "lib.rs: `save_workspace` must be in IN_ORDER_COMMANDS");
        for name in &in_order {
            assert!(!pool.contains(name), "lib.rs: `{name}` is in IN_ORDER_COMMANDS, so the pool must not run it too");
        }
        let handler = &lib[lib.find("fn off_main<").unwrap()..];
        let handler = &handler[..handler.find("\n}\n").unwrap()];
        assert!(
            handler.contains("IN_ORDER_COMMANDS\n            .contains(&command)") && handler.contains("in_turn(ticket, "),
            "lib.rs: off_main must ticket IN_ORDER_COMMANDS as they arrive and run each in its turn"
        );
    }

    /// The handler routes `OFF_MAIN_COMMANDS` and `IN_ORDER_COMMANDS` to the
    /// blocking pool, and every name there is a registered command: a name
    /// the generated handler doesn't know would be answered by nobody, and its
    /// caller would wait forever.
    #[test]
    fn off_main_commands_are_registered_and_routed() {
        let lib = include_str!("lib.rs");
        assert!(lib.contains(".invoke_handler(off_main(tauri::generate_handler!["));
        let handler = &lib[lib.find("generate_handler![").unwrap() + "generate_handler![".len()..];
        let registered: Vec<&str> = handler[..handler.find("])").unwrap()]
            .split(',')
            .filter_map(|entry| entry.trim().rsplit("::").next())
            .collect();
        let off_main = crate::codehealth::off_main_commands(lib);
        assert!(!off_main.is_empty());
        for name in &off_main {
            assert!(registered.contains(&name.as_str()), "lib.rs names `{name}` off the main thread, but it is not registered");
        }
    }

    /// Adding or removing a watch restarts the FSEvents stream. The commands
    /// stay sync so a mount's watch and its unmount's unwatch keep their
    /// order, which is why the restart itself must never be in their bodies:
    /// it belongs to the `fs-watch` thread.
    #[test]
    fn fs_watch_restarts_stay_off_the_main_thread() {
        let src = include_str!("fswatch.rs");
        for func in ["watch_dir", "unwatch_dir"] {
            let start = src.find(&format!("pub fn {func}(")).unwrap();
            let body = &src[start..start + src[start..].find("\n}\n").unwrap()];
            assert!(!body.contains(".watcher()"), "{func} must queue the stream change, not make it: {body}");
        }
        assert!(src.contains(".name(\"fs-watch\".into())"));
    }

    /// Run events name a run and its revision; they never carry the graph.
    /// A graph carries every node's output, and every mounted listener
    /// deserializes a broadcast whether it renders the run or not.
    #[test]
    fn run_events_carry_an_id_and_a_revision() {
        let runner = include_str!("runner.rs");
        assert!(runner.contains("app.emit(\"run-graph\", graph_event(g))"));
        for (file, src) in [
            ("runner.rs", runner),
            ("lib.rs", include_str!("lib.rs")),
            ("queue.rs", include_str!("queue.rs")),
            ("self_develop.rs", include_str!("self_develop.rs")),
        ] {
            for event in ["\"run-graph\"", "\"runner-changed\""] {
                for (at, _) in src.match_indices(&format!("emit({event}, ")) {
                    let arg = &src[at + event.len() + 7..];
                    assert!(
                        arg[..arg.find('(').unwrap_or(0)].ends_with("graph_event"),
                        "{file}: {event} must carry runner::graph_event, not the graph"
                    );
                }
            }
        }
    }

    /// Not a perf budget but the same mechanism: a source-shape invariant that
    /// a refactor could silently undo, with real stakes.
    ///
    /// `/v1/liveness` is how a booting sibling decides whether the instance on
    /// :7676 is a live app to defer to or a headless leftover to
    /// `POST /v1/admin/shutdown`. `webview_windows()` empties as soon as the
    /// browser pane attaches child webviews, so reading the count from it makes
    /// a live, windowed app answer `hasWindow:false` — and the next
    /// `npm run tauri dev` shuts it down with every hosted session inside it.
    #[test]
    fn liveness_counts_windows_not_webview_windows() {
        let src = include_str!("lib.rs");
        let start = src
            .find("async fn handle_liveness")
            .expect("lib.rs: handle_liveness must exist — it backs /v1/liveness");
        let body = &src[start..];
        let end = body
            .find("\n}\n")
            .expect("handle_liveness must be a closed fn");
        let body = &body[..end];
        assert!(
            !body.contains("webview_windows()"),
            "lib.rs: `handle_liveness` must not read `webview_windows()` — it \
             empties once the browser pane attaches child webviews, so a live \
             app would report hasWindow:false and be shut down by a booting \
             sibling's preflight"
        );
        assert!(
            body.contains(".windows()"),
            "lib.rs: `handle_liveness` must count real windows via `windows()`"
        );
    }

    /// Rule 7's readout: the renderer's footprint is watched for the life of
    /// the app and served on `/v1/perf`. Each is one line to lose in a
    /// refactor, and losing it is silent: the warning simply never comes.
    #[test]
    fn renderer_footprint_is_watched_and_served() {
        let postboot = include_str!("postboot.rs");
        assert!(
            postboot.contains("crate::renderer_memory::watch(app)"),
            "postboot.rs: start the renderer footprint watch after the reveal"
        );
        let lib = include_str!("lib.rs");
        let body = &lib[lib.find("async fn handle_perf(").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        assert!(
            body.contains("renderer_memory::current()") && body.contains("renderer_memory::note("),
            "lib.rs: `/v1/perf` must serve the renderer footprint and note a crossing"
        );
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

    /// A streamed reply's `{surface}-delta` events are a global `app.emit`,
    /// not a Channel — rule 3's documented exception, which holds only while
    /// `turn::DeltaPacer` coalesces them to one per 33 ms per turn. Every arm
    /// that receives a token must hand it to the pacer rather than emit it,
    /// and every reader must flush what the pacer holds before its terminal.
    #[test]
    fn streamed_reply_deltas_stay_coalesced() {
        let readers = [
            ("fork.rs", include_str!("fork.rs")),
            ("companion.rs", include_str!("companion.rs")),
            ("browse.rs", include_str!("browse.rs")),
            ("mission.rs", include_str!("mission.rs")),
            ("memchat.rs", include_str!("memchat.rs")),
            ("draft_chat.rs", include_str!("draft_chat.rs")),
            ("voice.rs", include_str!("voice.rs")),
            ("runner.rs", include_str!("runner.rs")),
            ("ai_review.rs", include_str!("ai_review.rs")),
        ];
        for (file, src) in readers {
            assert!(src.contains("DeltaPacer::default()"), "{file}: the reader must pace its deltas");
            assert!(
                src.contains("deltas.flush(") || src.contains("flush_output("),
                "{file}: the reader must flush held text before its terminal events"
            );
            // Each arm a reader receives one token's text in, up to its end.
            let arms = ["StreamLine::Delta(text) =>", "NodeEvent::Delta(text))=>", "Some(text) = step.delta"]
                .into_iter()
                .flat_map(|marker| src.split(marker).skip(1));
            for arm in arms {
                let arm = &arm[..arm.find('}').unwrap_or(arm.len())];
                assert!(
                    !arm.contains("app.emit(") && !arm.contains("push_delta("),
                    "{file}: a delta arm emits per token — hand it to the DeltaPacer:\n{arm}"
                );
                assert!(
                    arm.contains(".push(&text") || arm.contains("push_output("),
                    "{file}: a delta arm must feed the DeltaPacer:\n{arm}"
                );
            }
        }
    }
}
