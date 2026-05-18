import { memo, useEffect, useMemo, useRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { BlockHandle } from "../editor/applyCommentsToDoc";

export interface RegisteredHandle extends BlockHandle {
  anchorId: string;
  /** Plain-text the user first saw — the diff/revert basis for this block. */
  baseline: string;
}

interface EditableBlockProps {
  blockId: string;
  anchorId: string;
  /** Rich markdown rendered ONCE at mount via the same ReactMarkdown
   *  pipeline the read-only view uses, so styling is byte-identical. */
  sourceMarkdown: string;
  /** list/table/code — edited as plain text, never imperatively rewritten
   *  (keeps the rich DOM; documented to flatten only on a later reload). */
  structured: boolean;
  hasComment: boolean;
  register: (h: RegisteredHandle) => void;
  unregister: (blockId: string) => void;
  onInput: () => void;
}

function EditableBlockImpl({
  blockId,
  anchorId,
  sourceMarkdown,
  structured,
  hasComment,
  register,
  unregister,
  onInput,
}: EditableBlockProps) {
  const ref = useRef<HTMLDivElement>(null);
  const baseline = useRef("");

  // Rendered once per mount. A new revision remounts the block (keyed by
  // revision in Document), which is the only time content should reset.
  const html = useMemo(
    () =>
      renderToStaticMarkup(
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {sourceMarkdown}
        </ReactMarkdown>,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [blockId],
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    baseline.current = el.innerText;
    register({
      blockId,
      anchorId,
      baseline: baseline.current,
      getMarkdown: () => ref.current?.innerText ?? baseline.current,
      setMarkdown: (md) => {
        const node = ref.current;
        if (!node) return;
        // Structured blocks keep their rich DOM (accepted limitation);
        // never fight the caret; idempotent when already equal.
        if (structured) return;
        if (document.activeElement === node) return;
        if (node.innerText === md) return;
        node.innerText = md;
      },
    });
    return () => unregister(blockId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockId]);

  return (
    <div
      ref={ref}
      role="textbox"
      aria-label={`Editable block ${anchorId}`}
      tabIndex={0}
      contentEditable
      suppressContentEditableWarning
      spellCheck
      className={`flex-1 md-block${hasComment ? " md-commented" : ""}`}
      onInput={onInput}
      onBlur={onInput}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * Re-render only on identity / comment-flag change. `html` is memoized on
 * `blockId` so even when React re-renders, the `dangerouslySetInnerHTML`
 * string is unchanged and React leaves the (possibly mid-edit) DOM subtree
 * — and the caret — untouched. Content reconciliation from the sidebar is
 * imperative via the registered handle's guarded `setMarkdown`.
 */
export const EditableBlock = memo(
  EditableBlockImpl,
  (a, b) =>
    a.blockId === b.blockId &&
    a.hasComment === b.hasComment &&
    a.structured === b.structured &&
    a.sourceMarkdown === b.sourceMarkdown,
);
