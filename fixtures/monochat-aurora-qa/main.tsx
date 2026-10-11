import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { useFrontDoorConversation } from "../../src/hooks/useFrontDoorConversation";
import { writeSharedDraft } from "../../src/hooks/useSharedDraft";
import { MonochatIsland } from "../../src/components/MonochatIsland";
import { SurfaceChips } from "../../src/components/SurfaceChips";
import { ChatRoom } from "../../src/components/ChatRoom";
import { FrontDoor } from "../../src/components/FrontDoor";
import { IntegrationSetupDialog } from "../../src/components/IntegrationSetupDialog";
import { PaneDivider } from "../../src/components/PaneDivider";
import { Footer } from "../../src/components/Footer";
import { applyTheme } from "../../src/theme/applyTheme";
import { FRONT_DOOR_TEXT_KEY } from "../../src/lib/frontDoor";
import { isChipPressed, surfaceChips, toggleChip, visibleChips, type ChipPresses } from "../../src/lib/surfaceContext";
import type { SurfaceInfo } from "../../src/lib/activeSurface";
import type { BackendChoice } from "../../src/lib/backendChoice";
import type { DoorRecent } from "../../src/lib/doorRecents";
import "../../src/styles.css";
import "./fixture.css";
const noop = () => {};
// The composer's text lives in the shared draft, as it does in App.
const setText = (text: string) => writeSharedDraft(FRONT_DOOR_TEXT_KEY, text);
const recents: DoorRecent[] = [
  { kind: "plan", id: "s1", label: "Auth rewrite", detail: "Plan · redline — Auth rewrite" },
  { kind: "plan", id: "s2", label: "Billing export v2", detail: "Plan · redline — Billing export v2" },
  { kind: "chat", id: "qa", label: "Redline Aurora", detail: "Chat — Redline Aurora" },
  ...Array.from({ length: 6 }, (_, i) => ({ kind: "browse" as const, id: `b${i}`, label: `Research page ${i + 1} — a long title about gaussian splats and lidar`, detail: "", url: `https://example.test/${i}` })),
];
const surfaceOf = (name: string): SurfaceInfo => ({
  kind: name === "Document" ? "plan" : name === "Browser" ? "browser" : "welcome",
  id: name === "Document" ? "s1" : null, label: name === "Document" ? "Auth rewrite" : null, detail: null, projectPath: null, updatedAt: 0,
});
function Fixture() {
  const { chatId, setChatId, chats } = useFrontDoorConversation();
  // Boot starts shut, as App does: on Home the door rests on the plate.
  const [open, setOpen] = useState(false), [compact, setCompact] = useState(false), [chatInRoom, setChatInRoom] = useState(false);
  const openChat = (id: string) => { setChatId(id); setChatInRoom(true); setCompact(false); setOpen(true); };
  const [visible, setVisible] = useState(false);
  const [sidecar, setSidecar] = useState(false), [setup, setSetup] = useState(false), [surface, setSurface] = useState("Home");
  const [terminal, setTerminal] = useState(false);
  const [destination, setDestination] = useState<"chat" | "plan" | "drafter" | "run">("plan");
  const [project, setProject] = useState<string | null>("/projects/redline");
  const [choice, setChoice] = useState<BackendChoice>({ backend: "codex", model: null, effort: null });
  const [chatSlot, setChatSlot] = useState<HTMLDivElement | null>(null);
  const [presses, setPresses] = useState<ChipPresses>({ surfaceKey: "", on: {} });
  // News that never moves anything: setup left to finish, a review an agent
  // is waiting on.
  const [setupFault, setSetupFault] = useState(false), [reviewNews, setReviewNews] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { Object.assign(window, { __qa: { setOpen, setCompact, setSidecar, setSetup, setSurface, setText, openChat, setBusy, setSetupFault, setReviewNews, setTheme: applyTheme } }); document.documentElement.dataset.qaReady = "true"; }, []);
  useEffect(() => { if (!open) setChatInRoom(false); }, [open]);
  const roomChat = open && chatInRoom && !!chatId;
  const cardDestination = destination === "run" ? "run" : "plan";
  const renderComposer = (where: "door" | "card" | "chat", accessories?: React.ReactNode, workbench?: Parameters<NonNullable<React.ComponentProps<typeof ChatRoom>["composer"]>["render"]>[1]) => {
    const card = where === "card";
    const chips = visibleChips(surfaceChips(surfaceOf(surface), { page: { title: "LiDAR-GS", url: "https://github.com/x/lidar-gs" }, tasks: true }), where === "chat" ? "chat" : card ? cardDestination : destination);
    return <FrontDoor floating welcome={where === "door"} recents={recents} onOpenRecent={recent => { if (recent.kind === "chat") openChat(recent.id); }}
      chips={<SurfaceChips chips={chips} pressed={chip => isChipPressed(chip, presses, surface)} onToggle={chip => setPresses(p => toggleChip(p, surface, chip))}/>}
      autoFocusOnShow={where === "door" ? open : where === "chat" && roomChat} accessories={accessories} workbench={workbench}
      visible={where === "door" ? visible : card ? compact : roomChat} choice={project ? { path: project } : null} onChoiceChange={next => setProject(next?.path ?? null)}
      projectOptions={[{ path: "/projects/redline", name: "Redline", source: "workspace" }]} openFolder={null} lastLaunchProject={null} onResolvedProjectChange={noop}
      attachments={[]} onAttachmentsChange={noop} readiness={setupFault ? [{ id: "codex-contract-missing", state: "blocked", label: "The Codex planning integration isn't installed", detail: "Install it to bring plans back to Redline.", fix: { label: "Install integration", kind: "install-integration", backend: "codex" } }] : []} onFix={async () => true} pending={null} onLaunch={() => { setText(""); setCompact(false); }} onRun={() => { setText(""); setCompact(false); }} refusal={null}
      onDrafter={noop} onChat={noop} chatEnabled allowedDestinations={card && surface === "Browser" ? ["plan", "run"] : undefined}
      destination={card ? cardDestination : destination} onDestinationChange={next => { setDestination(next); if (card && (next === "drafter" || next === "chat")) { setCompact(false); setOpen(true); } }}
      backend={choice} onBackendChange={setChoice} modelCatalogs={{ codex: [{ slug: "qa-model", displayName: "Codex model", description: "Fixture model", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "medium" }] }} onNeedModels={noop} onRefreshModels={noop} modelStatus={{ refreshing: false, checkedAt: 1790708400000 }}
      onCancelPending={noop} onRevealPending={noop} onCreateProject={async () => null} focusNonce={0} consumeSeed={() => ""}
      chats={where === "door" ? chats.map(chat => ({ id: chat.companionId, title: chat.title })) : undefined} onOpenChat={where === "door" ? openChat : undefined}/>;
  };
  return <><nav className="qa-nav rl-app-header"><strong>REDLINE <span>AURORA</span></strong><button onClick={() => setSurface("Home")}>Home</button><button onClick={() => setSurface("Document")}>Document</button><button onClick={() => setSurface("Browser")}>Browser</button><button onClick={() => { setSidecar(true); }}>Discussion</button><button onClick={() => setSetup(true)}>Integration setup</button></nav>
    {surface === "Home" ? <main className="qa-empty-plate rl-doc-column"/> : surface === "Browser" ? <main className="qa-browser-page rl-doc-column"><h1>LiDAR-GS</h1><p>A synthetic page standing in for the native webview.</p></main> : <main className="qa-document rl-plate rl-doc-column"><div className="qa-eyebrow">PRODUCT DIRECTION · REVISION 04</div><h1>A little space.<br/>A larger possibility.</h1><p className="qa-lede">One conversation that moves with your work.</p><div className="qa-rule"/><h2>Stay inside the thought.</h2><p>The document is the center of attention. Redline waits at the edge, holding the thread until you need it. A question can become a discussion, a decision, or a coordinated run.</p><p>Each action remains connected to its source. The working context follows the conversation across documents, browser pages, reviews, and memory.</p><button id="qa-document-focus" className="qa-note" onClick={() => { setSidecar(true); }}>2 · Review the handoff between harnesses ↗</button><h2>Work with the whole team.</h2><p>Choose Codex or Claude for the next turn. Task dependencies, observed usage, and file ownership remain visible as the work progresses.</p></main>}
    {sidecar && <aside className="qa-discussion" aria-label="Document discussion"><button onClick={() => setSidecar(false)}>Close discussion</button><p>Preserve the original decision. This discussion stays beside its source.</p><textarea aria-label="Anchored reply" placeholder="Continue this discussion…"/><button>Send reply</button></aside>}
    <PaneDivider orientation="horizontal" label="terminal" collapsed={!terminal} dragging={false} onToggle={() => setTerminal(value => !value)} onPointerDown={noop}/>
    {terminal && <div className="qa-terminal rl-term-dock">Terminal · fixture</div>}
    <Footer comments={[]} sessionReady={surface !== "Home"} canSubmit={false} canApprove={false} canOrchestrate={false} waiting={false} waitingAsk={false} onSubmit={noop} onApprove={noop} onOrchestrate={noop} termCollapsed={!terminal} termTabCount={0} termHasUnseen={false} onExpandTerminal={() => setTerminal(true)} reviewNews={reviewNews} onOpenReviewNews={() => setReviewNews(null)}/>
    <MonochatIsland clearanceKey={String(terminal)} landing={surface === "Home"} surfaceKey={surface} onVisibilityChange={setVisible}
      open={open} onOpenChange={setOpen} compactOpen={compact} onCompactChange={setCompact} compact={compact && renderComposer("card")}
      context={roomChat ? "Redline Aurora" : surface === "Document" ? "Auth rewrite" : surface === "Browser" ? "LiDAR-GS" : "Front door"} busy={busy}
      onNewChat={roomChat ? () => { setChatId(null); setChatInRoom(false); } : undefined}>
      <div ref={setChatSlot} hidden={!roomChat} className="rl-frontdoor-chat-slot relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"/>
      {!roomChat && renderComposer("door")}
    </MonochatIsland>
    {chatId && chatSlot && createPortal(<ChatRoom companionId={chatId} onSelectChat={openChat} onEmpty={() => setChatId(null)} cwd={null} harness={choice} onClose={() => setOpen(false)} expanded={roomChat}
      composer={{ draftKey: FRONT_DOOR_TEXT_KEY, render: (accessories, workbench) => renderComposer("chat", accessories, workbench) }}/>, chatSlot)}
    {setup && <IntegrationSetupDialog backend="codex" health={null} busy={false} error="The previous verification timed out. Your draft is saved; retry when Codex is available." progress={null} done={false} pending onInstall={noop} onDismiss={() => setSetup(false)} onLocate={noop}/>}
  </>;
}
applyTheme("aurora");
createRoot(document.getElementById("root")!).render(<Fixture/>);
