// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The bundle exchange.
//!
//! The installed application and the verified candidate trade places in one
//! filesystem operation. macOS provides exactly that: `renamex_np` with
//! `RENAME_SWAP` exchanges two paths atomically — "the two paths' contents are
//! swapped" — with no window in which neither exists.
//!
//! The alternative, which is what the manual installation script has always
//! done, is `rm -rf` the installed bundle and copy the new one over. A crash
//! in the middle of that leaves no application at all, and nothing to roll
//! back to. The exchange's second virtue is that the old bundle is not
//! destroyed: it is simply at the other path afterwards, which is what makes
//! rollback a second exchange rather than a restore from a backup.
//!
//! Support is **qualified before the application quits**, not attempted after
//! it. An unsupported filesystem is a reason to refuse the restart while
//! Redline is still running and can say so — never a reason to fall back to
//! deleting the user's installed application.

use std::ffi::CString;
use std::io;
use std::path::Path;

/// `renamex_np` flag: exchange the two paths.
#[cfg(target_os = "macos")]
const RENAME_SWAP: libc::c_uint = 0x0002;

fn c_path(path: &Path) -> io::Result<CString> {
    CString::new(path.as_os_str().as_encoded_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains a NUL byte"))
}

/// Exchange two existing paths atomically.
///
/// Both must exist and be on the same filesystem. On success the contents of
/// `a` are at `b` and vice versa.
#[cfg(target_os = "macos")]
pub fn swap_paths(a: &Path, b: &Path) -> io::Result<()> {
    let (ca, cb) = (c_path(a)?, c_path(b)?);
    let rc = unsafe { libc::renamex_np(ca.as_ptr(), cb.as_ptr(), RENAME_SWAP) };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(target_os = "macos"))]
pub fn swap_paths(_a: &Path, _b: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "atomic path exchange is implemented for macOS only",
    ))
}

/// Prove that `dir`'s filesystem implements the exchange, by performing one.
///
/// Called before the application starts quitting. A probe rather than a
/// capability query: the flag is refused per-filesystem (`ENOTSUP`), and the
/// staging directory can sit on a volume the installed application does not.
pub fn swap_supported(dir: &Path) -> Result<(), String> {
    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    );
    let a = dir.join(format!(".redline-swap-a-{unique}"));
    let b = dir.join(format!(".redline-swap-b-{unique}"));
    let attempt = || -> Result<(), String> {
        std::fs::write(&a, b"a").map_err(|e| format!("{}: {e}", a.display()))?;
        std::fs::write(&b, b"b").map_err(|e| format!("{}: {e}", b.display()))?;
        swap_paths(&a, &b).map_err(|e| e.to_string())?;
        let first = std::fs::read(&a).map_err(|e| e.to_string())?;
        let second = std::fs::read(&b).map_err(|e| e.to_string())?;
        if first == b"b" && second == b"a" {
            Ok(())
        } else {
            Err("the exchange reported success but the paths were not exchanged".to_string())
        }
    };
    let result = attempt();
    let _ = std::fs::remove_file(&a);
    let _ = std::fs::remove_file(&b);
    // Every failure — an unsupported flag, an unwritable directory, a
    // filesystem that lies about the result — lands on the same answer,
    // because the answer is the same: do not proceed, and do not improvise.
    result.map_err(|e| {
        format!(
            "this filesystem cannot exchange the installed application atomically \
             ({}: {e}). Redline will not remove your installed copy to work around \
             that \u{2014} install this release the conventional way instead.",
            dir.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "rl-swap-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn directories_are_exchanged_whole() {
        // The real shape: two bundle-like directories trading places, with the
        // old one surviving at the other path.
        let dir = tmp("dirs");
        let installed = dir.join("Redline.app");
        let staged = dir.join("Staged.app");
        for (root, marker) in [(&installed, "old"), (&staged, "new")] {
            std::fs::create_dir_all(root.join("Contents/MacOS")).unwrap();
            std::fs::write(root.join("Contents/MacOS/Redline"), marker).unwrap();
        }
        swap_paths(&installed, &staged).unwrap();
        assert_eq!(
            std::fs::read_to_string(installed.join("Contents/MacOS/Redline")).unwrap(),
            "new"
        );
        assert_eq!(
            std::fs::read_to_string(staged.join("Contents/MacOS/Redline")).unwrap(),
            "old",
            "the previous bundle must survive the exchange — it is the rollback"
        );
        // And back again: rollback is the same operation.
        swap_paths(&installed, &staged).unwrap();
        assert_eq!(
            std::fs::read_to_string(installed.join("Contents/MacOS/Redline")).unwrap(),
            "old"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn support_is_demonstrated_on_the_temporary_filesystem() {
        let dir = tmp("support");
        swap_supported(&dir).expect("APFS implements RENAME_SWAP");
        // The probe leaves nothing behind.
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn a_missing_path_is_an_error_not_a_partial_exchange() {
        let dir = tmp("missing");
        let a = dir.join("exists");
        std::fs::write(&a, b"a").unwrap();
        let err = swap_paths(&a, &dir.join("ghost")).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "a");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unsupported_filesystem_says_so_instead_of_offering_to_delete() {
        // The message is the contract: it must never suggest removing the
        // installed application as a workaround.
        let err = swap_supported(Path::new("/definitely/not/a/directory")).unwrap_err();
        assert!(err.contains("conventional way"), "{err}");
        assert!(err.contains("will not remove your installed copy"), "{err}");
    }
}
