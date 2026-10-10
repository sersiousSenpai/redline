// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! One verified download of a model file the app fetches on first use (the
//! Whisper models today; meant to carry the Kokoro and studio-voice files
//! too). The file streams into a `.part` beside its destination and is renamed
//! into place only once it is byte-for-byte the published file: its size and
//! SHA-256 are pinned in the code that asks for it.
//!
//! What it adds over a plain streamed fetch is **resume**. A dropped or stalled
//! connection keeps the `.part`; the next attempt (a retry inside the same
//! call, or a later click) hashes what is already on disk and asks the server
//! for the rest with an HTTP `Range` request. A server that ignores the range
//! starts the file over, and a `.part` that can't be the published file (too
//! long, or wrong once complete) is deleted, so a bad half file never sticks.
//!
//! The file work is plain `std::fs`, not the runtime's async files: writing a
//! received chunk takes microseconds, and each async file operation would
//! build a blocking task of its own type into the binary. The one long call is
//! hashing a half file on resume, once per attempt.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::header::{CONTENT_RANGE, RANGE};
use reqwest::StatusCode;
use sha2::{Digest, Sha256};

/// What a download must come to before it replaces anything: where it is
/// published, its size, and the SHA-256 the host publishes for it.
#[derive(Clone, Copy, Debug)]
pub struct Pinned {
    pub url: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}

/// Report progress roughly every megabyte, so a bar moves without flooding
/// the IPC channel.
const PROGRESS_STEP: u64 = 1_000_000;
/// Attempts inside one call. Each one after the first resumes the `.part`.
const ATTEMPTS: usize = 3;

/// The `.part` a download of `dest` streams into.
pub fn part_path(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().unwrap_or_default().to_os_string();
    name.push(".part");
    dest.with_file_name(name)
}

/// Download `pin` to `dest`, resuming a `.part` left by an earlier attempt.
/// `what` names the file in errors ("the Whisper model"). `stall` gives up an
/// attempt that goes that long without a response or a byte. `progress` gets
/// `(received, total)`, counting bytes resumed from disk as received. It is a
/// `dyn` callback so every caller shares one copy of this state machine.
pub async fn fetch_pinned(
    http: &reqwest::Client,
    pin: &Pinned,
    dest: &Path,
    what: &str,
    stall: Duration,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<(), String> {
    let part = part_path(dest);
    let mut last = String::new();
    for _ in 0..ATTEMPTS {
        match attempt(http, pin, &part, what, stall, progress).await {
            Ok(()) => {
                return std::fs::rename(&part, dest).map_err(|e| format!("finalizing {what} failed: {e}"));
            }
            // Not the published file: it was discarded, and fetching the same
            // bytes again won't change that.
            Err(Failure::Wrong(e)) => return Err(e),
            Err(Failure::Retry(e)) => last = e,
        }
    }
    Err(last)
}

enum Failure {
    /// The connection failed or stalled; the `.part` is kept to resume.
    Retry(String),
    /// The bytes are not the published file; the `.part` was deleted.
    Wrong(String),
}

async fn attempt(
    http: &reqwest::Client,
    pin: &Pinned,
    part: &Path,
    what: &str,
    stall: Duration,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<(), Failure> {
    let retry = |e: String| Failure::Retry(e);
    let stalled = || Failure::Retry(format!("downloading {what} stalled — try again"));
    let (mut hasher, mut have) = resume_point(pin, part).map_err(retry)?;

    if have < pin.bytes {
        let mut req = http.get(pin.url);
        if have > 0 {
            req = req.header(RANGE, format!("bytes={have}-"));
        }
        let mut resp = tokio::time::timeout(stall, req.send())
            .await
            .map_err(|_| stalled())?
            .map_err(|e| retry(format!("downloading {what} failed: {e}")))?;
        let resumed = have > 0
            && resp.status() == StatusCode::PARTIAL_CONTENT
            && range_start(&resp) == Some(have);
        if have > 0 && !resumed {
            if resp.status() == StatusCode::RANGE_NOT_SATISFIABLE {
                let _ = std::fs::remove_file(part);
                return Err(retry(format!("downloading {what} has to start over — try again")));
            }
            // The server sent the whole file instead of the rest: start over.
            hasher = Sha256::new();
            have = 0;
        }
        if !resp.status().is_success() {
            return Err(retry(format!("downloading {what} failed: HTTP {}", resp.status())));
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(resumed)
            .truncate(!resumed)
            .open(part)
            .map_err(|e| retry(format!("creating the file for {what} failed: {e}")))?;
        let mut last_report = have;
        progress(have, pin.bytes);
        while let Some(chunk) = tokio::time::timeout(stall, resp.chunk())
            .await
            .map_err(|_| stalled())?
            .map_err(|e| retry(format!("downloading {what} failed: {e}")))?
        {
            if have + chunk.len() as u64 > pin.bytes {
                drop(file);
                return Err(discard(part, what, have + chunk.len() as u64));
            }
            file.write_all(&chunk)
                .map_err(|e| retry(format!("writing {what} failed: {e}")))?;
            hasher.update(&chunk);
            have += chunk.len() as u64;
            if have - last_report >= PROGRESS_STEP {
                last_report = have;
                progress(have, pin.bytes);
            }
        }
        progress(have, pin.bytes);
    }

    if have != pin.bytes {
        // The body ended early: keep what came, the next attempt resumes it.
        return Err(retry(format!("downloading {what} was cut off — try again")));
    }
    if format!("{:x}", hasher.finalize()) != pin.sha256 {
        return Err(discard(part, what, have));
    }
    Ok(())
}

/// Where a download picks up: the hash and length of a `.part` an earlier
/// attempt left, or a fresh start. A `.part` longer than the published file
/// can't be resumed into it, so it is deleted.
fn resume_point(pin: &Pinned, part: &Path) -> Result<(Sha256, u64), String> {
    let mut hasher = Sha256::new();
    let Ok(mut file) = std::fs::File::open(part) else {
        return Ok((hasher, 0));
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if len > pin.bytes {
        drop(file);
        let _ = std::fs::remove_file(part);
        return Ok((Sha256::new(), 0));
    }
    let mut buf = vec![0u8; 1 << 20];
    let mut read = 0u64;
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("reading the partial download failed: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        read += n as u64;
    }
    Ok((hasher, read))
}

/// The first byte a `206` response carries, from `Content-Range: bytes a-b/n`.
fn range_start(resp: &reqwest::Response) -> Option<u64> {
    let value = resp.headers().get(CONTENT_RANGE)?.to_str().ok()?;
    value.strip_prefix("bytes ")?.split('-').next()?.trim().parse().ok()
}

fn discard(part: &Path, what: &str, received: u64) -> Failure {
    let _ = std::fs::remove_file(part);
    Failure::Wrong(format!(
        "the downloaded {what} wasn't the published file ({received} bytes), so it was \
         discarded — try again"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    const BODY: &[u8] = b"weights for a model that is exactly this long, nothing more";

    fn pin_for(url: String, body: &[u8]) -> Pinned {
        Pinned {
            url: Box::leak(url.into_boxed_str()),
            bytes: body.len() as u64,
            sha256: Box::leak(format!("{:x}", Sha256::digest(body)).into_boxed_str()),
        }
    }

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("redline-pinned-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("model.bin")
    }

    /// How the loopback server answers one request.
    #[derive(Clone, Copy)]
    enum Answer {
        /// Honour a `Range` header with a 206; otherwise send the whole body.
        Ranged,
        /// Always the whole body with a 200, whatever the request asked.
        IgnoreRange,
        /// Claim the whole body but send only this many bytes, then hang up.
        CutAt(usize),
    }

    /// Serve `body` on a loopback port, one connection per entry in
    /// `answers`, and record each request's `Range` header (empty if none).
    fn serve(body: &'static [u8], answers: Vec<Answer>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for answer in answers {
                let Ok((mut s, _)) = listener.accept() else { return };
                let mut req = [0u8; 4096];
                let n = s.read(&mut req).unwrap_or(0);
                let head = String::from_utf8_lossy(&req[..n]).to_lowercase();
                let range = head
                    .lines()
                    .find_map(|l| l.strip_prefix("range: bytes="))
                    .map(|r| r.trim_end_matches('-').trim().to_string())
                    .unwrap_or_default();
                log.lock().unwrap().push(range.clone());
                let from: usize = range.parse().unwrap_or(0);
                let _ = match answer {
                    Answer::Ranged if from > 0 => {
                        let rest = &body[from..];
                        let _ = write!(
                            s,
                            "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\n\
                             Content-Range: bytes {from}-{}/{}\r\nConnection: close\r\n\r\n",
                            rest.len(),
                            body.len() - 1,
                            body.len()
                        );
                        s.write_all(rest)
                    }
                    Answer::Ranged | Answer::IgnoreRange => {
                        let _ = write!(
                            s,
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        s.write_all(body)
                    }
                    Answer::CutAt(n) => {
                        let _ = write!(
                            s,
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        s.write_all(&body[..n])
                    }
                };
            }
        });
        (format!("http://{addr}/model.bin"), seen)
    }

    const STALL: Duration = Duration::from_secs(5);

    #[tokio::test]
    async fn a_fresh_download_is_verified_and_renamed_into_place() {
        let dest = scratch("fresh");
        let (url, seen) = serve(BODY, vec![Answer::Ranged]);
        let reports = Mutex::new(Vec::new());
        fetch_pinned(&reqwest::Client::new(), &pin_for(url, BODY), &dest, "the model", STALL, &|r, t| {
            reports.lock().unwrap().push((r, t))
        })
        .await
        .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), BODY);
        assert!(!part_path(&dest).exists());
        assert_eq!(*seen.lock().unwrap(), vec![String::new()], "no range on a fresh start");
        let total = BODY.len() as u64;
        assert_eq!(reports.into_inner().unwrap().last(), Some(&(total, total)));
    }

    #[tokio::test]
    async fn a_partial_file_resumes_with_a_range_request_for_the_rest() {
        let dest = scratch("resume");
        std::fs::write(part_path(&dest), &BODY[..20]).unwrap();
        let (url, seen) = serve(BODY, vec![Answer::Ranged]);
        let first = Mutex::new(None);
        fetch_pinned(&reqwest::Client::new(), &pin_for(url, BODY), &dest, "the model", STALL, &|r, _| {
            first.lock().unwrap().get_or_insert(r);
        })
        .await
        .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), BODY, "the resumed bytes hash with the kept ones");
        assert_eq!(*seen.lock().unwrap(), vec!["20".to_string()]);
        assert_eq!(first.into_inner().unwrap(), Some(20), "progress counts the kept bytes");
    }

    #[tokio::test]
    async fn a_dropped_connection_keeps_its_bytes_and_the_retry_resumes_them() {
        let dest = scratch("dropped");
        let (url, seen) = serve(BODY, vec![Answer::CutAt(25), Answer::Ranged]);
        fetch_pinned(&reqwest::Client::new(), &pin_for(url, BODY), &dest, "the model", STALL, &|_, _| {})
            .await
            .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), BODY);
        assert_eq!(*seen.lock().unwrap(), vec![String::new(), "25".to_string()]);
    }

    #[tokio::test]
    async fn a_server_that_ignores_the_range_starts_the_file_over() {
        let dest = scratch("ignored-range");
        std::fs::write(part_path(&dest), &BODY[..20]).unwrap();
        let (url, _) = serve(BODY, vec![Answer::IgnoreRange]);
        fetch_pinned(&reqwest::Client::new(), &pin_for(url, BODY), &dest, "the model", STALL, &|_, _| {})
            .await
            .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), BODY, "not the kept bytes plus a second copy");
    }

    #[tokio::test]
    async fn bytes_that_are_not_the_published_file_are_discarded_without_a_retry() {
        let dest = scratch("wrong");
        let (url, seen) = serve(BODY, vec![Answer::Ranged, Answer::Ranged]);
        let mut pin = pin_for(url, BODY);
        pin.sha256 = "0000000000000000000000000000000000000000000000000000000000000000";
        let err = fetch_pinned(&reqwest::Client::new(), &pin, &dest, "the model", STALL, &|_, _| {})
            .await
            .unwrap_err();
        assert!(err.contains("wasn't the published file"), "{err}");
        assert!(!dest.exists());
        assert!(!part_path(&dest).exists(), "no half file left to resume");
        assert_eq!(seen.lock().unwrap().len(), 1, "the same bytes aren't fetched again");
    }

    #[tokio::test]
    async fn a_part_longer_than_the_published_file_is_thrown_away_first() {
        let dest = scratch("too-long");
        std::fs::write(part_path(&dest), [BODY, b"and then some"].concat()).unwrap();
        let (url, seen) = serve(BODY, vec![Answer::Ranged]);
        fetch_pinned(&reqwest::Client::new(), &pin_for(url, BODY), &dest, "the model", STALL, &|_, _| {})
            .await
            .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), BODY);
        assert_eq!(*seen.lock().unwrap(), vec![String::new()]);
    }

    #[tokio::test]
    async fn a_complete_part_from_an_interrupted_rename_needs_no_request() {
        let dest = scratch("complete-part");
        std::fs::write(part_path(&dest), BODY).unwrap();
        let pin = pin_for("http://127.0.0.1:9/never".to_string(), BODY);
        fetch_pinned(&reqwest::Client::new(), &pin, &dest, "the model", STALL, &|_, _| {})
            .await
            .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), BODY);
    }

    #[test]
    fn the_part_sits_beside_the_destination_under_its_full_name() {
        assert_eq!(
            part_path(Path::new("/m/ggml-base.en.bin")),
            PathBuf::from("/m/ggml-base.en.bin.part")
        );
    }
}
