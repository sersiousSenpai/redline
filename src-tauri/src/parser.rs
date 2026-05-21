// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
use std::collections::{HashMap, HashSet};

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

/// Like [`parse_plan_with_sidecars`], but adopts `block_id`s from `prev_sections`
/// for any newly-minted blocks whose plain-text signature matches an
/// unambiguous v1 block. This is the safety net for revise round-trips where
/// Claude rewrites the plan body from scratch and drops the `<!-- rl:blk-… -->`
/// sidecar markers — without it, every block in v2 receives a fresh id and the
/// frontend diff paints the whole plan as added/modified.
///
/// Conservative by design:
/// - Only "minted" v2 blocks (those without a Claude-echoed sidecar) are
///   eligible for rebinding — sidecars Claude DID preserve are never touched.
/// - A v1 id is only adopted when the signature has exactly one available
///   candidate (not already claimed by a v2 sidecar, not already consumed by
///   an earlier rebind in this pass).
/// - Rebinding updates both the in-memory `block_id` and the markdown
///   injection vector, so the persisted `raw_plan_markdown` carries the
///   adopted id in its sidecar — load-time reparse via `parse_plan` will
///   then yield the same id.
pub fn parse_plan_with_sidecars_relative_to(
    markdown: &str,
    prev_sections: &[Section],
) -> (Vec<Section>, String) {
    let (mut sections, mut injections, stripped) = parse_collect(markdown);
    rebind_block_ids(prev_sections, &mut sections, &mut injections);
    let augmented = apply_injections(&stripped, injections);
    (sections, augmented)
}

/// Heading signature (used by [`rebind_block_ids`]) — level + trimmed title.
fn heading_signature(level: u8, title: &str) -> String {
    format!("h{}: {}", level, title.trim())
}

/// Paragraph signature — `block_plain_text` is already whitespace-normalized
/// when `Paragraph::text` is built by `attach_block`, but we re-trim here for
/// safety when callers hand us synthetic sections.
fn paragraph_signature(text: &str) -> String {
    format!("p: {}", text.trim())
}

fn collect_prev_signature_index(prev: &[Section]) -> HashMap<String, Vec<String>> {
    fn walk(secs: &[Section], out: &mut HashMap<String, Vec<String>>) {
        for s in secs {
            out.entry(heading_signature(s.level, &s.title))
                .or_default()
                .push(s.block_id.clone());
            for p in &s.paragraphs {
                out.entry(paragraph_signature(&p.text))
                    .or_default()
                    .push(p.block_id.clone());
            }
            walk(&s.children, out);
        }
    }
    let mut out = HashMap::new();
    walk(prev, &mut out);
    out
}

/// Set of v2 `block_id`s that came from Claude-echoed sidecars (i.e., are not
/// in the `injections` minted-id list). Those must never be overwritten and
/// must never be adopted from v1, since the v1 id may differ from what
/// Claude correctly preserved.
fn collect_claimed_v2_ids(
    sections: &[Section],
    minted: &HashSet<String>,
) -> HashSet<String> {
    fn walk(secs: &[Section], minted: &HashSet<String>, out: &mut HashSet<String>) {
        for s in secs {
            if !minted.contains(&s.block_id) {
                out.insert(s.block_id.clone());
            }
            for p in &s.paragraphs {
                if !minted.contains(&p.block_id) {
                    out.insert(p.block_id.clone());
                }
            }
            walk(&s.children, minted, out);
        }
    }
    let mut out = HashSet::new();
    walk(sections, minted, &mut out);
    out
}

fn rebind_block_ids(
    prev_sections: &[Section],
    new_sections: &mut [Section],
    injections: &mut [(usize, String)],
) {
    if prev_sections.is_empty() || injections.is_empty() {
        return;
    }
    let prev_index = collect_prev_signature_index(prev_sections);
    let minted: HashSet<String> = injections.iter().map(|(_, id)| id.clone()).collect();
    let claimed_v2 = collect_claimed_v2_ids(new_sections, &minted);
    let mut consumed: HashSet<String> = HashSet::new();
    walk_rebind(
        new_sections,
        &prev_index,
        &claimed_v2,
        &minted,
        &mut consumed,
        injections,
    );
    // Second pass: positional fallback for paragraphs whose text changed
    // (signature match failed) but whose containing section's id is preserved
    // — either because Claude echoed the heading's sidecar or because the
    // first pass rebound it via heading signature. Without this, the
    // canonical Bug 2 case (an edit on a previously-edited paragraph) leaves
    // the paragraph with a fresh id; the diff falls back to anchor-id keying,
    // which is brittle if any sibling block was added/removed.
    rebind_paragraphs_by_ordinal(
        prev_sections,
        new_sections,
        &minted,
        &claimed_v2,
        &mut consumed,
        injections,
    );
}

/// Index v2 sections by their `block_id` for the positional-fallback pass.
/// After the signature pass, any v2 section whose id matches a v3 section's
/// id (echoed sidecar or signature-rebound heading) is a stable anchor —
/// inside it we can match paragraphs by ordinal without risking a
/// cross-section confusion.
fn collect_prev_sections_by_block_id(prev: &[Section]) -> HashMap<String, &Section> {
    fn walk<'a>(secs: &'a [Section], out: &mut HashMap<String, &'a Section>) {
        for s in secs {
            out.insert(s.block_id.clone(), s);
            walk(&s.children, out);
        }
    }
    let mut out = HashMap::new();
    walk(prev, &mut out);
    out
}

fn rebind_paragraphs_by_ordinal(
    prev_sections: &[Section],
    new_sections: &mut [Section],
    minted: &HashSet<String>,
    claimed_v2: &HashSet<String>,
    consumed: &mut HashSet<String>,
    injections: &mut [(usize, String)],
) {
    let prev_index = collect_prev_sections_by_block_id(prev_sections);
    walk_positional(new_sections, &prev_index, minted, claimed_v2, consumed, injections);
}

fn walk_positional(
    new_secs: &mut [Section],
    prev_index: &HashMap<String, &Section>,
    minted: &HashSet<String>,
    claimed_v2: &HashSet<String>,
    consumed: &mut HashSet<String>,
    injections: &mut [(usize, String)],
) {
    for s in new_secs {
        if let Some(prev_s) = prev_index.get(&s.block_id) {
            // Same logical section AND same paragraph count: a section whose
            // structure is unchanged but one or more paragraphs were
            // reworded. Zip paragraphs by ordinal. We require length equality
            // to avoid misaligned guesses when Claude added or removed a
            // sibling block (those land under the anchor-id fallback in the
            // frontend diff, where they're at least correctly *positional*).
            if s.paragraphs.len() == prev_s.paragraphs.len() {
                for (i, p) in s.paragraphs.iter_mut().enumerate() {
                    if !minted.contains(&p.block_id) {
                        continue;
                    }
                    let prev_p = &prev_s.paragraphs[i];
                    if claimed_v2.contains(&prev_p.block_id)
                        || consumed.contains(&prev_p.block_id)
                    {
                        continue;
                    }
                    let old_id = p.block_id.clone();
                    consumed.insert(prev_p.block_id.clone());
                    for entry in injections.iter_mut() {
                        if entry.1 == old_id {
                            entry.1 = prev_p.block_id.clone();
                            break;
                        }
                    }
                    p.block_id = prev_p.block_id.clone();
                }
            }
        }
        walk_positional(
            &mut s.children,
            prev_index,
            minted,
            claimed_v2,
            consumed,
            injections,
        );
    }
}

fn walk_rebind(
    secs: &mut [Section],
    prev_index: &HashMap<String, Vec<String>>,
    claimed_v2: &HashSet<String>,
    minted: &HashSet<String>,
    consumed: &mut HashSet<String>,
    injections: &mut [(usize, String)],
) {
    for s in secs {
        if minted.contains(&s.block_id) {
            if let Some(new_id) = pick_rebind_target(
                &s.block_id,
                &heading_signature(s.level, &s.title),
                prev_index,
                claimed_v2,
                consumed,
                injections,
            ) {
                s.block_id = new_id;
            }
        }
        for p in &mut s.paragraphs {
            if minted.contains(&p.block_id) {
                if let Some(new_id) = pick_rebind_target(
                    &p.block_id,
                    &paragraph_signature(&p.text),
                    prev_index,
                    claimed_v2,
                    consumed,
                    injections,
                ) {
                    p.block_id = new_id;
                }
            }
        }
        walk_rebind(
            &mut s.children,
            prev_index,
            claimed_v2,
            minted,
            consumed,
            injections,
        );
    }
}

/// If `signature` has exactly one v1 candidate that is neither claimed by a
/// surviving v2 sidecar nor already consumed by an earlier rebind, return it
/// and (a) splice the id swap into `injections` so the persisted markdown
/// carries the adopted id, and (b) mark the v1 id consumed.
fn pick_rebind_target(
    old_id: &str,
    signature: &str,
    prev_index: &HashMap<String, Vec<String>>,
    claimed_v2: &HashSet<String>,
    consumed: &mut HashSet<String>,
    injections: &mut [(usize, String)],
) -> Option<String> {
    let candidates = prev_index.get(signature)?;
    let mut available = candidates
        .iter()
        .filter(|id| !claimed_v2.contains(*id) && !consumed.contains(*id));
    let first = available.next()?;
    if available.next().is_some() {
        // Ambiguous match — leave the freshly minted id alone.
        return None;
    }
    let new_id = first.clone();
    consumed.insert(new_id.clone());
    for entry in injections.iter_mut() {
        if entry.1 == old_id {
            entry.1 = new_id.clone();
            break;
        }
    }
    Some(new_id)
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

/// Remove only the injected `<!-- rl:blk-… -->` sidecar lines, leaving every
/// other byte intact — including the trailing newline. The read side of the
/// `apply_injections` contract, used to export human-facing clean markdown;
/// mirrors the JS `stripSidecars` in `src/editor/markdown/sidecar.ts`.
pub fn strip_sidecar_lines(md: &str) -> String {
    md.split('\n')
        .filter(|l| {
            let t = l.trim();
            !(t.starts_with("<!-- rl:blk-") && t.ends_with("-->"))
        })
        .collect::<Vec<_>>()
        .join("\n")
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

/// Canonical plain-text "signature" of a plan, used by the Ask round-trip
/// detector to decide whether Claude's re-emitted plan body is meaningfully
/// the same as the prior revision. Walks the section tree in order,
/// folding in heading level + title + each paragraph's plain text. Two
/// plans with identical content but different sidecar stamps or cosmetic
/// markdown reflows produce equal signatures; any real wording change
/// breaks them apart.
pub fn plan_text_signature(sections: &[Section]) -> String {
    fn walk(secs: &[Section], out: &mut String) {
        for s in secs {
            out.push_str(&format!("h{} {}\n", s.level, s.title.trim()));
            for p in &s.paragraphs {
                out.push_str(p.text.trim());
                out.push('\n');
            }
            walk(&s.children, out);
        }
    }
    let mut out = String::new();
    walk(sections, &mut out);
    out.trim_end().to_string()
}

/// Plain-text rendering of a block's markdown, used for revision diffing so
/// cosmetic markdown reflows don't read as content changes.
pub fn block_plain_text(md: &str) -> String {
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
    fn strip_sidecar_lines_removes_sidecars_and_keeps_trailing_newline() {
        // A parser-augmented plan carries a sidecar before every block;
        // stripping them yields back the exact original bytes.
        let md = "# Title\n\nA paragraph.\n";
        let (_s, augmented) = parse_plan_with_sidecars(md);
        assert!(augmented.contains("<!-- rl:blk-"));
        assert_eq!(strip_sidecar_lines(&augmented), md);
        // Indented sidecars are matched too; the trailing newline is kept.
        assert_eq!(
            strip_sidecar_lines("  <!-- rl:blk-abc123 -->\nkept\n"),
            "kept\n"
        );
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

    #[test]
    fn plan_text_signature_ignores_cosmetic_reflow() {
        // Sidecar stamps and an extra blank line are cosmetic and must not
        // register as a content change for Ask round-trip detection.
        let a = parse_plan("# Alpha\n\nIntro paragraph.\n\n# Beta\n\nBeta body.\n");
        let stamped = parse_plan_with_sidecars(
            "# Alpha\n\nIntro paragraph.\n\n# Beta\n\nBeta body.\n",
        )
        .0;
        let with_extra_blank = parse_plan(
            "# Alpha\n\n\nIntro paragraph.\n\n# Beta\n\nBeta body.\n",
        );
        assert_eq!(plan_text_signature(&a), plan_text_signature(&stamped));
        assert_eq!(plan_text_signature(&a), plan_text_signature(&with_extra_blank));
    }

    #[test]
    fn plan_text_signature_detects_reworded_paragraph() {
        let a = parse_plan("# Alpha\n\nIntro paragraph.\n");
        let b = parse_plan("# Alpha\n\nRefined intro paragraph.\n");
        assert_ne!(plan_text_signature(&a), plan_text_signature(&b));
    }

    #[test]
    fn plan_text_signature_detects_heading_change() {
        let a = parse_plan("# Alpha\n\nbody.\n");
        let b = parse_plan("# Beta\n\nbody.\n");
        assert_ne!(plan_text_signature(&a), plan_text_signature(&b));
    }

    #[test]
    fn plan_text_signature_detects_added_section() {
        let a = parse_plan("# Alpha\n\nbody.\n");
        let b = parse_plan("# Alpha\n\nbody.\n\n# Beta\n\nmore.\n");
        assert_ne!(plan_text_signature(&a), plan_text_signature(&b));
    }

    /// The 100%-highlighted bug: Claude returns v2 without sidecars; without
    /// rebinding every block in v2 gets a fresh id and the diff paints the
    /// whole plan as added/modified. With rebinding, unchanged blocks must
    /// adopt their v1 ids verbatim.
    #[test]
    fn rebind_recovers_unchanged_ids_when_sidecars_are_dropped() {
        let v1_md = "# Alpha\n\nIntro paragraph.\n\n# Beta\n\nBeta body.\n";
        let (v1_sections, _) = parse_plan_with_sidecars(v1_md);
        let v1_ids = flatten_block_ids(&v1_sections);

        // Simulate Claude dropping every sidecar in the response.
        let v2_md_no_markers = "# Alpha\n\nIntro paragraph.\n\n# Beta\n\nBeta body.\n";
        let (v2_sections, v2_md_augmented) =
            parse_plan_with_sidecars_relative_to(v2_md_no_markers, &v1_sections);
        let v2_ids = flatten_block_ids(&v2_sections);

        // Every id is recovered from v1.
        assert_eq!(v1_ids, v2_ids);
        // The persisted markdown now carries the adopted ids so the
        // reparse-on-load path yields stable identity.
        for id in &v1_ids {
            assert!(
                v2_md_augmented.contains(&format!("<!-- rl:{id} -->")),
                "rebound id {id} missing from augmented markdown"
            );
        }
    }

    /// Heading + every paragraph in a structurally-unchanged section keep
    /// their v1 ids — including paragraphs Claude reworded. The unchanged
    /// paragraph matches via signature; the reworded paragraph matches via
    /// the positional fallback (same ordinal in the same section, equal
    /// paragraph count). This is what makes Bug 2's "edit on a previously-
    /// edited block" surface as a redline rather than as a phantom add.
    #[test]
    fn rebind_keeps_v1_ids_for_unchanged_blocks_only() {
        let v1_md = "# Plan\n\nIntro paragraph.\n\nSecond paragraph.\n";
        let (v1_sections, _) = parse_plan_with_sidecars(v1_md);
        let v1_heading_id = v1_sections[0].block_id.clone();
        let v1_p1_id = v1_sections[0].paragraphs[0].block_id.clone();
        let v1_p2_id = v1_sections[0].paragraphs[1].block_id.clone();

        // Claude reworded the first paragraph, kept the second.
        let v2_md = "# Plan\n\nRefined intro paragraph.\n\nSecond paragraph.\n";
        let (v2_sections, _) =
            parse_plan_with_sidecars_relative_to(v2_md, &v1_sections);

        // Heading is unchanged → adopt v1 id (signature pass).
        assert_eq!(v2_sections[0].block_id, v1_heading_id);
        // Unchanged paragraph adopts via signature pass.
        assert_eq!(v2_sections[0].paragraphs[1].block_id, v1_p2_id);
        // Reworded paragraph adopts via positional fallback (section
        // unchanged, paragraph count equal).
        assert_eq!(v2_sections[0].paragraphs[0].block_id, v1_p1_id);
    }

    /// A v2 sidecar Claude correctly echoed must never be overwritten, and the
    /// id it points at must not be stolen for a minted block elsewhere.
    #[test]
    fn rebind_never_overwrites_a_preserved_sidecar() {
        let v1_md = "# Plan\n\nFirst.\n\nSecond.\n";
        let (v1_sections, _) = parse_plan_with_sidecars(v1_md);
        let v1_p1_id = v1_sections[0].paragraphs[0].block_id.clone();

        // v2: Claude preserved the first paragraph's sidecar but dropped the
        // others. The minted blocks must NOT adopt `v1_p1_id` even if their
        // signature would otherwise match.
        let v2_md = format!(
            "# Plan\n\n<!-- rl:{v1_p1_id} -->\nFirst.\n\nSecond.\n"
        );
        let (v2_sections, _) =
            parse_plan_with_sidecars_relative_to(&v2_md, &v1_sections);

        // Preserved paragraph keeps the echoed id (claimed_v2 protects it).
        assert_eq!(v2_sections[0].paragraphs[0].block_id, v1_p1_id);
        // The other paragraph either picks up its own v1 id ("Second.") or
        // a fresh one — never the claimed `v1_p1_id`.
        assert_ne!(v2_sections[0].paragraphs[1].block_id, v1_p1_id);
    }

    /// When v1 has duplicate paragraph text, a single matching v2 minted
    /// block must NOT pick one arbitrarily — that would be a guess.
    #[test]
    fn rebind_skips_ambiguous_matches() {
        let v1_md = "# Plan\n\nTODO\n\nTODO\n";
        let (v1_sections, _) = parse_plan_with_sidecars(v1_md);

        let v2_md = "# Plan\n\nTODO\n\nNEW LINE\n\nTODO\n";
        let (v2_sections, _) =
            parse_plan_with_sidecars_relative_to(v2_md, &v1_sections);

        // The "TODO" v2 paragraphs both match v1's two "TODO" entries
        // ambiguously — neither gets rebound.
        let v1_ids: HashSet<String> = flatten_block_ids(&v1_sections).into_iter().collect();
        for p in &v2_sections[0].paragraphs {
            if p.text == "TODO" {
                assert!(
                    !v1_ids.contains(&p.block_id),
                    "ambiguous TODO paragraph must NOT adopt a v1 id"
                );
            }
        }
    }

    /// Bug 2 canonical case: a paragraph's text changed between revisions but
    /// its containing section is unchanged. The signature pass can't match
    /// (text differs), but the positional fallback adopts the v_{n-1} id by
    /// ordinal so the frontend diff keys correctly via `prevByBlock` and the
    /// revision redline renders.
    #[test]
    fn rebind_positional_fallback_adopts_id_when_only_text_changed() {
        let v1_md = "# Plan\n\nFirst paragraph.\n\nSecond paragraph.\n";
        let (v1_sections, _) = parse_plan_with_sidecars(v1_md);
        let v1_p1_id = v1_sections[0].paragraphs[0].block_id.clone();
        let v1_p2_id = v1_sections[0].paragraphs[1].block_id.clone();

        // Claude reworded the first paragraph AND dropped every sidecar.
        let v2_md = "# Plan\n\nRefined first paragraph.\n\nSecond paragraph.\n";
        let (v2_sections, v2_augmented) =
            parse_plan_with_sidecars_relative_to(v2_md, &v1_sections);

        // Signature pass rebinds the unchanged paragraph.
        assert_eq!(v2_sections[0].paragraphs[1].block_id, v1_p2_id);
        // Positional fallback rebinds the reworded paragraph by ordinal.
        assert_eq!(v2_sections[0].paragraphs[0].block_id, v1_p1_id);
        // The persisted markdown carries the adopted id (so the reparse path
        // yields stable identity).
        assert!(
            v2_augmented.contains(&format!("<!-- rl:{v1_p1_id} -->")),
            "positional-rebound id {v1_p1_id} missing from augmented markdown"
        );
    }

    /// The positional fallback must NOT apply when the section's paragraph
    /// count differs from v_{n-1} (Claude added or removed a sibling) — a
    /// blind ordinal zip would silently miscredit a fresh paragraph with the
    /// id of an adjacent unrelated block.
    #[test]
    fn rebind_positional_fallback_skipped_on_length_mismatch() {
        let v1_md = "# Plan\n\nOriginal A.\n\nOriginal B.\n";
        let (v1_sections, _) = parse_plan_with_sidecars(v1_md);
        let v1_a_id = v1_sections[0].paragraphs[0].block_id.clone();
        let v1_b_id = v1_sections[0].paragraphs[1].block_id.clone();

        // Claude added a third paragraph AND reworded the first.
        let v2_md =
            "# Plan\n\nReworded A.\n\nA brand new middle paragraph.\n\nOriginal B.\n";
        let (v2_sections, _) =
            parse_plan_with_sidecars_relative_to(v2_md, &v1_sections);

        // Length differs (3 vs 2) → positional skipped. Only the signature
        // pass applies: "Original B." matches → rebound; the reworded first
        // and the new middle each receive fresh ids — never v1's stale ids.
        assert_eq!(v2_sections[0].paragraphs[2].block_id, v1_b_id);
        for (i, p) in v2_sections[0].paragraphs.iter().enumerate() {
            if i == 2 {
                continue;
            }
            assert_ne!(
                p.block_id, v1_a_id,
                "length-mismatched paragraph must not adopt v1 id by position"
            );
            assert_ne!(p.block_id, v1_b_id);
        }
    }

    /// The positional fallback must respect `claimed_v2`: when Claude echoed
    /// a sidecar that already claims a v_{n-1} id at the SAME ordinal, the
    /// positional pass must not double-claim that id for a sibling.
    #[test]
    fn rebind_positional_fallback_respects_claimed_sidecars() {
        let v1_md = "# Plan\n\nFirst.\n\nSecond.\n";
        let (v1_sections, _) = parse_plan_with_sidecars(v1_md);
        let v1_p1_id = v1_sections[0].paragraphs[0].block_id.clone();

        // v2: Claude echoed the first paragraph's sidecar (so v1_p1_id is
        // claimed there) and reworded the second paragraph without a sidecar.
        // The positional pass at ordinal 1 must not try to adopt v1_p1_id
        // even though v3[0].block_id == v1_p1_id by direct echo.
        let v2_md = format!(
            "# Plan\n\n<!-- rl:{v1_p1_id} -->\nFirst.\n\nReworded second.\n"
        );
        let (v2_sections, _) =
            parse_plan_with_sidecars_relative_to(&v2_md, &v1_sections);

        // Echoed sidecar keeps its id.
        assert_eq!(v2_sections[0].paragraphs[0].block_id, v1_p1_id);
        // The reworded second adopts v1's second-paragraph id (signature pass
        // didn't match — text differs — but positional did, since lengths
        // are equal and v1_p1_id is claimed elsewhere so it stays available
        // for ordinal 1 only via "Second."'s own id).
        assert_ne!(v2_sections[0].paragraphs[1].block_id, v1_p1_id);
    }

    /// Empty prev_sections (fresh thread, no prior revision) is a no-op:
    /// every block gets a freshly minted id, identical to plain
    /// `parse_plan_with_sidecars`.
    #[test]
    fn rebind_is_noop_when_no_previous_revision() {
        let md = "# Plan\n\nIntro.\n\nSecond.\n";
        let (with_prev, _) = parse_plan_with_sidecars_relative_to(md, &[]);
        let (without_prev, _) = parse_plan_with_sidecars(md);
        // Both should have the same shape and freshly-minted ids (different
        // uuids, of course, but the structure is identical).
        assert_eq!(with_prev.len(), without_prev.len());
        assert_eq!(
            with_prev[0].paragraphs.len(),
            without_prev[0].paragraphs.len()
        );
    }
}
