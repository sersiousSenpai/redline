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
//! - **pane** (the workbench's Plan tab, RLPanePlan): the 28px row —
//!   "☰ Contents · v3 · 2 marks", the version pill while an older version is
//!   on screen, and the ⋯. No Full screen and no Close: the tab is the pane.
//!
//! Contents is in every pose (document controls never hide): the split
//! header carries it as an icon beside Full screen, since 4c's header has no
//! room on its left for a second label.

import { useEffect, useRef, useState } from "react";
import { Ellipsis, FileText, List, Maximize2, Minimize2, X } from "lucide-react";

import { MenuSurface } from "../ui/MenuSurface";
import { VersionPill, type VersionPillProps } from "./VersionPill";
import "./plan.css";

/** One row of the plan's ⋯ menu. */
export interface PlanMenuItem {
  id: string;
  label: string;
  detail?: string;
  onPick: () => void;
}

export type PlanChromePose = "split" | "full" | "pane";

export interface PlanPanelHeaderProps {
  pose: PlanChromePose;
  /** The latest version's number, or null before the plan has loaded. */
  version: number | null;
  /** Unsent marks on the latest version. */
  marks: number;
  /** Set while an older version is on screen. */
  viewing?: VersionPillProps | null;
  /** The contents rail's toggle; null when the plan has no sections. */
  onToggleContents: (() => void) | null;
  contentsOpen: boolean;
  /** Absent in the pane pose, which has no full screen and no close. */
  onToggleFull?: () => void;
  onClose?: () => void;
  /** The plan's own actions — export, share, invite, move — in a ⋯ menu,
   *  where classic kept them in the header's Download and Live Session
   *  menus. Empty draws no ⋯. */
  menu: readonly PlanMenuItem[];
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
  menu,
}: PlanPanelHeaderProps) {
  const full = pose === "full";
  const pane = pose === "pane";
  const meta = [
    version !== null ? `v${version}` : null,
    marks > 0 ? `${marks} mark${marks === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(" · ");
  const fullLabel = full ? "Leave full screen: the plan goes back beside the conversation" : "Full screen: the conversation moves into the panel's Chat tab";
  return (
    <header className="rl-plan-head" data-pose={pose} data-plan-panel-header>
      {full || pane ? (
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
      {pane && meta && <span className="rl-plan-head-meta">· {meta}</span>}

      {/* The ⋯ on the right is matched on the left in the full pose, so the
          version pill stays centred between Contents and Full screen (5a). */}
      {full && menu.length > 0 && <span className="rl-plan-head-balance" aria-hidden />}
      <span className="rl-plan-head-spacer" />
      {viewing && (
        <>
          <VersionPill {...viewing} />
          <span className="rl-plan-head-spacer" />
        </>
      )}
      {menu.length > 0 && <PlanMenu items={menu} />}
      {!full && !pane && onToggleContents && (
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
      {!pane && (
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
      )}
      {!full && !pane && (
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

/** The ⋯ and its menu, hung under the button's right edge. */
function PlanMenu({ items }: { items: readonly PlanMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    wrap.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    const away = (e: Event) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      wrap.current?.querySelector<HTMLButtonElement>("button")?.focus();
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <span ref={wrap} className="rl-plan-menu">
      <button
        type="button"
        className="rl-plan-head-btn rl-plan-head-icon-btn"
        aria-label="More plan actions"
        title="Export, share, invite, move"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Ellipsis aria-hidden size={14} strokeWidth={2} />
      </button>
      {open && (
        <MenuSurface ariaLabel="Plan actions" className="rl-plan-menu-panel">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className="rl-plan-menu-item"
              onClick={() => {
                setOpen(false);
                item.onPick();
              }}
            >
              {item.label}
              {item.detail && <span className="rl-plan-menu-detail">{item.detail}</span>}
            </button>
          ))}
        </MenuSurface>
      )}
    </span>
  );
}

export default PlanPanelHeader;
