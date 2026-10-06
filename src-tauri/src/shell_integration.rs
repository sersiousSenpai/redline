// SPDX-License-Identifier: Apache-2.0
//! Plain shell integration is optional and never replaces user rc files.
use portable_pty::CommandBuilder;
use std::path::Path;
use tauri::Manager;
fn write_if_changed(path: &Path, contents: &str) -> Result<(), String> {
    if std::fs::read_to_string(path).ok().as_deref() != Some(contents) {
        std::fs::write(path, contents).map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub(crate) fn configure(
    app: &tauri::AppHandle,
    shell: &str,
    cmd: &mut CommandBuilder,
) -> Result<bool, String> {
    let enabled = app
        .state::<crate::Settings>()
        .db
        .get_setting("redline.terminal.shellIntegration")
        .as_deref()
        != Some("false");
    if !enabled || std::env::var("REDLINE_SHELL_INTEGRATION").ok().as_deref() == Some("0") {
        return Ok(false);
    }
    let Some(home) = std::env::var_os("HOME") else {
        return Ok(false);
    };
    configure_at(
        shell,
        cmd,
        Path::new(&home),
        std::env::var_os("ZDOTDIR").as_deref().map(Path::new),
    )
}
fn configure_at(
    shell: &str,
    cmd: &mut CommandBuilder,
    home: &Path,
    zdotdir: Option<&Path>,
) -> Result<bool, String> {
    let name = Path::new(shell)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if !matches!(name, "zsh" | "bash") {
        return Ok(false);
    }
    let dir = home.join(".redline/shell-integration");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    match name {
        "zsh" => {
            write_if_changed(
                &dir.join(".zshenv"),
                include_str!("../shell-integration/zshenv"),
            )?;
            write_if_changed(
                &dir.join(".zprofile"),
                include_str!("../shell-integration/zprofile"),
            )?;
            write_if_changed(
                &dir.join(".zshrc"),
                include_str!("../shell-integration/zshrc"),
            )?;
            cmd.env(
                "REDLINE_USER_ZDOTDIR_SET",
                if zdotdir.is_some() { "1" } else { "0" },
            );
            cmd.env("REDLINE_USER_ZDOTDIR", zdotdir.unwrap_or(home));
            cmd.env("REDLINE_SHELL_INTEGRATION_DIR", &dir);
            cmd.env("ZDOTDIR", &dir);
            cmd.arg("-l");
        }
        "bash" => {
            let rc = dir.join("bashrc");
            write_if_changed(&rc, include_str!("../shell-integration/bashrc"))?;
            cmd.arg("--rcfile");
            cmd.arg(rc);
            cmd.arg("-i");
        }
        _ => unreachable!(),
    }
    Ok(true)
}
#[tauri::command]
pub fn shell_integration_get(settings: tauri::State<'_, crate::Settings>) -> bool {
    settings
        .db
        .get_setting("redline.terminal.shellIntegration")
        .as_deref()
        != Some("false")
}
#[tauri::command]
pub fn shell_integration_set(
    settings: tauri::State<'_, crate::Settings>,
    enabled: bool,
) -> Result<(), String> {
    settings
        .db
        .set_setting(
            "redline.terminal.shellIntegration",
            if enabled { "true" } else { "false" },
        )
        .map_err(|e| e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn completion_quotes_shell_metacharacters_and_literal_tilde_names() {
        let dir = std::env::temp_dir().join(format!("redline-completion-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["~root", "$(touch surprise)", "a;b"] {
            std::fs::write(dir.join(name), "fixture").unwrap();
        }
        let rows = complete_in(&dir, "").unwrap();
        assert!(rows.contains(&"\\~root".to_string()));
        assert!(rows.contains(&"\\$\\(touch\\ surprise\\)".to_string()));
        assert!(rows.contains(&"a\\;b".to_string()));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn shims_preserve_user_startup_and_unknown_shells_degrade() {
        let home = std::env::temp_dir().join(format!("redline-shim-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&home).unwrap();
        let mut zsh = CommandBuilder::new("/bin/zsh");
        assert!(configure_at("/bin/zsh", &mut zsh, &home, None).unwrap());
        let mut bash = CommandBuilder::new("/bin/bash");
        assert!(configure_at("/bin/bash", &mut bash, &home, None).unwrap());
        let mut fish = CommandBuilder::new("/bin/fish");
        assert!(!configure_at("/bin/fish", &mut fish, &home, None).unwrap());
        assert!(home.join(".redline/shell-integration/.zshrc").exists());
        assert!(!home.join(".zshrc").exists());
        let _ = std::fs::remove_dir_all(home);
    }
}

/// Completion is a filesystem read rooted at the live local PTY's cwd. No
/// shell command evaluation, substitutions, or remotely supplied cwd is used.
#[tauri::command(async)]
pub fn shell_complete_path(
    state: tauri::State<'_, crate::pty::PtyState>,
    id: String,
    word: String,
) -> Result<Vec<String>, String> {
    if word.len() > 4096 || word.chars().any(|c| c.is_control()) {
        return Ok(Vec::new());
    }
    let cwd = crate::pty::pty_cwd(state, id).ok_or("This shell is no longer running.")?;
    complete_in(Path::new(&cwd), &word)
}
fn complete_in(cwd: &Path, word: &str) -> Result<Vec<String>, String> {
    let (prefix, leaf) = word
        .rsplit_once('/')
        .map(|(dir, name)| (format!("{dir}/"), name))
        .unwrap_or_else(|| (String::new(), word));
    let directory = if let Some(rest) = prefix.strip_prefix("~/") {
        std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .ok_or("Home folder is unavailable.")?
            .join(rest)
    } else {
        cwd.join(&prefix)
    };
    let mut result = Vec::new();
    for entry in std::fs::read_dir(directory)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.chars().any(|c| c.is_control())
            || !name.starts_with(leaf)
            || (!leaf.starts_with('.') && name.starts_with('.'))
        {
            continue;
        }
        let mut completed = format!("{prefix}{name}");
        if entry.path().is_dir() {
            completed.push('/');
        }
        // Backslash-escape shell metacharacters in inserted filesystem names.
        let escaped = completed
            .chars()
            .enumerate()
            .map(|(index, c)| {
                // Only the user's explicit ~/ prefix should expand. A real
                // filename such as ~root must remain a literal filename.
                if c.is_ascii_alphanumeric()
                    || "/._-".contains(c)
                    || (c == '~' && index == 0 && prefix.starts_with("~/"))
                {
                    c.to_string()
                } else {
                    format!("\\{c}")
                }
            })
            .collect::<String>();
        result.push(escaped);
        if result.len() >= 100 {
            break;
        }
    }
    result.sort();
    Ok(result)
}
