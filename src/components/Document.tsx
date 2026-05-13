import type { ParagraphDiff } from "../diff";
import type { Paragraph, Section } from "../types";
import { AnchorPill } from "./AnchorPill";

interface DocumentProps {
  sections: Section[];
  diff?: ParagraphDiff;
}

export function Document({ sections, diff }: DocumentProps) {
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
        <SectionView key={s.anchorId} section={s} diff={diff} />
      ))}
    </article>
  );
}

function SectionView({
  section,
  diff,
}: {
  section: Section;
  diff?: ParagraphDiff;
}) {
  return (
    <section className="mb-8" data-anchor-id={section.anchorId}>
      <Heading section={section} />
      {section.paragraphs.map((p) => (
        <ParagraphView key={p.anchorId} paragraph={p} diff={diff} />
      ))}
      {section.children.length > 0 && (
        <div className="mt-4">
          {section.children.map((child) => (
            <SectionView key={child.anchorId} section={child} diff={diff} />
          ))}
        </div>
      )}
    </section>
  );
}

function ParagraphView({
  paragraph,
  diff,
}: {
  paragraph: Paragraph;
  diff?: ParagraphDiff;
}) {
  const info = diff?.get(paragraph.anchorId);
  const isAdded = info?.status === "added";
  const isModified = info?.status === "modified";

  return (
    <p
      className="mt-3 mb-3 group flex gap-3"
      data-anchor-id={paragraph.anchorId}
      style={
        isAdded
          ? {
              background: "rgba(21, 128, 61, 0.08)",
              borderLeft: "2px solid var(--color-success)",
              paddingLeft: "8px",
              marginLeft: "-10px",
            }
          : undefined
      }
    >
      <span
        className="shrink-0 pt-1 opacity-60 group-hover:opacity-100 transition-opacity"
        aria-hidden
      >
        <AnchorPill anchorId={paragraph.anchorId} />
      </span>
      <span className="flex-1">
        {isModified && info?.originalText ? (
          <>
            <span
              className="line-through block"
              style={{ color: "rgba(180, 35, 24, 0.7)" }}
            >
              {info.originalText}
            </span>
            <span
              className="block"
              style={{
                background: "rgba(21, 128, 61, 0.10)",
              }}
            >
              {paragraph.text}
            </span>
          </>
        ) : (
          paragraph.text
        )}
      </span>
    </p>
  );
}

function Heading({ section }: { section: Section }) {
  const { anchorId, title, level } = section;
  const sharedClass = "flex items-baseline gap-3 mt-6 mb-3";
  const inner = (
    <>
      <AnchorPill anchorId={anchorId} />
      <span>{title}</span>
    </>
  );
  switch (level) {
    case 1:
      return (
        <h1
          className={`${sharedClass} font-serif font-semibold`}
          style={{ fontSize: "26px", lineHeight: 1.2 }}
        >
          {inner}
        </h1>
      );
    case 2:
      return (
        <h2
          className={`${sharedClass} font-serif font-semibold`}
          style={{ fontSize: "20px", lineHeight: 1.25 }}
        >
          {inner}
        </h2>
      );
    case 3:
      return (
        <h3
          className={`${sharedClass} font-serif font-semibold`}
          style={{ fontSize: "16px", lineHeight: 1.3 }}
        >
          {inner}
        </h3>
      );
    default:
      return (
        <h4
          className={`${sharedClass} font-serif font-semibold`}
          style={{ fontSize: "14px", lineHeight: 1.3 }}
        >
          {inner}
        </h4>
      );
  }
}
