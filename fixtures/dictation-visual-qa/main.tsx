// Every composer that takes dictation, one scene each (`?scene=`), mounted as
// the app lays it out, with the real dictation host installed over a scripted
// mic (services.ts). scripts/dictation-visual-qa.mjs holds the key, speaks,
// and measures that the strip moves nothing in the composer.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { FrontDoor, type FrontDoorProps } from "../../src/components/FrontDoor";
import { MonochatIsland } from "../../src/components/MonochatIsland";
import { ChatRoom } from "../../src/components/ChatRoom";
import { BrowserChat } from "../../src/components/BrowserChat";
import { CommentComposer } from "../../src/components/CommentComposer";
import { CommentThread } from "../../src/components/CommentThread";
import { VoicePanel } from "../../src/components/VoicePanel";
import { PromptDrafter } from "../../src/components/PromptDrafter";
import { installDictation } from "../../src/audio/dictationHost";
import { composerAt } from "../../src/audio/dictationTarget";
import { readSharedDraft, writeSharedDraft } from "../../src/hooks/useSharedDraft";
import { FRONT_DOOR_TEXT_KEY } from "../../src/lib/frontDoor";
import { applyTheme } from "../../src/theme/applyTheme";
import type { Comment, Section } from "../../src/types";
import "../../src/styles.css";
import "./fixture.css";

const noop = () => {};
const scene = new URLSearchParams(location.search).get("scene") ?? "door";
// What the harness reads and drives.
const qa = {
  setTheme: applyTheme,
  // The registered composer around the caret: what the strip sits on.
  frame: () => composerAt(document.activeElement)?.frame ?? null,
  draft: () => readSharedDraft(FRONT_DOOR_TEXT_KEY),
  clearDraft: () => writeSharedDraft(FRONT_DOOR_TEXT_KEY, ""),
};
Object.assign(window, { __qa: qa });
const PROJECTS = [{ path: "/projects/redline", name: "Redline", source: "workspace" as const }];
const comment: Comment = { id: "c-1", type: "feedback", anchorId: "A.1", body: "This anchor drifts.", createdAt: 1, status: "draft" };
const SECTIONS: Section[] = [{ anchorId: "A", blockId: "b-a", level: 1, title: "Session replay", bodyMarkdown: "Ship it.", paragraphs: [], children: [] }];

/** The door's composer, as App renders it in each of its places. */
function door(over: Partial<FrontDoorProps>) {
  return <FrontDoor floating recents={[]} onOpenRecent={noop} autoFocusOnShow={false}
    visible choice={{ path: "/projects/redline" }} onChoiceChange={noop} projectOptions={PROJECTS} openFolder={null} lastLaunchProject={null} onResolvedProjectChange={noop}
    attachments={[]} onAttachmentsChange={noop} readiness={[]} onFix={async () => true} pending={null} onLaunch={noop} onRun={noop} refusal={null}
    onDrafter={noop} onChat={noop} chatEnabled destination="plan" onDestinationChange={noop}
    backend={{ backend: "claude-code", model: null, effort: null }} onBackendChange={noop} modelCatalogs={{}} onNeedModels={noop}
    onCancelPending={noop} onRevealPending={noop} onCreateProject={async () => null} focusNonce={0} consumeSeed={() => ""} {...over}/>;
}

/** A side panel beside a page, as the browser dock and the comment pane sit. */
function Panel({ width, children }: { width: number; children: React.ReactNode }) {
  return <div className="qa-split">
    <main className="qa-page">A page beside its panel.</main>
    <aside className="qa-panel" style={{ width }}>{children}</aside>
  </div>;
}

/** The compact card sprung out of the footer pill. */
function Card() {
  const [open, setOpen] = useState(false);
  const [compact, setCompact] = useState(true);
  useEffect(() => { Object.assign(qa, { cardOpen: () => compact, doorOpen: () => open }); }, [compact, open]);
  return <>
    <main className="qa-plate">The plan the card floats over.</main>
    <footer className="rl-app-footer qa-footer"/>
    <MonochatIsland clearanceKey="" landing={false} surfaceKey="document" onVisibilityChange={noop}
      open={open} onOpenChange={setOpen} compactOpen={compact} onCompactChange={setCompact}
      compact={compact && door({ welcome: false, visible: compact })} context="Auth rewrite" busy={false}>
      {door({ welcome: true, visible: open })}
    </MonochatIsland>
  </>;
}

/** A chat in the room: ChatRoom with the door's composer in chat mode. */
function Chat() {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  return <>
    <div ref={setSlot} className="qa-room rl-frontdoor-chat-slot"/>
    {slot && createPortal(<ChatRoom companionId="qa" onSelectChat={noop} onEmpty={noop} cwd={null} onClose={noop} expanded
      composer={{ draftKey: FRONT_DOOR_TEXT_KEY, render: (accessories, workbench) => door({ welcome: false, destination: "chat", accessories, workbench }) }}/>, slot)}
  </>;
}

function Scene() {
  switch (scene) {
    case "door": return <main className="qa-plate qa-center">{door({ welcome: true })}</main>;
    case "card": return <Card/>;
    case "chat": return <Chat/>;
    case "page-chat": return <Panel width={380}><BrowserChat conversation={{ kind: "tab", browseId: "b-1", title: "LiDAR-GS", targetLabel: "browser-b1", targetTitle: "LiDAR-GS", targetNumber: 1, scope: "pinned-page", anchoredFrom: null, exception: false }} workspace="regular" onClose={noop} onAddToMission={async () => true} onAddToCart={async () => true}/></Panel>;
    case "comment": return <Panel width={360}><div className="qa-pad"><CommentComposer type="feedback" sessionId="s-1" anchorId="A.1" selectedText="the anchor" charStart={0} charEnd={10} onCancel={noop} onSubmit={async () => {}}/></div></Panel>;
    case "reply": return <Panel width={360}><div className="qa-scroll"><CommentThread sessionId="s-1" comment={comment} autoOpen/></div></Panel>;
    case "voice": return <Panel width={380}><VoicePanel sessionId="qa-plan" markdown={"# Session replay\n\nShip it."} sections={SECTIONS} onClose={noop}/></Panel>;
    case "drafter": return <div className="qa-full"><PromptDrafter draftId="d-1" doc={{ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Plan the queue tray." }] }] }}
      onPersist={noop} projectOptions={PROJECTS} selectedProject="/projects/redline" onSelectedProjectChange={noop} onLaunch={noop}/></div>;
    default: throw new Error(`Unknown scene ${scene}`);
  }
}

function Fixture() {
  useEffect(() => {
    installDictation(() => null);
    document.documentElement.dataset.qaReady = "true";
  }, []);
  return <Scene/>;
}

// Every scene starts from nothing typed: drafts outlive a reload.
localStorage.clear();
createRoot(document.getElementById("root")!).render(<Fixture/>);
