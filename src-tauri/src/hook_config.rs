// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Shared serialization and compare-before-replace for integration settings.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

static WRITES: Mutex<()> = Mutex::new(());
pub fn lock() -> MutexGuard<'static, ()> {
    WRITES.lock().unwrap_or_else(|e| e.into_inner())
}
pub fn fingerprint(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn read(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// Caller holds `lock` across reading, editing and writing. An external editor
/// cannot be locked by us; recheck immediately before rename and refuse drift.
/// Never follow a settings symlink into a different, unreviewed write target.
pub fn replace(
    path: &Path,
    original: Option<&[u8]>,
    root: &Value,
) -> Result<Option<PathBuf>, String> {
    if !root.is_object() {
        return Err("configuration root must be a JSON object".into());
    }
    let bytes = format!(
        "{}\n",
        serde_json::to_string_pretty(root).map_err(|e| e.to_string())?
    )
    .into_bytes();
    if original == Some(bytes.as_slice()) {
        return Ok(None);
    }
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("configuration is a symlink; inspect and edit its target manually".into());
    }
    if read(path)?.as_deref() != original {
        return Err("configuration changed since inspection; refresh and retry".into());
    }
    let parent = path
        .parent()
        .ok_or("configuration has no parent directory")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let nonce = uuid::Uuid::new_v4();
    let name = path
        .file_name()
        .ok_or("configuration has no filename")?
        .to_string_lossy();
    let temporary = parent.join(format!(".{name}.redline-{nonce}.tmp"));
    let backup = original.map(|_| parent.join(format!("{name}.redline-backup-{nonce}")));
    let permissions = fs::metadata(path).ok().map(|m| m.permissions());
    if permissions.as_ref().is_some_and(|p| p.readonly()) {
        return Err("configuration is read-only; edit it in its owning scope".into());
    }
    let write_new = |target: &Path, data: &[u8]| -> Result<(), String> {
        let mut options = fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(target)
            .map_err(|e| format!("{}: {e}", target.display()))?;
        file.write_all(data).map_err(|e| e.to_string())?;
        if let Some(p) = &permissions {
            file.set_permissions(p.clone()).map_err(|e| e.to_string())?;
        }
        file.sync_all().map_err(|e| e.to_string())
    };
    let result = (|| {
        write_new(&temporary, &bytes)?;
        if let (Some(target), Some(data)) = (&backup, original) {
            write_new(target, data)?;
        }
        if read(path)?.as_deref() != original {
            return Err("configuration changed while preparing the edit; refresh and retry".into());
        }
        fs::rename(&temporary, path).map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(backup)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// Edit via an existing file-based helper without exposing the real settings
/// to a non-atomic writer. The helper receives a disposable sibling file.
pub fn stage<T>(path: &Path, edit: impl FnOnce(&Path) -> Result<T, String>) -> Result<T, String> {
    let _guard = lock();
    let original = read(path)?;
    if let Some(bytes) = &original {
        serde_json::from_slice::<Value>(bytes).map_err(|e| e.to_string())?;
    }
    let parent = path
        .parent()
        .ok_or("configuration has no parent directory")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let staging = parent.join(format!(".redline-stage-{}.json", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options
            .open(&staging)
            .map_err(|e| e.to_string())?
            .write_all(original.as_deref().unwrap_or(b"{}"))
            .map_err(|e| e.to_string())?;
        let output = edit(&staging)?;
        let root: Value = serde_json::from_slice(&fs::read(&staging).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        replace(path, original.as_deref(), &root)?;
        Ok(output)
    })();
    let _ = fs::remove_file(&staging);
    result
}
