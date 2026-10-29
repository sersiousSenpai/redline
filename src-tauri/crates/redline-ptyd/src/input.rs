// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! A terminal's input queue, paced where the write happens.
//!
//! The macOS tty input queue is **1024 bytes** (`TTYHOG`): a write to the
//! master larger than what the shell has drained is neither blocked nor
//! short-counted; the kernel discards the excess and reports success. So a
//! programmatic write goes out in [`PTY_CHUNK`]-byte pieces with
//! [`PTY_CHUNK_PAUSE`] between them (measured 2026-09-02: a raw-mode tty took
//! 100 KB with zero loss in 1.10 s, zsh's line editor 22 KB in 0.88 s).
//!
//! The pacing moved here from the app because frames batch on a socket: if
//! the app slept between chunks and the socket delivered two chunks in one
//! read, the tty would see them back to back. Likewise a frame's `gap`, the
//! quiet time before its first byte, is measured from the last byte this
//! queue wrote, not from when the frame arrived.
//!
//! Jobs run strictly in order, so a keystroke typed during a paced paste
//! lands after it, never inside it.

use std::collections::VecDeque;
use std::io;
use std::time::{Duration, Instant};

pub const PTY_CHUNK: usize = 512;
pub const PTY_CHUNK_PAUSE: Duration = Duration::from_millis(4);

pub struct Job {
    /// Who asked (the helper's client id), so a checked job is answered there.
    pub owner: u64,
    pub seq: u32,
    pub bytes: Vec<u8>,
    pub paced: bool,
    pub checked: bool,
    pub gap: Duration,
    off: usize,
}

impl Job {
    pub fn new(seq: u32, bytes: Vec<u8>, paced: bool, checked: bool, gap: Duration) -> Self {
        Self { owner: 0, seq, bytes, paced, checked, gap, off: 0 }
    }
}

/// A checked job's outcome.
#[derive(Debug, PartialEq, Eq)]
pub struct Done {
    pub owner: u64,
    pub seq: u32,
    pub ok: bool,
    pub error: String,
}

/// What the queue needs next.
#[derive(Debug, PartialEq, Eq)]
pub enum Next {
    /// Nothing queued.
    Idle,
    /// A pause or gap: wake at this instant.
    At(Instant),
    /// The master would block: wait for it to be writable.
    Writable,
}

#[derive(Default)]
pub struct InputQueue {
    jobs: VecDeque<Job>,
    not_before: Option<Instant>,
    last_write: Option<Instant>,
}

impl InputQueue {
    pub fn push(&mut self, job: Job) {
        self.jobs.push_back(job);
    }

    pub fn is_empty(&self) -> bool {
        self.jobs.is_empty()
    }

    pub fn len(&self) -> usize {
        self.jobs.len()
    }

    /// Fail every queued job (the terminal is gone).
    pub fn fail_all(&mut self, error: &str) -> Vec<Done> {
        self.jobs
            .drain(..)
            .filter(|j| j.checked)
            .map(|j| Done { owner: j.owner, seq: j.seq, ok: false, error: error.to_string() })
            .collect()
    }

    /// Write whatever is due at `now` through `write` (one `write(2)` on the
    /// master). Returns the checked jobs that finished and what to wait for.
    pub fn pump(&mut self, now: Instant, write: &mut dyn FnMut(&[u8]) -> io::Result<usize>) -> (Vec<Done>, Next) {
        let mut done = Vec::new();
        loop {
            let Some(job) = self.jobs.front_mut() else {
                return (done, Next::Idle);
            };
            if job.off == 0 && !job.gap.is_zero() {
                if let Some(last) = self.last_write {
                    let at = last + job.gap;
                    if now < at {
                        return (done, Next::At(at));
                    }
                }
            }
            if let Some(at) = self.not_before {
                if now < at {
                    return (done, Next::At(at));
                }
                self.not_before = None;
            }
            let end = if job.paced {
                (job.off - job.off % PTY_CHUNK + PTY_CHUNK).min(job.bytes.len())
            } else {
                job.bytes.len()
            };
            if job.off < end {
                match write(&job.bytes[job.off..end]) {
                    Ok(0) => return (done, Next::Writable),
                    Ok(n) => {
                        job.off += n;
                        self.last_write = Some(now);
                        if job.off < end {
                            return (done, Next::Writable);
                        }
                        if job.paced && job.off < job.bytes.len() {
                            self.not_before = Some(now + PTY_CHUNK_PAUSE);
                            continue;
                        }
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => return (done, Next::Writable),
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                    Err(e) => {
                        let job = self.jobs.pop_front().expect("front exists");
                        if job.checked {
                            done.push(Done { owner: job.owner, seq: job.seq, ok: false, error: format!("pty write failed: {e}") });
                        }
                        continue;
                    }
                }
            }
            let job = self.jobs.pop_front().expect("front exists");
            if job.checked {
                done.push(Done { owner: job.owner, seq: job.seq, ok: true, error: String::new() });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drive a queue with a fake clock to completion, recording every write
    /// with the instant it happened.
    fn run(queue: &mut InputQueue, start: Instant, mut accept: impl FnMut(&[u8]) -> io::Result<usize>) -> (Vec<(Duration, Vec<u8>)>, Vec<Done>) {
        let mut now = start;
        let mut writes = Vec::new();
        let mut all_done = Vec::new();
        for _ in 0..100_000 {
            let mut sink = |b: &[u8]| {
                let r = accept(b);
                if let Ok(n) = r {
                    writes.push((now - start, b[..n].to_vec()));
                }
                r
            };
            let (done, next) = queue.pump(now, &mut sink);
            all_done.extend(done);
            match next {
                Next::Idle => return (writes, all_done),
                Next::At(at) => now = at,
                Next::Writable => now += Duration::from_micros(100),
            }
        }
        panic!("the queue never drained");
    }

    #[test]
    fn a_paced_write_goes_out_in_chunks_with_pauses_and_loses_nothing() {
        let payload: Vec<u8> = (0..6_476u32).map(|i| (i % 251) as u8).collect();
        let mut q = InputQueue::default();
        q.push(Job::new(1, payload.clone(), true, true, Duration::ZERO));
        let t = Instant::now();
        let (writes, done) = run(&mut q, t, |b| Ok(b.len()));
        assert_eq!(writes.len(), 13, "6,476 bytes is 13 chunks");
        assert!(writes.iter().all(|(_, b)| b.len() <= PTY_CHUNK));
        assert_eq!(writes.iter().flat_map(|(_, b)| b.clone()).collect::<Vec<_>>(), payload);
        for pair in writes.windows(2) {
            assert!(pair[1].0 - pair[0].0 >= PTY_CHUNK_PAUSE, "4 ms between chunks");
        }
        assert_eq!(done, vec![Done { owner: 0, seq: 1, ok: true, error: String::new() }]);
    }

    #[test]
    fn a_short_write_is_one_write_and_unchecked_jobs_report_nothing() {
        let mut q = InputQueue::default();
        q.push(Job::new(0, b"3\r".to_vec(), true, false, Duration::ZERO));
        q.push(Job::new(0, b"ls\r".to_vec(), false, false, Duration::ZERO));
        let (writes, done) = run(&mut q, Instant::now(), |b| Ok(b.len()));
        assert_eq!(writes.iter().map(|(_, b)| b.as_slice()).collect::<Vec<_>>(), [b"3\r".as_slice(), b"ls\r"]);
        assert!(done.is_empty());
    }

    #[test]
    fn a_gap_is_measured_from_the_last_byte_written_even_when_frames_arrive_together() {
        // A paste and its Return batched into one socket read: the Return
        // still waits 30 ms after the paste's last chunk.
        let mut q = InputQueue::default();
        q.push(Job::new(0, vec![b'p'; 1500], true, false, Duration::ZERO));
        q.push(Job::new(2, b"\r".to_vec(), false, true, Duration::from_millis(30)));
        let (writes, done) = run(&mut q, Instant::now(), |b| Ok(b.len()));
        let last_paste = writes[writes.len() - 2].0;
        let ret = writes.last().unwrap();
        assert_eq!(ret.1, b"\r");
        assert!(ret.0 - last_paste >= Duration::from_millis(30));
        assert!(ret.0 - last_paste < Duration::from_millis(31));
        assert_eq!(done.len(), 1);
        // With nothing written before, a gap does not delay.
        let mut q = InputQueue::default();
        q.push(Job::new(0, b"x".to_vec(), false, false, Duration::from_millis(30)));
        let (writes, _) = run(&mut q, Instant::now(), |b| Ok(b.len()));
        assert_eq!(writes[0].0, Duration::ZERO);
    }

    #[test]
    fn a_partial_write_waits_for_writable_and_resumes_in_place() {
        let mut q = InputQueue::default();
        q.push(Job::new(5, (0..2000u32).map(|i| i as u8).collect(), true, true, Duration::ZERO));
        let mut n = 0;
        let (writes, done) = run(&mut q, Instant::now(), |b| {
            n += 1;
            match n % 3 {
                0 => Err(io::ErrorKind::WouldBlock.into()),
                1 => Ok(b.len().min(100)),
                _ => Ok(b.len()),
            }
        });
        assert_eq!(writes.iter().flat_map(|(_, b)| b.clone()).collect::<Vec<_>>(), (0..2000u32).map(|i| i as u8).collect::<Vec<_>>());
        assert_eq!(done, vec![Done { owner: 0, seq: 5, ok: true, error: String::new() }]);
    }

    #[test]
    fn a_write_error_fails_the_job_and_the_queue_goes_on() {
        let mut q = InputQueue::default();
        q.push(Job::new(1, vec![b'x'; PTY_CHUNK * 3], true, true, Duration::ZERO));
        q.push(Job::new(2, b"y".to_vec(), false, true, Duration::ZERO));
        let mut first = true;
        let (_, done) = run(&mut q, Instant::now(), |b| {
            if std::mem::take(&mut first) {
                Err(io::Error::from_raw_os_error(libc::EIO))
            } else {
                Ok(b.len())
            }
        });
        assert_eq!(done[0].seq, 1);
        assert!(!done[0].ok && done[0].error.contains("pty write failed"));
        assert_eq!(done[1], Done { owner: 0, seq: 2, ok: true, error: String::new() });
        let mut q = InputQueue::default();
        q.push(Job::new(3, b"z".to_vec(), false, true, Duration::ZERO));
        q.push(Job::new(0, b"z".to_vec(), false, false, Duration::ZERO));
        assert_eq!(q.fail_all("gone").len(), 1, "only checked jobs are answered");
        assert!(q.is_empty());
    }
}
