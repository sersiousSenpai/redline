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
    let stripped = strip_resolutions_block(markdown);
    let mut walker = Walker::new();
    let mut iter = Parser::new_ext(&stripped, Options::all()).into_offset_iter();
    while let Some((event, range)) = iter.next() {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                walker.begin_heading(heading_level_to_u8(level));
            }
            Event::End(TagEnd::Heading(_)) => {
                walker.end_heading();
            }
            Event::Text(t) | Event::Code(t) => {
                walker.push_title(&t);
            }
            Event::Start(tag) if is_block_container(&tag) => {
                let md = stripped[range].trim().to_string();
                // Consume this block's inner events up to its matching End so
                // nested content is not re-interpreted as plan structure.
                let mut depth = 1usize;
                while depth > 0 {
                    match iter.next() {
                        Some((Event::Start(_), _)) => depth += 1,
                        Some((Event::End(_), _)) => depth -= 1,
                        Some(_) => {}
                        None => break,
                    }
                }
                walker.attach_block(md);
            }
            Event::Rule => {
                walker.attach_block(stripped[range].trim().to_string());
            }
            _ => {}
        }
    }
    walker.finish()
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
}

impl Walker {
    fn new() -> Self {
        Self {
            stack: vec![SectionFrame::root()],
            title_buf: None,
            pending_heading_level: None,
        }
    }

    fn begin_heading(&mut self, level: u8) {
        self.pending_heading_level = Some(level);
        self.title_buf = Some(String::new());
    }

    fn push_title(&mut self, t: &str) {
        if let Some(buf) = self.title_buf.as_mut() {
            buf.push_str(t);
        }
    }

    fn end_heading(&mut self) {
        let level = self.pending_heading_level.take().unwrap_or(1);
        let title = self.title_buf.take().unwrap_or_default().trim().to_string();
        self.open_section(level, title);
    }

    fn attach_block(&mut self, markdown: String) {
        if markdown.is_empty() {
            return;
        }
        let text = block_plain_text(&markdown);
        let frame = self.stack.last_mut().unwrap();
        frame.next_paragraph_index += 1;
        let anchor = format!("{}.p{}", frame.anchor_id, frame.next_paragraph_index);
        if !frame.body_markdown.is_empty() {
            frame.body_markdown.push_str("\n\n");
        }
        frame.body_markdown.push_str(&markdown);
        frame.paragraphs.push(Paragraph {
            anchor_id: anchor,
            markdown,
            text,
        });
    }

    fn open_section(&mut self, level: u8, title: String) {
        while self.stack.len() > 1 && self.stack.last().unwrap().level >= level {
            self.close_top();
        }
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
            level: frame.level,
            title: frame.title,
            body_markdown: frame.body_markdown,
            children: frame.children,
            paragraphs: frame.paragraphs,
        };
        let parent = self.stack.last_mut().unwrap();
        parent.children.push(section);
    }

    fn finish(mut self) -> Vec<Section> {
        while self.stack.len() > 1 {
            self.close_top();
        }
        self.stack.pop().unwrap().children
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
