// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Who may talk on the socket.
//!
//! **Threat model, stated plainly.** Same-user processes can already read the
//! 0600 `daemon.token`, so this is not a wall against a determined same-user
//! attacker. It stops the realistic misuse: an agent's Bash in terminal A
//! connecting to the socket and typing into terminal B. Both ends check:
//!
//! * the helper accepts a peer only when `getpeereid` says it is this user
//!   **and** `LOCAL_PEERPID` → `proc_pidpath` lies in the directory the
//!   helper was started from (the sibling rule: `Contents/MacOS/` in the
//!   bundle, `target/debug/` in development);
//! * the app accepts a helper by **identity, not path** ([`check_helper`]):
//!   this user, an executable named `redline-ptyd` (when the kernel still has
//!   a path for it), and, on a Developer ID build, a valid signature by this
//!   app's own team. The handshake then asks it to prove it read the per-user
//!   secret in the 0700 socket directory (`sock::secret`,
//!   `redline_pty_proto::proof`). A path is never the test: an app update
//!   moves the running helper's bundle aside (and later deletes it), and the
//!   helper still holding the user's shells is exactly the one to adopt
//!   (and then retire, when its build is not current).
//!
//! On a Developer ID build both ends also require the peer's signing team to
//! be their own ([`same_team`]); an ad-hoc or unsigned build has no team.

use std::ffi::CStr;
use std::io;
use std::os::fd::RawFd;
use std::path::{Path, PathBuf};

/// The peer's effective uid.
pub fn peer_uid(fd: RawFd) -> io::Result<u32> {
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    // SAFETY: plain out-parameters.
    if unsafe { libc::getpeereid(fd, &mut uid, &mut gid) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(uid)
}

/// The peer's pid, as the kernel recorded it at connect.
#[cfg(target_os = "macos")]
pub fn peer_pid(fd: RawFd) -> io::Result<i32> {
    let mut pid: libc::pid_t = 0;
    let mut len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    // SAFETY: a pid_t-sized out-parameter with its length.
    let rc = unsafe { libc::getsockopt(fd, libc::SOL_LOCAL, libc::LOCAL_PEERPID, (&mut pid as *mut libc::pid_t).cast(), &mut len) };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(pid)
}

#[cfg(not(target_os = "macos"))]
pub fn peer_pid(_fd: RawFd) -> io::Result<i32> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "no LOCAL_PEERPID here"))
}

/// The executable a process is running, from the kernel.
#[cfg(target_os = "macos")]
pub fn pid_path(pid: i32) -> Option<PathBuf> {
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: the kernel writes at most `buf.len()` bytes.
    let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if n <= 0 {
        return None;
    }
    buf.truncate(n as usize);
    Some(PathBuf::from(String::from_utf8_lossy(&buf).into_owned()))
}

#[cfg(not(target_os = "macos"))]
pub fn pid_path(_pid: i32) -> Option<PathBuf> {
    None
}

fn canonical(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// The sibling rule: `exe` sits directly in `dir`.
pub fn in_dir(exe: &Path, dir: &Path) -> bool {
    canonical(exe).parent().is_some_and(|parent| parent == canonical(dir))
}

/// The helper's check of a connecting app.
pub fn check_app(fd: RawFd, peer_dir: &Path) -> Result<(), String> {
    // SAFETY: no arguments.
    let me = unsafe { libc::geteuid() };
    let uid = peer_uid(fd).map_err(|e| format!("getpeereid: {e}"))?;
    if uid != me {
        return Err(format!("peer uid {uid} is not {me}"));
    }
    let pid = peer_pid(fd).map_err(|e| format!("LOCAL_PEERPID: {e}"))?;
    let exe = pid_path(pid).ok_or_else(|| format!("no executable for pid {pid}"))?;
    if !in_dir(&exe, peer_dir) {
        return Err(format!("{} is not in {}", exe.display(), peer_dir.display()));
    }
    same_team(pid)
}

/// Who the app reached.
#[derive(Debug, Clone)]
pub struct HelperPeer {
    pub pid: i32,
    /// The kernel's path for its executable; `None` once the file is gone
    /// (an update deleted the old bundle).
    pub exe: Option<PathBuf>,
}

impl HelperPeer {
    /// Whether it runs from `expected` (the sibling of this app): false after
    /// an update moved or deleted its bundle, which makes it an older build
    /// to adopt and retire, never a stranger.
    pub fn runs_from(&self, expected: &Path) -> bool {
        self.exe.as_deref().is_some_and(|exe| canonical(exe) == canonical(expected))
    }
}

/// The app's check of the helper it connected to: by identity (uid, the
/// executable's name, the signing team), not by path. The caller still
/// verifies the handshake's proof of the per-user secret.
pub fn check_helper(fd: RawFd) -> Result<HelperPeer, String> {
    // SAFETY: no arguments.
    let me = unsafe { libc::geteuid() };
    let uid = peer_uid(fd).map_err(|e| format!("getpeereid: {e}"))?;
    if uid != me {
        return Err(format!("helper uid {uid} is not {me}"));
    }
    let pid = peer_pid(fd).map_err(|e| format!("LOCAL_PEERPID: {e}"))?;
    let exe = pid_path(pid);
    if let Some(exe) = &exe {
        if exe.file_name().and_then(|n| n.to_str()) != Some("redline-ptyd") {
            return Err(format!("{} is not a terminal helper", exe.display()));
        }
    }
    same_team(pid)?;
    Ok(HelperPeer { pid, exe })
}

// --- the signature anchor (Developer ID builds) ---------------------------------

/// A Developer ID build trusts only a peer signed by its own team. A build
/// without a team (ad hoc, unsigned, development) skips this: the path rule
/// stands alone there, as the threat model above says it may.
pub fn same_team(pid: i32) -> Result<(), String> {
    let Some(mine) = team::own() else { return Ok(()) };
    match team::of_pid(pid) {
        Some(theirs) if theirs == mine => Ok(()),
        Some(theirs) => Err(format!("peer team {theirs} is not {mine}")),
        None => Err(format!("peer pid {pid} is not signed by team {mine}")),
    }
}

#[cfg(target_os = "macos")]
mod team {
    use super::CStr;
    use std::ffi::c_void;
    use std::sync::OnceLock;

    type CFTypeRef = *const c_void;
    type OSStatus = i32;

    #[link(name = "Security", kind = "framework")]
    extern "C" {
        fn SecCodeCopySelf(flags: u32, code: *mut CFTypeRef) -> OSStatus;
        fn SecCodeCopyGuestWithAttributes(host: CFTypeRef, attrs: CFTypeRef, flags: u32, guest: *mut CFTypeRef) -> OSStatus;
        fn SecCodeCopyStaticCode(code: CFTypeRef, flags: u32, static_code: *mut CFTypeRef) -> OSStatus;
        fn SecCodeCopySigningInformation(code: CFTypeRef, flags: u32, info: *mut CFTypeRef) -> OSStatus;
        fn SecCodeCheckValidity(code: CFTypeRef, flags: u32, requirement: CFTypeRef) -> OSStatus;
        static kSecGuestAttributePid: CFTypeRef;
        static kSecCodeInfoTeamIdentifier: CFTypeRef;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: CFTypeRef);
        fn CFDictionaryGetValue(dict: CFTypeRef, key: CFTypeRef) -> CFTypeRef;
        fn CFDictionaryCreate(
            alloc: CFTypeRef,
            keys: *const CFTypeRef,
            values: *const CFTypeRef,
            n: isize,
            key_cb: *const c_void,
            value_cb: *const c_void,
        ) -> CFTypeRef;
        fn CFNumberCreate(alloc: CFTypeRef, kind: isize, value: *const c_void) -> CFTypeRef;
        fn CFStringGetCString(s: CFTypeRef, buf: *mut i8, size: isize, encoding: u32) -> u8;
        fn CFGetTypeID(cf: CFTypeRef) -> usize;
        fn CFStringGetTypeID() -> usize;
        static kCFTypeDictionaryKeyCallBacks: c_void;
        static kCFTypeDictionaryValueCallBacks: c_void;
    }

    const K_SEC_CS_SIGNING_INFORMATION: u32 = 1 << 1;
    const K_CF_NUMBER_SINT32: isize = 3;
    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    struct Owned(CFTypeRef);
    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: a +1 reference this wrapper owns.
                unsafe { CFRelease(self.0) }
            }
        }
    }

    /// The team identifier in a code object's signing information.
    unsafe fn team_of(code: CFTypeRef) -> Option<String> {
        let mut stat: CFTypeRef = std::ptr::null();
        if SecCodeCopyStaticCode(code, 0, &mut stat) != 0 {
            return None;
        }
        let stat = Owned(stat);
        let mut info: CFTypeRef = std::ptr::null();
        if SecCodeCopySigningInformation(stat.0, K_SEC_CS_SIGNING_INFORMATION, &mut info) != 0 {
            return None;
        }
        let info = Owned(info);
        let value = CFDictionaryGetValue(info.0, kSecCodeInfoTeamIdentifier);
        if value.is_null() || CFGetTypeID(value) != CFStringGetTypeID() {
            return None;
        }
        let mut buf = [0i8; 64];
        if CFStringGetCString(value, buf.as_mut_ptr(), buf.len() as isize, K_CF_STRING_ENCODING_UTF8) == 0 {
            return None;
        }
        let s = CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned();
        (!s.is_empty()).then_some(s)
    }

    pub fn own() -> Option<String> {
        static MINE: OnceLock<Option<String>> = OnceLock::new();
        MINE.get_or_init(|| unsafe {
            let mut code: CFTypeRef = std::ptr::null();
            if SecCodeCopySelf(0, &mut code) != 0 {
                return None;
            }
            let code = Owned(code);
            team_of(code.0)
        })
        .clone()
    }

    pub fn of_pid(pid: i32) -> Option<String> {
        unsafe {
            let number = Owned(CFNumberCreate(std::ptr::null(), K_CF_NUMBER_SINT32, (&pid as *const i32).cast()));
            let keys = [kSecGuestAttributePid];
            let values = [number.0];
            let attrs = Owned(CFDictionaryCreate(
                std::ptr::null(),
                keys.as_ptr(),
                values.as_ptr(),
                1,
                (&kCFTypeDictionaryKeyCallBacks as *const c_void).cast(),
                (&kCFTypeDictionaryValueCallBacks as *const c_void).cast(),
            ));
            let mut guest: CFTypeRef = std::ptr::null();
            if SecCodeCopyGuestWithAttributes(std::ptr::null(), attrs.0, 0, &mut guest) != 0 {
                return None;
            }
            let guest = Owned(guest);
            // A signature that no longer verifies names no team.
            if SecCodeCheckValidity(guest.0, 0, std::ptr::null()) != 0 {
                return None;
            }
            team_of(guest.0)
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod team {
    pub fn own() -> Option<String> {
        None
    }
    pub fn of_pid(_pid: i32) -> Option<String> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sibling_rule_is_the_parent_directory_exactly() {
        let dir = std::env::temp_dir().join(format!("rl-peer-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("Redline"), b"").unwrap();
        std::fs::write(dir.join("sub/other"), b"").unwrap();
        assert!(in_dir(&dir.join("Redline"), &dir));
        assert!(!in_dir(&dir.join("sub/other"), &dir), "a subdirectory is not the directory");
        assert!(!in_dir(&dir.join("Redline"), &dir.join("sub")));
        // A path spelled through `..` is the same file.
        assert!(in_dir(&dir.join("sub/../Redline"), &dir));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn this_process_is_its_own_peer_over_a_socketpair() {
        let (a, _b) = std::os::unix::net::UnixStream::pair().unwrap();
        use std::os::fd::AsRawFd;
        // SAFETY: no arguments.
        assert_eq!(peer_uid(a.as_raw_fd()).unwrap(), unsafe { libc::geteuid() });
        let pid = peer_pid(a.as_raw_fd()).unwrap();
        assert_eq!(pid as u32, std::process::id());
        let exe = pid_path(pid).unwrap();
        let me = std::env::current_exe().unwrap();
        assert!(in_dir(&exe, me.parent().unwrap()));
        assert!(check_app(a.as_raw_fd(), me.parent().unwrap()).is_ok());
        let err = check_app(a.as_raw_fd(), Path::new("/usr/bin")).unwrap_err();
        assert!(err.contains("is not in"), "{err}");
        // The test binary is not named redline-ptyd: not a helper.
        let err = check_helper(a.as_raw_fd()).unwrap_err();
        assert!(err.contains("is not a terminal helper"), "{err}");
        // A test binary is ad-hoc signed: no team, so the anchor check passes
        // on the path rule alone.
        assert!(same_team(pid).is_ok());
    }
}
