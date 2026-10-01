// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Local web launch suggestions. Read manifests only; never execute a discovery script.

use super::{package_manager, probe_project, ProjectProbe};
use serde::Serialize;
use std::path::{Path, PathBuf};

pub fn supported_manager(value: &str) -> Option<&str> {
    let name = value.split('@').next()?;
    ["npm", "pnpm", "yarn", "bun"]
        .contains(&name)
        .then_some(name)
}

pub fn manager(probe: &ProjectProbe) -> &str {
    probe
        .declared_manager
        .as_deref()
        .unwrap_or_else(|| package_manager(probe.lockfile.as_deref()))
}

/// Workspace packages usually keep the package-manager declaration and lock at
/// the repository root. Never inherit past a repository boundary.
pub fn inherit_manager(root: &Path, probe: &mut ProjectProbe) {
    if probe.declared_manager.is_some() || probe.lockfile.is_some() || root.join(".git").exists() {
        return;
    }
    for parent in root.ancestors().skip(1).take(6) {
        if let Ok(text) = std::fs::read_to_string(parent.join("package.json")) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                probe.declared_manager = value
                    .get("packageManager")
                    .and_then(|v| v.as_str())
                    .and_then(supported_manager)
                    .map(str::to_string);
            }
        }
        probe.lockfile = [
            "pnpm-lock.yaml",
            "yarn.lock",
            "bun.lock",
            "bun.lockb",
            "package-lock.json",
        ]
        .into_iter()
        .find(|name| parent.join(name).exists())
        .map(str::to_string);
        if probe.declared_manager.is_some()
            || probe.lockfile.is_some()
            || parent.join(".git").exists()
        {
            break;
        }
    }
}

pub fn script_command(probe: &ProjectProbe, script: &str) -> String {
    // Even script names come from untrusted manifest data.
    let name = if !script.is_empty()
        && script
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_:@./-".contains(c))
    {
        script.to_string()
    } else {
        format!("'{}'", script.replace('\'', "'\\''"))
    };
    format!("{} run {name}", manager(probe))
}

fn tokens(body: &str) -> Vec<String> {
    body.split(|c: char| c.is_whitespace() || ";&|\"'()".contains(c))
        .filter(|s| !s.is_empty())
        .map(|s| s.rsplit('/').next().unwrap_or(s).to_lowercase())
        .collect()
}

fn score(probe: &ProjectProbe, name: &str, raw_args: &str) -> Option<u16> {
    let lower = name.to_lowercase();
    let parts: Vec<_> = lower.split([':', '-', '_']).collect();
    if parts.iter().any(|p| {
        [
            "test",
            "lint",
            "build",
            "typecheck",
            "deploy",
            "publish",
            "android",
            "ios",
            "native",
            "mobile",
        ]
        .contains(p)
    }) || (lower.starts_with("pre") && lower != "preview")
        || lower.starts_with("post")
    {
        return None;
    }
    let body = probe
        .script_bodies
        .get(name)
        .map(String::as_str)
        .unwrap_or("");
    let words = tokens(body);
    // Mobile launchers are outside this localhost surface, even under `dev`.
    if words
        .iter()
        .any(|w| ["expo", "react-native", "tauri", "electron"].contains(&w.as_str()))
    {
        return None;
    }
    let server = words.iter().any(|w| {
        [
            "vite",
            "vite.js",
            "next",
            "astro",
            "nuxt",
            "nuxi",
            "remix",
            "react-scripts",
            "webpack",
            "webpack-dev-server",
            "http-server",
            "serve",
            "nodemon",
            "tsx",
            "uvicorn",
            "flask",
        ]
        .contains(&w.as_str())
    }) && !words
        .iter()
        .any(|w| ["build", "test", "lint", "check"].contains(&w.as_str()));
    if !server
        && words.iter().any(|w| {
            [
                "tsc",
                "tsup",
                "rollup",
                "babel",
                "vitest",
                "jest",
                "eslint",
                "prettier",
                "build",
                "test",
                "lint",
                "typecheck",
            ]
            .contains(&w.as_str())
        })
    {
        return None;
    }
    let base = match lower.as_str() {
        "dev" => 100,
        "dev:web" | "web:dev" | "start:dev" => 95,
        "serve" => 90,
        "start" => 80,
        "web" => 75,
        "preview" => 35,
        _ if parts.iter().any(|p| ["dev", "serve", "start"].contains(p)) => 70,
        _ if server => 60,
        _ => return None,
    };
    let running = tokens(raw_args);
    // Match the script to the actual listener when a repo runs several services.
    // Ignore ubiquitous runtime tokens; a runner or entry filename is evidence.
    let matches_running = words.iter().any(|w| {
        (w.ends_with(".js")
            || w.ends_with(".ts")
            || ["vite", "next", "astro", "nuxt", "uvicorn"].contains(&w.as_str()))
            && running
                .iter()
                .any(|r| r == w || r == &format!("{w}.js") || r == &format!("{w}-server"))
    });
    Some(base + if server { 10 } else { 0 } + if matches_running { 150 } else { 0 })
}

pub fn ranked_scripts(probe: &ProjectProbe, raw_args: &str) -> Vec<String> {
    let mut scripts: Vec<_> = probe
        .scripts
        .iter()
        .filter_map(|name| score(probe, name, raw_args).map(|score| (name.clone(), score)))
        .collect();
    scripts.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    scripts.into_iter().map(|(name, _)| name).collect()
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchOption {
    pub project_path: String,
    pub command: String,
    pub detail: String,
}

/// Bounded, shallow discovery covers common repo layouts without crawling a
/// user's whole tree, dependencies, symlinks or generated output.
fn candidate_roots(root: &Path) -> Vec<PathBuf> {
    let mut roots = vec![root.to_path_buf()];
    for name in ["web", "frontend", "client", "site", "app"] {
        let dir = root.join(name);
        if dir.is_dir() && !dir.is_symlink() {
            roots.push(dir);
        }
    }
    for name in ["apps", "packages"] {
        let parent = root.join(name);
        if parent.is_symlink() {
            continue;
        }
        if let Ok(entries) = std::fs::read_dir(parent) {
            let mut dirs: Vec<_> = entries
                .take(128)
                .flatten()
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
                .map(|e| e.path())
                .collect();
            dirs.sort();
            roots.extend(dirs.into_iter().take(48));
        }
    }
    roots
}

pub fn suggestions(root: &Path, probe: &ProjectProbe) -> Vec<LaunchOption> {
    let mut options = Vec::new();
    for dir in candidate_roots(root) {
        let child;
        let p = if dir == root {
            probe
        } else {
            child = probe_project(&dir);
            &child
        };
        for script in ranked_scripts(p, "").into_iter().take(8) {
            let priority = score(p, &script, "").unwrap_or(0) + if dir == root { 20 } else { 0 };
            options.push((
                priority,
                LaunchOption {
                    project_path: dir.to_string_lossy().into_owned(),
                    command: script_command(p, &script),
                    detail: p.script_bodies.get(&script).cloned().unwrap_or(script),
                },
            ));
        }
        if !p.has_package_json && p.has_manage_py {
            options.push((
                100,
                LaunchOption {
                    project_path: dir.to_string_lossy().into_owned(),
                    command: "python manage.py runserver".into(),
                    detail: "Django development server".into(),
                },
            ));
        }
    }
    options.sort_by(|a, b| b.0.cmp(&a.0));
    options
        .into_iter()
        .take(24)
        .map(|(_, option)| option)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn probe(scripts: &[(&str, &str)]) -> ProjectProbe {
        ProjectProbe {
            scripts: scripts.iter().map(|(k, _)| k.to_string()).collect(),
            script_bodies: scripts
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            ..Default::default()
        }
    }
    #[test]
    fn ranks_web_commands_and_ignores_mobile_and_lifecycle_tasks() {
        let p = probe(&[
            ("dev", "expo start"),
            ("predev", "node setup.js"),
            ("build", "vite build"),
            ("start:dev", "next dev"),
            ("preview", "vite preview"),
            ("local", "vite --host"),
            ("test", "vitest"),
        ]);
        assert_eq!(ranked_scripts(&p, ""), ["start:dev", "local", "preview"]);
        assert!(ranked_scripts(
            &probe(&[("dev", "tsc --watch"), ("start", "vite build")]),
            ""
        )
        .is_empty());
    }
    #[test]
    fn matches_listener_to_its_script_and_honors_explicit_manager() {
        let mut p = probe(&[("dev", "next dev"), ("api", "tsx watch api.ts")]);
        p.declared_manager = Some("bun".into());
        p.lockfile = Some("package-lock.json".into());
        assert_eq!(
            ranked_scripts(&p, "node /repo/node_modules/tsx/dist/cli.js watch api.ts")[0],
            "api"
        );
        assert_eq!(script_command(&p, "api"), "bun run api");
        assert_eq!(script_command(&p, "it's dev"), "bun run 'it'\\''s dev'");
        assert_eq!(supported_manager("pnpm@10.1.0"), Some("pnpm"));
        assert_eq!(supported_manager("something-else@1"), None);
    }
    #[test]
    fn discovers_nested_apps_and_inherits_the_workspace_manager() {
        let root = std::env::temp_dir().join(format!("redline-launch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("apps/site")).unwrap();
        std::fs::create_dir(root.join(".git")).unwrap();
        std::fs::write(
            root.join("package.json"),
            r#"{"packageManager":"pnpm@10","scripts":{"build":"turbo build","preview":"vite preview"}}"#,
        )
        .unwrap();
        std::fs::write(
            root.join("apps/site/package.json"),
            r#"{"scripts":{"serve":"vite --host"}}"#,
        )
        .unwrap();
        let options = suggestions(&root, &probe_project(&root));
        assert_eq!(options.len(), 2);
        assert_eq!(options[0].command, "pnpm run serve");
        assert_eq!(options[1].command, "pnpm run preview");
        assert_eq!(
            options[0].project_path,
            root.join("apps/site").to_string_lossy()
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
