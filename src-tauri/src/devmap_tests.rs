// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! `devmap.rs`'s `mod tests`, moved out verbatim: a `#[path]` child of the
//! same parent, so `use super::*` still resolves as it did inline.

use super::*;

#[test]
fn redline_services_are_protected_even_as_collateral_processes() {
    let frontend = RawListener {
        pid: 20,
        port: 1420,
        comm: "node".into(),
    };
    assert_eq!(
        service_role(&frontend, 99, Some(1420)),
        Some("App frontend")
    );
    assert_eq!(service_role(&frontend, 99, None), None);
    let daemon = RawListener {
        pid: 99,
        port: 7676,
        comm: "redline".into(),
    };
    let plan = StopPlan {
        root: 10,
        root_label: "npm".into(),
        pids: vec![10, 20, 21],
        collateral_ports: vec![1420],
    };
    assert!(protect_services(&plan, &[frontend.clone(), daemon], 99, Some(1420)).is_err());
    assert!(protect_services(&plan, &[frontend], 99, None).is_ok());
    assert!(protect_services(
        &plan,
        &[RawListener {
            pid: 21,
            port: 7676,
            comm: "redline".into()
        }],
        99,
        None
    )
    .is_err());
}

fn proc_tree(rows: &[(u32, u32, &str)]) -> HashMap<u32, ProcRow> {
    rows.iter()
        .map(|&(pid, ppid, comm)| {
            (
                pid,
                ProcRow {
                    ppid,
                    comm: comm.into(),
                },
            )
        })
        .collect()
}

fn listener(pid: u32, port: u16) -> RawListener {
    RawListener {
        pid,
        comm: "node".into(),
        port,
    }
}

#[test]
fn stop_accepts_the_lsof_node_vs_ps_next_server_name_mismatch() {
    let tree = proc_tree(&[
        (10, 1, "-zsh"),
        (20, 10, "npm run dev"),
        (21, 20, "next-server (v16.3.4)"),
    ]);
    let plan = stop_root(
        21,
        3103,
        &tree,
        &[listener(21, 3103)],
        99,
        None,
        &HashMap::new(),
    )
    .unwrap();
    assert_eq!(plan.root, 20);
    assert_eq!(plan.pids, vec![20, 21]);
    assert!(stop_root(
        21,
        3100,
        &tree,
        &[listener(21, 3103)],
        99,
        None,
        &HashMap::new()
    )
    .unwrap_err()
    .contains("no longer on :3100"));
}

#[test]
fn stopping_redlines_vite_never_signals_redline_or_tauri_dev() {
    let tree = proc_tree(&[
        (96031, 1, "tauri dev"),
        (96158, 96031, "npm run dev"),
        (96207, 96158, "node"),
        (96210, 96207, "esbuild"),
        (96246, 96031, "redline"),
    ]);
    let plan = stop_root(
        96207,
        1420,
        &tree,
        &[listener(96207, 1420)],
        96246,
        None,
        &HashMap::new(),
    )
    .unwrap();
    assert_eq!(plan.root, 96158);
    assert_eq!(plan.pids, vec![96158, 96207, 96210]);
    for target in [96246, 96031, 1] {
        assert!(stop_root(
            target,
            1420,
            &tree,
            &[listener(target, 1420)],
            96246,
            None,
            &HashMap::new()
        )
        .is_err());
    }
}

#[test]
fn another_card_blocks_the_climb_and_parent_stop_reports_collateral() {
    let tree = proc_tree(&[
        (62300, 1, "-zsh"),
        (62343, 62300, "pnpm dev"),
        (62408, 62343, "next-server"),
        (16389, 62408, "npm run dev --port 3103"),
        (16413, 16389, "next dev"),
        (16416, 16413, "next-server"),
    ]);
    let listeners = [
        listener(62408, 3100),
        listener(16416, 3103),
        listener(16413, 52000),
    ];
    let child = stop_root(16416, 3103, &tree, &listeners, 99, None, &HashMap::new()).unwrap();
    assert_eq!(child.root, 16389);
    assert!(child.collateral_ports.is_empty());
    let parent = stop_root(62408, 3100, &tree, &listeners, 99, None, &HashMap::new()).unwrap();
    assert_eq!(parent.root, 62343);
    assert_eq!(parent.collateral_ports, vec![3103]);
    assert_eq!(parent.pids.len(), 5);
}

#[test]
fn stop_respects_login_shell_and_repo_directory_boundaries() {
    let tree = proc_tree(&[(10, 1, "-zsh"), (20, 10, "runner"), (30, 20, "node")]);
    let cwds = HashMap::from([
        (20, "/Users/me/app-sibling".into()),
        (30, "/Users/me/app/packages/web".into()),
    ]);
    assert_eq!(
        stop_root(
            30,
            3000,
            &tree,
            &[listener(30, 3000)],
            99,
            Some("/Users/me/app"),
            &cwds
        )
        .unwrap()
        .root,
        30
    );
    assert_eq!(
        stop_root(30, 3000, &tree, &[listener(30, 3000)], 99, None, &cwds)
            .unwrap()
            .root,
        20
    );
    assert!(stop_root(
        30,
        3000,
        &tree,
        &[listener(30, 3000)],
        99,
        Some("/another"),
        &cwds
    )
    .is_err());
    for shell in [
        "-zsh",
        "/bin/bash",
        "-fish",
        "iTerm2",
        "/Applications/Terminal.app/Contents/MacOS/Terminal",
    ] {
        assert!(is_shell_or_terminal(shell));
    }
}

#[test]
fn stop_walk_has_depth_and_subtree_bounds_and_terminates_on_cycles() {
    let tree: HashMap<u32, ProcRow> = (10..30)
        .map(|pid| {
            (
                pid,
                ProcRow {
                    ppid: pid - 1,
                    comm: "node".into(),
                },
            )
        })
        .collect();
    let plan = stop_root(
        29,
        3000,
        &tree,
        &[listener(29, 3000)],
        99,
        None,
        &HashMap::new(),
    )
    .unwrap();
    assert_eq!(plan.root, 29 - MAX_CLIMB as u32);
    let cycle = proc_tree(&[(10, 12, "node"), (11, 10, "node"), (12, 11, "node")]);
    let plan = stop_root(
        10,
        3000,
        &cycle,
        &[listener(10, 3000)],
        99,
        None,
        &HashMap::new(),
    )
    .unwrap();
    assert_eq!(plan.pids, vec![10, 11, 12]);
    let mut wide = proc_tree(&[(10, 1, "node")]);
    for pid in 100..100 + MAX_STOP_PIDS as u32 {
        wide.insert(
            pid,
            ProcRow {
                ppid: 10,
                comm: "node".into(),
            },
        );
    }
    assert!(stop_root(
        10,
        3000,
        &wide,
        &[listener(10, 3000)],
        50,
        None,
        &HashMap::new()
    )
    .unwrap_err()
    .contains("more than"));
}

#[test]
fn ps_tree_preserves_spaces_and_slashes_and_rejects_malformed_rows() {
    let tree = parse_ps_tree("  100   10 /Applications/LM Studio.app/Contents/MacOS/LM Studio\n 200 100 next-server (v16.3.4)\n bad 20 node\n 300 bad node\n 400 1\n");
    assert_eq!(tree.len(), 2);
    assert_eq!(
        tree[&100].comm,
        "/Applications/LM Studio.app/Contents/MacOS/LM Studio"
    );
    assert_eq!(tree[&200].ppid, 100);
}

#[test]
fn escalation_excludes_recycled_pids_but_allows_reparented_children() {
    let (_, before) = parse_ps_snapshot("  20 10 Wed Sep 9 10:20:30 2026 next-server (v16.3.4)\n 21 20 Wed Sep 9 10:20:30 2026 node\n");
    let (_, after) = parse_ps_snapshot("  20 1 Wed Sep 9 10:20:30 2026 next-server (v16.3.4)\n 21 1 Wed Sep 9 10:20:31 2026 node\n");
    assert_eq!(matching_pids(&[20, 21, 22], &before, &after), vec![20]);
    assert_eq!(before[&20].comm, "next-server (v16.3.4)");
}

#[test]
fn probe_without_process_argv_uses_lockfile_or_returns_an_editable_blank() {
    let mut probe = ProjectProbe {
        has_package_json: true,
        scripts: HashSet::from(["dev".into()]),
        ..Default::default()
    };
    for (lock, pm) in [
        ("pnpm-lock.yaml", "pnpm"),
        ("yarn.lock", "yarn"),
        ("bun.lockb", "bun"),
        ("package-lock.json", "npm"),
    ] {
        probe.lockfile = Some(lock.into());
        assert_eq!(
            derive_run_command(Some(&probe), "", ""),
            format!("{pm} run dev")
        );
    }
    probe.scripts = HashSet::from(["test".into()]);
    assert_eq!(derive_run_command(Some(&probe), "", ""), "");
}

/// These integration fixtures own every process they can stop. No existing
/// app/server pid or fixed port is ever used. Opt in because they need the
/// host's python3, ps and lsof and exercise actual TERM/KILL delivery.
#[test]
#[ignore = "spawns disposable localhost fixtures; run with --ignored"]
fn disposable_servers_stop_plain_supervised_and_sigterm_ignoring() {
    use std::io::BufRead;
    use std::process::{Command, Stdio};
    struct Fixture {
        child: std::process::Child,
        identities: HashMap<u32, ProcIdentity>,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let pids: Vec<u32> = self.identities.keys().copied().collect();
            let _ = signal_matching("-KILL", &pids, &self.identities);
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
    for mode in ["plain", "supervised", "ignore"] {
        let source = r#"
import os, signal, socket, subprocess, sys, time
mode = sys.argv[1]
if mode == 'supervised':
    child = subprocess.Popen([sys.executable, '-u', '-c', sys.argv[2], 'plain'])
    def stop(signum, frame):
        child.terminate()
        child.wait()
        sys.exit(0)
    signal.signal(signal.SIGTERM, stop)
    while True:
        child.wait()
        child = subprocess.Popen([sys.executable, '-u', '-c', sys.argv[2], 'plain'])
else:
    if mode == 'ignore': signal.signal(signal.SIGTERM, lambda *args: None)
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    sock.listen()
    print(str(os.getpid()) + ' ' + str(sock.getsockname()[1]), flush=True)
    while True: time.sleep(1)
"#;
        let mut child = Command::new("python3")
            .args(["-u", "-c", source, mode, source])
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let result = std::io::BufReader::new(stdout)
                .read_line(&mut line)
                .map(|_| line);
            let _ = sender.send(result);
        });
        let mut fixture = Fixture {
            child,
            identities: HashMap::new(),
        };
        let line = receiver
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap()
            .unwrap();
        let values: Vec<&str> = line.split_whitespace().collect();
        let pid: u32 = values[0].parse().unwrap();
        let port: u16 = values[1].parse().unwrap();
        let snapshot = prepare_stop(pid, port, None, None).unwrap();
        fixture.identities = snapshot
            .plan
            .pids
            .iter()
            .map(|pid| (*pid, snapshot.identities[pid].clone()))
            .collect();
        assert_eq!(snapshot.plan.root, fixture.child.id(), "{mode}");
        assert_eq!(
            snapshot.plan.pids.len(),
            if mode == "supervised" { 2 } else { 1 }
        );
        assert!(
            stop_listeners()
                .unwrap()
                .iter()
                .any(|l| l.pid == pid && l.port == port),
            "dry run sent no signal"
        );
        let start = std::time::Instant::now();
        let (plan, count) = execute_stop(pid, port, None, None).unwrap();
        assert_eq!(plan.root, fixture.child.id());
        assert!(count >= 1);
        if mode == "ignore" {
            assert!(start.elapsed() >= std::time::Duration::from_secs(3));
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
        assert!(
            !stop_listeners().unwrap().iter().any(|l| l.port == port),
            "{mode} respawned"
        );
        fixture.child.wait().unwrap();
    }
}

/// The registry as `scan_with` hands it over: normalized on the way in, so
/// `resolve_project` compares two canonical forms and never pays a
/// per-lookup allocation.
const HOME: Option<&str> = Some("/Users/me");

fn known(paths: &[&str]) -> HashSet<String> {
    paths.iter().map(|p| normalize_path(p)).collect()
}

#[test]
fn listeners_collapse_ipv4_and_ipv6_rows_for_one_port() {
    let out = "p100\ncnode\nn*:5173\nn127.0.0.1:5173\nn[::1]:5173\n";
    let got = parse_lsof_listeners(out, 1);
    assert_eq!(
        got,
        vec![RawListener {
            pid: 100,
            comm: "node".into(),
            port: 5173
        }]
    );
}

#[test]
fn listeners_keep_distinct_ports_of_one_process() {
    let out = "p100\ncnode\nn*:5173\nn*:24678\n";
    let ports: Vec<u16> = parse_lsof_listeners(out, 1)
        .into_iter()
        .map(|l| l.port)
        .collect();
    assert_eq!(ports, vec![5173, 24678]);
}

#[test]
fn listeners_drop_our_own_pid_and_the_daemon_port() {
    let out = "p42\ncredline\nn*:7676\np100\ncnode\nn*:7676\np101\ncnode\nn*:3000\n";
    let got = parse_lsof_listeners(out, 42);
    assert_eq!(got.len(), 1, "{got:?}");
    assert_eq!(got[0].pid, 101);
    assert_eq!(got[0].port, 3000);
}

#[test]
fn listeners_survive_garbage_and_orphan_name_lines() {
    // A name line before any process line, an unparseable port, and a
    // field we never asked for must all be skipped, not panic.
    let out = "n*:9999\nfoo\np100\ncnode\nnsomething-with-no-colon\nn*:abc\nn*:3000\n";
    let got = parse_lsof_listeners(out, 1);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].port, 3000);
}

#[test]
fn cwds_and_args_parse_from_batched_output() {
    let cwds = parse_lsof_cwds("p100\nn/Users/me/app\np200\nn/tmp\n");
    assert_eq!(cwds.get(&100).map(String::as_str), Some("/Users/me/app"));
    assert_eq!(cwds.get(&200).map(String::as_str), Some("/tmp"));

    let args = parse_ps_args("  100 node /a/b/vite --host\n 200 python manage.py runserver\n");
    assert_eq!(
        args.get(&100).map(String::as_str),
        Some("node /a/b/vite --host")
    );
    assert_eq!(
        args.get(&200).map(String::as_str),
        Some("python manage.py runserver")
    );
}

#[test]
fn a_known_project_beats_a_nearer_root_marker() {
    // The monorepo package has its own package.json, but the user's
    // registry knows the repo root — the card should say the repo.
    let got = resolve_project(
        "/Users/me/myapp/packages/web",
        &known(&["/Users/me/myapp"]),
        HOME,
        |p| p.ends_with("web"),
    );
    assert_eq!(got, Some(PathBuf::from("/Users/me/myapp")));
}

#[test]
fn root_markers_resolve_the_nearest_directory_when_nothing_is_known() {
    let got = resolve_project("/Users/me/scratch/thing/src", &known(&[]), HOME, |p| {
        p == Path::new("/Users/me/scratch/thing")
    });
    assert_eq!(got, Some(PathBuf::from("/Users/me/scratch/thing")));
}

#[test]
fn the_walk_up_is_depth_bounded() {
    // Eight levels down: the marker at the root is out of reach, so this
    // listener is simply not project-mapped rather than mis-attributed.
    let deep = "/a/b/c/d/e/f/g/h";
    assert_eq!(
        resolve_project(deep, &known(&[]), HOME, |p| p == Path::new("/a")),
        None
    );
    assert_eq!(
        resolve_project(deep, &known(&["/a"]), HOME, |_| false),
        None,
        "a known path further up than the bound is also out of reach"
    );
}

#[test]
fn junk_roots_are_not_projects() {
    // Every one of these was observed on a live scan producing a rich
    // "dev server" card it had no business producing.
    for junk in [
        "/",
        "/Users",
        "/Users/me",     // the home dir itself
        "/opt/homebrew", // Homebrew keeps a .git
        "/usr/local/share/thing",
        "/Applications/Some.app/Contents",
        "/Library/Whatever",
        "/Users/me/.vscode/extensions/ms-python.foo", // extensions ship package.json
        "/Users/me/.cargo/registry/src/x",
        "/Users/me/app/node_modules/some-dep",
    ] {
        assert!(
            !is_plausible_project_root(Path::new(junk), HOME),
            "{junk} must not be treated as a project"
        );
    }
    for real in [
        "/Users/me/app",
        "/Users/me/code/clients/acme",
        "/Users/me/dot.files/app", // a dot INSIDE a name is not a dotdir
        "/srv/deploy/app",
    ] {
        assert!(
            is_plausible_project_root(Path::new(real), HOME),
            "{real} is a legitimate project root"
        );
    }
}

#[test]
fn a_junk_ancestor_never_captures_a_real_project() {
    // A server started in ~/.vscode/... must fall through to "not a
    // project" rather than being attributed to the home directory.
    assert_eq!(
        resolve_project("/Users/me/.vscode/extensions/x", &known(&[]), HOME, |_| {
            true
        }),
        None,
    );
    // Even if the home directory is in the registry (a plan session that
    // launched in $HOME — a real thing that has happened), it must not
    // become every listener's project.
    assert_eq!(
        resolve_project("/Users/me/random/dir", &known(&["/Users/me"]), HOME, |_| {
            false
        }),
        None,
    );
    // But a real repo below home still resolves.
    assert_eq!(
        resolve_project(
            "/Users/me/app/src",
            &known(&["/Users/me/app"]),
            HOME,
            |_| false
        ),
        Some(PathBuf::from("/Users/me/app")),
    );
}

#[test]
fn trailing_slashes_do_not_split_a_project() {
    // `sessions.project_path` rows are user-supplied strings, so the same
    // repo can be recorded both ways. Normalizing at the boundary is what
    // keeps that from minting two projects for one directory.
    assert_eq!(normalize_path("/Users/me/app/"), "/Users/me/app");
    assert_eq!(normalize_path("/"), "/", "the root survives normalization");
    let got = resolve_project("/Users/me/app", &known(&["/Users/me/app/"]), HOME, |_| {
        false
    });
    assert_eq!(got, Some(PathBuf::from("/Users/me/app")));
}

fn probe_with(deps: &[&str], scripts: &[&str]) -> ProjectProbe {
    ProjectProbe {
        dir_name: "myapp".into(),
        has_package_json: true,
        pkg_name: Some("myapp".into()),
        deps: deps.iter().map(|d| d.to_string()).collect(),
        scripts: scripts.iter().map(|s| s.to_string()).collect(),
        ..Default::default()
    }
}

#[test]
fn the_framework_beats_the_bundler() {
    // Both present (Astro ships Vite) — the useful label is the framework.
    let p = probe_with(&["vite", "astro"], &[]);
    assert_eq!(detect_stack(Some(&p), "node", ""), "Astro — myapp");
    let p = probe_with(&["vite", "next"], &[]);
    assert_eq!(detect_stack(Some(&p), "node", ""), "Next.js — myapp");
}

#[test]
fn each_framework_gets_its_own_label() {
    for (dep, label) in [
        ("next", "Next.js"),
        ("astro", "Astro"),
        ("@remix-run/node", "Remix"),
        ("react-scripts", "CRA"),
        ("vite", "Vite"),
        ("express", "Express"),
    ] {
        let p = probe_with(&[dep], &[]);
        assert_eq!(
            detect_stack(Some(&p), "node", ""),
            format!("{label} — myapp")
        );
    }
    // A package.json with nothing recognizable still beats a bare comm.
    let p = probe_with(&["lodash"], &[]);
    assert_eq!(detect_stack(Some(&p), "node", ""), "Node — myapp");
}

#[test]
fn stack_falls_back_through_python_rust_and_finally_the_command() {
    let django = ProjectProbe {
        dir_name: "site".into(),
        has_manage_py: true,
        has_pyproject: true,
        ..Default::default()
    };
    assert_eq!(detect_stack(Some(&django), "python3", ""), "Django — site");

    let py = ProjectProbe {
        dir_name: "site".into(),
        has_pyproject: true,
        ..Default::default()
    };
    assert_eq!(detect_stack(Some(&py), "python3", ""), "Python — site");

    let rs = ProjectProbe {
        dir_name: "dir".into(),
        has_cargo_toml: true,
        cargo_name: Some("server".into()),
        ..Default::default()
    };
    assert_eq!(detect_stack(Some(&rs), "server", ""), "Rust — server");

    assert_eq!(detect_stack(None, "rapportd", ""), "rapportd");
}

#[test]
fn a_second_runtime_in_one_repo_gets_its_own_label_and_command() {
    // The case the whole runner check exists for: a Next.js web app and a
    // Python API out of the SAME repo. Describing both from package.json
    // gives two identical cards, and Run on the API would start the web app.
    let repo = probe_with(&["next"], &["dev"]);
    let web = "next-server (v16.2.6)";
    let api = "python3 -m uvicorn app:main --port 8000";

    assert_eq!(detect_stack(Some(&repo), "node", web), "Next.js — myapp");
    assert_eq!(detect_stack(Some(&repo), "Python", api), "Uvicorn — myapp");

    assert_eq!(derive_run_command(Some(&repo), "node", web), "npm run dev");
    assert_eq!(
        derive_run_command(Some(&repo), "Python", api),
        api,
        "the project's dev script would start the wrong server entirely"
    );
}

#[test]
fn within_one_family_the_project_manifest_still_wins() {
    // The runner only breaks ties ACROSS runtimes. Inside a family the
    // dependency list is the better evidence — and this is what stops a
    // project living at ~/next/myapp from being mislabeled "Next.js".
    let vite_app = probe_with(&["vite"], &["dev"]);
    assert_eq!(
        detect_stack(Some(&vite_app), "node", "node /Users/me/next/myapp/x"),
        "Vite — myapp",
    );
}

#[test]
fn runners_are_matched_as_whole_tokens_never_substrings() {
    assert_eq!(
        detect_runner("node", "node /a/vite-experiments/api.js"),
        None
    );
    assert_eq!(
        detect_runner("node", "node /a/node_modules/.bin/vite dev"),
        Some(("Vite", Family::Node)),
    );
    assert_eq!(
        detect_runner("Python", "/opt/x/MacOS/Python -m http.server 5199"),
        Some(("Python", Family::Python)),
    );
    assert_eq!(
        detect_runner("python", "python manage.py runserver"),
        Some(("Django", Family::Python)),
        "the most specific runner wins over the bare interpreter",
    );
    // A bare `node` is far too common in argv to mean anything on its own.
    assert_eq!(detect_runner("node", "node server.js"), None);
}

#[test]
fn probe_family_reads_the_manifests() {
    assert_eq!(probe_family(&probe_with(&[], &[])), Family::Node);
    assert_eq!(
        probe_family(&ProjectProbe {
            has_pyproject: true,
            ..Default::default()
        }),
        Family::Python,
    );
    assert_eq!(
        probe_family(&ProjectProbe {
            has_cargo_toml: true,
            ..Default::default()
        }),
        Family::Rust,
    );
    assert_eq!(probe_family(&ProjectProbe::default()), Family::Unknown);
}

#[test]
fn the_package_name_falls_back_to_the_directory_name() {
    let mut p = probe_with(&["vite"], &[]);
    p.pkg_name = None;
    assert_eq!(detect_stack(Some(&p), "node", ""), "Vite — myapp");
}

#[test]
fn cargo_package_name_reads_only_the_package_section() {
    let toml = "[dependencies]\nname = \"wrong\"\n\n[package]\nname = \"right\"\n";
    assert_eq!(cargo_package_name(toml), Some("right".into()));
    assert_eq!(cargo_package_name("[package]\nversion = \"1\"\n"), None);
}

#[test]
fn run_command_prefers_dev_and_follows_the_lockfile() {
    for (lock, pm) in [
        (Some("pnpm-lock.yaml"), "pnpm"),
        (Some("yarn.lock"), "yarn"),
        (Some("bun.lockb"), "bun"),
        (Some("package-lock.json"), "npm"),
        (None, "npm"),
    ] {
        let mut p = probe_with(&[], &["dev", "start"]);
        p.lockfile = lock.map(|l| l.to_string());
        assert_eq!(
            derive_run_command(Some(&p), "node", "node x"),
            format!("{pm} run dev")
        );
    }
}

#[test]
fn run_command_falls_through_start_cargo_manage_then_raw_args() {
    let p = probe_with(&[], &["start"]);
    assert_eq!(
        derive_run_command(Some(&p), "node", "node x"),
        "npm run start"
    );

    let rs = ProjectProbe {
        has_cargo_toml: true,
        ..Default::default()
    };
    assert_eq!(
        derive_run_command(Some(&rs), "node", "target/debug/x"),
        "cargo run"
    );

    let dj = ProjectProbe {
        has_manage_py: true,
        ..Default::default()
    };
    assert_eq!(
        derive_run_command(Some(&dj), "node", "python x"),
        "python manage.py runserver"
    );

    let bare = ProjectProbe::default();
    assert_eq!(
        derive_run_command(Some(&bare), "node", "  ./serve --port 9000 "),
        "./serve --port 9000"
    );
    assert_eq!(derive_run_command(None, "sh", "./serve"), "./serve");
}

#[test]
fn a_neighbor_process_does_not_claim_the_project() {
    let root = Path::new("/Users/me/app");
    // The observed failure: a long-dead standalone binary, living outside
    // the repo, started once from a terminal whose cwd was the repo.
    assert!(!claims_project(
        "legacyapp",
        "/Users/me/.local/bin/legacyapp",
        root
    ));
    // A bare PATH lookup is not evidence either — no separator, no origin.
    assert!(!claims_project("myserver", "myserver --port 9000", root));
    // Nor is an absolute path that merely shares a prefix with the root.
    assert!(!claims_project(
        "appd",
        "/Users/me/app-backup/bin/appd",
        root
    ));
}

#[test]
fn a_real_server_still_claims_the_project() {
    let root = Path::new("/Users/me/app");
    // 1 — argv names a runner.
    assert!(claims_project("sh", "vite --port 5173", root));
    // 2 — the process's own command is a runtime, even with a bare argv.
    assert!(claims_project(
        "node",
        "/opt/homebrew/bin/node server.js",
        root
    ));
    assert!(claims_project("bun", "/usr/local/bin/bun run serve", root));
    // 3 — a compiled binary that lives IN the repo, absolute or relative.
    assert!(claims_project(
        "api",
        "/Users/me/app/target/debug/api",
        root
    ));
    assert!(claims_project(
        "api",
        "./target/debug/api --port 8080",
        root
    ));
    // A trailing slash on the root must not break the prefix test.
    assert!(claims_project(
        "api",
        "/Users/me/app/target/debug/api",
        Path::new("/Users/me/app/")
    ));
}

fn row(id: i64, path: &str, port: u16) -> crate::db::DevServerRow {
    crate::db::DevServerRow {
        id,
        project_path: path.into(),
        project_name: "app".into(),
        port,
        url: format!("http://localhost:{port}"),
        stack: "Vite — app".into(),
        run_command: "npm run dev".into(),
        last_seen_at: 1,
        thumb_path: None,
    }
}

#[test]
fn recent_drops_live_rows_and_missing_directories_and_flags_busy_ports() {
    let rows = vec![
        row(1, "/a", 5173),    // live right now → not "recent"
        row(2, "/a", 3000),    // same repo, other port → recent
        row(3, "/gone", 8080), // directory no longer exists → dropped
        row(4, "/b", 4000),    // port squatted by a foreign process
    ];
    let live: HashSet<(String, u16)> = [("/a".to_string(), 5173u16)].into_iter().collect();
    let busy: HashSet<u16> = [5173, 4000].into_iter().collect();
    let got = partition_recent(rows, &live, &busy, |p| p != "/gone");
    assert_eq!(
        got.iter().map(|r| r.id).collect::<Vec<_>>(),
        vec![2, 4],
        "{got:?}"
    );
    assert!(!got[0].port_busy);
    assert!(got[1].port_busy, "a foreign listener on 4000 is flagged");
}

#[test]
fn recent_forgets_os_assigned_ports() {
    // Rows written before the floor existed still sit in the table; the
    // filter is what retires them, without a migration.
    let rows = vec![row(1, "/a", 3000), row(2, "/a", 54441), row(3, "/a", 49152)];
    let got = partition_recent(rows, &HashSet::new(), &HashSet::new(), |_| true);
    assert_eq!(
        got.iter().map(|r| r.id).collect::<Vec<_>>(),
        vec![1],
        "only the re-runnable port is worth remembering: {got:?}"
    );
}

#[test]
fn upsert_keeps_first_seen_across_rescans() {
    let db = Database::open_in_memory().unwrap();
    db.upsert_dev_server(
        "/a",
        "a",
        5173,
        "http://localhost:5173",
        "Vite — a",
        "npm run dev",
        Some(1),
        Some("node x"),
        1_000,
    )
    .unwrap();
    let id = db.list_dev_servers(10).unwrap()[0].id;
    // A later scan sees the same server with a churned run command.
    db.upsert_dev_server(
        "/a",
        "a",
        5173,
        "http://localhost:5173",
        "Vite — a",
        "pnpm run dev",
        Some(2),
        Some("node y"),
        2_000,
    )
    .unwrap();
    let rows = db.list_dev_servers(10).unwrap();
    assert_eq!(rows.len(), 1, "the (path, port) key is the same server");
    assert_eq!(rows[0].run_command, "pnpm run dev");
    assert_eq!(rows[0].last_seen_at, 2_000);
    assert_eq!(
        db.dev_server_first_seen(id).unwrap(),
        1_000,
        "first_seen_at is written once"
    );
}

/// Exercises the three real subprocess invocations against this machine.
///
/// The unit tests above all feed the parsers canned strings, which cannot
/// catch the likeliest regression by far: a wrong flag. `lsof` rejects an
/// unknown option with empty stdout and a non-zero status, and every
/// downstream parser would cheerfully return nothing — a permanently empty
/// dashboard with no error anywhere. So assert on the SHAPE of a live scan,
/// never on what happens to be running — and for the "flags stopped
/// matching" case, plant a listener of our own rather than assume the box
/// has one (a bare CI runner has none).
#[test]
fn a_live_scan_runs_the_real_commands_and_returns_a_coherent_shape() {
    if std::process::Command::new("lsof")
        .arg("-v")
        .output()
        .is_err()
    {
        return; // no lsof on this box — nothing to assert
    }
    let db = Database::open_in_memory().unwrap();
    let scan = scan_with(&db, std::process::id(), None).expect("a live scan must not error");

    // A wrong lsof flag means empty stdout with a non-zero status, which
    // run_capture still surfaces as Ok("") — an invisibly empty dashboard.
    // Hold a loopback socket and sweep WITHOUT excluding this process: a
    // correct invocation must see at least the listener we planted.
    let planted = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let seeded = scan_with(&Database::open_in_memory().unwrap(), u32::MAX, None)
        .expect("a live scan must not error");
    assert!(
        !seeded.running.is_empty() || !seeded.others.is_empty(),
        "a planted listener was invisible — the lsof invocation is probably wrong"
    );
    drop(planted);
    assert!(scan.others.len() <= MAX_OTHERS);
    assert!(scan.recent.len() <= MAX_RECENT as usize);

    let own = std::process::id();
    for o in &scan.others {
        assert_ne!(o.pid, own);
        assert_ne!(o.port, DAEMON_PORT);
    }
    let mut seen_pids = HashSet::new();
    for r in &scan.running {
        assert_ne!(r.pid, own);
        assert_ne!(r.port, DAEMON_PORT);
        assert!(
            seen_pids.insert(r.pid),
            "one process must be exactly one card"
        );
        assert!(
            !r.project_path.is_empty(),
            "a running card is project-mapped"
        );
        assert!(!r.project_name.is_empty());
        assert!(!r.stack.is_empty());
        assert_eq!(r.url, format!("http://localhost:{}", r.port));
        assert!(
            r.extra_ports.iter().all(|p| *p > r.port),
            "the primary port is the lowest one the process holds"
        );
        assert!(
            claims_project(&r.comm, &r.args, Path::new(&r.project_path)),
            "a card must be a dev server, not merely a process whose cwd is \
                 the repo: {r:?}"
        );
    }
    // Every running card on a re-runnable port was recorded, and no live
    // server is ever also listed as "recent". Cards on OS-assigned ports
    // are shown but deliberately not remembered.
    let rows = db.list_dev_servers(100).unwrap();
    assert_eq!(
        rows.len(),
        scan.running
            .iter()
            .filter(|r| r.port < EPHEMERAL_PORT_FLOOR)
            .count()
    );
    for r in &scan.running {
        assert!(
            !scan
                .recent
                .iter()
                .any(|x| x.project_path == r.project_path && x.port == r.port),
            "a live server must not also appear as recently-run"
        );
    }
}

#[test]
fn prune_keeps_the_most_recent_rows() {
    let db = Database::open_in_memory().unwrap();
    for i in 0..60u16 {
        db.upsert_dev_server(
            "/a",
            "a",
            3000 + i,
            "u",
            "s",
            "c",
            None,
            None,
            1_000 + i as i64,
        )
        .unwrap();
    }
    db.prune_dev_servers(50).unwrap();
    let rows = db.list_dev_servers(100).unwrap();
    assert_eq!(rows.len(), 50);
    assert_eq!(rows[0].port, 3059, "newest survives");
    assert!(rows.iter().all(|r| r.port >= 3010));
}

fn sighting(port: u16, stack: &str) -> crate::db::DevServerSighting {
    crate::db::DevServerSighting {
        project_path: "/p".into(),
        project_name: "p".into(),
        port,
        url: format!("http://localhost:{port}"),
        stack: stack.into(),
        run_command: "npm run dev".into(),
        last_pid: Some(42),
        last_args: Some("vite".into()),
    }
}

/// A scan writes only what changed, in one transaction: a rescan of the same
/// servers inside the refresh window writes nothing at all.
#[test]
fn a_rescan_writes_only_what_changed() {
    use crate::db::DEV_SERVER_SEEN_REFRESH_MS as REFRESH;
    let db = Database::open_in_memory().unwrap();
    let seen = vec![sighting(3000, "vite"), sighting(3001, "next")];
    assert_eq!(db.record_dev_servers(&seen, 1_000, 50).unwrap(), 2, "new rows");
    assert_eq!(db.record_dev_servers(&seen, 2_000, 50).unwrap(), 0, "nothing moved");
    let rows = db.list_dev_servers(10).unwrap();
    assert!(rows.iter().all(|r| r.last_seen_at == 1_000), "an unchanged rescan keeps its stamp");
    let mut moved = seen.clone();
    moved[1].stack = "remix".into();
    assert_eq!(db.record_dev_servers(&moved, 3_000, 50).unwrap(), 1, "one fact moved");
    assert_eq!(
        db.record_dev_servers(&moved, 1_000 + REFRESH, 50).unwrap(),
        1,
        "the stale stamp refreshes; the one just written does not"
    );
    let rows = db.list_dev_servers(10).unwrap();
    let r3001 = rows.iter().find(|r| r.port == 3001).unwrap();
    assert_eq!((r3001.stack.as_str(), r3001.last_seen_at), ("remix", 3_000));
    assert_eq!(rows.iter().find(|r| r.port == 3000).unwrap().last_seen_at, 1_000 + REFRESH);
}

/// The prune that used to run on every scan runs when a row is added, and
/// keeps the newest.
#[test]
fn recording_a_new_server_prunes_to_the_newest() {
    let db = Database::open_in_memory().unwrap();
    for i in 0..60u16 {
        db.record_dev_servers(&[sighting(3000 + i, "vite")], 1_000 + i as i64, 50).unwrap();
    }
    let rows = db.list_dev_servers(100).unwrap();
    assert_eq!(rows.len(), 50);
    assert_eq!(rows[0].port, 3059, "newest survives");
}

/// A scan that changed nothing never takes the writer: it answers while
/// another thread holds it.
#[test]
fn an_unchanged_scan_never_waits_for_the_writer() {
    let dir = std::env::temp_dir().join(format!("redline-devmap-writer-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let db = std::sync::Arc::new(Database::open(&dir.join("redline.db")).unwrap());
    let seen = vec![sighting(3000, "vite")];
    db.record_dev_servers(&seen, 1_000, 50).unwrap();
    let held = db.lock_conn();
    let (tx, rx) = std::sync::mpsc::channel();
    {
        let (db, seen) = (std::sync::Arc::clone(&db), seen.clone());
        std::thread::spawn(move || {
            let _ = tx.send(db.record_dev_servers(&seen, 2_000, 50).ok());
        });
    }
    let written = rx.recv_timeout(std::time::Duration::from_secs(3));
    drop(held);
    assert_eq!(written.ok(), Some(Some(0)), "an unchanged scan waited on the held writer");
    let _ = std::fs::remove_dir_all(&dir);
}
