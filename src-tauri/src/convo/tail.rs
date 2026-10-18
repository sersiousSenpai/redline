// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Reading a transcript three ways: the first read of a session that is
//! already under way, the live tail after it, and backward pages for older
//! history. All three cut on line boundaries and hand whole lines to
//! [`claude::parse_line`], which is what makes a page's events the same
//! events the tail produced for those bytes.

use std::collections::VecDeque;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use super::claude::{self, ToolNames};
use super::wire::ConvoEvent;
use crate::runwatch::{read_new_records, split_lines, Cursor};

/// The first read takes this much of the transcript's end; older history
/// comes back through pages.
pub const PRIME_BYTES: u64 = 4 * 1024 * 1024;
/// Per live read. Far beyond anything a turn writes between two polls, so
/// the tail never skips; a tool result the CLI didn't truncate is still a
/// few hundred KB.
const LIVE_CAP: u64 = 64 * 1024 * 1024;
/// One backward page.
pub const PAGE_BYTES: u64 = 1024 * 1024;
/// The ring's budget per terminal; the stage itself keeps about 400 rows.
pub const RING_BYTES: usize = 4 * 1024 * 1024;

/// What one read produced.
#[derive(Default)]
pub struct Polled {
    pub events: Vec<ConvoEvent>,
    /// The session's title, when a line carried one (`ai-title`).
    pub title: Option<String>,
    /// The read started past the transcript's beginning (a first read of a
    /// long session): there is history before `events`.
    pub skipped: bool,
}

/// The live tail of one epoch's transcript.
pub struct ClaudeSource {
    pub path: PathBuf,
    pub epoch: u32,
    cursor: Cursor,
    tools: ToolNames,
    primed: bool,
}

impl ClaudeSource {
    pub fn new(path: PathBuf, epoch: u32) -> Self {
        Self { path, epoch, cursor: Cursor::default(), tools: ToolNames::default(), primed: false }
    }

    /// The new lines since the last read. The first read takes the last
    /// [`PRIME_BYTES`] and reports whether it started mid-file.
    pub fn poll(&mut self, fallback_ts: i64) -> Polled {
        let cap = if self.primed { LIVE_CAP } else { PRIME_BYTES };
        let (records, skipped) = read_new_records(&self.path, &mut self.cursor, cap);
        // A missing file is a session that hasn't written its first line.
        if self.path.exists() {
            self.primed = true;
        }
        let mut out = parse(&records, self.epoch, fallback_ts, &mut self.tools);
        out.skipped = skipped > 0;
        out
    }

    /// Where the next line will start: a host event's offset.
    pub fn offset(&self) -> u64 {
        self.cursor.line_start()
    }
}

fn parse(records: &[(u64, String)], epoch: u32, fallback_ts: i64, tools: &mut ToolNames) -> Polled {
    let mut out = Polled::default();
    for (offset, line) in records {
        let parsed = claude::parse_line(line, epoch, *offset, fallback_ts, tools);
        out.events.extend(parsed.events);
        if parsed.title.is_some() {
            out.title = parsed.title;
        }
    }
    out
}

/// The events of the lines that start in `[start, before)`, where `start` is
/// the beginning of the line holding `before - PAGE_BYTES`: a window that
/// lands inside a long line widens to take all of it, so no line is ever cut
/// or skipped. Returns the events and the window's start (0 = nothing
/// older in this transcript).
pub fn page(path: &Path, epoch: u32, before: u64, fallback_ts: i64) -> std::io::Result<(Vec<ConvoEvent>, u64)> {
    page_window(path, epoch, before, PAGE_BYTES, fallback_ts)
}

fn page_window(path: &Path, epoch: u32, before: u64, window: u64, fallback_ts: i64) -> std::io::Result<(Vec<ConvoEvent>, u64)> {
    let mut file = std::fs::File::open(path)?;
    let before = before.min(file.metadata()?.len());
    let start = line_start(&mut file, before.saturating_sub(window))?;
    let mut bytes = Vec::with_capacity((before - start) as usize);
    file.seek(SeekFrom::Start(start))?;
    (&mut file).take(before - start).read_to_end(&mut bytes)?;
    let (records, _) = split_lines(&bytes, start);
    let mut tools = ToolNames::default();
    Ok((parse(&records, epoch, fallback_ts, &mut tools).events, start))
}

/// The start of the line that holds byte `pos`: `pos` itself when a newline
/// precedes it, else the byte after the nearest newline before it.
fn line_start(file: &mut std::fs::File, pos: u64) -> std::io::Result<u64> {
    const CHUNK: u64 = 64 * 1024;
    let mut end = pos;
    let mut buf = Vec::new();
    while end > 0 {
        let from = end.saturating_sub(CHUNK);
        buf.clear();
        file.seek(SeekFrom::Start(from))?;
        file.take(end - from).read_to_end(&mut buf)?;
        if let Some(i) = buf.iter().rposition(|&b| b == b'\n') {
            return Ok(from + i as u64 + 1);
        }
        end = from;
    }
    Ok(0)
}

/// A terminal's recent events, bounded by [`RING_BYTES`].
#[derive(Default)]
pub struct Ring {
    events: VecDeque<ConvoEvent>,
    bytes: usize,
    /// Nothing before the oldest event was ever dropped or left unread.
    pub complete: bool,
}

impl Ring {
    pub fn push(&mut self, event: ConvoEvent) {
        self.bytes += event.body.weight();
        self.events.push_back(event);
        while self.bytes > RING_BYTES && self.events.len() > 1 {
            if let Some(old) = self.events.pop_front() {
                self.bytes -= old.body.weight();
            }
            self.complete = false;
        }
    }

    /// The newest `n` events, oldest first, and whether anything precedes them.
    pub fn tail(&self, n: usize) -> (Vec<ConvoEvent>, bool) {
        let skip = self.events.len().saturating_sub(n);
        (self.events.iter().skip(skip).cloned().collect(), skip > 0 || !self.complete)
    }

    pub fn iter(&self) -> impl DoubleEndedIterator<Item = &ConvoEvent> {
        self.events.iter()
    }

    pub fn clear(&mut self) {
        self.events.clear();
        self.bytes = 0;
        self.complete = false;
    }

    pub fn len(&self) -> usize {
        self.events.len()
    }
}

#[cfg(test)]
pub(super) fn page_with(path: &Path, before: u64, window: u64) -> (Vec<ConvoEvent>, u64) {
    page_window(path, 0, before, window, 0).unwrap()
}
