import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { ParagraphDiff } from "../diff";
import type { Comment, Paragraph, Section } from "../types";
import { AnchorPill } from "./AnchorPill";

interface DocumentProps {
  sections: Section[];
  diff?: ParagraphDiff;
  comments?: Comment[];
}

export function Document({ sections, diff, comments }: DocumentProps) {
  const commentedAnchors = useMemo(() => {
    const set = new Set<string>();
    for (const c of comments ?? []) {
      if (c.status !== "withdrawn") set.add(c.anchorId);
    }
    return set;
  }, [comments]);

  if (sections.length === 0) {
    return (
      <div
        className="font-sans text-sm italic"
        style={{ color: "var(--color-ink-muted)" }}
      >
        Empty plan — no headings found.
      </div>
    );
  }
  return (
    <article
      className="font-serif leading-relaxed"
      style={{ color: "var(--color-ink)", fontSize: "15px", lineHeight: 1.7 }}
    >
      {sections.map((s) => (
        <SectionView
          key={s.anchorId}
          section={s}
          diff={diff}
          commentedAnchors={commentedAnchors}
        />
      ))}
    </article>
  );
}

function SectionView({
  section,
  diff,
  commentedAnchors,
}: {
  section: Section;
  diff?: ParagraphDiff;
  commentedAnchors: Set<string>;
}) {
  return (
    <section className="mb-8" data-anchor-id={section.anchorId}>
      <Heading
        section={section}
        hasComment={commentedAnchors.has(section.anchorId)}
      />
      {section.paragraphs.map((p) => (
        <ParagraphView
          key={p.anchorId}
          paragraph={p}
          diff={diff}
          hasComment={commentedAnchors.has(p.anchorId)}
        />
      ))}
      {section.children.length > 0 && (
        <div className="mt-4">
          {section.children.map((child) => (
            <SectionView
              key={child.anchorId}
              section={child}
              diff={diff}
              commentedAnchors={commentedAnchors}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ParagraphView({
  paragraph,
  diff,
  hasComment,
}: {
  paragraph: Paragraph;
  diff?: ParagraphDiff;
  hasComment: boolean;
}) {
  const info = diff?.get(paragraph.anchorId);
  const isAdded = info?.status === "added";
  const isModified = info?.status === "modified";

  const blockStyle: React.CSSProperties = {};
  if (isAdded) {
    blockStyle.background = "color-mix(in srgb, var(--color-success) 10%, transparent)";
    blockStyle.borderLeft = "2px solid var(--color-success)";
    blockStyle.paddingLeft = "8px";
    blockStyle.marginLeft = "-10px";
  } else if (isModified) {
    blockStyle.background = "color-mix(in srgb, var(--color-warning) 10%, transparent)";
    blockStyle.borderLeft = "2px solid var(--color-warning)";
    blockStyle.paddingLeft = "8px";
    blockStyle.marginLeft = "-10px";
  }

  return (
    <div
      className="mt-3 mb-3 group flex gap-3"
      data-anchor-id={paragraph.anchorId}
      style={blockStyle}
    >
      <span
        className="shrink-0 pt-1 opacity-60 group-hover:opacity-100 transition-opacity"
        aria-hidden
      >
        <AnchorPill anchorId={paragraph.anchorId} />
      </span>
      <div className={`flex-1 md-block${hasComment ? " md-commented" : ""}`}>
        {isModified && info?.originalText && (
          <span
            className="line-through block mb-1"
            style={{ color: "var(--color-ink-muted)" }}
          >
            {info.originalText}
          </span>
        )}
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {paragraph.markdown}
        </ReactMarkdown>
      </div>
    </div>
  );
}

function Heading({
  section,
  hasComment,
}: {
  section: Section;
  hasComment: boolean;
}) {
  const { anchorId, title, level } = section;
  const sharedClass = `flex items-baseline gap-3 mt-6 mb-3 font-serif font-semibold${
    hasComment ? " md-commented" : ""
  }`;
  const inner = (
    <>
      <AnchorPill anchorId={anchorId} />
      <span>{title}</span>
    </>
  );
  switch (level) {
    case 1:
      return (
        <h1 className={sharedClass} style={{ fontSize: "26px", lineHeight: 1.2 }}>
          {inner}
        </h1>
      );
    case 2:
      return (
        <h2 className={sharedClass} style={{ fontSize: "20px", lineHeight: 1.25 }}>
          {inner}
        </h2>
      );
    case 3:
      return (
        <h3 className={sharedClass} style={{ fontSize: "16px", lineHeight: 1.3 }}>
          {inner}
        </h3>
      );
    default:
      return (
        <h4 className={sharedClass} style={{ fontSize: "14px", lineHeight: 1.3 }}>
          {inner}
        </h4>
      );
  }
}
