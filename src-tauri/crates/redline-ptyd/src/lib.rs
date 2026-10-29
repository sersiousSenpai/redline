// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The pure half of `redline-ptyd`, and the rules both ends of its socket
//! share.
//!
//! * [`outlet`]: the 256 KB replay ring and the ACK credit of one terminal,
//!   the same contract `pty.rs`'s in-process `Pump` keeps (one replay frame
//!   per attach, a 256 KB high-water mark, a 5 s stall suspension, the
//!   `ESC c` reset when a stalled reader fell behind the ring).
//! * [`input`]: paced writes. A long programmatic write goes out in 512-byte
//!   chunks 4 ms apart, and a frame can ask for a quiet gap before it (the
//!   30 ms settle between a paste and its Return), so batching on the socket
//!   can never compress what the tty needs spread out.
//! * [`tombs`]: what is kept of a terminal that exited on its own.
//! * [`peer`]: who may talk to whom (same user, and the sibling executable).
//! * [`sock`]: where the socket lives, the `sun_path` fallback, and how the
//!   app starts a helper that leaves its process group.

pub mod input;
pub mod outlet;
pub mod peer;
pub mod sock;
pub mod tombs;

/// Follows `ESC[?2004h` / `ESC[?2004l` through an output stream, across
/// reads that split the sequence anywhere: the conversation composer's "the
/// prompt can take a paste now". The helper runs it over every byte,
/// attached or not, so the state survives a relaunch.
#[derive(Default)]
pub struct ModeScan {
    matched: usize,
}

impl ModeScan {
    const PREFIX: &'static [u8] = b"\x1b[?2004";

    /// The last switch in `bytes`, if any.
    pub fn feed(&mut self, bytes: &[u8]) -> Option<bool> {
        let mut last = None;
        for &b in bytes {
            if self.matched == Self::PREFIX.len() {
                match b {
                    b'h' => last = Some(true),
                    b'l' => last = Some(false),
                    _ => {}
                }
                self.matched = usize::from(b == 0x1b);
            } else if b == Self::PREFIX[self.matched] {
                self.matched += 1;
            } else {
                self.matched = usize::from(b == 0x1b);
            }
        }
        last
    }
}

/// The capabilities this helper offers beyond the frozen core frame set.
pub const CAPS: &[&str] = &["tail", "meta", "retire", "tombs"];

/// This helper's build, for the handshake.
pub fn build_id() -> String {
    option_env!("REDLINE_BUILD_ID").map(str::to_string).unwrap_or_else(|| format!("ptyd-{}", env!("CARGO_PKG_VERSION")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paste_mode_is_followed_across_reads_split_anywhere() {
        let stream: &[u8] = b"\x1b[?25l\x1b[?2004hprompt\x1b[2J\x1b[?2004l bye \x1b\x1b[?2004h";
        for first in 0..=stream.len() {
            for second in first..=stream.len() {
                let mut scan = ModeScan::default();
                let parts = [&stream[..first], &stream[first..second], &stream[second..]];
                let seen: Vec<bool> = parts.iter().filter_map(|part| scan.feed(part)).collect();
                assert_eq!(seen.last(), Some(&true), "split at {first}/{second}");
            }
        }
        assert_eq!(ModeScan::default().feed(b"\x1b[?2004;1h \x1b[?200h"), None);
    }
}
