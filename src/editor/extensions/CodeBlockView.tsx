// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useState } from "react";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { common, createLowlight } from "lowlight";

import { MermaidView } from "./MermaidView";

/**
 * Rich rendering for the plan's ` ``` ` fenced blocks (Planning-IDE Phase 1).
 *
 * This is additive: the `codeBlock` ProseMirror node — its name, `language`
 * attribute, and `text*` content — is unchanged, so `planSchema()` stays
 * schema-equivalent and the markdown parser/serializer and the round-trip
 * idempotency gate are untouched. Only the on-screen presentation changes.
 *
 * One shared `lowlight` instance highlights every code block; `common` bundles
 * ~37 languages — the set Claude routinely emits in plans. An unrecognised
 * language simply renders unhighlighted.
 */
const lowlight = createLowlight(common);

/**
 * A single React NodeView for the `codeBlock` node. It branches on the
 * language: a ` ```mermaid ` block renders as a diagram (with its source kept
 * editable behind a disclosure), every other block as syntax-highlighted code
 * under a chrome header.
 */
function CodeBlockView({ node }: NodeViewProps) {
  const language: string = node.attrs.language || "";
  const isMermaid = language.toLowerCase() === "mermaid";
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard
      ?.writeText(node.textContent)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {
        /* clipboard unavailable — silently ignore */
      });
  };

  if (isMermaid) {
    return (
      <NodeViewWrapper className="rl-mermaid-block">
        <MermaidView code={node.textContent} />
        {/* The contentDOM stays mounted (just collapsed) so ProseMirror keeps
            managing the node's text — round-trip and block edits are intact. */}
        <details className="rl-mermaid-source">
          <summary contentEditable={false}>Diagram source</summary>
          <pre>
            <NodeViewContent as="code" />
          </pre>
        </details>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper className="rl-codeblock">
      <div className="rl-codeblock-header" contentEditable={false}>
        <span className="rl-codeblock-lang">{language || "text"}</span>
        <button
          type="button"
          className="rl-codeblock-copy"
          // preventDefault on mousedown so the click never disturbs the
          // editor's selection or focus.
          onMouseDown={(e) => e.preventDefault()}
          onClick={copy}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <NodeViewContent as="code" />
      </pre>
    </NodeViewWrapper>
  );
}

/**
 * The plan editor's code-block extension: `CodeBlockLowlight` (syntax-highlight
 * decorations over a node spec identical to StarterKit's `codeBlock`) plus the
 * React NodeView above. Replaces StarterKit's bundled `codeBlock` in
 * {@link planExtensions}.
 */
export function richCodeBlock() {
  return CodeBlockLowlight.extend({
    addNodeView() {
      return ReactNodeViewRenderer(CodeBlockView);
    },
  }).configure({ lowlight });
}
