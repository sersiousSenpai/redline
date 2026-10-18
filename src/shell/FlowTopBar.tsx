// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The flow shell's top bar (boards 4a–4d, 5a): where you are on the left,
//! what needs you and where else you can go on the right.
//!
//! Left: the sidebar toggle (⌘B), the brand, the session's title, its mode
//! chip (lib/sessionMode) and, while its plan panel is closed, Show plan.
//! Right: "● N needs you", the stage's Conversation | Terminal (⌘J), Tools ▾
//! (⌘1–⌘4, lazy) and the settings gear.
//!
//! Loaded statically, unlike every other flow piece: this bar is the window's
//! drag region (there is no native title bar; see lib/windowDrag) and the
//! macOS traffic lights float over its left end, so it has to be there on the
//! first frame. It keeps the classic header's `rl-app-header` class (the boot
//! choreography and the island's geometry find the bar by it) and its `pl-20`
//! clearance. It reads the flow state it drives (sidebar, stage, plan pose)
//! straight from shell/flowState; everything about the session comes from App
//! through props.

import { lazy, Suspense, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronUp, FilePenLine, FileText, Hammer, MessageSquare, PanelLeft, PenLine, Settings, Terminal } from "lucide-react";
import { SettingsGear, type SettingsGearProps } from "../components/SettingsGear";
import type { ToolDescriptor, ToolId } from "../config/workspace";
import type { ToolExtra } from "./ToolsMenu";
import { modeColors, type ModeKind, type SessionMode } from "../lib/sessionMode";
import { warmableChunk } from "../lib/warmableChunk";
import { beginWindowDrag, toggleWindowMaximize } from "../lib/windowDrag";
import { planPoseOf, setPlanPose, setStage, useFlow, type StageView } from "./flowState";
import "./topbar.css";

// The menu's rows only exist while it is open; the chunk is warmed as the
// pointer or focus reaches Tools, so the first open paints in its own frame.
const toolsChunk = warmableChunk(() => import("./ToolsMenu"));
const ToolsMenu = lazy(toolsChunk.load);

export interface FlowTopBarProps {
  /** The session's name; null on the New-session screen, which reads a
   *  muted "New session". */
  title: string | null;
  /** The mode chip, from lib/sessionMode; null shows none. */
  mode: SessionMode | null;
  /** The plan session whose panel Show plan opens; null until a plan
   *  exists (a launch still writing its first plan, a chat). */
  planSessionId: string | null;
  /** The session's own terminal. The Conversation | Terminal toggle exists
   *  only for a session that has one. */
  terminalId: string | null;
  /** The Tools surface on screen instead of the session stage, or null. Its
   *  Tools row reads as current, and the bar shows the way back: "‹ session
   *  / Tool". */
  toolSurface: ToolId | null;
  /** Whether the sidebar is on screen, and its switch (⌘B). App's, so the
   *  button always says what it will do to what you can see. */
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** Bring the session stage back from a Tools surface. Called before the
   *  bar's own stage gestures (Show plan, the toggle, the title), so each
   *  lands where it can be seen. */
  onShowStage: () => void;
  /** Held plans, terminals asking for something and a blocking code-review
   *  request — none of them the session on screen. */
  needsYou: number;
  onJumpToNeedsYou: () => void;
  /** The Tools rows this workspace allows (config/workspace `toolSurfaces`). */
  tools: readonly ToolDescriptor[];
  /** Orchestrated runs in flight: the Runs row's "N live". */
  liveRuns: number;
  onOpenTool: (id: ToolId) => void;
  /** The utilities classic kept in its header, under the tools. */
  toolExtras?: readonly ToolExtra[];
  /** The gear: the same SettingsMenu, rows and all, the classic header
   *  mounts. */
  settings: SettingsGearProps;
}

const MODE_ICON: Record<ModeKind, typeof PenLine> = {
  chat: MessageSquare,
  plan: FilePenLine,
  redline: PenLine,
  build: Hammer,
};

export function FlowTopBar({
  title,
  mode,
  planSessionId,
  terminalId,
  toolSurface,
  sidebarOpen,
  onToggleSidebar,
  onShowStage,
  needsYou,
  onJumpToNeedsYou,
  tools,
  liveRuns,
  onOpenTool,
  toolExtras,
  settings,
}: FlowTopBarProps) {
  const stage = useFlow((s) => s.stage);
  const pose = useFlow((s) => (planSessionId && s.planPose[planSessionId]) || "closed");
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsRef = useRef<HTMLButtonElement | null>(null);

  // The toggle swaps what fills the whole stage, so it shows while the
  // conversation has the stage to itself: not beside an open plan, and not
  // while the plan is back for your review — there Show plan is the next
  // step (boards 4c, 4d). It never hides the way back from the terminal,
  // whatever the pose.
  const showToggle =
    !!terminalId && !toolSurface && (stage === "terminal" || (pose === "closed" && mode?.kind !== "redline"));
  const tool = toolSurface ? tools.find((t) => t.id === toolSurface) : null;
  const showPlan = !!planSessionId && pose === "closed";
  const ModeIcon = mode ? MODE_ICON[mode.kind] : null;
  const colors = mode ? modeColors(mode.kind) : null;
  const pickStage = (next: StageView) => {
    onShowStage();
    setStage(next);
  };

  return (
    <>
    <header
      className="rl-app-header rl-ftb pl-20"
      data-flow-topbar=""
      onMouseDown={beginWindowDrag}
      onDoubleClick={toggleWindowMaximize}
    >
      <button
        type="button"
        className="rl-ftb-icon"
        onClick={onToggleSidebar}
        aria-pressed={sidebarOpen}
        aria-label={sidebarOpen ? "Hide the sidebar" : "Show the sidebar"}
        title={`${sidebarOpen ? "Hide" : "Show"} the sidebar (⌘B)`}
      >
        <PanelLeft size={15} aria-hidden />
      </button>
      <span className="rl-ftb-brand">
        <span className="rl-ftb-mark" aria-hidden>/</span>
        Redline
      </span>
      <span className="rl-ftb-divider" aria-hidden>|</span>
      {toolSurface ? (
        // On a Tool: where you came from, as the way back to it (Esc, or the
        // Tool's own key again, do the same), then where you are.
        <>
          <button
            type="button"
            className="rl-ftb-back"
            data-flow-back=""
            onClick={onShowStage}
            title={`Back to ${title ?? "the new session"} (Esc)`}
          >
            <ChevronLeft size={14} aria-hidden />
            <span className="rl-ftb-back-label">{title ?? "New session"}</span>
          </button>
          <span className="rl-ftb-divider" aria-hidden>/</span>
          <span className="rl-ftb-here">{tool?.label ?? "Terminals"}</span>
        </>
      ) : (
        <span className="rl-ftb-title" data-empty={title ? undefined : ""} title={title ?? undefined}>
          {title ?? "New session"}
        </span>
      )}
      {!toolSurface && mode && ModeIcon && colors && (
        <span
          className="rl-ftb-mode"
          data-flow-mode-chip=""
          data-mode={mode.kind}
          style={{ color: colors.fg, background: colors.bg }}
        >
          <ModeIcon size={11} aria-hidden />
          {mode.label}
        </span>
      )}
      {showPlan && (
        <button
          type="button"
          className="rl-ftb-show-plan"
          data-flow-show-plan=""
          title="Show the plan beside the conversation (⌘⌥B)"
          onClick={() => {
            onShowStage();
            setPlanPose(planSessionId!, "split");
          }}
        >
          <FileText size={11} aria-hidden />
          Show plan
        </button>
      )}
      <span className="rl-ftb-spacer" />
      {needsYou > 0 && (
        <button
          type="button"
          className="rl-ftb-needs"
          data-flow-needs-you=""
          onClick={onJumpToNeedsYou}
          title="Go to the first thing waiting on you"
        >
          <span className="rl-ftb-needs-dot" aria-hidden />
          {needsYou} needs you
        </button>
      )}
      {showToggle && (
        <div className="rl-ftb-seg" role="radiogroup" aria-label="Stage (⌘J)">
          <button
            type="button"
            role="radio"
            aria-checked={stage === "conversation"}
            onClick={() => pickStage("conversation")}
          >
            Conversation
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={stage === "terminal"}
            onClick={() => pickStage("terminal")}
          >
            <Terminal size={11} aria-hidden />
            Terminal
          </button>
        </div>
      )}
      <button
        ref={toolsRef}
        type="button"
        className="rl-ftb-tools"
        data-flow-tools=""
        aria-haspopup="menu"
        aria-expanded={toolsOpen}
        onPointerEnter={toolsChunk.warm}
        onFocus={toolsChunk.warm}
        onClick={() => setToolsOpen((open) => !open)}
      >
        Tools
        {toolsOpen ? <ChevronUp size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
      </button>
      <SettingsGear {...settings} compact triggerClassName="rl-ftb-icon" icon={<Settings size={15} aria-hidden />} />
    </header>
      {/* Outside the header in the React tree too: a press in the menu must
          never bubble into the bar's window-drag handlers. */}
      {toolsOpen && (
        <Suspense fallback={null}>
          <ToolsMenu
            anchor={toolsRef}
            tools={tools}
            current={toolSurface}
            liveRuns={liveRuns}
            onPick={(id) => {
              setToolsOpen(false);
              onOpenTool(id);
            }}
            extras={toolExtras}
            onClose={() => setToolsOpen(false)}
          />
        </Suspense>
      )}
    </>
  );
}

/** ⌘⌥B: the plan panel, closed ↔ beside the conversation. From the full
 *  pose it closes, like the panel's own ✕. */
export function togglePlanPanel(sessionId: string): void {
  setPlanPose(sessionId, planPoseOf(sessionId) === "closed" ? "split" : "closed");
}
