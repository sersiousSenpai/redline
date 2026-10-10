// One scene per chat surface, chosen by `?scene=`: the production chat
// components, mounted where they sit in the app at the size they get there,
// over the synthetic turn store in services.ts. scripts/chat-stream-visual-qa.mjs
// drives the store and measures.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { ChatRoom } from "../../src/components/ChatRoom";
import { FrontDoor } from "../../src/components/FrontDoor";
import { BrowserChat } from "../../src/components/BrowserChat";
import { MissionChat } from "../../src/components/MissionChat";
import { MemoryAsk } from "../../src/components/MemoryAsk";
import { ReviewThread } from "../../src/components/ReviewThread";
import { CommentThread } from "../../src/components/CommentThread";
import { DraftThread } from "../../src/components/DrafterSidecar";
import { applyTheme } from "../../src/theme/applyTheme";
import { FRONT_DOOR_TEXT_KEY } from "../../src/lib/frontDoor";
import type { BackendChoice } from "../../src/lib/backendChoice";
import type { Comment, Mission } from "../../src/types";
import "../../src/styles.css";
import "./fixture.css";

const noop = () => {};
const scene = new URLSearchParams(location.search).get("scene") ?? "card";
const ready = () => { document.documentElement.dataset.qaReady = "true"; };
const comment: Comment = { id: "c-1", type: "feedback", anchorId: "A.1", body: "This anchor drifts.", createdAt: 1, status: "draft" };
const mission = { missionId: "m-1", title: "Splat survey", goal: "Compare lidar splat pipelines", createdAt: 1, updatedAt: 1, status: "active" } as unknown as Mission;

/** A side panel beside a synthetic page, as the browser dock and the comment
 *  pane sit. `scroll` gives the panel its own scroller for a thread that
 *  grows in place (review, comment, Drafter threads). */
function Panel({ width, scroll, children }: { width: number; scroll?: boolean; children: React.ReactNode }) {
  return <div className="qa-split">
    <main className="qa-page">Synthetic page</main>
    <aside data-qa-scene className="qa-panel" style={{ width }}>
      {scroll ? <div data-qa-scroller className="qa-panel-scroller rl-thin-scroll-y">{children}</div> : children}
    </aside>
  </div>;
}

/** The conversation as the door hosts it: ChatRoom with the door's composer.
 *  `room` is the plate-scale reading layout; otherwise the chat sits in a
 *  card-sized slot. The slot is the card's frame only, not MonochatIsland,
 *  which the door work is rebuilding: what is measured is the chat in it. */
function DoorChat({ room }: { room: boolean }) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const [choice, setChoice] = useState<BackendChoice>({ backend: "claude-code", model: null, effort: null });
  useEffect(ready, []);
  const composer = (accessories?: React.ReactNode, workbench?: Parameters<NonNullable<React.ComponentProps<typeof ChatRoom>["composer"]>["render"]>[1]) => <FrontDoor floating welcome={false} recents={[]} onOpenRecent={noop}
    autoFocusOnShow={false} accessories={accessories} workbench={workbench}
    visible choice={{ path: "/projects/redline" }} onChoiceChange={noop}
    projectOptions={[{ path: "/projects/redline", name: "Redline", source: "workspace" }]} onResolvedProjectChange={noop}
    attachments={[]} onAttachmentsChange={noop} readiness={[]} onFix={async () => true} pending={null} onLaunch={noop} onRun={noop} refusal={null}
    onDrafter={noop} onChat={noop} chatEnabled destination="chat" onDestinationChange={noop}
    backend={choice} onBackendChange={setChoice} modelCatalogs={{}} onNeedModels={noop} onRefreshModels={noop} modelStatus={{ refreshing: false, checkedAt: 1790708400000 }}
    onCancelPending={noop} onRevealPending={noop} onCreateProject={async () => null} focusNonce={0} consumeSeed={() => ""} dictationEnabled={false} chats={[{ id: "qa", title: "Streaming QA" }]} onOpenChat={noop}/>;
  return <>
    <main className="qa-plate">Synthetic plate</main>
    <footer className="qa-footer"/>
    <div data-qa-scene ref={setSlot} className={`qa-door-chat rl-frontdoor-chat-slot ${room ? "is-room" : "is-card"}`}/>
    {slot && createPortal(<ChatRoom companionId="qa" onSelectChat={noop} onEmpty={noop} cwd={null} dictationEnabled={false} onClose={noop} expanded={room}
      harness={choice} composer={{ draftKey: FRONT_DOOR_TEXT_KEY, render: composer }}/>, slot)}
  </>;
}

function Scene() {
  useEffect(() => { if (scene !== "card" && scene !== "room") requestAnimationFrame(() => requestAnimationFrame(ready)); }, []);
  switch (scene) {
    case "card": return <DoorChat room={false}/>;
    case "room": return <DoorChat room/>;
    // With a mission running, as the dock wires it: the most actions a reply's tail carries.
    case "browser": case "browser-zoom": return <Panel width={380}><BrowserChat conversation={{ kind: "tab", browseId: "b-1", title: "LiDAR-GS", targetLabel: "browser-b1", targetTitle: "LiDAR-GS", targetNumber: 1, scope: "pinned-page", anchoredFrom: null, exception: false }} workspace="regular" onClose={noop} onAddToMission={async () => true} onAddToCart={async () => true}/></Panel>;
    case "mission": return <Panel width={380}><MissionChat mission={mission} findings={[]} onClose={noop} onRemoveFinding={noop} onEditGoal={noop}/></Panel>;
    case "memory": return <div data-qa-scene className="qa-full"><MemoryAsk onCite={noop}/></div>;
    case "review": return <Panel width={420} scroll><ReviewThread reviewId="r-1" annotationId="a-1"/></Panel>;
    case "comment": case "comment-chat": return <Panel width={360} scroll><CommentThread sessionId="s-1" comment={comment} autoOpen/></Panel>;
    case "drafter": return <Panel width={300} scroll><DraftThread draftId="d-1" commentId="c-1"/></Panel>;
    default: throw new Error(`Unknown scene ${scene}`);
  }
}

// The plan comment's chat view is a per-comment preference, read on mount.
if (scene === "comment-chat") localStorage.setItem("redline.sidecarView.s-1.c-1", "chat");
// Page chat's text size (A−/A+) is per-app, read on mount: the largest step.
localStorage.setItem("redline.browseZoom", scene === "browser-zoom" ? "1.6" : "1");
applyTheme("aurora");
try { createRoot(document.getElementById("root")!).render(<Scene/>); }
catch (error) { document.body.dataset.qaError = String((error as Error)?.stack ?? error); }
