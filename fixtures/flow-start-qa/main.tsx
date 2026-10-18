// The flow shell's start screen (board 4a) with its real components: the
// MonochatIsland door resting on a stand-in stage, FrontDoor in flow mode,
// the lazy strip / checklist / Continue chunk. Services are synthetic.
//
// Query: `?theme=` boots another theme, `?text=` puts a sentence in the box,
// `?checklist=1` shows first-run blockers, `?continues=1` two Continue links,
// `?strip=0` a retired strip, `?mode=chat` the Chat mode.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { SHELL_KEY } from "../../src/lib/shellFlag";
import { writeSharedDraft } from "../../src/hooks/useSharedDraft";
import { MonochatIsland } from "../../src/components/MonochatIsland";
import { FrontDoor } from "../../src/components/FrontDoor";
import { applyTheme } from "../../src/theme/applyTheme";
import { FRONT_DOOR_TEXT_KEY } from "../../src/lib/frontDoor";
import type { BackendChoice, ModelCatalogs } from "../../src/lib/backendChoice";
import type { ReadinessItem } from "../../src/lib/readiness";
import type { ThemeName } from "../../src/theme/themes";
import "../../src/styles.css";
import "./fixture.css";

// The flow shell, as main.tsx would have read and stamped it.
localStorage.setItem(SHELL_KEY, "flow");
document.documentElement.dataset.rlShell = "flow";

const query = new URLSearchParams(location.search);
const noop = () => {};
const setText = (text: string) => writeSharedDraft(FRONT_DOOR_TEXT_KEY, text);
setText(query.get("text") ?? "");

// Fixture data only: the board's copy. The app reads the live catalog.
const CATALOGS: ModelCatalogs = {
  "claude-code": [{ slug: "opus", displayName: "Opus 4.5", description: "", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" }],
};
const BLOCKERS: ReadinessItem[] = [
  { id: "claude-missing", state: "blocked", label: "Can't find the `claude` command", detail: "Redline launches your own Claude Code. Point it at the binary.", fix: { label: "Locate it…", kind: "locate-claude" } },
  { id: "hook-missing", state: "blocked", label: "The plan hook isn't installed", detail: "Plans come back to Redline through a hook in your Claude Code settings.", fix: { label: "Install integration", kind: "install-integration" } },
  { id: "hook-unapproved", state: "warning", label: "The plan hook may not be approved yet", detail: "Claude Code asks you to approve new hooks once. Run /hooks in your session.", fix: { label: "/hooks", kind: "copy-hooks", copyText: "/hooks" } },
];
const CONTINUES = [
  { id: "s1", title: "Din retrieval plan" },
  { id: "s2", title: "Din backend: Hono + Fly" },
];

function Fixture() {
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  const [destination, setDestination] = useState<"chat" | "plan" | "drafter" | "run">(query.get("mode") === "chat" ? "chat" : "plan");
  const [project, setProject] = useState<string | null>("/Users/me/projects/din");
  const [choice, setChoice] = useState<BackendChoice>({ backend: "claude-code", model: "opus", effort: "high" });
  const [readiness, setReadiness] = useState<ReadinessItem[]>(query.get("checklist") === "1" ? BLOCKERS : []);
  const [continued, setContinued] = useState<string | null>(null);
  const [launched, setLaunched] = useState<string | null>(null);
  useEffect(() => {
    Object.assign(window, { __qa: { setOpen, setText, setDestination, setReadiness: (on: boolean) => setReadiness(on ? BLOCKERS : []), setTheme: (name: ThemeName) => applyTheme(name), launched: () => launched, continued: () => continued } });
    document.documentElement.dataset.qaReady = "true";
  }, [launched, continued]);
  return <>
    <header className="qa-topbar rl-app-header" />
    <div className="qa-body">
      <aside className="qa-sidebar" />
      <main className="qa-stage" data-rl-door-plate />
    </div>
    <MonochatIsland landing pill={false} surfaceKey="start" onVisibilityChange={setVisible}
      open={open} onOpenChange={setOpen} context="New session" busy={false}>
      <FrontDoor floating welcome visible={visible} autoFocusOnShow={false} recents={[]}
        choice={project ? { path: project } : null} onChoiceChange={(next) => setProject(next?.path ?? null)}
        projectOptions={[{ path: "/Users/me/projects/din", name: "din", source: "session" }]} openFolder={null} lastLaunchProject={null} onResolvedProjectChange={noop}
        attachments={[]} onAttachmentsChange={noop} readiness={readiness} onFix={async () => true} pending={null}
        onLaunch={() => { setLaunched("plan"); setText(""); }} onRun={() => { setLaunched("run"); setText(""); }} refusal={null}
        onDrafter={noop} onChat={() => { setLaunched("chat"); setText(""); }} chatEnabled
        destination={destination} onDestinationChange={setDestination}
        backend={choice} onBackendChange={setChoice} modelCatalogs={CATALOGS} onNeedModels={noop} onRefreshModels={noop}
        onCancelPending={noop} onRevealPending={noop} onCreateProject={async () => null} focusNonce={0} consumeSeed={() => ""}
        flow={{
          manyHarnesses: false,
          strip: query.get("strip") !== "0",
          continues: query.get("continues") === "1" ? CONTINUES : [],
          onContinue: setContinued,
        }}
      />
    </MonochatIsland>
  </>;
}

applyTheme((query.get("theme") ?? "aurora") as ThemeName);
createRoot(document.getElementById("root")!).render(<Fixture />);
