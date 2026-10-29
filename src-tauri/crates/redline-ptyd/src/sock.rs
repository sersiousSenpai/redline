// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Where the socket lives and how the helper is started.
//!
//! The socket is `<data dir>/<name>`: the app names it after its own
//! executable's path, so the release app, the dev app and each worktree's dev
//! app get their own helper and a walk lane never adopts the user's
//! terminals. The directory is 0700 and the socket 0600.
//!
//! `sun_path` holds 104 bytes. When `<dir>/<name>` is longer, the helper
//! (single-threaded, so a process `chdir` is safe there) binds the bare name
//! inside the directory, and the app connects to the bare name from a thread
//! whose own working directory it has moved there (`pthread_fchdir_np`), so
//! nothing else in the app sees a changed cwd.

use std::ffi::CString;
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};

/// `sun_path`'s size on macOS, terminator included.
pub const SUN_PATH: usize = 104;

/// Whether `path` can be bound or connected to as it is.
pub fn fits(path: &Path) -> bool {
    path.as_os_str().len() < SUN_PATH
}

/// Make the directory owner-only (creating it if need be).
pub fn private_dir(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

/// Bind `<dir>/<name>`, 0600, replacing a stale socket nobody answers on.
/// `AddrInUse` means a live helper already holds it. Long paths bind the
/// bare name after a process `chdir` into `dir`: callers must be
/// single-threaded (the helper is).
pub fn bind(dir: &Path, name: &str) -> io::Result<UnixListener> {
    use std::os::unix::fs::PermissionsExt;
    let full = dir.join(name);
    if connect(dir, name).is_ok() {
        return Err(io::Error::new(io::ErrorKind::AddrInUse, format!("a helper is already serving {}", full.display())));
    }
    match std::fs::remove_file(&full) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    // The socket is created with the umask applied; 0177 makes it 0600 from
    // the first instant, before the chmod below pins it.
    // SAFETY: umask has no failure mode.
    let old = unsafe { libc::umask(0o177) };
    let listener = if fits(&full) {
        UnixListener::bind(&full)
    } else {
        std::env::set_current_dir(dir).and_then(|()| UnixListener::bind(name))
    };
    // SAFETY: as above.
    unsafe { libc::umask(old) };
    let listener = listener?;
    std::fs::set_permissions(&full, std::fs::Permissions::from_mode(0o600))?;
    cloexec(listener.as_raw_fd())?;
    Ok(listener)
}

extern "C" {
    /// Per-thread working directory (libSystem). `-1` returns the thread to
    /// the process's directory.
    fn pthread_fchdir_np(fd: libc::c_int) -> libc::c_int;
}

/// Connect to `<dir>/<name>`, by a bare name from a thread-local working
/// directory when the full path is too long.
pub fn connect(dir: &Path, name: &str) -> io::Result<UnixStream> {
    let full = dir.join(name);
    let stream = if fits(&full) {
        UnixStream::connect(&full)?
    } else {
        let dir = dir.to_path_buf();
        let name = name.to_string();
        // A fresh thread, so the moved working directory dies with it.
        std::thread::spawn(move || -> io::Result<UnixStream> {
            let d = std::fs::File::open(&dir)?;
            // SAFETY: a valid directory fd; affects only this thread.
            if unsafe { pthread_fchdir_np(d.as_raw_fd()) } != 0 {
                return Err(io::Error::last_os_error());
            }
            let result = UnixStream::connect(&name);
            // SAFETY: back to the process directory before the thread ends.
            unsafe { pthread_fchdir_np(-1) };
            result
        })
        .join()
        .map_err(|_| io::Error::other("connect thread panicked"))??
    };
    cloexec(stream.as_raw_fd())?;
    Ok(stream)
}

pub fn cloexec(fd: libc::c_int) -> io::Result<()> {
    // SAFETY: fcntl on an fd this process owns.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFD);
        if flags < 0 || libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

/// The helper beside an executable: `Contents/MacOS/redline-ptyd` beside
/// `Contents/MacOS/Redline`, `target/debug/redline-ptyd` beside the dev
/// `redline`.
pub fn sibling(exe: &Path) -> Option<PathBuf> {
    Some(exe.parent()?.join("redline-ptyd"))
}

/// Not in libc 0.2.186's apple module; `<spawn.h>`: `POSIX_SPAWN_SETSID`.
const POSIX_SPAWN_SETSID: libc::c_int = 0x0400;

/// Start a helper out of the caller's session and process group.
///
/// * `posix_spawn` with `POSIX_SPAWN_SETSID`, so it leaves `tauri dev`'s
///   process group (Ctrl-C in the dev terminal no longer reaches it) and
///   never had a controlling terminal;
/// * `POSIX_SPAWN_CLOEXEC_DEFAULT`, which is **load-bearing**: a helper that
///   inherited the app's `:7676` listener would keep the port bound after
///   quit, and the next launch could not bind it. Only stdio on `/dev/null`
///   crosses;
/// * default signal dispositions and an empty mask;
/// * an empty environment: the helper needs none, and every terminal's
///   environment arrives explicitly in its `Spawn`.
///
/// The helper binds its socket, then forks once more and the intermediate
/// exits, so launchd adopts it and the caller never holds a zombie. This
/// waits for that intermediate: when it returns `Ok`, the socket is
/// listening.
pub fn spawn_helper(exe: &Path, args: &[String]) -> io::Result<()> {
    let prog = CString::new(exe.as_os_str().as_encoded_bytes()).map_err(io::Error::other)?;
    let mut argv_c: Vec<CString> = vec![prog.clone()];
    for a in args {
        argv_c.push(CString::new(a.as_bytes()).map_err(io::Error::other)?);
    }
    let mut argv: Vec<*mut libc::c_char> = argv_c.iter().map(|c| c.as_ptr() as *mut _).collect();
    argv.push(std::ptr::null_mut());
    let mut envp: Vec<*mut libc::c_char> = vec![std::ptr::null_mut()];
    let devnull = CString::new("/dev/null").unwrap();
    // SAFETY: every pointer handed to posix_spawn outlives the call, and the
    // attr/file-action objects are initialized before use and destroyed after.
    unsafe {
        let mut attr: libc::posix_spawnattr_t = std::mem::zeroed();
        let mut actions: libc::posix_spawn_file_actions_t = std::mem::zeroed();
        check(libc::posix_spawnattr_init(&mut attr))?;
        check(libc::posix_spawn_file_actions_init(&mut actions))?;
        let result = (|| {
            let flags = POSIX_SPAWN_SETSID | libc::POSIX_SPAWN_CLOEXEC_DEFAULT | libc::POSIX_SPAWN_SETSIGDEF | libc::POSIX_SPAWN_SETSIGMASK;
            check(libc::posix_spawnattr_setflags(&mut attr, flags as libc::c_short))?;
            let mut all: libc::sigset_t = std::mem::zeroed();
            libc::sigfillset(&mut all);
            check(libc::posix_spawnattr_setsigdefault(&mut attr, &all))?;
            let mut none: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut none);
            check(libc::posix_spawnattr_setsigmask(&mut attr, &none))?;
            for (fd, mode) in [(0, libc::O_RDONLY), (1, libc::O_WRONLY), (2, libc::O_WRONLY)] {
                check(libc::posix_spawn_file_actions_addopen(&mut actions, fd, devnull.as_ptr(), mode, 0))?;
            }
            let mut pid: libc::pid_t = 0;
            check(libc::posix_spawn(&mut pid, prog.as_ptr(), &actions, &attr, argv.as_mut_ptr(), envp.as_mut_ptr()))?;
            let mut status = 0;
            loop {
                if libc::waitpid(pid, &mut status, 0) >= 0 {
                    break;
                }
                let e = io::Error::last_os_error();
                if e.kind() != io::ErrorKind::Interrupted {
                    return Err(e);
                }
            }
            if libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0 {
                Ok(())
            } else if libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == EXIT_IN_USE {
                Err(io::Error::new(io::ErrorKind::AddrInUse, "a helper is already serving this socket"))
            } else {
                Err(io::Error::other(format!("the helper failed to start (wait status {status})")))
            }
        })();
        libc::posix_spawn_file_actions_destroy(&mut actions);
        libc::posix_spawnattr_destroy(&mut attr);
        result
    }
}

/// The helper's exit code when another helper already serves its socket.
pub const EXIT_IN_USE: i32 = 3;

fn check(rc: libc::c_int) -> io::Result<()> {
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(rc))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rl-sock-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        private_dir(&dir).unwrap();
        dir
    }

    #[test]
    fn a_short_path_binds_owner_only_and_a_stale_socket_is_replaced() {
        let dir = scratch("short");
        let l = bind(&dir, "s.sock").unwrap();
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(dir.join("s.sock")).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        let err = bind(&dir, "s.sock").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AddrInUse, "a live listener is not stale");
        drop(l);
        // The file outlives the listener; nobody answers it, so it is stale.
        assert!(dir.join("s.sock").exists());
        let _l = bind(&dir, "s.sock").unwrap();
        assert!(connect(&dir, "s.sock").is_ok());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_sun_path_limit_is_the_kernels() {
        assert!(fits(Path::new("/Users/someone/Library/Application Support/com.redline.app/ptyd-0123abcd.sock")));
        assert!(!fits(&Path::new("/").join("x".repeat(SUN_PATH - 1))), "the terminator needs a byte");
        assert!(fits(&Path::new("/").join("x".repeat(SUN_PATH - 3))));
        // The long branch itself runs in the real helper (tests/e2e.rs), which
        // is single-threaded as its process-wide chdir requires.
    }
}
