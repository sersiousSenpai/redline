// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Discover model ids from the installed Claude binary without reading its
//! hundreds of megabytes into memory. This is an advisory catalog: extraction
//! can change between releases, so every failure preserves the four aliases.

use std::collections::HashSet;
use std::io::{self, Read};
use std::sync::OnceLock;

use serde::Serialize;

const FAMILIES: [&str; 4] = ["fable", "opus", "sonnet", "haiku"];
const MARKER: &[u8] = b"new Set([\"claude-";
const CHUNK_BYTES: usize = 4 * 1024 * 1024;
const OVERLAP: usize = 256;
const MAX_SET_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeModel {
    pub id: String,
    pub label: String,
    pub alias: bool,
    pub note: Option<String>,
}

fn family_name(family: &str) -> String {
    let mut chars = family.chars();
    chars
        .next()
        .map(|first| first.to_ascii_uppercase().to_string() + chars.as_str())
        .unwrap_or_default()
}

/// Strict ASCII id grammar; no expression fragments or arbitrary strings from
/// an adjacent literal can become a model choice.
fn valid_model_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("claude-") else {
        return false;
    };
    let mut parts = rest.split('-');
    let Some(family) = parts.next() else {
        return false;
    };
    !family.is_empty()
        && family.bytes().all(|c| c.is_ascii_lowercase())
        && parts.all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
}

fn pinned_family(id: &str) -> Option<(&str, Vec<u64>)> {
    if !valid_model_id(id) {
        return None;
    }
    let mut parts = id.strip_prefix("claude-")?.split('-');
    let family = parts.next()?;
    if !FAMILIES.contains(&family) {
        return None;
    }
    let major = parts.next()?.parse::<u64>().ok()?;
    if major < 4 {
        return None;
    }
    let mut version = vec![major];
    version.extend(
        parts
            .take_while(|part| part.bytes().all(|c| c.is_ascii_digit()))
            .filter_map(|part| part.parse::<u64>().ok()),
    );
    Some((family, version))
}

fn pinned_label(id: &str) -> String {
    let Some((family, _)) = pinned_family(id) else {
        return id.to_string();
    };
    let version = id
        .strip_prefix(&format!("claude-{family}-"))
        .unwrap_or_default()
        .replace('-', ".");
    format!("{} {version}", family_name(family))
}

fn present_catalog(ids: Vec<String>) -> Vec<ClaudeModel> {
    let mut seen = HashSet::new();
    let mut pinned: Vec<String> = ids
        .into_iter()
        .filter(|id| pinned_family(id).is_some() && seen.insert(id.clone()))
        .collect();
    pinned.sort_by(|a, b| {
        let (af, av) = pinned_family(a).unwrap();
        let (bf, bv) = pinned_family(b).unwrap();
        FAMILIES
            .iter()
            .position(|family| *family == af)
            .cmp(&FAMILIES.iter().position(|family| *family == bf))
            .then_with(|| bv.cmp(&av))
            .then_with(|| a.cmp(b))
    });
    let mut models: Vec<ClaudeModel> = FAMILIES
        .iter()
        .map(|family| {
            let highest = pinned
                .iter()
                .find(|id| pinned_family(id).is_some_and(|(f, _)| f == *family));
            ClaudeModel {
                id: family.to_string(),
                label: highest
                    .map(|id| pinned_label(id))
                    .unwrap_or_else(|| format!("latest {}", family_name(family))),
                alias: true,
                note: highest.map(|id| format!("Alias for {id}; follows Claude updates")),
            }
        })
        .collect();
    models.extend(pinned.into_iter().map(|id| ClaudeModel {
        label: pinned_label(&id),
        id,
        alias: false,
        note: None,
    }));
    models
}

pub fn fallback_catalog() -> Vec<ClaudeModel> {
    present_catalog(Vec::new())
}

fn literal_ids(window: &[u8]) -> Option<Vec<String>> {
    let end = window.windows(2).position(|part| part == b"])")?;
    let text = std::str::from_utf8(window.get(b"new Set(".len()..=end)?).ok()?;
    let ids: Vec<String> = serde_json::from_str(text).ok()?;
    let ids: Vec<_> = ids.into_iter().filter(|id| valid_model_id(id)).collect();
    let families: HashSet<_> = ids
        .iter()
        .filter_map(|id| pinned_family(id).map(|(family, _)| family))
        .collect();
    (families.len() >= 2).then_some(ids)
}

fn extract_ids(mut reader: impl Read, chunk_bytes: usize) -> io::Result<Vec<String>> {
    let mut chunk = vec![0; chunk_bytes.max(1)];
    let mut buffer = Vec::with_capacity(chunk.len() + MAX_SET_BYTES);
    let mut best = Vec::new();
    loop {
        let read = reader.read(&mut chunk)?;
        let eof = read == 0;
        buffer.extend_from_slice(&chunk[..read]);
        let mut cursor = 0;
        let mut pending = None;
        while let Some(offset) = buffer[cursor..]
            .windows(MARKER.len())
            .position(|part| part == MARKER)
        {
            let start = cursor + offset;
            let end = buffer.len().min(start + MAX_SET_BYTES);
            let window = &buffer[start..end];
            if let Some(ids) = literal_ids(window) {
                if ids.len() > best.len() {
                    best = ids;
                }
            } else if !eof
                && window.len() < MAX_SET_BYTES
                && !window.windows(2).any(|part| part == b"])")
            {
                // A set crossing the chunk boundary gets a bounded pending
                // window. Ordinary boundaries retain only 256 bytes.
                pending = Some(start);
                break;
            }
            cursor = start + MARKER.len();
        }
        if eof {
            break;
        }
        let retain_from = pending.unwrap_or_else(|| buffer.len().saturating_sub(OVERLAP));
        buffer.drain(..retain_from);
    }
    Ok(best)
}

static CATALOG: OnceLock<crate::binprobe::Cache<Vec<ClaudeModel>>> = OnceLock::new();

pub fn model_catalog_for_bin(bin: &str) -> Vec<ClaudeModel> {
    crate::binprobe::cached(&CATALOG, bin, || {
        std::fs::File::open(bin)
            .and_then(|file| extract_ids(file, CHUNK_BYTES))
            .map(present_catalog)
            .unwrap_or_else(|_| fallback_catalog())
    })
}

pub fn forget_model_catalog(bin: &str) {
    crate::binprobe::forget(&CATALOG, bin);
}

pub async fn model_catalog() -> Vec<ClaudeModel> {
    tokio::task::spawn_blocking(|| model_catalog_for_bin(&crate::claude_proc::resolve_claude_bin()))
        .await
        .unwrap_or_else(|_| fallback_catalog())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &[u8] = include_bytes!("../tests/fixtures/claude-model-sets.js");

    #[test]
    fn largest_model_table_wins_over_unrelated_and_older_sets() {
        let models = present_catalog(extract_ids(FIXTURE, CHUNK_BYTES).unwrap());
        assert_eq!(
            models
                .iter()
                .take(4)
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
            FAMILIES
        );
        assert_eq!(models[0].label, "Fable 5.1");
        assert_eq!(models[1].label, "Opus 5");
        assert_eq!(models[2].label, "Sonnet 5");
        assert_eq!(models[3].label, "Haiku 4.5");
        assert!(models
            .iter()
            .any(|row| row.id == "claude-opus-4-8" && row.label == "Opus 4.8"));
        assert!(!models
            .iter()
            .any(|row| row.id.contains("mythos") || row.id.starts_with("claude-3-")));
        assert!(!models.iter().any(|row| row.id == "claude-desktop"));
    }

    #[test]
    fn every_chunk_boundary_preserves_the_catalog() {
        let expected = extract_ids(FIXTURE, CHUNK_BYTES).unwrap();
        for size in [1, 7, 15, 32, 100, 256, 300, 512] {
            assert_eq!(
                extract_ids(FIXTURE, size).unwrap(),
                expected,
                "chunk size {size}"
            );
        }
    }

    #[test]
    fn failures_and_unrecognizable_formats_leave_four_aliases() {
        assert_eq!(
            present_catalog(extract_ids(&b"invalid binary"[..], 4).unwrap()),
            fallback_catalog()
        );
        let fallback = model_catalog_for_bin("/redline-missing-claude-for-catalog-test");
        assert_eq!(fallback.len(), 4);
        assert!(fallback.iter().all(|row| row.alias));
        assert_eq!(fallback[1].label, "latest Opus");
    }

    #[test]
    fn unterminated_and_oversized_sets_are_bounded_and_skipped() {
        let mut bytes = b"new Set([\"claude-opus-5\",\"claude-sonnet-5\",\"".to_vec();
        bytes.extend(vec![b'x'; MAX_SET_BYTES * 2]);
        bytes.extend_from_slice(FIXTURE);
        assert_eq!(
            extract_ids(bytes.as_slice(), 128).unwrap(),
            extract_ids(FIXTURE, 128).unwrap()
        );
    }

    #[test]
    fn id_grammar_refuses_expression_fragments_and_family_versions_sort_numerically() {
        for invalid in [
            "claude-Opus-5",
            "claude-opus_5",
            "claude-opus-5;alert",
            "claude-opus--5",
        ] {
            assert!(!valid_model_id(invalid));
        }
        let models = present_catalog(vec!["claude-opus-4-9".into(), "claude-opus-4-10".into()]);
        assert_eq!(models[1].label, "Opus 4.10");
        assert_eq!(models[4].id, "claude-opus-4-10");
    }
}
