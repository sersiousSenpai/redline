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
import type { NodeView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { common, createLowlight } from "lowlight";

import { MermaidView } from "./MermaidView";

/**
 * Rich rendering for the plan's ` ``` ` fenced blocks (Planning-IDE Phase 1).
 *
 * Mostly additive: the `codeBlock` node keeps its name, `language` attribute and
 * `text*` content, so the markdown parser/serializer and the round-trip
 * idempotency gate are untouched. The ONE deliberate schema difference is that
 * `richCodeBlock()` widens the node's `marks` from the base `code_block` spec's
 * `marks: ''` (which forbids every mark) to permit the two track-change marks
 * (`rl_ins`/`rl_del`) — see the comment on {@link richCodeBlock}. Everything
 * else here is presentation only.
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
 * A hand-built (non-React) node view for ordinary fenced code blocks: the same
 * chrome header as the React view, but ProseMirror owns the editable `<code>`
 * contentDOM directly.
 *
 * Why not React here: `CodeBlockLowlight` re-emits its syntax-highlight
 * decorations on every keystroke. Under a `ReactNodeViewRenderer`, those
 * decoration repaints race React's reconciliation of `<NodeViewContent>` and
 * drop the caret — so typing into a code block silently failed. A plain
 * contentDOM has no React layer to fight, so input and the caret stay reliable.
 * The mermaid branch keeps using the React view (its source is hidden, so the
 * decoration race never bites).
 */
function domCodeBlockView(node: PMNode): NodeView {
  const wrapper = document.createElement("div");
  wrapper.className = "rl-codeblock";

  const header = document.createElement("div");
  header.className = "rl-codeblock-header";
  header.contentEditable = "false";

  const langEl = document.createElement("span");
  langEl.className = "rl-codeblock-lang";

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "rl-codeblock-copy";
  copyBtn.textContent = "Copy";
  // preventDefault on mousedown so the click never disturbs the editor's
  // selection or focus.
  copyBtn.addEventListener("mousedown", (e) => e.preventDefault());
  copyBtn.addEventListener("click", () => {
    void navigator.clipboard
      ?.writeText(code.textContent ?? "")
      .then(() => {
        copyBtn.textContent = "Copied";
        setTimeout(() => {
          copyBtn.textContent = "Copy";
        }, 1200);
      })
      .catch(() => {
        /* clipboard unavailable — silently ignore */
      });
  });

  header.append(langEl, copyBtn);

  const pre = document.createElement("pre");
  const code = document.createElement("code");
  pre.appendChild(code);
  wrapper.append(header, pre);

  // Mirror what the default renderer / React NodeViewWrapper would stamp, so
  // useTextSelection's anchor lookup and the redline `[data-anchor-id]` CSS
  // keep working over the custom DOM.
  const syncAttrs = (n: PMNode) => {
    langEl.textContent = n.attrs.language || "text";
    const blockId = n.attrs.blockId as string | undefined;
    const anchorId = n.attrs.anchorId as string | undefined;
    if (blockId) wrapper.setAttribute("data-block-id", blockId);
    else wrapper.removeAttribute("data-block-id");
    if (anchorId) wrapper.setAttribute("data-anchor-id", anchorId);
    else wrapper.removeAttribute("data-anchor-id");
  };
  syncAttrs(node);

  return {
    dom: wrapper,
    contentDOM: code,
    update(updated) {
      if (updated.type !== node.type) return false;
      syncAttrs(updated);
      return true;
    },
    ignoreMutation(mutation) {
      // ProseMirror owns the editable <code>; ignore chrome-header mutations
      // (lang label / "Copy"→"Copied" text swap) so they don't trigger a
      // re-parse of the node.
      if (mutation.type === "selection") return false;
      return !code.contains(mutation.target as Node);
    },
  };
}

/**
 * The plan editor's code-block extension: `CodeBlockLowlight` (syntax-highlight
 * decorations) plus a NodeView that branches by language — the React
 * {@link CodeBlockView} for `mermaid` diagrams, a plain editable
 * {@link domCodeBlockView} for everything else. Replaces StarterKit's bundled
 * `codeBlock` in {@link planExtensions}.
 *
 * `marks: "rl_ins rl_del"` is load-bearing, NOT decoration. Word-style
 * track-changes deletes text by *marking* it `rl_del` in place (never removing
 * it — see `trackedDelete` in TrackChangesInput.ts). The base `code_block` spec
 * ships `marks: ''`, so ProseMirror SILENTLY dropped that `addMark` and
 * strike/delete inside a fenced block did nothing — a bug that regressed every
 * time this node was rebuilt. Permitting only the two track-change marks keeps
 * code text literal (bold/italic/etc. stay forbidden) while letting strikes
 * land. Additive & round-trip-safe: existing plans carry no such marks, and the
 * serializer accepts them away (drops `rl_del` text) back to clean markdown.
 * The schema guard in `schema.test.ts` pins this so it can't silently regress.
 */
export function richCodeBlock() {
  return CodeBlockLowlight.extend({
    marks: "rl_ins rl_del",
    addNodeView() {
      const renderReact = ReactNodeViewRenderer(CodeBlockView);
      return (props) => {
        const language = (props.node.attrs.language || "")
          .toString()
          .toLowerCase();
        if (language === "mermaid") return renderReact(props);
        return domCodeBlockView(props.node);
      };
    },
  }).configure({ lowlight });
}
