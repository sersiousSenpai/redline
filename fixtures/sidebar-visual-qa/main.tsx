import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { SessionSidebar, type SidebarTerminal } from "../../src/components/SessionSidebar";
import type { PortServer } from "../../src/lib/sessionPorts";
import type { SessionSummary } from "../../src/types";
import { applyTheme } from "../../src/theme/applyTheme";
import "../../src/styles.css";

// The D44 scene: the screenshot's qwallah project (one dev server, :3000,
// run from ONE plan's terminal), a plan in every state the phrase names, a
// revision tree open on the active plan, and a row that needs you.
const noop = () => {};
const now = Date.now();
const rev = (n: number) => Array.from({ length: n }, (_, i) => ({ versionNumber: i + 1, receivedAt: now - (n - i) * 3_600_000, threadStart: i === 0, restored: false }));
let t = 0;
const plan = (id: string, title: string, project: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId: id,
  projectName: project,
  projectPath: `/Users/dev/${project}`,
  planTitle: title,
  latestVersion: over.revisions?.length ?? 1,
  revisions: rev(1),
  createdAt: 1,
  updatedAt: now - ++t * 600_000,
  status: "in_review",
  pendingCount: 0,
  awaitingReview: true,
  held: false,
  attachState: "idle",
  ...over,
});
const sessions: SessionSummary[] = [
  plan("q1", "Qwallah onboarding flow: account linking and first-run checklist", "qwallah", { revisions: rev(3), latestVersion: 3, pendingCount: 2 }),
  plan("q2", "Billing settings page", "qwallah", { status: "approved", runState: "building" }),
  plan("q3", "Search results ranking", "qwallah", { attachState: "detached", pendingCount: 3 }),
  plan("q4", "Notification preferences", "qwallah", { status: "approved" }),
  plan("q5", "Design tokens migration", "qwallah", { revisions: rev(2), latestVersion: 2, backend: "codex", model: "gpt-5", attachState: "detached" }),
  plan("q6", "Marketing site hero", "qwallah", { status: "approved", runState: "landed" }),
  plan("r1", "Sidebar row anatomy (D44)", "redline", { held: true }),
  plan("r2", "PTY helper daemon", "redline", { status: "aborted" }),
];
const pendingCounts = Object.fromEntries(sessions.map((s) => [s.sessionId, s.pendingCount]));
const servers: PortServer[] = [
  { port: 3000, url: "http://localhost:3000", projectPath: "/Users/dev/qwallah", projectName: "qwallah", runCommand: "npm run dev" },
  { port: 1420, url: "http://localhost:1420", projectPath: "/Users/dev/redline", projectName: "redline", runCommand: "npm run tauri dev" },
];
const terminals: Record<string, SidebarTerminal[]> = {
  q1: [{ id: "t1", title: "claude", status: "idle" }, { id: "t2", title: "npm run dev", status: "idle", ports: [3000] }],
  q2: [{ id: "t3", title: "claude", status: "working" }],
  r1: [{ id: "t4", title: "claude", status: "needs" }],
};

function Fixture() {
  useEffect(() => {
    (window as unknown as { __qa: unknown }).__qa = { setTheme: applyTheme };
    document.documentElement.dataset.qaReady = "true";
  }, []);
  return (
    <div style={{ height: "100vh", display: "flex", background: "var(--color-canvas)" }}>
      <aside data-qa-sidebar style={{ width: "clamp(200px, 24vw, 264px)", flex: "none", display: "flex", borderRight: "1px solid var(--color-rule)" }}>
        <SessionSidebar
          sessions={sessions}
          activeId="q1"
          pendingCounts={pendingCounts}
          onSelect={noop}
          onDelete={noop}
          onRename={noop}
          onArchive={noop}
          onSetPlanState={noop}
          onMoveProject={noop}
          onExport={noop}
          onSelectRevision={noop}
          viewedVersionNumber={null}
          onCombine={noop}
          onNewSessionIn={noop}
          onSelectPlace={noop}
          place="home"
          needs={{ "plan:r1": "Permission" }}
          working={new Set(["plan:q2"])}
          servers={servers}
          onOpenPort={noop}
          terminals={terminals}
          onSelectTerminal={noop}
          chats={[{ companionId: "c1", title: "Pricing page copy", updatedAt: now - 7_200_000, projectPath: "/Users/dev/qwallah" }]}
          onSelectChat={noop}
          onNewTab={noop}
        />
      </aside>
      <main style={{ flex: 1, background: "var(--color-paper)" }} />
    </div>
  );
}
applyTheme("basic");
createRoot(document.getElementById("root")!).render(<Fixture />);
