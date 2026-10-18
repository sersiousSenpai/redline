// Flow sidebar fixture: the production SessionSidebar in its flow layout,
// laid out as the boards lay it out (a 46px top bar and its rule, then the
// sidebar column), with the data each board shows. Only the data is made up.
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { SessionSidebar } from "../../src/components/SessionSidebar";
import { applyTheme } from "../../src/theme/applyTheme";
import type { ThemeName } from "../../src/theme/themes";
import type { SessionSummary } from "../../src/types";
import type { FlowChat, FlowLaunch, NeedReason } from "../../src/lib/sessionGroups";
import "../../src/styles.css";

const DIN = "/Users/me/projects/din";
const DIAL = "/Users/me/projects/dialcrown";
const day = (d: number, h = 10) => new Date(2026, 9, d, h, 0).getTime();

const plan = (id: string, title: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId: id,
  projectName: "din",
  projectPath: DIN,
  planTitle: title,
  latestVersion: 1,
  revisions: [{ versionNumber: 1, receivedAt: day(12), threadStart: true, restored: false }],
  createdAt: day(12),
  updatedAt: day(12),
  status: "approved",
  pendingCount: 0,
  awaitingReview: false,
  held: false,
  attachState: "idle",
  ...over,
});

const backend = plan("backend", "Din backend: Hono + Fly", { updatedAt: day(16) });
const retrieval = plan("retrieval", "Din retrieval plan", { updatedAt: day(15) });
const status: FlowChat = { companionId: "status", title: "Review status check", updatedAt: day(14), projectPath: DIN };
const roadmapPlan = plan("roadmap", "Din roadmap: next steps", { status: "in_review", updatedAt: day(17) });

interface Scene {
  width: number;
  height: number;
  sessions: SessionSummary[];
  chats: FlowChat[];
  launches: FlowLaunch[];
  activeId: string | null;
  activeLaunchId?: string | null;
  needs?: Record<string, NeedReason>;
  viewedVersionNumber?: number | null;
  startActive?: boolean;
}

const inReview = [
  "Component meshes from a splat",
  "Foundation docs for gpu-harness",
  "Skip the \"trust this folder\" prompt",
  "Memory surface: kill the jank",
  "Theme cull + light theme",
  ...Array.from({ length: 9 }, (_, i) => `Older review ${i + 1}`),
].map((title, i) => plan(`review-${i}`, title, { status: "in_review", projectPath: DIAL, projectName: "dialcrown", updatedAt: day(13, 20 - i) }));

const SCENES: Record<string, Scene> = {
  // 4a: the start screen, nothing open.
  "4a": { width: 1280, height: 800, sessions: [backend, retrieval], chats: [status], launches: [], activeId: null, startActive: true },
  // 4b: a launch planning in its terminal, before any plan row exists.
  "4b": {
    width: 1280, height: 800, sessions: [backend, retrieval], chats: [status],
    launches: [{ terminalId: "t-roadmap", title: "Din roadmap: next steps", startedAt: day(17), projectPath: DIN, working: true }],
    activeId: null, activeLaunchId: "t-roadmap", startActive: false,
  },
  // 4d: the plan is being redlined (amber), and a row menu opens on the
  // next row.
  "4d": { width: 1280, height: 800, sessions: [roadmapPlan, backend, retrieval], chats: [status], launches: [], activeId: "roadmap" },
  // 5a: sorted by need, viewing v1 of a building v4.
  "5a": {
    width: 1600, height: 960,
    sessions: [
      plan("vehicle", "Every vehicle gets a 3D model", { status: "in_review", projectPath: DIAL, projectName: "dialcrown", updatedAt: day(16) }),
      plan("dial", "Dialcrown: fastest credible launch", {
        status: "approved", runState: "building", projectPath: DIAL, projectName: "dialcrown", updatedAt: day(15, 18), latestVersion: 4,
        revisions: [
          { versionNumber: 1, receivedAt: day(14, 9), threadStart: true, restored: false },
          { versionNumber: 2, receivedAt: day(14, 16), threadStart: false, restored: false },
          { versionNumber: 3, receivedAt: day(15, 9), threadStart: false, restored: false },
          { versionNumber: 4, receivedAt: day(15, 17), threadStart: false, restored: false },
        ],
      }),
      plan("sprint", "MachineOS \"Full Bore\" sprint", { status: "approved", runState: "running", projectPath: "/Users/me/projects/machineos", projectName: "machineos", updatedAt: day(15, 12) }),
      ...inReview,
    ],
    chats: [], launches: [], activeId: "dial", needs: { "plan:vehicle": "Question" }, viewedVersionNumber: 1,
  },
  // Archived rows and a chat without a folder, for the fold.
  archive: {
    width: 1280, height: 800,
    sessions: [backend, retrieval, plan("old", "Din search spike", { archivedAt: day(11), updatedAt: day(10) })],
    chats: [status, { companionId: "loose", title: "Pricing questions", updatedAt: day(9), projectPath: null }, { companionId: "gone", title: "Old brainstorm", updatedAt: day(8), projectPath: DIN, archivedAt: day(12) }],
    launches: [], activeId: "backend",
  },
};

declare global {
  interface Window {
    __qa: {
      setScene: (name: string) => void;
      setTheme: (name: ThemeName) => void;
      calls: unknown[][];
    };
  }
}

const calls: unknown[][] = [];
const log = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); };
// Module-stable, as App's `useStableHandlers` makes them.
const handlers = {
  onSelect: log("select"),
  onDelete: log("delete"),
  onRename: log("rename"),
  onArchive: log("archive"),
  onExport: log("export"),
  onSelectRevision: log("revision"),
  onNewSession: log("new-session"),
  onNewSessionIn: log("new-session-in"),
  onSelectChat: log("select-chat"),
  onRenameChat: log("rename-chat"),
  onArchiveChat: log("archive-chat"),
  onDeleteChat: log("delete-chat"),
  onSelectLaunch: log("select-launch"),
};

function Fixture() {
  const [name, setName] = useState("4a");
  const scene = SCENES[name];
  const pendingCounts = useMemo(() => ({}), []);
  useEffect(() => {
    window.__qa = { setScene: setName, setTheme: (theme) => applyTheme(theme), calls };
    document.documentElement.dataset.qaScene = name;
  }, [name]);
  // The sidebar column, sized as App sizes it under the flow shell.
  const sidebarWidth = Math.min(281, Math.max(253, Math.round(scene.width * 0.1625) + 21));
  return (
    <div className="qa-board" style={{ width: scene.width, height: scene.height, display: "flex", flexDirection: "column", background: "var(--color-canvas)", color: "var(--color-ink)" }}>
      <div className="qa-top" style={{ height: 47, flex: "none", borderBottom: "1px solid var(--color-rule)" }} />
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div className="qa-sidebar" style={{ width: sidebarWidth, flex: "none", display: "flex", flexDirection: "column" }}>
          <SessionSidebar
            key={name}
            {...handlers}
            layout="flow"
            sessions={scene.sessions}
            chats={scene.chats}
            launches={scene.launches}
            activeId={scene.activeId}
            activeLaunchId={scene.activeLaunchId ?? null}
            needs={scene.needs}
            startActive={scene.startActive}
            pendingCounts={pendingCounts}
            viewedVersionNumber={scene.viewedVersionNumber ?? null}
          />
        </div>
        <div className="qa-stage" style={{ flex: 1 }} />
      </div>
    </div>
  );
}

applyTheme("aurora");
document.body.style.margin = "0";
document.body.style.background = "var(--color-canvas)";
createRoot(document.getElementById("root")!).render(<Fixture />);
