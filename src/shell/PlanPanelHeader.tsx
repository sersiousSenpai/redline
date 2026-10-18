// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The plan panel's 48px header, in its two poses.
//!
//! - **split** (4c): "📄 Plan" and a faint "v1 · 2 marks" on the left; on the
//!   right two LABELLED buttons, "⤢ Full screen" (ghost) and "✕ Close plan"
//!   (a filled chip). They are words rather than icons on purpose: the
//!   walkthrough's "I didn't know the right pane closes" was a hidden icon.
//! - **full** (5a): "☰ Contents" on the left, the version pill in the middle
//!   while an older version is on screen, "Full screen" on the right — now a
//!   pressed toggle that puts the plan back beside the conversation.
//!
//! Contents is in both poses (document controls never hide): the split
//! header carries it as an icon beside Full screen, since 4c's header has no
//! room on its left for a second label.

import { FileText, List, Maximize2, Minimize2, X } from "lucide-react";

import { VersionPill, type VersionPillProps } from "./VersionPill";

export interface PlanPanelHeaderProps {
  pose: "split" | "full";
  /** The latest version's number, or null before the plan has loaded. */
  version: number | null;
  /** Unsent marks on the latest version. */
  marks: number;
  /** Set while an older version is on screen. */
  viewing?: VersionPillProps | null;
  /** The contents rail's toggle; null when the plan has no sections. */
  onToggleContents: (() => void) | null;
  contentsOpen: boolean;
  onToggleFull: () => void;
  onClose: () => void;
}

export function PlanPanelHeader({
  pose,
  version,
  marks,
  viewing,
  onToggleContents,
  contentsOpen,
  onToggleFull,
  onClose,
}: PlanPanelHeaderProps) {
  const full = pose === "full";
  const meta = [
    version !== null ? `v${version}` : null,
    marks > 0 ? `${marks} mark${marks === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(" · ");
  const fullLabel = full ? "Leave full screen: the plan goes back beside the conversation" : "Full screen: the conversation moves into the panel's Chat tab";
  return (
    <header className="rl-plan-head" data-pose={pose} data-plan-panel-header>
      {full ? (
        <button
          type="button"
          className="rl-plan-head-btn rl-plan-head-contents"
          onClick={onToggleContents ?? undefined}
          disabled={!onToggleContents}
          aria-pressed={contentsOpen}
          title={contentsOpen ? "Hide contents" : "Show contents"}
        >
          <List aria-hidden size={13} strokeWidth={2} />
          Contents
        </button>
      ) : (
        <span className="rl-plan-head-title">
          <FileText aria-hidden size={14} strokeWidth={2} className="rl-plan-head-icon" />
          <span className="rl-plan-head-name">Plan</span>
          {meta && <span className="rl-plan-head-meta">{meta}</span>}
        </span>
      )}
      <span className="rl-plan-head-spacer" />
      {viewing && (
        <>
          <VersionPill {...viewing} />
          <span className="rl-plan-head-spacer" />
        </>
      )}
      {!full && onToggleContents && (
        <button
          type="button"
          className="rl-plan-head-btn rl-plan-head-icon-btn"
          onClick={onToggleContents}
          aria-pressed={contentsOpen}
          aria-label="Contents"
          title={contentsOpen ? "Hide contents" : "Show contents"}
        >
          <List aria-hidden size={13} strokeWidth={2} />
        </button>
      )}
      <button
        type="button"
        className="rl-plan-head-btn"
        onClick={onToggleFull}
        aria-pressed={full}
        title={fullLabel}
      >
        {full ? (
          <Minimize2 aria-hidden size={13} strokeWidth={2} />
        ) : (
          <Maximize2 aria-hidden size={13} strokeWidth={2} />
        )}
        Full screen
      </button>
      {!full && (
        <button
          type="button"
          className="rl-plan-head-btn rl-plan-head-close"
          onClick={onClose}
          title="Close the plan. Show plan in the top bar, or the plan's card in the conversation, brings it back."
        >
          <X aria-hidden size={13} strokeWidth={2} />
          Close plan
        </button>
      )}
    </header>
  );
}

export default PlanPanelHeader;
