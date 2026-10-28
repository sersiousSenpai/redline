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
    /// A heavy `#[tauri::command]` (fs read / parse / encode / SQLite) must
    /// not run on the WebView main thread. A sync body goes to the blocking
    /// pool by name (`OFF_MAIN_COMMANDS`, which costs a string); a body that
    /// awaits is an `async fn`. `(async)` on a sync body also leaves the main
    /// thread, at ~8 KB of release binary a command, so
    /// `sync_commands_ride_the_pool_not_async_tasks` keeps it off sync bodies.
    /// The attribute must sit directly above the function, `pub` or not.
    fn assert_off_main_command(src: &str, file: &str, func: &str) {
        let pool = crate::codehealth::off_main_commands(include_str!("lib.rs"));
        let declared = |attr: &str, kind: &str| {
            ["pub ", ""].iter().any(|vis| {
                ["(", "<"].iter().any(|open| src.contains(&format!("{attr}\n{vis}{kind} {func}{open}")))
            })
        };
        let on_pool = pool.iter().any(|name| name == func) && declared("#[tauri::command]", "fn");
        let awaits = declared("#[tauri::command(async)]", "async fn") || declared("#[tauri::command]", "async fn");
        assert!(
            on_pool || awaits || declared("#[tauri::command(async)]", "fn"),
            "{file}: `{func}` must leave the WebView main thread — a sync body by name in \
             OFF_MAIN_COMMANDS, an awaiting one as an async fn (see docs/perf-budget.md)"
        );
    }

    /// The check itself: a sync command the pool does not name runs on the
    /// main thread, and must fail it.
    #[test]
    fn the_off_main_check_rejects_a_main_thread_command() {
        let src = "#[tauri::command]\npub fn not_pooled(id: String) {}\n";
        assert!(std::panic::catch_unwind(|| assert_off_main_command(src, "x.rs", "not_pooled")).is_err());
        let pooled = "#[tauri::command]\nfn list_sessions(store: State<'_, SessionStore>) {}\n";
        assert_off_main_command(pooled, "x.rs", "list_sessions");
        let awaits = "#[tauri::command(async)]\npub async fn fetch<R: Runtime>(app: AppHandle<R>) {}\n";
        assert_off_main_command(awaits, "x.rs", "fetch");
    }

    #[test]
    fn heavy_highlight_commands_stay_off_the_main_thread() {
        let src = include_str!("highlight.rs");
        assert_off_main_command(src, "highlight.rs", "open_doc");
        assert_off_main_command(src, "highlight.rs", "doc_lines");
        assert_off_main_command(src, "highlight.rs", "highlight_diff");
    }

    #[test]
    fn browser_persistence_and_hook_watches_stay_off_the_ui_thread() {
        let workspace = include_str!("browser_workspace.rs");
        for command in ["browser_workspace_read", "browser_workspace_write", "browser_workspace_list", "browser_workspace_delete"] {
            assert_off_main_command(workspace, "browser_workspace.rs", command);
        }
        assert_off_main_command(include_str!("mission.rs"), "mission.rs", "mission_add_finding");
        for command in ["scan_hook_conflicts", "remove_hook_conflicts", "watch_hook_conflicts", "unwatch_hook_conflicts"] {
            assert_off_main_command(include_str!("hook_conflicts.rs"), "hook_conflicts.rs", command);
        }
        // A page's appearance waits on its webview.
        assert_off_main_command(include_str!("browser_events.rs"), "browser_events.rs", "browser_set_appearance");
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
    fn heavy_fsbrowse_commands_stay_off_the_main_thread() {
        let src = include_str!("fsbrowse.rs");
        assert_off_main_command(src, "fsbrowse.rs", "list_dir");
        assert_off_main_command(src, "fsbrowse.rs", "read_text_file");
        assert_off_main_command(src, "fsbrowse.rs", "read_file_base64");
        assert_off_main_command(src, "fsbrowse.rs", "save_text_file");
        assert_off_main_command(src, "fsbrowse.rs", "save_attachment");
        assert_off_main_command(src, "fsbrowse.rs", "import_attachment");
    }

    /// A tab's repo mark walks ancestors looking for `.git`, then reads and
    /// hashes candidate image files — per terminal, on the poll that follows
    /// the shell's `cd`. Squarely the shape that must never run on the WebView
    /// main thread.
    #[test]
    fn heavy_repoicon_commands_stay_off_the_main_thread() {
        let src = include_str!("repoicon.rs");
        assert_off_main_command(src, "repoicon.rs", "repo_icon");
    }

    /// The cwd reads and the process table are kernel reads now (`libproc`),
    /// but `pty_procs` (the wall's foreground program and ports) still forks
    /// one `lsof` for the whole fleet, and all three walk the registry. A
    /// subprocess fork on the WebView main thread is exactly perf-budget
    /// rule 4.
    #[test]
    fn heavy_pty_cwd_commands_stay_off_the_main_thread() {
        let src = include_str!("pty.rs");
        assert_off_main_command(src, "pty.rs", "pty_cwd");
        assert_off_main_command(src, "pty.rs", "pty_cwds");
        assert_off_main_command(src, "pty.rs", "pty_procs");
        // …and the lifecycle: a spawn forks a shell, a kill reaps one.
        for func in ["pty_spawn", "pty_list", "pty_attach", "pty_detach", "pty_resize", "pty_kill", "pty_kill_all"] {
            assert_off_main_command(src, "pty.rs", func);
        }
        // Keystrokes keep their order by staying on the main thread.
        let pool = crate::codehealth::off_main_commands(include_str!("lib.rs"));
        for func in ["pty_write", "pty_ack"] {
            assert!(!pool.iter().any(|name| name == func), "pty.rs: `{func}` must stay on the main thread for byte order");
        }
    }

    /// Rule 5: what the wall polls scales per call, never per terminal — and
    /// since the 2026-10-27 idle-heat work, never forks for what the kernel
    /// will say. `pty_procs` forks exactly one `lsof` (the listening sockets)
    /// and reads the process table through `proc_pidinfo`; the ancestry walk
    /// reads that table instead of forking per hop; `pty_cwds` forks nothing.
    #[test]
    fn pty_procs_forks_once_for_the_whole_fleet() {
        let src = include_str!("pty.rs");
        let start = src.find("pub fn pty_procs(").unwrap();
        let body = &src[start..start + src[start..].find("\n}\n").unwrap()];
        assert_eq!(body.matches("Command::new(").count(), 1, "{body}");
        assert!(body.contains("libproc::table()"), "the process table is a kernel read");
        assert!(!body.contains("ppid_of"), "the walk must read the snapshot, not fork per hop");
        let assemble = &src[src.find("fn term_procs(").unwrap()..];
        assert!(!assemble[..assemble.find("\n}\n").unwrap()].contains("Command::new("));
        let cwds = src.find("pub fn pty_cwds(").unwrap();
        let cwds = &src[cwds..cwds + src[cwds..].find("\n}\n").unwrap()];
        assert!(!cwds.contains("Command::new("), "the cwd batch is a kernel read per shell: {cwds}");
    }

    /// The Localhost dashboard's scan forks three subprocesses and reads
    /// project roots off disk, on a poll — squarely the shape that must never
    /// run on the WebView main thread.
    #[test]
    fn heavy_devmap_commands_stay_off_the_main_thread() {
        let src = include_str!("devmap.rs");
        assert_off_main_command(src, "devmap.rs", "dev_servers_scan");
        assert_off_main_command(src, "devmap.rs", "dev_server_stop");
        assert_off_main_command(src, "devmap.rs", "dev_server_stop_plan");
        assert_off_main_command(src, "devmap.rs", "dev_server_probe");
    }

    /// Uninstalling an extension deletes its directory tree from disk —
    /// filesystem work that must not run on the WebView main thread.
    #[test]
    fn extension_uninstall_stays_off_the_main_thread() {
        assert_off_main_command(include_str!("lib.rs"), "lib.rs", "extension_uninstall");
    }

    /// The rest of lib.rs's disk, database, webview and probe work: the
    /// extension installs, the browser tab commands (each waits on a webview),
    /// the boot snapshot (two user-config trees), a plan's build marks and
    /// handoff file, the drafter's suggestions, the exports (a save dialog,
    /// then a write) and the install-status reads.
    #[test]
    fn lib_disk_and_webview_commands_stay_off_the_main_thread() {
        let lib = include_str!("lib.rs");
        for func in [
            "local_install_inspect",
            "local_install_confirm",
            "extension_reload",
            "browser_set_tabs",
            "browser_navigate",
            "browser_eval",
            "browser_url",
            "browser_set_view",
            "bootstrap_state",
            "mark_plan_build",
            "write_plan_handoff",
            "set_session_project",
            "resume_startup_cwd",
            "draft_suggestion_unresolve",
            "export_revision_markdown",
            "export_revision_docx",
            "save_revision_to_obsidian",
            "get_hook_status",
            "get_codex_hook_status",
            "get_codex_skill_status",
            "get_skill_status",
        ] {
            assert_off_main_command(lib, "lib.rs", func);
        }
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
    fn heavy_thumbs_commands_stay_off_the_main_thread() {
        let src = include_str!("thumbs.rs");
        assert_off_main_command(src, "thumbs.rs", "browser_take_thumbnail");
        assert_off_main_command(src, "thumbs.rs", "thumbs_list");
        assert_off_main_command(src, "thumbs.rs", "thumbs_prune");
        // The memory shots: a directory listing, a file delete, the policy and
        // the caption counts in SQLite.
        let shots = include_str!("shots.rs");
        for func in ["shots_list", "shot_forget", "shots_get_policy", "shots_set_policy", "shots_caption_backlog"] {
            assert_off_main_command(shots, "shots.rs", func);
        }
    }

    /// The Bookshelf writes the document itself on the drafter's 400ms persist
    /// debounce — a full TipTap JSON serialize plus a SQLite upsert, per pause in
    /// typing. Squarely perf-budget rule 4, and the reason `drafter_set_doc` left
    /// the main thread when the fidelity source moved out of localStorage. The digest
    /// probe in `codehealth::probe_command_hygiene` would flag a regression here
    /// too; this fails the build, which is faster.
    #[test]
    fn bookshelf_document_writes_stay_off_the_main_thread() {
        let src = include_str!("lib.rs");
        assert_off_main_command(src, "lib.rs", "drafter_set_doc");
        assert_off_main_command(src, "lib.rs", "drafter_get_doc");
        // The Shipwright walks the repo and shells out to git before it spawns
        // anything — never on the main thread.
        assert_off_main_command(src, "lib.rs", "shipwright_agent");
    }

    /// Every Bookshelf command touches SQLite, and the two delete commands
    /// cascade across five tables. None may run on the WebView main thread:
    /// each is sync in shape and runs on the blocking pool by name.
    #[test]
    fn bookshelf_commands_stay_off_the_main_thread() {
        let src = include_str!("bookshelf.rs");
        let off_main = crate::codehealth::off_main_commands(include_str!("lib.rs"));
        let commands: Vec<&str> = src
            .split("#[tauri::command]")
            .skip(1)
            .filter_map(|after| after.split("pub fn ").nth(1)?.split('(').next())
            .collect();
        for known in ["bookshelf_list", "bookshelf_delete_folder", "draft_source_import_file"] {
            assert!(commands.contains(&known), "bookshelf.rs: the command scan missed `{known}`");
        }
        for func in commands {
            assert!(
                off_main.iter().any(|name| name == func),
                "bookshelf.rs: `{func}` must be in OFF_MAIN_COMMANDS — it must not run on \
                 the WebView main thread (see docs/perf-budget.md)"
            );
        }
        assert!(!src.contains("#[tauri::command(async)]"), "bookshelf.rs: the pool route costs a string, `(async)` ~11 KB");
    }

    /// `memory_status` backs the memory pill: a 60s poll, plus a re-read on
    /// every browse capture. It walks the ledger to verify the hash chain and
    /// aggregates compaction stats — on the main thread it froze the UI for the
    /// length of the walk, once a minute, forever.
    #[test]
    fn memory_status_stays_off_the_main_thread() {
        let src = include_str!("lib.rs");
        assert_off_main_command(src, "lib.rs", "memory_status");
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
    /// that puts one back on the main thread fails here. The mirror's commands
    /// write the vault on disk (and two ask for its folder first).
    #[test]
    fn memory_surface_commands_stay_off_the_main_thread() {
        let lib = include_str!("lib.rs");
        for func in [
            "memory_catalog_health",
            "ledger_verify",
            "ledger_get_capture_external",
            "ledger_set_capture_external",
            "memory_embed_settings",
            "memory_set_embed_provider",
            "classmem_tree",
            "classmem_node",
            "classmem_proposals",
            "classmem_latest_run",
            "classmem_runs",
            "classmem_run",
            "classmem_revert_run",
            "ledger_list_events",
            "ledger_prompt_body",
            "ledger_prompt_models",
            "ledger_query",
            "context_stats",
            "context_thread_tree",
            "memory_map",
            "memory_forget",
            "memory_note_write",
            "export_context_bundle",
            "mirror_status",
            "mirror_sync",
            "mirror_rebuild",
            "set_mirror_dir",
            "pick_mirror_dir",
            "create_memory_vault",
        ] {
            assert_off_main_command(lib, "lib.rs", func);
        }
        let work = include_str!("work.rs");
        assert_off_main_command(work, "work.rs", "get_work_graph");
        assert_off_main_command(work, "work.rs", "work_ready_count");
        let memchat = include_str!("memchat.rs");
        assert_off_main_command(memchat, "memchat.rs", "memchat_thread");
        assert_off_main_command(memchat, "memchat.rs", "memchat_clear");
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
    /// SQLite (a chat's build probe and meters, a browser chat's model pick, session reads) or
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
            "companion_build_activity",
            "thread_meters",
            "browse_thread_harness",
            "browse_thread_set_harness",
            // Re-read on every turn while the activity panel is open.
            "monochat_traces",
            // Its liveness check takes each terminal's session lock, which PTY
            // I/O can hold.
            "term_attention_snapshot",
            "save_workspace",
            "list_harnesses",
            "get_ui_prefs",
            "list_sessions",
            "get_session",
            "build_plan_snapshot",
            "prepare_restore",
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
        // A comment add, edit and delete wait on the database writer, and an
        // edit sent right after its add must not overtake it.
        for name in ["save_workspace", "add_comment", "update_comment", "delete_comment"] {
            assert!(in_order.iter().any(|n| n == name), "lib.rs: `{name}` must be in IN_ORDER_COMMANDS");
        }
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

    /// `(async)` on a sync body, or an `async fn` command that never awaits,
    /// builds a tokio task type for that one command: ~11 KB of release binary
    /// each (docs/perf-budget.md rule 4). A sync body goes in
    /// OFF_MAIN_COMMANDS instead, for the cost of a string, so an async
    /// command is one that awaits.
    #[test]
    fn sync_commands_ride_the_pool_not_async_tasks() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let (mut async_commands, mut offenders) = (0, Vec::new());
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_none_or(|ext| ext != "rs") {
                continue;
            }
            let src = std::fs::read_to_string(&path).unwrap();
            async_commands += async_task_offenders(&path.file_name().unwrap().to_string_lossy(), &src, &mut offenders);
        }
        assert!(async_commands > 10, "the scan found almost no async commands: it is not reading the sources");
        assert!(offenders.is_empty(), "name these in OFF_MAIN_COMMANDS as plain sync commands: {offenders:#?}");
    }

    /// One file's share of that scan: pushes each `(async)` sync body and each
    /// `async fn` command that never awaits, and returns how many async
    /// commands it read.
    fn async_task_offenders(file: &str, src: &str, offenders: &mut Vec<String>) -> usize {
        let lines: Vec<&str> = src.lines().collect();
        let mut async_commands = 0;
        for (i, line) in lines.iter().enumerate() {
            if !matches!(line.trim(), "#[tauri::command(async)]" | "#[tauri::command]") {
                continue;
            }
            let Some(at) = lines[i + 1..].iter().position(|l| l.contains("fn ")) else { continue };
            let signature = lines[i + 1 + at];
            if !signature.contains("async fn ") {
                if line.trim() != "#[tauri::command]" {
                    offenders.push(format!("{file}: `(async)` on a sync body: {}", signature.trim()));
                }
                continue;
            }
            async_commands += 1;
            // The body runs to the function's closing brace at column 0, or
            // ends on the signature's own line when it closes there.
            let body: String = if signature.contains('{') && signature.trim_end().ends_with('}') {
                signature.to_string()
            } else {
                lines[i + 1 + at..].iter().take_while(|l| **l != "}").copied().collect()
            };
            if !body.contains(".await") {
                offenders.push(format!("{file}: an async fn that never awaits: {}", signature.trim()));
            }
        }
        async_commands
    }

    /// The scan itself: a one-line body is read alone, so it cannot borrow
    /// the `.await` of the function after it.
    #[test]
    fn the_async_scan_reads_each_body_alone() {
        let src = "#[tauri::command]\npub async fn ready() -> bool { probe() }\n\nasync fn later() {\n    tick().await;\n}\n\
                   #[tauri::command]\npub async fn awaits(app: AppHandle) -> Result<(), String> { run(app).await }\n\
                   #[tauri::command(async)]\npub fn sync_body() {}\n";
        let mut offenders = Vec::new();
        assert_eq!(async_task_offenders("x.rs", src, &mut offenders), 2);
        assert_eq!(
            offenders,
            [
                "x.rs: an async fn that never awaits: pub async fn ready() -> bool { probe() }",
                "x.rs: `(async)` on a sync body: pub fn sync_body() {}",
            ]
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

    /// The agent harnesses: every agent command reads or writes its SQLite
    /// table, and uninstalling a harness removes its link on disk.
    #[test]
    fn harness_commands_stay_off_the_main_thread() {
        let harness = include_str!("harness.rs");
        for func in [
            "harness_agent_create",
            "harness_agent_list",
            "harness_agent_update",
            "harness_agent_set_starred",
            "harness_agent_set_folder",
            "harness_agent_delete",
            "harness_agent_duplicate",
            "harness_preview_discard",
        ] {
            assert_off_main_command(harness, "harness.rs", func);
        }
        assert_off_main_command(include_str!("userconfig.rs"), "userconfig.rs", "harness_uninstall");
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

    /// The studio voice's audio streams over one raw-byte Channel per request,
    /// never a global event per chunk (~10 a second while it speaks), and the
    /// command that starts it only queues: it may not block or go `(async)`.
    #[test]
    fn studio_audio_streams_over_a_channel() {
        let src = include_str!("tts_studio.rs");
        assert!(
            src.contains("let on_audio: Channel<Response>") && src.contains("ch.send(Response::new(frame))"),
            "tts_studio.rs: studio audio must stream as raw frames over the request's Channel"
        );
        let events: Vec<&str> = src
            .split("emit(\"")
            .skip(1)
            .chain(src.split("events.push((\"").skip(1))
            .filter_map(|rest| rest.split('"').next())
            .collect();
        assert!(
            events.iter().all(|e| *e == "studio-status" || *e == "studio-setup"),
            "tts_studio.rs: only state changes and install progress go out as events, not audio: {events:?}"
        );
        assert!(
            src.contains("#[tauri::command]\npub fn tts_studio("),
            "tts_studio.rs: `tts_studio` must stay a plain command that returns at once"
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
