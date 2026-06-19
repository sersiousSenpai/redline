use std::process::Command;

fn main() {
    stamp_build_sha();
    tauri_build::build()
}

/// Stamp the commit this binary is built from into `REDLINE_BUILD_SHA` so
/// "Check for Updates" can tell when the *installed binary* is older than the
/// source checkout — e.g. an interrupted rebuild left HEAD ahead of the last
/// build it actually produced. Best-effort: outside a git checkout we stamp
/// nothing and the updater falls back to its upstream-only comparison.
fn stamp_build_sha() {
    let Some(sha) = run_git(&["rev-parse", "HEAD"]) else {
        return;
    };
    println!("cargo:rustc-env=REDLINE_BUILD_SHA={sha}");
    // logs/HEAD is appended on every commit / checkout / pull, so re-running the
    // build script on its change keeps the stamp accurate even when a commit
    // touched no file in this crate (tauri-build already emits its own
    // rerun-if-changed directives, so the package isn't otherwise rescanned).
    if let Some(git_dir) = run_git(&["rev-parse", "--absolute-git-dir"]) {
        println!("cargo:rerun-if-changed={git_dir}/logs/HEAD");
    }
}

fn run_git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (!s.is_empty()).then_some(s)
}
