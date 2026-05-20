// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolutionParseResult {
    pub stripped_markdown: String,
    pub resolutions: HashMap<String, String>,
    pub parse_error: Option<String>,
    pub raw_block: Option<String>,
}

pub fn extract_resolutions(markdown: &str) -> ResolutionParseResult {
    let Some((block_start, block_end, content_start, content_end)) =
        find_resolution_block(markdown)
    else {
        return ResolutionParseResult {
            stripped_markdown: markdown.to_string(),
            resolutions: HashMap::new(),
            parse_error: None,
            raw_block: None,
        };
    };

    let block_text = markdown[content_start..content_end].to_string();
    let json_part = strip_keyword(&block_text);
    let parse = try_parse(json_part);

    let mut stripped = String::with_capacity(markdown.len());
    stripped.push_str(&markdown[..block_start]);
    stripped.push_str(&markdown[block_end..]);
    let stripped = stripped
        .trim_start_matches(|c: char| c == '\n' || c == '\r')
        .to_string();

    match parse {
        Ok(map) => ResolutionParseResult {
            stripped_markdown: stripped,
            resolutions: map,
            parse_error: None,
            raw_block: Some(block_text),
        },
        Err(e) => ResolutionParseResult {
            stripped_markdown: stripped,
            resolutions: HashMap::new(),
            parse_error: Some(e),
            raw_block: Some(block_text),
        },
    }
}

fn find_resolution_block(md: &str) -> Option<(usize, usize, usize, usize)> {
    let lower = md.to_lowercase();
    let mut cursor = 0;
    while cursor < md.len() {
        let rel = lower[cursor..].find("<!--")?;
        let start = cursor + rel;
        let after_open = start + 4;
        let rest = &lower[after_open..];
        let trimmed_start = after_open + (rest.len() - rest.trim_start().len());
        if !lower[trimmed_start..].starts_with("redline_resolutions") {
            cursor = after_open;
            continue;
        }
        let rel_end = md[trimmed_start..].find("-->")?;
        let content_end = trimmed_start + rel_end;
        let block_end = content_end + 3;
        return Some((start, block_end, trimmed_start, content_end));
    }
    None
}

fn strip_keyword(block: &str) -> &str {
    let lower = block.to_lowercase();
    let keyword = "redline_resolutions";
    if let Some(idx) = lower.find(keyword) {
        let after = &block[idx + keyword.len()..];
        return after.trim_start();
    }
    block.trim_start()
}

fn try_parse(text: &str) -> Result<HashMap<String, String>, String> {
    let trimmed = text.trim();
    if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
        return value_to_map(v);
    }
    let cleaned = strip_trailing_commas(trimmed);
    if let Ok(v) = serde_json::from_str::<Value>(&cleaned) {
        return value_to_map(v);
    }
    Err("resolution block JSON could not be parsed".to_string())
}

fn value_to_map(v: Value) -> Result<HashMap<String, String>, String> {
    let obj = v
        .as_object()
        .ok_or_else(|| "resolution block was not a JSON object".to_string())?;
    let mut out = HashMap::new();
    for (k, v) in obj {
        let s = match v {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        out.insert(k.clone(), s);
    }
    Ok(out)
}

fn strip_trailing_commas(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b',' {
            let mut j = i + 1;
            while j < bytes.len() && (bytes[j] as char).is_whitespace() {
                j += 1;
            }
            if j < bytes.len() && (bytes[j] == b'}' || bytes[j] == b']') {
                i += 1;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_canonical_block() {
        let md = r#"<!-- REDLINE_RESOLUTIONS
{
  "c-001": "Addressed in v2.",
  "c-002": "Restructured §C."
}
-->

# Plan title

Body.
"#;
        let result = extract_resolutions(md);
        assert!(result.parse_error.is_none());
        assert_eq!(result.resolutions.len(), 2);
        assert_eq!(
            result.resolutions.get("c-001").unwrap(),
            "Addressed in v2."
        );
        assert!(result.stripped_markdown.starts_with("# Plan title"));
    }

    #[test]
    fn tolerates_fence_variations() {
        let cases = [
            "<!--REDLINE_RESOLUTIONS\n{\"c-1\":\"a\"}\n-->\n# Title",
            "<!--   redline_resolutions   \n{\"c-1\":\"a\"}\n-->\n# Title",
            "<!-- Redline_Resolutions\n{\"c-1\":\"a\"}\n-->\n# Title",
        ];
        for md in &cases {
            let r = extract_resolutions(md);
            assert!(r.parse_error.is_none(), "case failed: {}", md);
            assert_eq!(r.resolutions.get("c-1").unwrap(), "a");
        }
    }

    #[test]
    fn tolerates_trailing_commas() {
        let md = "<!-- REDLINE_RESOLUTIONS\n{\n  \"c-001\": \"ok\",\n}\n-->\n# Title";
        let r = extract_resolutions(md);
        assert!(r.parse_error.is_none());
        assert_eq!(r.resolutions.get("c-001").unwrap(), "ok");
    }

    #[test]
    fn block_anywhere_in_body() {
        let md = "# Title\n\nBody.\n\n<!-- REDLINE_RESOLUTIONS\n{\"c-1\":\"answer\"}\n-->\n\nMore body.";
        let r = extract_resolutions(md);
        assert!(r.parse_error.is_none());
        assert_eq!(r.resolutions.get("c-1").unwrap(), "answer");
        assert!(r.stripped_markdown.starts_with("# Title"));
        assert!(!r.stripped_markdown.contains("REDLINE_RESOLUTIONS"));
    }

    #[test]
    fn no_block_returns_unchanged() {
        let md = "# Title\n\nNo resolutions here.\n";
        let r = extract_resolutions(md);
        assert!(r.raw_block.is_none());
        assert!(r.parse_error.is_none());
        assert_eq!(r.resolutions.len(), 0);
        assert_eq!(r.stripped_markdown, md);
    }

    #[test]
    fn malformed_json_surfaces_error_but_strips_block() {
        let md = "<!-- REDLINE_RESOLUTIONS\nthis is not json\n-->\n\n# Title";
        let r = extract_resolutions(md);
        assert!(r.parse_error.is_some());
        assert!(r.raw_block.is_some());
        assert_eq!(r.resolutions.len(), 0);
        assert!(r.stripped_markdown.starts_with("# Title"));
    }

    #[test]
    fn ignores_unrelated_html_comments() {
        let md = "<!-- not a resolution block -->\n\n<!-- REDLINE_RESOLUTIONS\n{\"c-1\":\"a\"}\n-->\n\n# Title";
        let r = extract_resolutions(md);
        assert_eq!(r.resolutions.get("c-1").unwrap(), "a");
        // The first comment should still be present in stripped markdown
        assert!(r.stripped_markdown.contains("<!-- not a resolution block -->"));
    }
}
