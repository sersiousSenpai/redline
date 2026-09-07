// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The one tolerant JSON extractor every agent-reply parser uses: find the
//! first balanced `{…}` in a reply (prose, fences and all) that parses and
//! carries a given key. Replaces the two identical copies that lived in
//! Redline's `classmem.rs` and `keeper.rs`.

use serde_json::Value;

/// First top-level `{…}` substring that parses as JSON and carries `key`.
/// Shared with classmem's supersede-verifier parser.
pub fn extract_object_with_key(text: &str, key: &str) -> Option<Value> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            if let Some(end) = matching_brace(bytes, i) {
                if let Ok(v) = serde_json::from_str::<Value>(&text[i..=end]) {
                    if v.get(key).is_some() {
                        return Some(v);
                    }
                }
            }
        }
        i += 1;
    }
    None
}

pub fn matching_brace(bytes: &[u8], start: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escaped = false;
    for (offset, &b) in bytes.iter().enumerate().skip(start) {
        if in_str {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_str = false;
            }
            continue;
        }
        match b {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(offset);
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_first_balanced_object_carrying_the_key() {
        let text = "Sure. {\"other\":1} then ```json\n{\"verdicts\":[{\"a\":\"}\"}]}\n``` done";
        let v = extract_object_with_key(text, "verdicts").expect("found");
        assert_eq!(v["verdicts"][0]["a"], "}");
        assert!(extract_object_with_key(text, "missing").is_none());
        assert!(extract_object_with_key("no json", "verdicts").is_none());
    }

    #[test]
    fn matching_brace_respects_strings_and_escapes() {
        let s = br#"{"k":"\"}{"}"#;
        assert_eq!(matching_brace(s, 0), Some(s.len() - 1));
        assert_eq!(matching_brace(b"{ unterminated", 0), None);
    }
}
