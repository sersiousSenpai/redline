// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The wire between Redline and `redline-ptyd`, the helper that owns the
//! terminals so they outlive the app.
//!
//! Every frame is `u32 length (LE) · u8 type · u32 pty · payload`, where
//! `length` counts the type byte, the handle and the payload. One stream
//! connection per app carries every terminal; `pty` is the helper's handle for
//! a terminal (0 when a frame is about none), so string ids appear only in
//! control frames.
//!
//! Payloads are fixed little-endian layouts. Strings are `u16 len + UTF-8`;
//! byte payloads (output, input) run to the end of the frame.
//!
//! Compatibility: [`CORE`] names the frozen frame set. A type with bit 7 set
//! is optional: a decoder that doesn't know it skips it, which is how an
//! optional capability adds frames without bumping `CORE`. An unknown type
//! without bit 7 is a protocol error, and so is a frame over [`MAX_FRAME`].

use std::fmt;

/// The frozen frame set this codec speaks.
pub const CORE: u16 = 1;
/// Frames over this size are a protocol error; the connection drops.
pub const MAX_FRAME: usize = 1 << 20;
/// Bit 7 of the type: a decoder that does not know this frame skips it.
pub const OPTIONAL: u8 = 0x80;
/// The header after the length prefix: type + handle.
const HEADER: usize = 5;
/// The bound on ids, attachment ids, names and messages.
pub const MAX_NAME: usize = 1024;
/// The bound on a terminal's opaque metadata.
pub const MAX_META: usize = 2048;

/// Input flags.
pub const INPUT_PACED: u8 = 1;
pub const INPUT_CHECKED: u8 = 2;

mod t {
    // App → helper.
    pub const HELLO: u8 = 1;
    pub const SPAWN: u8 = 2;
    pub const ATTACH: u8 = 3;
    pub const DETACH: u8 = 4;
    pub const INPUT: u8 = 5;
    pub const RESIZE: u8 = 6;
    pub const ACK: u8 = 7;
    pub const KILL: u8 = 8;
    pub const KILL_WHERE: u8 = 9;
    pub const SET_META: u8 = 10;
    pub const LIST: u8 = 11;
    pub const FG: u8 = 12;
    pub const REAP: u8 = 13;
    pub const TAIL: u8 = 14;
    pub const RETIRE: u8 = 15;
    // Helper → app.
    pub const WELCOME: u8 = 32;
    pub const SPAWNED: u8 = 33;
    pub const LIST_REPLY: u8 = 34;
    pub const REPLAY: u8 = 35;
    pub const OUTPUT: u8 = 36;
    pub const MODE: u8 = 37;
    pub const ACTIVITY: u8 = 38;
    pub const EXIT: u8 = 39;
    pub const INPUT_DONE: u8 = 40;
    pub const FG_REPLY: u8 = 41;
    pub const ERROR: u8 = 42;
    pub const TAIL_REPLY: u8 = 43;
}

/// One terminal as `List` reports it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Row {
    pub handle: u32,
    pub id: String,
    pub pid: u32,
    pub alive: bool,
    /// The wait status, once the child has exited (a tombstone).
    pub exit: Option<i32>,
    /// Unix ms.
    pub started_at: u64,
    /// Unix ms of the newest output, 0 for none.
    pub last_output: u64,
    pub cwd: Option<String>,
    pub persist: bool,
    /// Bracketed paste as the program last set it.
    pub paste: bool,
    /// Opaque to the helper: the app's `{owner, title, sessionId, …}`.
    pub meta: Vec<u8>,
}

/// Everything either side can say. The handle a frame concerns travels in
/// [`Frame::pty`], not here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Msg {
    // App → helper.
    /// `token` only matters on the first `Hello` that carries one: the
    /// helper keeps it for as long as it lives (the token lease).
    /// `nonce` is the app's challenge: the helper answers it with `proof`
    /// ([`proof`] keyed by the per-user secret in the socket's directory),
    /// which is how an app knows the helper it reached is one it could have
    /// started, whatever path its executable now has.
    Hello { core: u16, caps: Vec<String>, build: String, token: Option<String>, nonce: u64 },
    /// The environment is explicit and complete: the helper adds nothing.
    /// A live `id` makes this an attach (the idempotent spawn).
    Spawn {
        seq: u32,
        id: String,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        argv: Vec<String>,
        env: Vec<String>,
        persist: bool,
        meta: Vec<u8>,
        attachment: String,
    },
    /// Replaces any prior attachment: answered with one `Replay`, then live
    /// `Output`, in socket order.
    Attach { attachment: String },
    /// Ignored unless it names the current attachment.
    Detach { attachment: String },
    /// `gap_ms`: the minimum quiet time on this terminal's input before this
    /// frame's first byte (a paste's settle before its Return). Paced input
    /// goes out in 512-byte chunks 4 ms apart. `checked` asks for `InputDone`.
    Input { seq: u32, flags: u8, gap_ms: u16, bytes: Vec<u8> },
    Resize { cols: u16, rows: u16 },
    Ack { attachment: String, n: u32 },
    /// Marks the exit expected.
    Kill { signal: i32 },
    /// The quit path: `all`, or only the terminals not marked persist.
    KillWhere { all: bool },
    SetMeta { persist: bool, meta: Vec<u8> },
    List { seq: u32 },
    Fg { seq: u32 },
    /// Forget a tombstone.
    Reap,
    /// The newest `max` bytes of the ring.
    Tail { seq: u32, max: u32 },
    /// Move to `sock` (a name in the helper's directory), leave the primary
    /// socket to a newer helper, and exit after the last terminal ends.
    Retire { sock: String },

    // Helper → app.
    Welcome { core: u16, caps: Vec<String>, build: String, instance: u64, token: String, pid: u32, proof: u64 },
    Spawned { seq: u32, pid: u32, existed: bool },
    ListReply { seq: u32, rows: Vec<Row> },
    Replay { attachment: String, bytes: Vec<u8> },
    Output { bytes: Vec<u8> },
    Mode { paste: bool },
    Activity { last_output: u64 },
    Exit { status: i32, expected: bool },
    InputDone { seq: u32, ok: bool, error: String },
    FgReply { seq: u32, rows: Vec<(u32, Option<i32>)> },
    /// `seq` 0 answers no request.
    Error { seq: u32, message: String },
    TailReply { seq: u32, bytes: Vec<u8> },
}

/// A message and the terminal it concerns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub pty: u32,
    pub msg: Msg,
}

impl Frame {
    pub fn new(pty: u32, msg: Msg) -> Self {
        Self { pty, msg }
    }
    /// The frame with no terminal.
    pub fn bare(msg: Msg) -> Self {
        Self { pty: 0, msg }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtoError {
    TooLarge(usize),
    UnknownType(u8),
    Truncated(&'static str),
    BadUtf8(&'static str),
    TooLong(&'static str, usize),
    Trailing(u8),
}

impl fmt::Display for ProtoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLarge(n) => write!(f, "frame of {n} bytes is over the {MAX_FRAME}-byte limit"),
            Self::UnknownType(t) => write!(f, "unknown frame type {t}"),
            Self::Truncated(what) => write!(f, "frame ends inside {what}"),
            Self::BadUtf8(what) => write!(f, "{what} is not UTF-8"),
            Self::TooLong(what, n) => write!(f, "{what} of {n} bytes is over its bound"),
            Self::Trailing(t) => write!(f, "frame type {t} has bytes after its payload"),
        }
    }
}

impl std::error::Error for ProtoError {}

// --- the helper's proof -------------------------------------------------------------

/// The per-user secret's size, in bytes.
pub const SECRET_LEN: usize = 32;

/// The helper's answer to an app's `nonce`: SipHash-2-4 of the nonce keyed by
/// the secret (its first 16 bytes; the rest is reserved). Not a MAC against
/// a same-user attacker, who can read the 0600 secret too (see the threat
/// model in `redline_ptyd::peer`): it proves the helper read the file only
/// this user's processes can, in the directory only this user's app owns.
pub fn proof(secret: &[u8; SECRET_LEN], nonce: u64) -> u64 {
    let k0 = u64::from_le_bytes(secret[0..8].try_into().unwrap());
    let k1 = u64::from_le_bytes(secret[8..16].try_into().unwrap());
    siphash24(k0, k1, &nonce.to_le_bytes())
}

fn siphash24(k0: u64, k1: u64, msg: &[u8]) -> u64 {
    let mut v0 = 0x736f_6d65_7073_6575 ^ k0;
    let mut v1 = 0x646f_7261_6e64_6f6d ^ k1;
    let mut v2 = 0x6c79_6765_6e65_7261 ^ k0;
    let mut v3 = 0x7465_6462_7974_6573 ^ k1;
    macro_rules! round {
        () => {
            v0 = v0.wrapping_add(v1);
            v1 = v1.rotate_left(13);
            v1 ^= v0;
            v0 = v0.rotate_left(32);
            v2 = v2.wrapping_add(v3);
            v3 = v3.rotate_left(16);
            v3 ^= v2;
            v0 = v0.wrapping_add(v3);
            v3 = v3.rotate_left(21);
            v3 ^= v0;
            v2 = v2.wrapping_add(v1);
            v1 = v1.rotate_left(17);
            v1 ^= v2;
            v2 = v2.rotate_left(32);
        };
    }
    let mut chunks = msg.chunks_exact(8);
    for c in &mut chunks {
        let m = u64::from_le_bytes(c.try_into().unwrap());
        v3 ^= m;
        round!();
        round!();
        v0 ^= m;
    }
    let rest = chunks.remainder();
    let mut last = (msg.len() as u64 & 0xff) << 56;
    for (i, b) in rest.iter().enumerate() {
        last |= u64::from(*b) << (8 * i);
    }
    v3 ^= last;
    round!();
    round!();
    v0 ^= last;
    v2 ^= 0xff;
    round!();
    round!();
    round!();
    round!();
    v0 ^ v1 ^ v2 ^ v3
}

// --- encoding -------------------------------------------------------------------

struct Out<'a>(&'a mut Vec<u8>);

impl Out<'_> {
    fn u8(&mut self, v: u8) {
        self.0.push(v);
    }
    fn bool(&mut self, v: bool) {
        self.0.push(u8::from(v));
    }
    fn u16(&mut self, v: u16) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn i32(&mut self, v: i32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn u64(&mut self, v: u64) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn str(&mut self, what: &'static str, s: &str, max: usize) -> Result<(), ProtoError> {
        if s.len() > max.min(u16::MAX as usize) {
            return Err(ProtoError::TooLong(what, s.len()));
        }
        self.u16(s.len() as u16);
        self.0.extend_from_slice(s.as_bytes());
        Ok(())
    }
    fn opt_str(&mut self, what: &'static str, s: &Option<String>, max: usize) -> Result<(), ProtoError> {
        match s {
            Some(s) => {
                self.u8(1);
                self.str(what, s, max)
            }
            None => {
                self.u8(0);
                Ok(())
            }
        }
    }
    fn strs(&mut self, what: &'static str, list: &[String], max: usize) -> Result<(), ProtoError> {
        if list.len() > u16::MAX as usize {
            return Err(ProtoError::TooLong(what, list.len()));
        }
        self.u16(list.len() as u16);
        list.iter().try_for_each(|s| self.str(what, s, max))
    }
    fn blob(&mut self, what: &'static str, b: &[u8], max: usize) -> Result<(), ProtoError> {
        if b.len() > max.min(u16::MAX as usize) {
            return Err(ProtoError::TooLong(what, b.len()));
        }
        self.u16(b.len() as u16);
        self.0.extend_from_slice(b);
        Ok(())
    }
    fn rest(&mut self, b: &[u8]) {
        self.0.extend_from_slice(b);
    }
}

/// The type byte of a message.
pub fn type_of(msg: &Msg) -> u8 {
    match msg {
        Msg::Hello { .. } => t::HELLO,
        Msg::Spawn { .. } => t::SPAWN,
        Msg::Attach { .. } => t::ATTACH,
        Msg::Detach { .. } => t::DETACH,
        Msg::Input { .. } => t::INPUT,
        Msg::Resize { .. } => t::RESIZE,
        Msg::Ack { .. } => t::ACK,
        Msg::Kill { .. } => t::KILL,
        Msg::KillWhere { .. } => t::KILL_WHERE,
        Msg::SetMeta { .. } => t::SET_META,
        Msg::List { .. } => t::LIST,
        Msg::Fg { .. } => t::FG,
        Msg::Reap => t::REAP,
        Msg::Tail { .. } => t::TAIL,
        Msg::Retire { .. } => t::RETIRE,
        Msg::Welcome { .. } => t::WELCOME,
        Msg::Spawned { .. } => t::SPAWNED,
        Msg::ListReply { .. } => t::LIST_REPLY,
        Msg::Replay { .. } => t::REPLAY,
        Msg::Output { .. } => t::OUTPUT,
        Msg::Mode { .. } => t::MODE,
        Msg::Activity { .. } => t::ACTIVITY,
        Msg::Exit { .. } => t::EXIT,
        Msg::InputDone { .. } => t::INPUT_DONE,
        Msg::FgReply { .. } => t::FG_REPLY,
        Msg::Error { .. } => t::ERROR,
        Msg::TailReply { .. } => t::TAIL_REPLY,
    }
}

/// Append one encoded frame to `buf`. Nothing is appended on an error.
pub fn encode(frame: &Frame, buf: &mut Vec<u8>) -> Result<(), ProtoError> {
    let start = buf.len();
    buf.extend_from_slice(&[0; 4]);
    buf.push(type_of(&frame.msg));
    buf.extend_from_slice(&frame.pty.to_le_bytes());
    let result = encode_payload(&frame.msg, &mut Out(buf));
    let len = buf.len() - start - 4;
    if let Err(e) = result {
        buf.truncate(start);
        return Err(e);
    }
    if len > MAX_FRAME {
        buf.truncate(start);
        return Err(ProtoError::TooLarge(len));
    }
    buf[start..start + 4].copy_from_slice(&(len as u32).to_le_bytes());
    Ok(())
}

/// One frame as a fresh buffer.
pub fn to_bytes(frame: &Frame) -> Result<Vec<u8>, ProtoError> {
    let mut buf = Vec::new();
    encode(frame, &mut buf)?;
    Ok(buf)
}

fn encode_payload(msg: &Msg, o: &mut Out<'_>) -> Result<(), ProtoError> {
    match msg {
        Msg::Hello { core, caps, build, token, nonce } => {
            o.u16(*core);
            o.strs("cap", caps, MAX_NAME)?;
            o.str("build", build, MAX_NAME)?;
            o.opt_str("token", token, MAX_NAME)?;
            o.u64(*nonce);
        }
        Msg::Spawn { seq, id, cwd, cols, rows, argv, env, persist, meta, attachment } => {
            o.u32(*seq);
            o.str("id", id, MAX_NAME)?;
            o.opt_str("cwd", cwd, u16::MAX as usize)?;
            o.u16(*cols);
            o.u16(*rows);
            o.strs("argv", argv, u16::MAX as usize)?;
            o.strs("env", env, u16::MAX as usize)?;
            o.bool(*persist);
            o.blob("meta", meta, MAX_META)?;
            o.str("attachment", attachment, MAX_NAME)?;
        }
        Msg::Attach { attachment } | Msg::Detach { attachment } => o.str("attachment", attachment, MAX_NAME)?,
        Msg::Input { seq, flags, gap_ms, bytes } => {
            o.u32(*seq);
            o.u8(*flags);
            o.u16(*gap_ms);
            o.rest(bytes);
        }
        Msg::Resize { cols, rows } => {
            o.u16(*cols);
            o.u16(*rows);
        }
        Msg::Ack { attachment, n } => {
            o.str("attachment", attachment, MAX_NAME)?;
            o.u32(*n);
        }
        Msg::Kill { signal } => o.i32(*signal),
        Msg::KillWhere { all } => o.bool(*all),
        Msg::SetMeta { persist, meta } => {
            o.bool(*persist);
            o.blob("meta", meta, MAX_META)?;
        }
        Msg::List { seq } | Msg::Fg { seq } => o.u32(*seq),
        Msg::Reap => {}
        Msg::Tail { seq, max } => {
            o.u32(*seq);
            o.u32(*max);
        }
        Msg::Retire { sock } => o.str("sock", sock, MAX_NAME)?,
        Msg::Welcome { core, caps, build, instance, token, pid, proof } => {
            o.u16(*core);
            o.strs("cap", caps, MAX_NAME)?;
            o.str("build", build, MAX_NAME)?;
            o.u64(*instance);
            o.str("token", token, MAX_NAME)?;
            o.u32(*pid);
            o.u64(*proof);
        }
        Msg::Spawned { seq, pid, existed } => {
            o.u32(*seq);
            o.u32(*pid);
            o.bool(*existed);
        }
        Msg::ListReply { seq, rows } => {
            o.u32(*seq);
            if rows.len() > u16::MAX as usize {
                return Err(ProtoError::TooLong("rows", rows.len()));
            }
            o.u16(rows.len() as u16);
            for r in rows {
                o.u32(r.handle);
                o.str("id", &r.id, MAX_NAME)?;
                o.u32(r.pid);
                o.bool(r.alive);
                o.bool(r.exit.is_some());
                o.i32(r.exit.unwrap_or(0));
                o.u64(r.started_at);
                o.u64(r.last_output);
                o.opt_str("cwd", &r.cwd, u16::MAX as usize)?;
                o.bool(r.persist);
                o.bool(r.paste);
                o.blob("meta", &r.meta, MAX_META)?;
            }
        }
        Msg::Replay { attachment, bytes } => {
            o.str("attachment", attachment, MAX_NAME)?;
            o.rest(bytes);
        }
        Msg::Output { bytes } => o.rest(bytes),
        Msg::Mode { paste } => o.bool(*paste),
        Msg::Activity { last_output } => o.u64(*last_output),
        Msg::Exit { status, expected } => {
            o.i32(*status);
            o.bool(*expected);
        }
        Msg::InputDone { seq, ok, error } => {
            o.u32(*seq);
            o.bool(*ok);
            o.str("error", error, MAX_NAME)?;
        }
        Msg::FgReply { seq, rows } => {
            o.u32(*seq);
            if rows.len() > u16::MAX as usize {
                return Err(ProtoError::TooLong("rows", rows.len()));
            }
            o.u16(rows.len() as u16);
            for (handle, pgid) in rows {
                o.u32(*handle);
                o.i32(pgid.unwrap_or(-1));
            }
        }
        Msg::Error { seq, message } => {
            o.u32(*seq);
            let cut = truncate_utf8(message, MAX_NAME);
            o.str("message", cut, MAX_NAME)?;
        }
        Msg::TailReply { seq, bytes } => {
            o.u32(*seq);
            o.rest(bytes);
        }
    }
    Ok(())
}

fn truncate_utf8(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

// --- decoding -------------------------------------------------------------------

struct In<'a> {
    b: &'a [u8],
    at: usize,
}

impl<'a> In<'a> {
    fn take(&mut self, n: usize, what: &'static str) -> Result<&'a [u8], ProtoError> {
        if self.b.len() - self.at < n {
            return Err(ProtoError::Truncated(what));
        }
        let s = &self.b[self.at..self.at + n];
        self.at += n;
        Ok(s)
    }
    fn u8(&mut self, what: &'static str) -> Result<u8, ProtoError> {
        Ok(self.take(1, what)?[0])
    }
    fn bool(&mut self, what: &'static str) -> Result<bool, ProtoError> {
        Ok(self.u8(what)? != 0)
    }
    fn u16(&mut self, what: &'static str) -> Result<u16, ProtoError> {
        Ok(u16::from_le_bytes(self.take(2, what)?.try_into().unwrap()))
    }
    fn u32(&mut self, what: &'static str) -> Result<u32, ProtoError> {
        Ok(u32::from_le_bytes(self.take(4, what)?.try_into().unwrap()))
    }
    fn i32(&mut self, what: &'static str) -> Result<i32, ProtoError> {
        Ok(i32::from_le_bytes(self.take(4, what)?.try_into().unwrap()))
    }
    fn u64(&mut self, what: &'static str) -> Result<u64, ProtoError> {
        Ok(u64::from_le_bytes(self.take(8, what)?.try_into().unwrap()))
    }
    fn str(&mut self, what: &'static str, max: usize) -> Result<String, ProtoError> {
        let n = self.u16(what)? as usize;
        if n > max {
            return Err(ProtoError::TooLong(what, n));
        }
        let raw = self.take(n, what)?;
        String::from_utf8(raw.to_vec()).map_err(|_| ProtoError::BadUtf8(what))
    }
    fn opt_str(&mut self, what: &'static str, max: usize) -> Result<Option<String>, ProtoError> {
        if self.bool(what)? {
            self.str(what, max).map(Some)
        } else {
            Ok(None)
        }
    }
    fn strs(&mut self, what: &'static str, max: usize) -> Result<Vec<String>, ProtoError> {
        let n = self.u16(what)? as usize;
        (0..n).map(|_| self.str(what, max)).collect()
    }
    fn blob(&mut self, what: &'static str, max: usize) -> Result<Vec<u8>, ProtoError> {
        let n = self.u16(what)? as usize;
        if n > max {
            return Err(ProtoError::TooLong(what, n));
        }
        Ok(self.take(n, what)?.to_vec())
    }
    fn rest(&mut self) -> Vec<u8> {
        let s = self.b[self.at..].to_vec();
        self.at = self.b.len();
        s
    }
}

/// Decode one frame body (type, handle, payload; no length prefix).
/// `Ok(None)` is an optional frame this codec does not know.
pub fn decode_body(body: &[u8]) -> Result<Option<Frame>, ProtoError> {
    if body.len() < HEADER {
        return Err(ProtoError::Truncated("header"));
    }
    let ty = body[0];
    let pty = u32::from_le_bytes(body[1..5].try_into().unwrap());
    let mut i = In { b: &body[HEADER..], at: 0 };
    let msg = match ty {
        t::HELLO => Msg::Hello {
            core: i.u16("core")?,
            caps: i.strs("cap", MAX_NAME)?,
            build: i.str("build", MAX_NAME)?,
            token: i.opt_str("token", MAX_NAME)?,
            nonce: i.u64("nonce")?,
        },
        t::SPAWN => Msg::Spawn {
            seq: i.u32("seq")?,
            id: i.str("id", MAX_NAME)?,
            cwd: i.opt_str("cwd", u16::MAX as usize)?,
            cols: i.u16("cols")?,
            rows: i.u16("rows")?,
            argv: i.strs("argv", u16::MAX as usize)?,
            env: i.strs("env", u16::MAX as usize)?,
            persist: i.bool("persist")?,
            meta: i.blob("meta", MAX_META)?,
            attachment: i.str("attachment", MAX_NAME)?,
        },
        t::ATTACH => Msg::Attach { attachment: i.str("attachment", MAX_NAME)? },
        t::DETACH => Msg::Detach { attachment: i.str("attachment", MAX_NAME)? },
        t::INPUT => Msg::Input {
            seq: i.u32("seq")?,
            flags: i.u8("flags")?,
            gap_ms: i.u16("gap")?,
            bytes: i.rest(),
        },
        t::RESIZE => Msg::Resize { cols: i.u16("cols")?, rows: i.u16("rows")? },
        t::ACK => Msg::Ack { attachment: i.str("attachment", MAX_NAME)?, n: i.u32("n")? },
        t::KILL => Msg::Kill { signal: i.i32("signal")? },
        t::KILL_WHERE => Msg::KillWhere { all: i.bool("all")? },
        t::SET_META => Msg::SetMeta { persist: i.bool("persist")?, meta: i.blob("meta", MAX_META)? },
        t::LIST => Msg::List { seq: i.u32("seq")? },
        t::FG => Msg::Fg { seq: i.u32("seq")? },
        t::REAP => Msg::Reap,
        t::TAIL => Msg::Tail { seq: i.u32("seq")?, max: i.u32("max")? },
        t::RETIRE => Msg::Retire { sock: i.str("sock", MAX_NAME)? },
        t::WELCOME => Msg::Welcome {
            core: i.u16("core")?,
            caps: i.strs("cap", MAX_NAME)?,
            build: i.str("build", MAX_NAME)?,
            instance: i.u64("instance")?,
            token: i.str("token", MAX_NAME)?,
            pid: i.u32("pid")?,
            proof: i.u64("proof")?,
        },
        t::SPAWNED => Msg::Spawned { seq: i.u32("seq")?, pid: i.u32("pid")?, existed: i.bool("existed")? },
        t::LIST_REPLY => {
            let seq = i.u32("seq")?;
            let n = i.u16("rows")? as usize;
            let mut rows = Vec::with_capacity(n.min(256));
            for _ in 0..n {
                let handle = i.u32("handle")?;
                let id = i.str("id", MAX_NAME)?;
                let pid = i.u32("pid")?;
                let alive = i.bool("alive")?;
                let has_exit = i.bool("exit")?;
                let exit = i.i32("exit")?;
                rows.push(Row {
                    handle,
                    id,
                    pid,
                    alive,
                    exit: has_exit.then_some(exit),
                    started_at: i.u64("started")?,
                    last_output: i.u64("last output")?,
                    cwd: i.opt_str("cwd", u16::MAX as usize)?,
                    persist: i.bool("persist")?,
                    paste: i.bool("paste")?,
                    meta: i.blob("meta", MAX_META)?,
                });
            }
            Msg::ListReply { seq, rows }
        }
        t::REPLAY => Msg::Replay { attachment: i.str("attachment", MAX_NAME)?, bytes: i.rest() },
        t::OUTPUT => Msg::Output { bytes: i.rest() },
        t::MODE => Msg::Mode { paste: i.bool("paste")? },
        t::ACTIVITY => Msg::Activity { last_output: i.u64("last output")? },
        t::EXIT => Msg::Exit { status: i.i32("status")?, expected: i.bool("expected")? },
        t::INPUT_DONE => Msg::InputDone { seq: i.u32("seq")?, ok: i.bool("ok")?, error: i.str("error", MAX_NAME)? },
        t::FG_REPLY => {
            let seq = i.u32("seq")?;
            let n = i.u16("rows")? as usize;
            let mut rows = Vec::with_capacity(n.min(256));
            for _ in 0..n {
                let handle = i.u32("handle")?;
                let pgid = i.i32("pgid")?;
                rows.push((handle, (pgid >= 0).then_some(pgid)));
            }
            Msg::FgReply { seq, rows }
        }
        t::ERROR => Msg::Error { seq: i.u32("seq")?, message: i.str("message", MAX_NAME)? },
        t::TAIL_REPLY => Msg::TailReply { seq: i.u32("seq")?, bytes: i.rest() },
        ty if ty & OPTIONAL != 0 => return Ok(None),
        ty => return Err(ProtoError::UnknownType(ty)),
    };
    if i.at != i.b.len() {
        return Err(ProtoError::Trailing(ty));
    }
    Ok(Some(Frame { pty, msg }))
}

/// A streaming decoder: feed it whatever a read returned, take frames out.
/// After an error the stream is unusable; the caller drops the connection.
#[derive(Default)]
pub struct Decoder {
    buf: Vec<u8>,
    at: usize,
}

impl Decoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        if self.at > 0 && self.at == self.buf.len() {
            self.buf.clear();
            self.at = 0;
        } else if self.at > 64 * 1024 && self.at * 2 > self.buf.len() {
            self.buf.drain(..self.at);
            self.at = 0;
        }
        self.buf.extend_from_slice(bytes);
    }

    /// Bytes held but not yet decoded.
    pub fn buffered(&self) -> usize {
        self.buf.len() - self.at
    }

    /// The next complete frame, `Ok(None)` when more bytes are needed.
    /// Optional frames this codec doesn't know are skipped.
    pub fn next_frame(&mut self) -> Result<Option<Frame>, ProtoError> {
        loop {
            let avail = &self.buf[self.at..];
            if avail.len() < 4 {
                return Ok(None);
            }
            let len = u32::from_le_bytes(avail[..4].try_into().unwrap()) as usize;
            if len > MAX_FRAME {
                return Err(ProtoError::TooLarge(len));
            }
            if len < HEADER {
                return Err(ProtoError::Truncated("header"));
            }
            if avail.len() < 4 + len {
                return Ok(None);
            }
            let body = &avail[4..4 + len];
            let decoded = decode_body(body);
            self.at += 4 + len;
            match decoded? {
                Some(frame) => return Ok(Some(frame)),
                None => continue,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn every_message() -> Vec<Frame> {
        let row = Row {
            handle: 3,
            id: "term-1".into(),
            pid: 4242,
            alive: true,
            exit: None,
            started_at: 1_700_000_000_000,
            last_output: 1_700_000_000_500,
            cwd: Some("/tmp/é".into()),
            persist: true,
            paste: false,
            meta: br#"{"owner":"s1"}"#.to_vec(),
        };
        let tomb = Row { alive: false, exit: Some(256), cwd: None, meta: vec![], ..row.clone() };
        vec![
            Frame::bare(Msg::Hello { core: CORE, caps: vec!["tail".into(), "meta".into()], build: "rel-1".into(), token: Some("t0k".into()), nonce: 7 }),
            Frame::bare(Msg::Hello { core: 7, caps: vec![], build: String::new(), token: None, nonce: 0 }),
            Frame::bare(Msg::Spawn {
                seq: 9,
                id: "term-1".into(),
                cwd: Some("/Users/x".into()),
                cols: 120,
                rows: 40,
                argv: vec!["/bin/zsh".into(), "-l".into()],
                env: vec!["TERM=xterm-256color".into(), "A=".into()],
                persist: true,
                meta: vec![1, 2, 3],
                attachment: "a1".into(),
            }),
            Frame::bare(Msg::Spawn { seq: 1, id: "x".into(), cwd: None, cols: 1, rows: 1, argv: vec![], env: vec![], persist: false, meta: vec![], attachment: String::new() }),
            Frame::new(3, Msg::Attach { attachment: "a2".into() }),
            Frame::new(3, Msg::Detach { attachment: "a2".into() }),
            Frame::new(3, Msg::Input { seq: 4, flags: INPUT_PACED | INPUT_CHECKED, gap_ms: 30, bytes: b"\x1b[200~hi\x1b[201~".to_vec() }),
            Frame::new(3, Msg::Input { seq: 0, flags: 0, gap_ms: 0, bytes: vec![] }),
            Frame::new(3, Msg::Resize { cols: 80, rows: 24 }),
            Frame::new(3, Msg::Ack { attachment: "a2".into(), n: 65536 }),
            Frame::new(3, Msg::Kill { signal: -1 }),
            Frame::bare(Msg::KillWhere { all: true }),
            Frame::new(3, Msg::SetMeta { persist: false, meta: b"{}".to_vec() }),
            Frame::bare(Msg::List { seq: 77 }),
            Frame::bare(Msg::Fg { seq: 78 }),
            Frame::new(5, Msg::Reap),
            Frame::new(3, Msg::Tail { seq: 79, max: 12288 }),
            Frame::bare(Msg::Retire { sock: "ptyd-abcd-1.sock".into() }),
            Frame::bare(Msg::Welcome { core: CORE, caps: vec!["tail".into()], build: "rel-1".into(), instance: u64::MAX, token: "t0k".into(), pid: 99, proof: 0xfeed }),
            Frame::new(3, Msg::Spawned { seq: 9, pid: 4242, existed: false }),
            Frame::bare(Msg::ListReply { seq: 77, rows: vec![row, tomb] }),
            Frame::bare(Msg::ListReply { seq: 1, rows: vec![] }),
            Frame::new(3, Msg::Replay { attachment: "a2".into(), bytes: vec![] }),
            Frame::new(3, Msg::Replay { attachment: String::new(), bytes: (0..=255).collect() }),
            Frame::new(3, Msg::Output { bytes: b"\x00\xffbytes".to_vec() }),
            Frame::new(3, Msg::Mode { paste: true }),
            Frame::new(3, Msg::Activity { last_output: 12345 }),
            Frame::new(3, Msg::Exit { status: 15, expected: true }),
            Frame::new(3, Msg::InputDone { seq: 4, ok: false, error: "broken pipe".into() }),
            Frame::bare(Msg::FgReply { seq: 78, rows: vec![(3, Some(4243)), (4, None)] }),
            Frame::bare(Msg::Error { seq: 0, message: "no such terminal".into() }),
            Frame::new(3, Msg::TailReply { seq: 79, bytes: b"tail".to_vec() }),
        ]
    }

    #[test]
    fn siphash_matches_the_reference_vectors() {
        // The SipHash paper's key 00..0f; messages 00, 00 01, … (vectors 0, 1, 8).
        let k0 = u64::from_le_bytes([0, 1, 2, 3, 4, 5, 6, 7]);
        let k1 = u64::from_le_bytes([8, 9, 10, 11, 12, 13, 14, 15]);
        assert_eq!(siphash24(k0, k1, &[]), 0x726f_db47_dd0e_0e31);
        assert_eq!(siphash24(k0, k1, &[0]), 0x74f8_39c5_93dc_67fd);
        assert_eq!(siphash24(k0, k1, &[0, 1, 2, 3, 4, 5, 6, 7]), 0x93f5_f579_9a93_2462);
        let mut secret = [0u8; SECRET_LEN];
        secret[..16].copy_from_slice(&(0u8..16).collect::<Vec<_>>());
        assert_eq!(proof(&secret, u64::from_le_bytes([0, 1, 2, 3, 4, 5, 6, 7])), 0x93f5_f579_9a93_2462);
        assert_ne!(proof(&secret, 1), proof(&secret, 2));
    }

    #[test]
    fn every_frame_round_trips() {
        for frame in every_message() {
            let bytes = to_bytes(&frame).unwrap();
            let len = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
            assert_eq!(len, bytes.len() - 4, "{frame:?}");
            assert_eq!(decode_body(&bytes[4..]).unwrap(), Some(frame.clone()));
        }
    }

    #[test]
    fn every_type_is_named_once() {
        let mut seen: Vec<u8> = every_message().iter().map(|f| type_of(&f.msg)).collect();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), 27, "one type byte per message kind");
        assert!(seen.iter().all(|t| t & OPTIONAL == 0), "the core set has no optional types");
    }

    #[test]
    fn a_stream_read_one_byte_at_a_time_decodes_to_the_same_frames() {
        let frames = every_message();
        let mut wire = Vec::new();
        for f in &frames {
            encode(f, &mut wire).unwrap();
        }
        let mut d = Decoder::new();
        let mut got = Vec::new();
        for b in &wire {
            d.feed(std::slice::from_ref(b));
            while let Some(f) = d.next_frame().unwrap() {
                got.push(f);
            }
        }
        assert_eq!(got, frames);
        assert_eq!(d.buffered(), 0);
    }

    #[test]
    fn oversize_truncated_and_unknown_core_frames_are_rejected() {
        let mut d = Decoder::new();
        d.feed(&((MAX_FRAME + 1) as u32).to_le_bytes());
        assert_eq!(d.next_frame(), Err(ProtoError::TooLarge(MAX_FRAME + 1)));

        // A length that ends before its payload does.
        let mut body = vec![t::RESIZE];
        body.extend_from_slice(&3u32.to_le_bytes());
        body.extend_from_slice(&80u16.to_le_bytes());
        assert_eq!(decode_body(&body), Err(ProtoError::Truncated("rows")));
        assert_eq!(decode_body(&[t::RESIZE, 0]), Err(ProtoError::Truncated("header")));

        // Bytes left over after a fixed layout.
        let mut body = vec![t::MODE, 0, 0, 0, 0, 1, 9];
        assert_eq!(decode_body(&body), Err(ProtoError::Trailing(t::MODE)));
        body.pop();
        assert_eq!(decode_body(&body).unwrap(), Some(Frame::new(0, Msg::Mode { paste: true })));

        // An unknown core type.
        assert_eq!(decode_body(&[0x7f, 0, 0, 0, 0]), Err(ProtoError::UnknownType(0x7f)));

        // A frame whose length is below the header.
        let mut d = Decoder::new();
        d.feed(&2u32.to_le_bytes());
        d.feed(&[1, 2]);
        assert!(d.next_frame().is_err());
    }

    #[test]
    fn unknown_optional_frames_are_skipped() {
        let mut wire = Vec::new();
        // An optional frame from a future capability, with a payload.
        let body = [OPTIONAL | 5, 1, 0, 0, 0, 0xde, 0xad];
        wire.extend_from_slice(&(body.len() as u32).to_le_bytes());
        wire.extend_from_slice(&body);
        let after = Frame::new(1, Msg::Output { bytes: b"after".to_vec() });
        encode(&after, &mut wire).unwrap();
        let mut d = Decoder::new();
        d.feed(&wire);
        assert_eq!(d.next_frame().unwrap(), Some(after));
        assert_eq!(d.next_frame().unwrap(), None);
    }

    #[test]
    fn a_string_over_its_bound_is_refused_both_ways() {
        let long = "x".repeat(MAX_NAME + 1);
        let frame = Frame::new(1, Msg::Attach { attachment: long.clone() });
        let mut buf = b"keep".to_vec();
        assert_eq!(encode(&frame, &mut buf), Err(ProtoError::TooLong("attachment", MAX_NAME + 1)));
        assert_eq!(buf, b"keep", "nothing appended on an error");
        let meta = Frame::new(1, Msg::SetMeta { persist: true, meta: vec![0; MAX_META + 1] });
        assert!(encode(&meta, &mut buf).is_err());

        // Hand-built: a declared length over the bound.
        let mut body = vec![t::ATTACH, 1, 0, 0, 0];
        body.extend_from_slice(&((MAX_NAME + 1) as u16).to_le_bytes());
        body.extend_from_slice(long.as_bytes());
        assert_eq!(decode_body(&body), Err(ProtoError::TooLong("attachment", MAX_NAME + 1)));

        // Not UTF-8.
        let mut body = vec![t::ATTACH, 1, 0, 0, 0, 2, 0, 0xff, 0xfe];
        assert_eq!(decode_body(&body), Err(ProtoError::BadUtf8("attachment")));
        body.truncate(5);
        assert_eq!(decode_body(&body), Err(ProtoError::Truncated("attachment")));

        // An error message is cut to its bound rather than refused.
        let long_error = Frame::bare(Msg::Error { seq: 1, message: "é".repeat(MAX_NAME) });
        let bytes = to_bytes(&long_error).unwrap();
        let Some(Frame { msg: Msg::Error { message, .. }, .. }) = decode_body(&bytes[4..]).unwrap() else { panic!() };
        assert!(message.len() <= MAX_NAME && message.chars().all(|c| c == 'é'));
    }

    #[test]
    fn a_frame_over_the_limit_is_refused_at_encode() {
        let frame = Frame::new(1, Msg::Output { bytes: vec![0; MAX_FRAME] });
        let mut buf = Vec::new();
        assert!(matches!(encode(&frame, &mut buf), Err(ProtoError::TooLarge(_))));
        assert!(buf.is_empty());
        let fits = Frame::new(1, Msg::Output { bytes: vec![0; MAX_FRAME - HEADER] });
        encode(&fits, &mut buf).unwrap();
        let mut d = Decoder::new();
        d.feed(&buf);
        assert_eq!(d.next_frame().unwrap(), Some(fits));
    }

    /// xorshift64*: deterministic, no dependency.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
        fn bytes(&mut self, max: usize) -> Vec<u8> {
            let n = self.below(max + 1);
            (0..n).map(|_| self.next() as u8).collect()
        }
        fn text(&mut self, max: usize) -> String {
            let n = self.below(max + 1);
            (0..n).map(|_| ['a', 'é', '日', '\n', '0', ' '][self.below(6)]).collect()
        }
    }

    fn random_frame(r: &mut Rng) -> Frame {
        let pty = r.next() as u32;
        let msg = match r.below(10) {
            0 => Msg::Output { bytes: r.bytes(5000) },
            1 => Msg::Input { seq: r.next() as u32, flags: r.below(4) as u8, gap_ms: r.next() as u16, bytes: r.bytes(3000) },
            2 => Msg::Ack { attachment: r.text(40), n: r.next() as u32 },
            3 => Msg::Replay { attachment: r.text(20), bytes: r.bytes(9000) },
            4 => Msg::Spawn {
                seq: r.next() as u32,
                id: r.text(30),
                cwd: (r.below(2) == 0).then(|| r.text(60)),
                cols: r.next() as u16,
                rows: r.next() as u16,
                argv: (0..r.below(4)).map(|_| r.text(20)).collect(),
                env: (0..r.below(30)).map(|_| r.text(80)).collect(),
                persist: r.below(2) == 0,
                meta: r.bytes(200),
                attachment: r.text(20),
            },
            5 => Msg::Exit { status: r.next() as i32, expected: r.below(2) == 0 },
            6 => Msg::FgReply { seq: 1, rows: (0..r.below(20)).map(|_| (r.next() as u32, (r.below(2) == 0).then(|| (r.next() >> 33) as i32))).collect() },
            7 => Msg::SetMeta { persist: r.below(2) == 0, meta: r.bytes(MAX_META) },
            8 => Msg::Error { seq: r.next() as u32, message: r.text(100) },
            _ => Msg::Mode { paste: r.below(2) == 0 },
        };
        Frame { pty, msg }
    }

    #[test]
    fn random_sequences_survive_encoding_and_splitting_anywhere() {
        let mut r = Rng(0x9e37_79b9_7f4a_7c15);
        for _ in 0..200 {
            let frames: Vec<Frame> = (0..r.below(12) + 1).map(|_| random_frame(&mut r)).collect();
            let mut wire = Vec::new();
            for f in &frames {
                encode(f, &mut wire).unwrap();
            }
            let mut d = Decoder::new();
            let mut got = Vec::new();
            let mut at = 0;
            while at < wire.len() {
                let n = (r.below(700) + 1).min(wire.len() - at);
                d.feed(&wire[at..at + n]);
                at += n;
                while let Some(f) = d.next_frame().unwrap() {
                    got.push(f);
                }
            }
            assert_eq!(got, frames);
        }
    }
}
