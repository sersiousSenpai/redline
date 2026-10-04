import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { useFrontDoorConversation } from "../../src/hooks/useFrontDoorConversation";
import { MonochatIsland } from "../../src/components/MonochatIsland";
import { ChatRoom } from "../../src/components/ChatRoom";
import { FrontDoor } from "../../src/components/FrontDoor";
import { IntegrationSetupDialog } from "../../src/components/IntegrationSetupDialog";
import { PaneDivider } from "../../src/components/PaneDivider";
import { Footer } from "../../src/components/Footer";
import { applyTheme } from "../../src/theme/applyTheme";
import type { BackendChoice } from "../../src/lib/backendChoice";
import "../../src/styles.css";
import "./fixture.css";
const noop = () => {};
function Fixture() {
  const { chatId, setChatId, chats } = useFrontDoorConversation();
  const openChat = (id: string) => { setChatId(id); setOpen(true); };
  const [open, setOpen] = useState(false), [sidecar, setSidecar] = useState(false), [setup, setSetup] = useState(false), [surface, setSurface] = useState("Home");
  const [visible, setVisible] = useState(false), [terminal, setTerminal] = useState(false);
  const [text, setText] = useState("");
  const [destination, setDestination] = useState<"chat" | "plan" | "drafter">("chat");
  const [project, setProject] = useState<string | null>("/projects/redline");
  const [choice, setChoice] = useState<BackendChoice>({ backend: "codex", model: null, effort: null });
  const [chatSlot, setChatSlot] = useState<HTMLDivElement | null>(null);
  useEffect(() => { Object.assign(window, { __qa: { setOpen, setSidecar, setSetup, setSurface } }); document.documentElement.dataset.qaReady = "true"; }, []);
  const renderComposer = (accessories?: React.ReactNode) => <FrontDoor floating autoFocusOnShow={open} accessories={accessories}
          visible={visible} text={text} onTextChange={setText} choice={project ? { path: project } : null} onChoiceChange={next => setProject(next?.path ?? null)}
          projectOptions={[{ path: "/projects/redline", name: "Redline", source: "workspace" }]} resolvedProject={project}
          attachments={[]} onAttachmentsChange={noop} readiness={[]} onFix={async () => true} pending={null} onLaunch={noop} refusal={null}
          onDrafter={noop} onChat={noop} chatEnabled destination={destination} onDestinationChange={setDestination}
          backend={choice} onBackendChange={setChoice} modelCatalogs={{ codex: [{ slug: "qa-model", displayName: "Codex model", description: "Fixture model", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "medium" }] }} onNeedModels={noop} onRefreshModels={noop} modelStatus={{ refreshing: false, checkedAt: 1790708400000 }}
          onCancelPending={noop} onRevealPending={noop} onHowItWorks={noop} onCreateProject={async () => null} focusNonce={0} consumeSeed={() => ""} dictationEnabled={false} chats={chats.map(chat => ({ id: chat.companionId, title: chat.title }))} onOpenChat={openChat}/>;
  return <><nav className="qa-nav"><strong>REDLINE <span>AURORA</span></strong><button onClick={() => setSurface("Home")}>Home</button><button onClick={() => setSurface("Document")}>Document</button><button onClick={() => setSurface("Browser")}>Browser</button><button onClick={() => { setSidecar(true); }}>Discussion</button><button onClick={() => setSetup(true)}>Integration setup</button></nav>
    {surface === "Home" ? <main className="rl-monochat-rest" aria-hidden="true"/> : <main className="qa-document rl-plate"><div className="qa-eyebrow">PRODUCT DIRECTION · REVISION 04</div><h1>A little space.<br/>A larger possibility.</h1><p className="qa-lede">One conversation that moves with your work.</p><div className="qa-rule"/><h2>Stay inside the thought.</h2><p>The document is the center of attention. Redline waits at the edge, holding the thread until you need it. A question can become a discussion, a decision, or a coordinated run.</p><p>Each action remains connected to its source. The working context follows the conversation across documents, browser pages, reviews, and memory.</p><button id="qa-document-focus" className="qa-note" onClick={() => { setSidecar(true); }}>2 · Review the handoff between harnesses ↗</button><h2>Work with the whole team.</h2><p>Choose Codex or Claude for the next turn. Task dependencies, observed usage, and file ownership remain visible as the work progresses.</p></main>}
    {sidecar && <aside className="qa-discussion" aria-label="Document discussion"><button onClick={() => setSidecar(false)}>Close discussion</button><p>Preserve the original decision. This discussion stays beside its source.</p><textarea aria-label="Anchored reply" placeholder="Continue this discussion…"/><button>Send reply</button></aside>}
    <PaneDivider orientation="horizontal" label="terminal" collapsed={!terminal} dragging={false} onToggle={() => setTerminal(value => !value)} onPointerDown={noop}/>
    {terminal && <div className="qa-terminal">Terminal · fixture</div>}
    <Footer comments={[]} sessionReady={surface !== "Home"} canSubmit={false} canApprove={false} canOrchestrate={false} waiting={false} waitingAsk={false} onSubmit={noop} onApprove={noop} onOrchestrate={noop} termCollapsed={!terminal} termTabCount={0} termHasUnseen={false} onExpandTerminal={() => setTerminal(true)}/>
    <MonochatIsland clearanceKey={String(terminal)} landing={surface === "Home"} surfaceKey={surface} onVisibilityChange={setVisible} open={open} onOpenChange={setOpen} context={`${surface} · Aurora direction`} busy={false}>
      <div ref={setChatSlot} style={{ display: chatId ? "contents" : "none" }}/>
      {!chatId && renderComposer()}
    </MonochatIsland>
    {chatId && chatSlot && createPortal(<ChatRoom companionId={chatId} onSelectChat={openChat} onEmpty={() => setChatId(null)} cwd={null} dictationEnabled={false} harness={choice} onClose={() => setOpen(false)} onSent={() => setOpen(true)}
      composer={{ text, onTextChange: setText, render: renderComposer }}/>, chatSlot)}
    {setup && <IntegrationSetupDialog backend="codex" health={null} busy={false} error="The previous verification timed out. Your draft is saved; retry when Codex is available." progress={null} done={false} pending onInstall={noop} onDismiss={() => setSetup(false)} onLocate={noop}/>}
  </>;
}
applyTheme("aurora");
createRoot(document.getElementById("root")!).render(<Fixture/>);
