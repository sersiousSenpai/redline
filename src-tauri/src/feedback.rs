use std::collections::HashMap;
use std::fmt::Write;

use crate::state::{Comment, CommentKind, Section};

pub fn serialize_feedback_payload(sections: &[Section], comments: &[Comment]) -> String {
    let anchors = flatten_anchors(sections);
    let order: HashMap<String, usize> = anchors
        .iter()
        .enumerate()
        .map(|(i, (a, _))| (a.clone(), i))
        .collect();

    let mut sorted: Vec<&Comment> = comments.iter().collect();
    sorted.sort_by_key(|c| anchor_order_key(&c.anchor_id, &order));

    let mut out = String::new();
    out.push_str(
        "The user reviewed your plan in Redline and has requested revisions.\n\n",
    );

    out.push_str("ORIGINAL PLAN ANCHORS (for reference):\n");
    for (anchor, title) in &anchors {
        let _ = writeln!(out, "- §{}: {}", anchor, title);
    }
    out.push('\n');

    out.push_str("FEEDBACK:\n\n");
    for c in &sorted {
        write_comment_block(&mut out, c);
    }

    out.push_str("REQUIRED RESPONSE FORMAT:\n\n");
    out.push_str(
        "Produce plan v2 incorporating the edits above and addressing the feedback. \
         When you call ExitPlanMode again, include a resolution block at the top of the plan \
         in this exact format:\n\n",
    );
    out.push_str("<!-- REDLINE_RESOLUTIONS\n{\n");
    let n = sorted.len();
    for (i, c) in sorted.iter().enumerate() {
        let comma = if i + 1 < n { "," } else { "" };
        let _ = writeln!(
            out,
            "  \"{}\": \"<your resolution for this comment>\"{}",
            c.id, comma
        );
    }
    out.push_str("}\n-->\n\n");
    out.push_str(
        "Each comment_id from the FEEDBACK section above MUST appear as a key in the resolution \
         block. Do not skip any.\n",
    );

    out
}

fn flatten_anchors(sections: &[Section]) -> Vec<(String, String)> {
    fn walk(secs: &[Section], out: &mut Vec<(String, String)>) {
        for s in secs {
            out.push((s.anchor_id.clone(), s.title.clone()));
            walk(&s.children, out);
        }
    }
    let mut out = Vec::new();
    walk(sections, &mut out);
    out
}

fn anchor_order_key(anchor: &str, order: &HashMap<String, usize>) -> (usize, usize) {
    if let Some(idx) = order.get(anchor) {
        return (*idx, 0);
    }
    if let Some(dot_p) = anchor.rfind(".p") {
        let section = &anchor[..dot_p];
        let pn: usize = anchor[dot_p + 2..].parse().unwrap_or(0);
        if let Some(idx) = order.get(section) {
            return (*idx, pn);
        }
    }
    (usize::MAX, 0)
}

fn write_comment_block(out: &mut String, c: &Comment) {
    let header = display_anchor(&c.anchor_id);
    match c.kind {
        CommentKind::Edit => {
            let _ = writeln!(out, "{} [edit, local]", header);
            if let Some(e) = &c.edit {
                let _ = writeln!(out, "  ORIGINAL: {}", quoted(&e.original));
                let _ = writeln!(out, "  REVISED:  {}", quoted(&e.revised));
            }
            if !c.body.is_empty() && c.body.trim() != "(edit)" {
                let _ = writeln!(out, "  NOTE: {}", quoted(&c.body));
            }
            let _ = writeln!(out, "  COMMENT_ID: {}", c.id);
            out.push('\n');
        }
        CommentKind::Feedback => {
            let scope = c
                .scope
                .map(|s| s.as_str())
                .unwrap_or("local");
            let _ = writeln!(out, "{} [feedback, {}]", header, scope);
            out.push_str("  USER COMMENT (verbatim):\n");
            out.push_str("    ");
            out.push_str(&indent(c.body.trim(), "    "));
            out.push('\n');
            let _ = writeln!(out, "  COMMENT_ID: {}", c.id);
            out.push('\n');
        }
        CommentKind::Question => {
            let _ = writeln!(out, "{} [question]", header);
            out.push_str("  USER COMMENT (verbatim):\n");
            out.push_str("    ");
            out.push_str(&indent(c.body.trim(), "    "));
            out.push('\n');
            let _ = writeln!(out, "  COMMENT_ID: {}", c.id);
            out.push('\n');
        }
    }
}

fn display_anchor(anchor: &str) -> String {
    if let Some(dot_p) = anchor.rfind(".p") {
        let section = &anchor[..dot_p];
        let pn = &anchor[dot_p + 2..];
        return format!("§{} ¶{}", section, pn);
    }
    format!("§{}", anchor)
}

fn quoted(s: &str) -> String {
    let cleaned = s.replace('\n', " ");
    let escaped = cleaned.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{}\"", escaped)
}

fn indent(s: &str, prefix: &str) -> String {
    s.lines().collect::<Vec<_>>().join(&format!("\n{}", prefix))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::parse_plan;
    use crate::state::{Comment, CommentKind, CommentScope, CommentStatus, EditPayload};

    fn mk_comment(
        id: &str,
        kind: CommentKind,
        anchor: &str,
        body: &str,
        scope: Option<CommentScope>,
        edit: Option<EditPayload>,
    ) -> Comment {
        Comment {
            id: id.to_string(),
            kind,
            scope,
            anchor_id: anchor.to_string(),
            body: body.to_string(),
            edit,
            created_at: 0,
            status: CommentStatus::Submitted,
            resolution: None,
        }
    }

    #[test]
    fn serializes_basic_payload() {
        let sections = parse_plan("# Alpha\n\nIntro paragraph.\n\n## Sub\n\nSub body.\n\n# Beta\n\nBeta body.\n");
        let comments = vec![
            mk_comment(
                "c-001",
                CommentKind::Edit,
                "A.p1",
                "(edit)",
                None,
                Some(EditPayload {
                    original: "Intro paragraph.".to_string(),
                    revised: "Refined intro paragraph.".to_string(),
                }),
            ),
            mk_comment(
                "c-002",
                CommentKind::Feedback,
                "A.1",
                "Rethink the threat model here.",
                Some(CommentScope::Structural),
                None,
            ),
            mk_comment(
                "c-003",
                CommentKind::Question,
                "B",
                "Why is this last?",
                None,
                None,
            ),
        ];

        let payload = serialize_feedback_payload(&sections, &comments);
        assert!(payload.starts_with("The user reviewed your plan in Redline"));
        assert!(payload.contains("ORIGINAL PLAN ANCHORS (for reference):"));
        assert!(payload.contains("- §A: Alpha"));
        assert!(payload.contains("- §A.1: Sub"));
        assert!(payload.contains("- §B: Beta"));
        assert!(payload.contains("§A ¶1 [edit, local]"));
        assert!(payload.contains("ORIGINAL: \"Intro paragraph.\""));
        assert!(payload.contains("REVISED:  \"Refined intro paragraph.\""));
        assert!(payload.contains("§A.1 [feedback, structural]"));
        assert!(payload.contains("Rethink the threat model here."));
        assert!(payload.contains("§B [question]"));
        assert!(payload.contains("REDLINE_RESOLUTIONS"));
        assert!(payload.contains("\"c-001\":"));
        assert!(payload.contains("\"c-002\":"));
        assert!(payload.contains("\"c-003\":"));
        assert!(payload.contains("MUST appear as a key in the resolution block"));
    }

    #[test]
    fn comments_ordered_by_anchor_position() {
        let sections = parse_plan("# A\n\nfirst.\n\nsecond.\n\n# B\n\nbody.\n");
        let comments = vec![
            mk_comment("c-001", CommentKind::Question, "B", "q", None, None),
            mk_comment("c-002", CommentKind::Question, "A.p2", "q", None, None),
            mk_comment("c-003", CommentKind::Question, "A.p1", "q", None, None),
        ];
        let payload = serialize_feedback_payload(&sections, &comments);
        let p1 = payload.find("§A ¶1 [question]").expect("A.p1");
        let p2 = payload.find("§A ¶2 [question]").expect("A.p2");
        let b = payload.find("§B [question]").expect("B");
        assert!(p1 < p2);
        assert!(p2 < b);
    }

    #[test]
    fn escapes_quotes_in_edit_text() {
        let sections = parse_plan("# A\n\nparagraph.\n");
        let comments = vec![mk_comment(
            "c-001",
            CommentKind::Edit,
            "A.p1",
            "(edit)",
            None,
            Some(EditPayload {
                original: "He said \"hi\".".to_string(),
                revised: "He said \"hello\".".to_string(),
            }),
        )];
        let payload = serialize_feedback_payload(&sections, &comments);
        assert!(payload.contains("ORIGINAL: \"He said \\\"hi\\\".\""));
        assert!(payload.contains("REVISED:  \"He said \\\"hello\\\".\""));
    }
}
