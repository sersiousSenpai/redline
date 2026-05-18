use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};

use crate::state::{Paragraph, Section};

/// Parse a plan's markdown into the section/anchor tree.
///
/// Headings drive the section hierarchy and anchor scheme (`A`, `A.1`, `A.p1`).
/// Every top-level content node inside a section (paragraph, list, code block,
/// blockquote, table, html block, thematic break) becomes one anchored
/// `Paragraph` whose `markdown` is the **verbatim source slice** — nothing is
/// flattened or dropped, so the frontend can render it faithfully.
pub fn parse_plan(markdown: &str) -> Vec<Section> {
    parse_collect(markdown).0
}

/// Parse a plan and return it alongside a copy of the (resolution-stripped)
/// markdown in which **every** section/block is preceded by a stable
/// `<!-- rl:blk-… -->` sidecar. Blocks that already carried a sidecar keep
/// their id verbatim; blocks without one get a freshly minted id injected at
/// the block's byte offset, leaving every other byte untouched.
///
/// Invariant (asserted in tests): the operation is idempotent — feeding the
/// returned markdown back in yields byte-identical markdown and identical
/// `block_id`s. This is what makes `block_id` survive the "reparse on load"
/// model in `db.rs::load_all`.
pub fn parse_plan_with_sidecars(markdown: &str) -> (Vec<Section>, String) {
    let (sections, injections, stripped) = parse_collect(markdown);
    let augmented = apply_injections(&stripped, injections);
    (sections, augmented)
}

fn parse_collect(markdown: &str) -> (Vec<Section>, Vec<(usize, String)>, String) {
    let stripped = strip_resolutions_block(markdown);
    let mut walker = Walker::new();
    {
        let mut iter = Parser::new_ext(&stripped, Options::all()).into_offset_iter();
        while let Some((event, range)) = iter.next() {
            match event {
                Event::Start(Tag::Heading { level, .. }) => {
                    walker.begin_heading(heading_level_to_u8(level), range.start);
                }
                Event::End(TagEnd::Heading(_)) => {
                    walker.end_heading();
                }
                Event::Text(t) | Event::Code(t) => {
                    walker.push_title(&t);
                }
                Event::Start(tag) if is_block_container(&tag) => {
                    let start = range.start;
                    let md = stripped[range].trim().to_string();
                    // Consume this block's inner events up to its matching End
                    // so nested content is not re-interpreted as plan structure.
                    let mut depth = 1usize;
                    while depth > 0 {
                        match iter.next() {
                            Some((Event::Start(_), _)) => depth += 1,
                            Some((Event::End(_), _)) => depth -= 1,
                            Some(_) => {}
                            None => break,
                        }
                    }
                    if let Some(id) = parse_sidecar_id(&md) {
                        // A redline sidecar: not content — it names the next block.
                        walker.pending_block_id = Some(id);
                    } else {
                        walker.attach_block(start, md);
                    }
                }
                Event::Rule => {
                    walker.attach_block(range.start, stripped[range].trim().to_string());
                }
                _ => {}
            }
        }
    }
    let (sections, injections) = walker.finish();
    (sections, injections, stripped)
}

/// If `s` (trimmed) is exactly a redline block sidecar, return its block id.
fn parse_sidecar_id(s: &str) -> Option<String> {
    let inner = s.strip_prefix("<!--")?.strip_suffix("-->")?.trim();
    let id = inner.strip_prefix("rl:")?.trim();
    let rest = id.strip_prefix("blk-")?;
    if !rest.is_empty()
        && rest
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        Some(id.to_string())
    } else {
        None
    }
}

fn mint_block_id() -> String {
    let u = uuid::Uuid::new_v4().simple().to_string();
    format!("blk-{}", &u[..8])
}

/// Splice `<!-- rl:blk-… -->\n` in front of each recorded block offset,
/// preserving every other byte of `src` exactly.
fn apply_injections(src: &str, mut injections: Vec<(usize, String)>) -> String {
    if injections.is_empty() {
        return src.to_string();
    }
    injections.sort_by_key(|(off, _)| *off);
    let mut out = String::with_capacity(src.len() + injections.len() * 28);
    let mut last = 0usize;
    for (off, id) in injections {
        out.push_str(&src[last..off]);
        out.push_str("<!-- rl:");
        out.push_str(&id);
        out.push_str(" -->\n");
        last = off;
    }
    out.push_str(&src[last..]);
    out
}

fn is_block_container(tag: &Tag<'_>) -> bool {
    matches!(
        tag,
        Tag::Paragraph
            | Tag::CodeBlock(_)
            | Tag::List(_)
            | Tag::BlockQuote
            | Tag::Table(_)
            | Tag::HtmlBlock
            | Tag::FootnoteDefinition(_)
    )
}

/// Plain-text rendering of a block's markdown, used for revision diffing so
/// cosmetic markdown reflows don't read as content changes.
fn block_plain_text(md: &str) -> String {
    let mut out = String::new();
    for event in Parser::new_ext(md, Options::all()) {
        match event {
            Event::Text(t) | Event::Code(t) => out.push_str(&t),
            Event::SoftBreak => out.push(' '),
            Event::HardBreak => out.push('\n'),
            Event::End(TagEnd::Paragraph)
            | Event::End(TagEnd::Item)
            | Event::End(TagEnd::CodeBlock) => out.push('\n'),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn strip_resolutions_block(md: &str) -> String {
    let mut cursor = 0usize;
    let bytes = md.as_bytes();
    while cursor < bytes.len() {
        let rest = &md[cursor..];
        let Some(rel_start) = rest.find("<!--") else { break };
        let start = cursor + rel_start;
        let after_open = start + 4;
        let Some(rel_end) = md[after_open..].find("-->") else { break };
        let close_end = after_open + rel_end + 3;
        let block = &md[start..close_end];
        if block.to_uppercase().contains("REDLINE_RESOLUTIONS") {
            let mut out = String::with_capacity(md.len());
            out.push_str(&md[..start]);
            out.push_str(&md[close_end..]);
            return out.trim_start_matches(|c: char| c == '\n' || c == '\r').to_string();
        }
        cursor = close_end;
    }
    md.to_string()
}

struct SectionFrame {
    level: u8,
    anchor_id: String,
    block_id: String,
    title: String,
    paragraphs: Vec<Paragraph>,
    children: Vec<Section>,
    next_child_index: u32,
    next_paragraph_index: u32,
    body_markdown: String,
}

impl SectionFrame {
    fn root() -> Self {
        Self {
            level: 0,
            anchor_id: String::new(),
            block_id: String::new(),
            title: String::new(),
            paragraphs: Vec::new(),
            children: Vec::new(),
            next_child_index: 0,
            next_paragraph_index: 0,
            body_markdown: String::new(),
        }
    }
}

struct Walker {
    stack: Vec<SectionFrame>,
    title_buf: Option<String>,
    pending_heading_level: Option<u8>,
    pending_heading_start: usize,
    /// Block id read from a sidecar, awaiting the section/block it names.
    pending_block_id: Option<String>,
    /// `(byte offset, minted id)` for blocks that had no sidecar — used to
    /// splice sidecars back into the stored markdown.
    injections: Vec<(usize, String)>,
}

impl Walker {
    fn new() -> Self {
        Self {
            stack: vec![SectionFrame::root()],
            title_buf: None,
            pending_heading_level: None,
            pending_heading_start: 0,
            pending_block_id: None,
            injections: Vec::new(),
        }
    }

    /// Resolve the id for a section/block starting at byte `start`: reuse a
    /// sidecar id if one preceded it, else mint one and record where its
    /// sidecar must be injected.
    fn take_block_id(&mut self, start: usize) -> String {
        if let Some(id) = self.pending_block_id.take() {
            id
        } else {
            let id = mint_block_id();
            self.injections.push((start, id.clone()));
            id
        }
    }

    fn begin_heading(&mut self, level: u8, start: usize) {
        self.pending_heading_level = Some(level);
        self.pending_heading_start = start;
        self.title_buf = Some(String::new());
    }

    fn push_title(&mut self, t: &str) {
        if let Some(buf) = self.title_buf.as_mut() {
            buf.push_str(t);
        }
    }

    fn end_heading(&mut self) {
        let level = self.pending_heading_level.take().unwrap_or(1);
        let start = self.pending_heading_start;
        let title = self.title_buf.take().unwrap_or_default().trim().to_string();
        self.open_section(level, start, title);
    }

    fn attach_block(&mut self, start: usize, markdown: String) {
        if markdown.is_empty() {
            return;
        }
        let text = block_plain_text(&markdown);
        let block_id = self.take_block_id(start);
        let frame = self.stack.last_mut().unwrap();
        frame.next_paragraph_index += 1;
        let anchor = format!("{}.p{}", frame.anchor_id, frame.next_paragraph_index);
        if !frame.body_markdown.is_empty() {
            frame.body_markdown.push_str("\n\n");
        }
        frame.body_markdown.push_str(&markdown);
        frame.paragraphs.push(Paragraph {
            anchor_id: anchor,
            block_id,
            markdown,
            text,
        });
    }

    fn open_section(&mut self, level: u8, start: usize, title: String) {
        while self.stack.len() > 1 && self.stack.last().unwrap().level >= level {
            self.close_top();
        }
        let block_id = self.take_block_id(start);
        let parent = self.stack.last_mut().unwrap();
        parent.next_child_index += 1;
        let anchor = if parent.level == 0 {
            letter_label(parent.next_child_index)
        } else {
            format!("{}.{}", parent.anchor_id, parent.next_child_index)
        };
        self.stack.push(SectionFrame {
            level,
            anchor_id: anchor,
            block_id,
            title,
            paragraphs: Vec::new(),
            children: Vec::new(),
            next_child_index: 0,
            next_paragraph_index: 0,
            body_markdown: String::new(),
        });
    }

    fn close_top(&mut self) {
        let frame = self.stack.pop().unwrap();
        let section = Section {
            anchor_id: frame.anchor_id,
            block_id: frame.block_id,
            level: frame.level,
            title: frame.title,
            body_markdown: frame.body_markdown,
            children: frame.children,
            paragraphs: frame.paragraphs,
        };
        let parent = self.stack.last_mut().unwrap();
        parent.children.push(section);
    }

    fn finish(mut self) -> (Vec<Section>, Vec<(usize, String)>) {
        while self.stack.len() > 1 {
            self.close_top();
        }
        let injections = std::mem::take(&mut self.injections);
        (self.stack.pop().unwrap().children, injections)
    }
}

fn heading_level_to_u8(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

fn letter_label(n: u32) -> String {
    let mut n = n;
    let mut out = String::new();
    while n > 0 {
        n -= 1;
        let c = (b'A' + (n % 26) as u8) as char;
        out.insert(0, c);
        n /= 26;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assigns_anchors_for_nested_headings() {
        let md = "\
# Refactor authentication

Top-level intro paragraph.

## Current state

This section describes the current state.

### Threat model

Some text about threats.

## Proposed approach

More text here.

# Migration path

Final section.
";
        let sections = parse_plan(md);
        assert_eq!(sections.len(), 2);

        let a = &sections[0];
        assert_eq!(a.anchor_id, "A");
        assert_eq!(a.title, "Refactor authentication");
        assert_eq!(a.paragraphs.len(), 1);
        assert_eq!(a.paragraphs[0].anchor_id, "A.p1");
        assert_eq!(a.children.len(), 2);

        let a1 = &a.children[0];
        assert_eq!(a1.anchor_id, "A.1");
        assert_eq!(a1.title, "Current state");
        assert_eq!(a1.paragraphs[0].anchor_id, "A.1.p1");
        assert_eq!(a1.children.len(), 1);

        let a11 = &a1.children[0];
        assert_eq!(a11.anchor_id, "A.1.1");
        assert_eq!(a11.title, "Threat model");
        assert_eq!(a11.paragraphs[0].anchor_id, "A.1.1.p1");

        let a2 = &a.children[1];
        assert_eq!(a2.anchor_id, "A.2");
        assert_eq!(a2.title, "Proposed approach");

        let b = &sections[1];
        assert_eq!(b.anchor_id, "B");
        assert_eq!(b.title, "Migration path");
        assert_eq!(b.paragraphs[0].anchor_id, "B.p1");
    }

    #[test]
    fn multiple_paragraphs_in_section() {
        let md = "\
# Section

First paragraph.

Second paragraph.

Third paragraph.
";
        let sections = parse_plan(md);
        assert_eq!(sections.len(), 1);
        let s = &sections[0];
        assert_eq!(s.paragraphs.len(), 3);
        assert_eq!(s.paragraphs[0].anchor_id, "A.p1");
        assert_eq!(s.paragraphs[1].anchor_id, "A.p2");
        assert_eq!(s.paragraphs[2].anchor_id, "A.p3");
        assert_eq!(s.paragraphs[0].text, "First paragraph.");
    }

    #[test]
    fn strips_redline_resolutions_block() {
        let md = "<!-- REDLINE_RESOLUTIONS\n{\"c-001\": \"done\"}\n-->\n\n# Title\n\nBody.\n";
        let sections = parse_plan(md);
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].title, "Title");
        assert_eq!(sections[0].paragraphs.len(), 1);
    }

    #[test]
    fn letter_labels_beyond_z() {
        assert_eq!(letter_label(1), "A");
        assert_eq!(letter_label(26), "Z");
        assert_eq!(letter_label(27), "AA");
        assert_eq!(letter_label(28), "AB");
        assert_eq!(letter_label(52), "AZ");
        assert_eq!(letter_label(53), "BA");
    }

    #[test]
    fn empty_input_yields_no_sections() {
        let sections = parse_plan("");
        assert_eq!(sections.len(), 0);
    }

    #[test]
    fn preserves_list_and_code_verbatim() {
        let md = "\
# Plan

A paragraph with **bold**, a [link](https://example.com) and `inline code`.

- First bullet
- Second bullet
  - Nested bullet

1. Step one
2. Step two

```rust
fn main() {
    println!(\"hi\");
}
```

> A blockquote line.

| Col A | Col B |
| ----- | ----- |
| 1     | 2     |

---
";
        let sections = parse_plan(md);
        assert_eq!(sections.len(), 1);
        let s = &sections[0];
        // paragraph, bullet list, ordered list, code block, blockquote, table, rule
        assert_eq!(s.paragraphs.len(), 7);

        let para = &s.paragraphs[0];
        assert_eq!(para.anchor_id, "A.p1");
        assert!(para.markdown.contains("**bold**"));
        assert!(para.markdown.contains("[link](https://example.com)"));
        assert!(para.markdown.contains("`inline code`"));

        let bullets = &s.paragraphs[1];
        assert!(bullets.markdown.contains("- First bullet"));
        assert!(bullets.markdown.contains("  - Nested bullet"));

        let ordered = &s.paragraphs[2];
        assert!(ordered.markdown.contains("1. Step one"));
        assert!(ordered.markdown.contains("2. Step two"));

        let code = &s.paragraphs[3];
        assert!(code.markdown.contains("```rust"));
        assert!(code.markdown.contains("println!(\"hi\");"));

        let quote = &s.paragraphs[4];
        assert!(quote.markdown.starts_with('>'));

        let table = &s.paragraphs[5];
        assert!(table.markdown.contains("| Col A | Col B |"));

        let rule = &s.paragraphs[6];
        assert!(rule.markdown.contains("---"));
    }

    fn flatten_block_ids(secs: &[Section]) -> Vec<String> {
        fn walk(secs: &[Section], out: &mut Vec<String>) {
            for s in secs {
                out.push(s.block_id.clone());
                for p in &s.paragraphs {
                    out.push(p.block_id.clone());
                }
                walk(&s.children, out);
            }
        }
        let mut out = Vec::new();
        walk(secs, &mut out);
        out
    }

    /// Remove only the injected sidecar lines, leaving everything else.
    fn strip_sidecar_lines(md: &str) -> String {
        md.split('\n')
            .filter(|l| {
                let t = l.trim();
                !(t.starts_with("<!-- rl:blk-") && t.ends_with("-->"))
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    const RICH_PLAN: &str = "\
# Plan

Intro paragraph with **bold**.

- bullet one
- bullet two
  - nested

```rust
fn main() {}
```

> a quote

| A | B |
| - | - |
| 1 | 2 |

---

## Sub

Sub body.

### Deep

Deep body.

# Second

Tail paragraph.
";

    #[test]
    fn sidecars_inject_for_every_block_and_section() {
        let (sections, md) = parse_plan_with_sidecars(RICH_PLAN);
        let ids = flatten_block_ids(&sections);
        assert!(!ids.is_empty());
        // Every id is unique and well-formed.
        let mut seen = std::collections::HashSet::new();
        for id in &ids {
            assert!(id.starts_with("blk-"), "bad id {id}");
            assert!(seen.insert(id.clone()), "duplicate id {id}");
            assert!(md.contains(&format!("<!-- rl:{id} -->")), "missing sidecar for {id}");
        }
        // One sidecar per section + paragraph.
        assert_eq!(md.matches("<!-- rl:blk-").count(), ids.len());
    }

    #[test]
    fn sidecar_round_trip_is_byte_stable_and_id_stable() {
        let (s1, md1) = parse_plan_with_sidecars(RICH_PLAN);
        // Re-feeding the augmented markdown must not change a single byte and
        // must read the same ids back (the reparse-on-load invariant).
        let (s2, md2) = parse_plan_with_sidecars(&md1);
        assert_eq!(md1, md2, "sidecar injection is not idempotent");
        assert_eq!(flatten_block_ids(&s1), flatten_block_ids(&s2));
        // Plain reparse (what db.rs::load_all does) also yields the same ids.
        let s3 = parse_plan(&md1);
        assert_eq!(flatten_block_ids(&s1), flatten_block_ids(&s3));
    }

    #[test]
    fn injection_only_adds_sidecars_nothing_else() {
        let (_, md1) = parse_plan_with_sidecars(RICH_PLAN);
        assert_eq!(
            strip_sidecar_lines(&md1),
            RICH_PLAN,
            "bytes other than sidecars were altered"
        );
    }

    #[test]
    fn sidecars_do_not_create_spurious_blocks() {
        // Structure/anchors with sidecars must match structure without them.
        let bare = parse_plan(RICH_PLAN);
        let (_, md1) = parse_plan_with_sidecars(RICH_PLAN);
        let with = parse_plan(&md1);

        fn shape(secs: &[Section]) -> Vec<(String, usize)> {
            fn walk(secs: &[Section], out: &mut Vec<(String, usize)>) {
                for s in secs {
                    out.push((s.anchor_id.clone(), s.paragraphs.len()));
                    walk(&s.children, out);
                }
            }
            let mut out = Vec::new();
            walk(secs, &mut out);
            out
        }
        assert_eq!(shape(&bare), shape(&with));

        // List/table/code content stays verbatim (the de-risked case).
        let plan = &with[0];
        assert!(plan.paragraphs.iter().any(|p| p.markdown.contains("- nested")));
        assert!(plan.paragraphs.iter().any(|p| p.markdown.contains("```rust")));
        assert!(plan.paragraphs.iter().any(|p| p.markdown.contains("| A | B |")));
    }

    #[test]
    fn parse_sidecar_id_matches_only_real_sidecars() {
        assert_eq!(parse_sidecar_id("<!-- rl:blk-7f3a -->"), Some("blk-7f3a".into()));
        assert_eq!(parse_sidecar_id("<!--rl:blk-AB_c-1-->"), Some("blk-AB_c-1".into()));
        assert_eq!(parse_sidecar_id("<!-- not ours -->"), None);
        assert_eq!(parse_sidecar_id("<!-- rl:other -->"), None);
        assert_eq!(parse_sidecar_id("<!-- rl:blk- -->"), None);
        assert_eq!(parse_sidecar_id("plain text"), None);
    }

    #[test]
    fn heading_adjacent_with_no_blank_line_round_trips() {
        let md = "# Title\nBody right after heading.\n";
        let (s1, md1) = parse_plan_with_sidecars(md);
        assert_eq!(s1.len(), 1);
        assert_eq!(s1[0].paragraphs.len(), 1);
        assert_eq!(strip_sidecar_lines(&md1), md);
        let (s2, md2) = parse_plan_with_sidecars(&md1);
        assert_eq!(md1, md2);
        assert_eq!(flatten_block_ids(&s1), flatten_block_ids(&s2));
    }

    #[test]
    fn parse_is_deterministic() {
        let md = "\
# Heading

Intro.

- a
- b

```
code
```

## Sub

Body two.
";
        let a = parse_plan(md);
        let b = parse_plan(md);
        let flatten = |secs: &[Section]| -> Vec<String> {
            fn walk(secs: &[Section], out: &mut Vec<String>) {
                for s in secs {
                    out.push(s.anchor_id.clone());
                    for p in &s.paragraphs {
                        out.push(p.anchor_id.clone());
                    }
                    walk(&s.children, out);
                }
            }
            let mut out = Vec::new();
            walk(secs, &mut out);
            out
        };
        assert_eq!(flatten(&a), flatten(&b));
        assert!(!flatten(&a).is_empty());
    }
}
