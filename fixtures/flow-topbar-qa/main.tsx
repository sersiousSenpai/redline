// The flow top bar in each board's state (4a–4d, 5a), real component, real
// styles, synthetic Tauri services. Driven by scripts/flow-topbar-visual-qa.mjs.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { FlowTopBar, type FlowTopBarProps } from "../../src/shell/FlowTopBar";
import { resetFlowStateForTests, setPlanPose, setStage, type PlanPose } from "../../src/shell/flowState";
import { defaultWorkspace, toolSurfaces, type ToolId } from "../../src/config/workspace";
import { sessionMode } from "../../src/lib/sessionMode";
import type { SettingsGearProps } from "../../src/components/SettingsGear";
import { applyTheme } from "../../src/theme/applyTheme";
import { isThemeName } from "../../src/theme/themes";
import { DEFAULT_SOUND } from "../../src/audio/beep";
import "../../src/styles.css";

// The flow shell, as main.tsx would have stamped it before React mounts.
localStorage.setItem("redline.shell", "flow");
document.documentElement.dataset.rlShell = "flow";

type Board = "4a" | "4b" | "4c" | "4d" | "5a" | "sink";
const noop = () => {};
const v = (...ns: number[]) => ns.map((versionNumber) => ({ versionNumber, restored: false }));

interface BoardState {
  bar: Omit<FlowTopBarProps, "settings" | "tools" | "onShowStage" | "onJumpToNeedsYou" | "onOpenTool" | "liveRuns" | "sidebarOpen" | "onToggleSidebar">;
  pose?: [string, PlanPose];
  sidebar: number;
}

const BOARDS: Record<Board, BoardState> = {
  // 4a Start: "New session", no chip, Tools and the gear only.
  "4a": { sidebar: 232, bar: { title: null, mode: null, planSessionId: null, terminalId: null, toolSurface: null, needsYou: 0 } },
  // 4b Claude plans: a launch writing its first plan.
  "4b": { sidebar: 232, bar: { title: "Din roadmap: next steps", mode: sessionMode({ target: "launch" }), planSessionId: null, terminalId: "t1", toolSurface: null, needsYou: 0 } },
  // 4c You redline: the plan held, beside the chat.
  "4c": { sidebar: 0, pose: ["s1", "split"], bar: { title: "Din roadmap: next steps", mode: sessionMode({ target: "plan", status: "in_review", held: true, revisions: v(1) }), planSessionId: "s1", terminalId: "t1", toolSurface: null, needsYou: 0 } },
  // 4d Managing · Tools: the plan closed, the Tools menu open.
  "4d": { sidebar: 232, pose: ["s1", "closed"], bar: { title: "Din roadmap: next steps", mode: sessionMode({ target: "plan", status: "in_review", held: true, revisions: v(1) }), planSessionId: "s1", terminalId: "t1", toolSurface: null, needsYou: 0 } },
  // 5a Review: viewing v1 of a plan building v4, the full pose.
  "5a": { sidebar: 260, pose: ["s2", "full"], bar: { title: "Dialcrown: fastest credible launch", mode: sessionMode({ target: "plan", status: "approved", runState: "building", revisions: v(1, 2, 3, 4) }), planSessionId: "s2", terminalId: null, toolSurface: null, needsYou: 1 } },
  // Everything at once, for the contrast sweep: chip, Show plan, needs-you
  // and the toggle all on the bar.
  sink: { sidebar: 232, pose: ["s3", "closed"], bar: { title: "Every control on one bar", mode: sessionMode({ target: "plan", status: "in_review", revising: true, revisions: v(1, 2) }), planSessionId: "s3", terminalId: "t3", toolSurface: null, needsYou: 3 } },
};

const SETTINGS: SettingsGearProps = {
  theme: "aurora",
  onThemeChange: noop,
  font: "san-francisco",
  onFontChange: noop,
  lint: "off",
  onLintChange: noop,
  mode: "active",
  onModeChange: noop,
  flashEnabled: false,
  onFlashEnabledChange: noop,
  flashColor: "#ff0000",
  onFlashColorChange: noop,
  flashSound: false,
  onFlashSoundChange: noop,
  flashSoundConfig: DEFAULT_SOUND,
  onFlashSoundConfigChange: noop,
  onFlashSoundPreview: noop,
  onFlashTest: noop,
  surfacesPanel: null,
};

const query = new URLSearchParams(location.search);
const initialBoard = (query.get("board") as Board) || "4a";

function applyBoard(board: Board) {
  resetFlowStateForTests({ sidebar: true });
  const pose = BOARDS[board].pose;
  if (pose) setPlanPose(pose[0], pose[1]);
}
applyBoard(initialBoard);
const theme = query.get("theme");
applyTheme(theme && isThemeName(theme) ? theme : "aurora");

function Fixture() {
  const [board, setBoard] = useState<Board>(initialBoard);
  const [mode, setMode] = useState(BOARDS[initialBoard].bar.mode);
  const [picked, setPicked] = useState<ToolId | null>(null);
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__qa = {
      setBoard: (next: Board) => {
        applyBoard(next);
        setBoard(next);
        setMode(BOARDS[next].bar.mode);
      },
      setTheme: applyTheme,
      setMode,
      setStage,
      picked: () => picked,
    };
    document.documentElement.dataset.qaReady = "true";
  }, [picked]);
  const state = BOARDS[board];
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--color-canvas)", color: "var(--color-ink)" }}>
      <FlowTopBar
        {...state.bar}
        mode={mode}
        tools={toolSurfaces(defaultWorkspace())}
        liveRuns={1}
        onShowStage={noop}
        sidebarOpen={state.sidebar > 0}
        onToggleSidebar={noop}
        onJumpToNeedsYou={() => ((window as unknown as Record<string, unknown>).__qaJumped = true)}
        onOpenTool={(id) => setPicked(id)}
        settings={SETTINGS}
      />
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {state.sidebar > 0 && <aside className="qa-sidebar" style={{ width: state.sidebar, flex: "none", borderRight: "1px solid var(--color-rule)" }} />}
        <main className="rl-flow-stage" style={{ flex: 1, display: "flex", justifyContent: "center", paddingTop: 36, fontSize: 15, lineHeight: 1.65 }}>
          <div style={{ width: 720, color: "var(--color-ink-2)" }}>
            The two pending migrations ship with the next build. Compiling first catches Track A breakage before they run against staging.
          </div>
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
