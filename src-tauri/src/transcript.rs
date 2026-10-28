// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Reading agent transcripts: append-only JSONL files tailed by byte-offset
//! cursors, plus the small text and time helpers every reader shares.
//!
//! The Agent pane's conversation mirror (`convo`), the plan meter, the token
//! meter and the asks reader all tail the CLIs' transcripts the same way: a
//! `Cursor` that holds a torn trailing line across reads, a per-read cap that
//! seeks to the tail and says what it skipped, and ISO stamps parsed without a
//! date crate (the binary-size law).

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Collapse whitespace runs and truncate on a char boundary.
pub(crate) fn preview(s: &str, cap: usize) -> String {
    let mut out = String::with_capacity(cap.min(s.len()) + 1);
    let mut last_ws = false;
    for c in s.chars() {
        if out.chars().count() >= cap {
            out.push('…');
            break;
        }
        if c.is_whitespace() {
            if !last_ws && !out.is_empty() {
                out.push(' ');
            }
            last_ws = true;
        } else {
            out.push(c);
            last_ws = false;
        }
    }
    out.trim_end().to_string()
}

/// Epoch millis from the transcripts' ISO-8601 UTC stamps
/// (`2026-08-07T11:09:26.237Z`). Hand-rolled — no date crate in the tree.
pub(crate) fn iso_millis(ts: &str) -> Option<i64> {
    let b = ts.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| ts.get(r)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, s) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    let mut ms = 0i64;
    if b.len() > 20 && b[19] == b'.' {
        let frac: String = ts[20..].chars().take_while(char::is_ascii_digit).collect();
        ms = match frac.len() {
            0 => 0,
            1 => frac.parse::<i64>().unwrap_or(0) * 100,
            2 => frac.parse::<i64>().unwrap_or(0) * 10,
            _ => frac[..3].parse::<i64>().unwrap_or(0),
        };
    }
    // Days-from-civil (Hinnant) — valid for all Gregorian dates.
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let mp = if mo > 2 { mo - 3 } else { mo + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some((((days * 24 + h) * 60 + mi) * 60 + s) * 1000 + ms)
}

/// UTC calendar day (`YYYY-MM-DD`) for an epoch-millis stamp — the fallback
/// when local time is unavailable. Civil-from-days (Hinnant), the inverse of
/// `iso_millis`'s days-from-civil; no date crate in the tree.
pub(crate) fn utc_day(ms: i64) -> String {
    let z = ms.div_euclid(86_400_000) + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// LOCAL calendar day (`YYYY-MM-DD`) for an epoch-millis stamp — the
/// `seat_burn` day key (`Database::add_seat_burn` documents that the caller
/// formats a local day). POSIX `localtime_r` through a minimal extern
/// binding — no date/libc crate in the tree (the binary-size law). The
/// buffer is padded well past any known libc's `struct tm`, and a failed
/// call falls back to the UTC day.
#[cfg(unix)]
pub(crate) fn local_day(ms: i64) -> String {
    #[repr(C)]
    struct Tm {
        tm_sec: i32,
        tm_min: i32,
        tm_hour: i32,
        tm_mday: i32,
        tm_mon: i32,
        tm_year: i32,
        tm_wday: i32,
        tm_yday: i32,
        tm_isdst: i32,
        tm_gmtoff: i64,
        tm_zone: *const std::ffi::c_char,
        // Safety margin beyond macOS/glibc/musl layouts so a larger libc
        // `struct tm` can never write past our buffer.
        _reserved: [u8; 64],
    }
    extern "C" {
        fn localtime_r(timep: *const i64, result: *mut Tm) -> *mut Tm;
    }
    let secs = ms.div_euclid(1000);
    let mut tm = std::mem::MaybeUninit::<Tm>::uninit();
    let ok = unsafe { !localtime_r(&secs, tm.as_mut_ptr()).is_null() };
    if !ok {
        return utc_day(ms);
    }
    let tm = unsafe { tm.assume_init() };
    format!(
        "{:04}-{:02}-{:02}",
        i64::from(tm.tm_year) + 1900,
        tm.tm_mon + 1,
        tm.tm_mday
    )
}

#[cfg(not(unix))]
pub(crate) fn local_day(ms: i64) -> String {
    utc_day(ms)
}

// --- incremental file reading ----------------------------------------------

#[derive(Default)]
pub(crate) struct Cursor {
    offset: u64,
    /// The unterminated last line, kept as bytes: a read can end inside a
    /// multibyte character, and decoding that half on its own would turn it
    /// into replacement characters.
    partial: Vec<u8>,
}

impl Cursor {
    /// Where the next unread line starts: past every complete line read.
    pub(crate) fn line_start(&self) -> u64 {
        self.offset - self.partial.len() as u64
    }
}

/// Complete new lines since the cursor. Over-cap growth seeks to the tail,
/// drops the torn line (the `model_from_transcript` pattern) and reports the
/// skip. Partial trailing lines are held across calls — never parse a torn
/// line.
pub(crate) fn read_new_lines(path: &Path, cur: &mut Cursor, cap: u64) -> (Vec<String>, u64) {
    let (records, skipped) = read_new_records(path, cur, cap);
    (records.into_iter().map(|(_, line)| line).collect(), skipped)
}

/// `read_new_lines` with the byte offset each line starts at, which is what
/// the conversation mirror orders by and pages from.
pub(crate) fn read_new_records(path: &Path, cur: &mut Cursor, cap: u64) -> (Vec<(u64, String)>, u64) {
    let Ok(mut f) = std::fs::File::open(path) else {
        return (Vec::new(), 0);
    };
    let Ok(md) = f.metadata() else {
        return (Vec::new(), 0);
    };
    let len = md.len();
    if len < cur.offset {
        // Truncated/replaced — restart honestly.
        cur.offset = 0;
        cur.partial.clear();
    }
    if len == cur.offset {
        return (Vec::new(), 0);
    }
    let mut skipped = 0u64;
    if len - cur.offset > cap {
        skipped = len - cur.offset - cap;
        cur.offset = len - cap;
        cur.partial.clear();
    }
    if f.seek(SeekFrom::Start(cur.offset)).is_err() {
        return (Vec::new(), 0);
    }
    let mut buf = Vec::with_capacity((len - cur.offset) as usize);
    let mut handle = f.take(len - cur.offset);
    if handle.read_to_end(&mut buf).is_err() {
        return (Vec::new(), 0);
    }
    let start = cur.line_start();
    cur.offset += buf.len() as u64;
    let mut bytes = std::mem::take(&mut cur.partial);
    bytes.extend_from_slice(&buf);
    let (mut lines, rest) = split_lines(&bytes, start);
    cur.partial = bytes[rest..].to_vec();
    if skipped > 0 {
        // The first line after a tail-seek is torn mid-line.
        if lines.is_empty() {
            cur.partial.clear();
        } else {
            lines.remove(0);
        }
    }
    (lines, skipped)
}

/// The complete lines in `bytes` (which starts at file offset `base`), each
/// with its offset, plus where the unterminated remainder begins. Decoding
/// happens per whole line, so no character is ever split.
pub(crate) fn split_lines(bytes: &[u8], base: u64) -> (Vec<(u64, String)>, usize) {
    let mut lines = Vec::new();
    let mut pos = 0;
    while let Some(i) = bytes[pos..].iter().position(|&b| b == b'\n') {
        let line = &bytes[pos..pos + i];
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        lines.push((base + pos as u64, String::from_utf8_lossy(line).into_owned()));
        pos += i + 1;
    }
    (lines, pos)
}

/// Summarize a tool call's input down to the one telling field.
pub(crate) fn summarize_tool_input(input: &serde_json::Value) -> String {
    for key in ["file_path", "command", "pattern", "prompt", "url", "path", "query", "description"] {
        if let Some(s) = input.get(key).and_then(serde_json::Value::as_str) {
            if !s.trim().is_empty() {
                return preview(s, 200);
            }
        }
    }
    preview(&input.to_string(), 200)
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn torn_line_two_chunk_feed_equals_whole_file() {
        let dir = std::env::temp_dir().join(format!("rl-transcript-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("chunks.jsonl");
        let whole = "{\"a\":1}\n{\"b\":2}\n{\"c\":3}\n";
        const CAP: u64 = 512 * 1024;
        // Whole-file read.
        std::fs::write(&path, whole).unwrap();
        let mut cur = Cursor::default();
        let (all, _) = read_new_lines(&path, &mut cur, CAP);
        assert_eq!(all.len(), 3);
        // Two-chunk feed torn mid-line.
        std::fs::write(&path, &whole[..11]).unwrap(); // "...{\"b\""
        let mut cur = Cursor::default();
        let (first, _) = read_new_lines(&path, &mut cur, CAP);
        assert_eq!(first, vec!["{\"a\":1}".to_string()]);
        std::fs::write(&path, whole).unwrap();
        let (second, _) = read_new_lines(&path, &mut cur, CAP);
        assert_eq!(second, vec!["{\"b\":2}".to_string(), "{\"c\":3}".to_string()]);
        let mut joined = first;
        joined.extend(second);
        assert_eq!(joined, all);
        // Over-cap growth: seeks to tail, drops the torn first line, reports.
        let mut cur = Cursor::default();
        let (tail, skipped) = read_new_lines(&path, &mut cur, 10);
        assert!(skipped > 0);
        assert_eq!(tail, vec!["{\"c\":3}".to_string()]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn day_key_formatting() {
        assert_eq!(utc_day(0), "1970-01-01");
        assert_eq!(utc_day(-1), "1969-12-31");
        assert_eq!(
            utc_day(iso_millis("2026-08-07T11:09:26.237Z").unwrap()),
            "2026-08-07"
        );
        assert_eq!(
            utc_day(iso_millis("2026-12-31T23:59:59.999Z").unwrap()),
            "2026-12-31"
        );
        // local_day: the zone under test varies by machine, so assert the
        // shape and that it stays within a calendar day of the UTC answer.
        let ms = 1_786_100_966_237;
        let local = local_day(ms);
        assert_eq!(local.len(), 10);
        assert_eq!(&local[4..5], "-");
        assert_eq!(&local[7..8], "-");
        let candidates = [utc_day(ms - 86_400_000), utc_day(ms), utc_day(ms + 86_400_000)];
        assert!(candidates.contains(&local));
    }

    #[test]
    fn iso_millis_known_values() {
        assert_eq!(iso_millis("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso_millis("1970-01-01T00:00:01.5Z"), Some(1500));
        assert_eq!(iso_millis("2026-08-07T11:09:26.237Z"), Some(1_786_100_966_237));
        assert_eq!(iso_millis("garbage"), None);
        assert_eq!(iso_millis("2026-13-07T11:09:26Z"), None);
    }

    #[test]
    fn preview_collapses_whitespace_and_truncates_on_a_char() {
        assert_eq!(preview("a  b\n\tc", 240), "a b c");
        assert_eq!(preview("héllo world", 3), "hél…");
    }

    #[test]
    fn summarize_tool_input_picks_the_telling_field() {
        let v = serde_json::json!({"file_path": "/x/y.rs", "content": "big"});
        assert_eq!(summarize_tool_input(&v), "/x/y.rs");
        let v = serde_json::json!({"other": 1});
        assert_eq!(summarize_tool_input(&v), "{\"other\":1}");
    }
}
