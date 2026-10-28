// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The document controls (W6 moved them here): the floating zoom and
// line-width control over a document on screen — the Plan pane or the
// drafter, never an Agent tab or a browser — pinned to the pane, not
// scrolling with the plan. Doc controls never hide: the control stacks into a
// narrow column whenever the text would otherwise reach it (always in wide
// view, where full-bleed text leaves no horizontal gutter, and on any pane
// too narrow to seat the row). The toggle that undoes wide view lives in
// here, so this control shrinking is always the right answer and
// disappearing never is. `column-reverse` keeps + above − with the mode
// toggle on top. App measures the pose (`zoomColumn`) and owns the values.

import type { RefObject } from "react";

import { DocWidthToggle } from "../../components/DocWidthToggle";
import { ZoomButton } from "../../components/ZoomButton";

export interface DocZoomControlProps {
  zoomCtrlRef: RefObject<HTMLDivElement | null>;
  /** Stacked into the narrow column. */
  zoomColumn: boolean;
  docZoom: number;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
  docWide: boolean;
  docMeasure: number;
  documentRef: RefObject<HTMLElement | null>;
  setDocWide: (wide: boolean) => void;
  setDocMeasure: (measure: number) => void;
}

export function DocZoomControl({ zoomCtrlRef, zoomColumn, docZoom, zoomIn, zoomOut, zoomReset, docWide, docMeasure, documentRef, setDocWide, setDocMeasure }: DocZoomControlProps) {
  return (
    <div
      ref={zoomCtrlRef}
      className={`rl-doc-zoom absolute flex items-center gap-1 rounded-full${zoomColumn ? " flex-col-reverse" : ""}`}
      style={{
        right: "16px",
        bottom: "16px",
        padding: "3px",
        background: "var(--color-bg-elevated)",
        border: "1px solid var(--color-rule)",
        boxShadow: "0 4px 14px rgba(0,0,0,0.18)",
        opacity: 0.92,
      }}
    >
      <ZoomButton label="−" title="Zoom out (⌘−)" onClick={zoomOut} />
      <button
        type="button"
        onClick={zoomReset}
        title="Reset zoom (⌘0)"
        className="font-mono"
        style={{
          fontSize: "10px",
          // Stacked, the readout sets the whole column's width — so it
          // drops the "%" and its reserved room for the three digits it
          // actually needs. Every px here is a px of gutter the column
          // needs to clear the text, and on the panes that force the
          // stack there are few going spare.
          minWidth: zoomColumn ? "22px" : "34px",
          color: "var(--color-ink-muted)",
          background: "transparent",
          border: "none",
          cursor: "pointer",
        }}
      >
        {Math.round(docZoom * 100)}
        {zoomColumn ? "" : "%"}
      </button>
      <ZoomButton label="+" title="Zoom in (⌘+)" onClick={zoomIn} />
      <DocWidthToggle
        wide={docWide}
        measure={docMeasure}
        articleRef={documentRef}
        onToggle={() => setDocWide(!docWide)}
        onCommit={({ wide, measure }) => { setDocWide(wide); setDocMeasure(measure); }}
      />
    </div>
  );
}
