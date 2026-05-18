import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { ParagraphDiff } from "../diff";
import type {
  Comment,
  NewCommentRequest,
  Paragraph,
  Section,
  UpdateCommentRequest,
} from "../types";
import type { BaseBlock } from "../editor/changeLedger";
import { applyCommentsToDoc } from "../editor/applyCommentsToDoc";
import { useTrackChangesSync } from "../editor/useTrackChangesSync";
import { AnchorPill } from "./AnchorPill";
import { EditableBlock, type RegisteredHandle } from "./EditableBlock";

interface DocumentProps {
  sections: Section[];
  diff?: ParagraphDiff;
  comments?: Comment[];
  /** Changes when a new revision arrives → remounts every block. */
  revisionKey: string;
  onAddComment?: (req: NewCommentRequest) => Promise<unknown>;
  onUpdateComment?: (id: string, u: UpdateCommentRequest) => Promise<unknown>;
  onDeleteComment?: (id: string) => Promise<unknown>;
}

/** A block is "structured" (list/table/code/etc.) when its rich markdown
 *  differs from its plain-text rendering — editing it captures plain text. */
function isStructured(p: Paragraph): boolean {
  return p.markdown.trim() !== p.text.trim();
}

function countEditable(sections: Section[]): number {
  let n = 0;
  const walk = (secs: Section[]) => {
    for (const s of secs) {
      n += 1; // heading title
      n += s.paragraphs.length;
      walk(s.children);
    }
  };
  walk(sections);
  return n;
}

export function Document({
  sections,
  diff,
  comments,
  revisionKey,
  onAddComment,
  onUpdateComment,
  onDeleteComment,
}: DocumentProps) {
  const commentedAnchors = useMemo(() => {
    const set = new Set<string>();
    for (const c of comments ?? []) {
      if (c.status !== "withdrawn") set.add(c.anchorId);
    }
    return set;
  }, [comments]);

  // Block handles register themselves on mount; their captured baseline
  // (initial innerText) is the authoritative diff/revert basis, so an
  // untouched block never reads as edited.
  const registry = useRef(new Map<string, RegisteredHandle>());
  const [baseTick, setBaseTick] = useState(0);

  const register = useCallback((h: RegisteredHandle) => {
    registry.current.set(h.blockId, h);
    setBaseTick((t) => t + 1);
  }, []);
  const unregister = useCallback((blockId: string) => {
    registry.current.delete(blockId);
    setBaseTick((t) => t + 1);
  }, []);

  const base = useMemo<BaseBlock[]>(
    () =>
      [...registry.current.values()].map((h) => ({
        blockId: h.blockId,
        anchorId: h.anchorId,
        markdown: h.baseline,
      })),
    [baseTick, revisionKey],
  );

  const expected = useMemo(() => countEditable(sections), [sections]);
  const editable =
    !!onAddComment && !!onUpdateComment && !!onDeleteComment;
  const enabled =
    editable && base.length > 0 && base.length === expected;

  const backend = useMemo(
    () => ({
      addComment: (req: NewCommentRequest) =>
        onAddComment?.(req) ?? Promise.resolve(),
      updateComment: (id: string, u: UpdateCommentRequest) =>
        onUpdateComment?.(id, u) ?? Promise.resolve(),
      deleteComment: (id: string) =>
        onDeleteComment?.(id) ?? Promise.resolve(),
    }),
    [onAddComment, onUpdateComment, onDeleteComment],
  );

  const readCurrent = useCallback(
    () =>
      [...registry.current.values()].map((h) => ({
        blockId: h.blockId,
        anchorId: h.anchorId,
        markdown: h.getMarkdown(),
      })),
    [],
  );

  const { schedule } = useTrackChangesSync({
    base,
    comments: comments ?? [],
    backend,
    readCurrent,
    enabled,
  });

  // Sidebar → document reconcile (idempotent, focus/structure-guarded inside
  // each handle's setMarkdown). Runs on comment changes and as blocks mount.
  useEffect(() => {
    if (!editable) return;
    const baseMap = new Map(base.map((b) => [b.blockId, b.markdown]));
    applyCommentsToDoc(comments ?? [], [...registry.current.values()], baseMap);
  }, [comments, base, editable]);

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
          revisionKey={revisionKey}
          editable={editable}
          register={register}
          unregister={unregister}
          onInput={schedule}
        />
      ))}
    </article>
  );
}

interface BlockWiring {
  revisionKey: string;
  editable: boolean;
  register: (h: RegisteredHandle) => void;
  unregister: (blockId: string) => void;
  onInput: () => void;
}

function SectionView({
  section,
  diff,
  commentedAnchors,
  ...wiring
}: {
  section: Section;
  diff?: ParagraphDiff;
  commentedAnchors: Set<string>;
} & BlockWiring) {
  return (
    <section className="mb-8" data-anchor-id={section.anchorId}>
      <Heading
        section={section}
        hasComment={commentedAnchors.has(section.anchorId)}
        {...wiring}
      />
      {section.paragraphs.map((p) => (
        <ParagraphView
          key={`${wiring.revisionKey}:${p.blockId}`}
          paragraph={p}
          diff={diff}
          hasComment={commentedAnchors.has(p.anchorId)}
          {...wiring}
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
              {...wiring}
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
  editable,
  register,
  unregister,
  onInput,
}: {
  paragraph: Paragraph;
  diff?: ParagraphDiff;
  hasComment: boolean;
} & BlockWiring) {
  const info = diff?.get(paragraph.anchorId);
  const isAdded = info?.status === "added";
  const isModified = info?.status === "modified";
  const isMoved = info?.status === "moved";

  const blockStyle: React.CSSProperties = {};
  if (isMoved) {
    blockStyle.borderLeft = "2px dashed var(--color-info)";
    blockStyle.paddingLeft = "8px";
    blockStyle.marginLeft = "-10px";
  }
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
        contentEditable={false}
        aria-hidden
      >
        <AnchorPill anchorId={paragraph.anchorId} />
      </span>
      <div className="flex-1">
        {isModified && info?.originalText && (
          <span
            className="line-through block mb-1"
            style={{ color: "var(--color-ink-muted)" }}
          >
            {info.originalText}
          </span>
        )}
        {editable ? (
          <EditableBlock
            blockId={paragraph.blockId}
            anchorId={paragraph.anchorId}
            sourceMarkdown={paragraph.markdown}
            structured={isStructured(paragraph)}
            hasComment={hasComment}
            register={register}
            unregister={unregister}
            onInput={onInput}
          />
        ) : (
          <ReadOnlyBlock markdown={paragraph.markdown} hasComment={hasComment} />
        )}
      </div>
    </div>
  );
}

// Read-only fallback (no comment backend wired) — the original
// ReactMarkdown render, byte-identical to the editable surface's mount HTML.
function ReadOnlyBlock({
  markdown,
  hasComment,
}: {
  markdown: string;
  hasComment: boolean;
}) {
  return (
    <div className={`md-block${hasComment ? " md-commented" : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
    </div>
  );
}

function Heading({
  section,
  hasComment,
  revisionKey,
  editable,
  register,
  unregister,
  onInput,
}: {
  section: Section;
  hasComment: boolean;
} & BlockWiring) {
  const { anchorId, title, level, blockId } = section;
  const sharedClass = `flex items-baseline gap-3 mt-6 mb-3 font-serif font-semibold${
    hasComment ? " md-commented" : ""
  }`;
  const inner = (
    <>
      <AnchorPill anchorId={anchorId} />
      {editable ? (
        <HeadingTitle
          key={`${revisionKey}:${blockId}`}
          blockId={blockId}
          anchorId={anchorId}
          title={title}
          register={register}
          unregister={unregister}
          onInput={onInput}
        />
      ) : (
        <span>{title}</span>
      )}
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

// Editable heading title — plain serif text (no markdown), same registry
// mechanism as EditableBlock.
function HeadingTitle({
  blockId,
  anchorId,
  title,
  register,
  unregister,
  onInput,
}: {
  blockId: string;
  anchorId: string;
  title: string;
} & Pick<BlockWiring, "register" | "unregister" | "onInput">) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const baseline = el.innerText;
    register({
      blockId,
      anchorId,
      baseline,
      getMarkdown: () => ref.current?.innerText ?? baseline,
      setMarkdown: (md) => {
        const node = ref.current;
        if (!node) return;
        if (document.activeElement === node) return;
        if (node.innerText === md) return;
        node.innerText = md;
      },
    });
    return () => unregister(blockId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockId]);
  return (
    <span
      ref={ref}
      role="textbox"
      aria-label={`Edit heading ${anchorId}`}
      tabIndex={0}
      contentEditable
      suppressContentEditableWarning
      spellCheck
      onInput={onInput}
      onBlur={onInput}
    >
      {title}
    </span>
  );
}
