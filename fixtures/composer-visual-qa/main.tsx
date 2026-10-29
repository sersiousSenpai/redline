// The two composers, by `?scene=`: `chat`, a chat pane (ChatRoom with the
// door's composer, D27) with the "skills out of date" notice on it; `door`,
// the Home door's composer on its plate. The production components over the
// chat-stream fixture's synthetic services; scripts/composer-visual-qa.mjs
// opens the menus and measures.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatRoom } from "../../src/components/ChatRoom";
import { FrontDoor, type FrontDoorProps } from "../../src/components/FrontDoor";
import { applyTheme } from "../../src/theme/applyTheme";
import { FRONT_DOOR_TEXT_KEY } from "../../src/lib/frontDoor";
import type { BackendChoice } from "../../src/lib/backendChoice";
import type { ReadinessItem } from "../../src/lib/readiness";
import "../../src/styles.css";
import "../../src/components/MonochatIsland.css";

const noop = () => {};
const scene = new URLSearchParams(location.search).get("scene") ?? "chat";
const SKILLS: ReadinessItem = {
  id: "skill-stale", state: "warn", label: "The Redline skills are out of date",
  detail: "They teach Claude how to present a plan and fold your revisions back in. Plans still arrive without them — they just read worse.",
  fix: { label: "Install integration", kind: "install-integration" },
};

function composer(over: Partial<FrontDoorProps>, choice: BackendChoice, setChoice: (c: BackendChoice) => void) {
  return <FrontDoor floating recents={[]} onOpenRecent={noop} autoFocusOnShow={false}
    visible choice={null} onChoiceChange={noop} openFolder={null} lastLaunchProject={null}
    projectOptions={[{ path: "/Users/dev/redline", name: "redline", source: "folder" }, { path: "/Users/dev/qwallah", name: "qwallah", source: "folder" }]} onResolvedProjectChange={noop}
    attachments={[]} onAttachmentsChange={noop} readiness={[SKILLS]} onFix={async () => true} pending={null} onLaunch={noop} refusal={null}
    onDrafter={noop} onChat={noop} chatEnabled destination="plan" onDestinationChange={noop}
    backend={choice} onBackendChange={setChoice} modelCatalogs={{}} onNeedModels={noop} onRefreshModels={noop} modelStatus={{ refreshing: false, checkedAt: 1790708400000 }}
    onCancelPending={noop} onRevealPending={noop} onCreateProject={async () => null} focusNonce={0} consumeSeed={() => ""}
    {...over}/>;
}

function Scene() {
  const [choice, setChoice] = useState<BackendChoice>({ backend: "claude-code", model: null, effort: null });
  useEffect(() => {
    (window as unknown as { __qa: unknown }).__qa = { setTheme: applyTheme };
    if (scene === "chat") (window as unknown as { __turn: { set(p: unknown): void } }).__turn.set({ messages: [
      { id: "u1", role: "user", body: "Can the composer's menus open outside the card?", status: "complete" },
      { id: "a1", role: "assistant", body: "Yes. Each chip opens a popover portalled to the document body, placed above or below the chip by the room there is, so the card never clips it.", status: "complete" },
    ] });
    requestAnimationFrame(() => requestAnimationFrame(() => { document.documentElement.dataset.qaReady = "true"; }));
  }, []);
  const sidebar = <aside className="qa-sidebar"/>;
  if (scene === "door") return <div className="qa-shell">{sidebar}
    <main data-qa-scene className="qa-pane qa-door">
      <div className="rl-monochat qa-door-room" data-pose="entry">
        {composer({ welcome: true, chats: [{ id: "c1", title: "Pricing page copy" }], onOpenChat: noop }, choice, setChoice)}
      </div>
    </main>
  </div>;
  return <div className="qa-shell">{sidebar}
    <main data-qa-scene className="qa-pane">
      <ChatRoom companionId="qa" onSelectChat={noop} onEmpty={noop} cwd={null} onClose={noop} expanded
        harness={choice} onHarnessChange={setChoice}
        composer={{ draftKey: FRONT_DOOR_TEXT_KEY, render: (accessories, workbench) => composer({ welcome: false, accessories, workbench, destination: "chat" }, choice, setChoice) }}/>
    </main>
  </div>;
}

const style = document.createElement("style");
style.textContent = `
html,body,#root{height:100%;margin:0;overflow:hidden}
.qa-shell{display:flex;height:100%;background:var(--color-canvas)}
.qa-sidebar{width:clamp(200px,24vw,264px);flex:none;border-right:1px solid var(--color-rule)}
.qa-pane{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0;background:var(--color-paper);position:relative}
.qa-door{align-items:center;justify-content:center}
.qa-door-room{position:relative;display:flex;flex-direction:column;justify-content:center;height:min(760px,100%);width:min(800px,calc(100% - 48px))}
`;
document.head.append(style);
applyTheme("basic");
createRoot(document.getElementById("root")!).render(<Scene/>);
