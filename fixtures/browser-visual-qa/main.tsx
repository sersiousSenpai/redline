import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal, flushSync } from "react-dom";
import BrowserTabRail from "../../src/components/BrowserTabRail";
import BrowserHomePage from "../../src/components/BrowserHomePage";
import { MonochatIsland } from "../../src/components/MonochatIsland";
import { FrontDoor } from "../../src/components/FrontDoor";
import { writeSharedDraft } from "../../src/hooks/useSharedDraft";
import { FRONT_DOOR_TEXT_KEY } from "../../src/lib/frontDoor";
import { fallbackGroups } from "../../src/lib/tabGroups";
import type { LaunchDestination } from "../../src/lib/launch";
import { BrowserChrome } from "../../src/components/BrowserChrome";
import { BrowserDialog } from "../../src/components/BrowserSurfaces";
import { BrowserLayoutDialog, BrowserBookmarksDialog, BrowserPreferencesDialog } from "../../src/components/BrowserPagePanels";
import { BrowserTileStage, type TilePage } from "../../src/components/BrowserTileStage";
import { createBoundedPortalHost, PersistentPortalSlot } from "../../src/components/PersistentPortalSlot";
import { ChatRoom } from "../../src/components/ChatRoom";
import { BrowserChat } from "../../src/components/BrowserChat";
import { useChatWorld } from "../../src/hooks/useChatWorld";
import { resolveConversation } from "../../src/lib/browserChat/scope";
import { LINKED_MODE_KEY } from "../../src/lib/browseChatState";
import { reorderTabs, startTabPointerDrag } from "../../src/lib/browserTabDrag";
import { assignVisibleTile, swapVisibleTiles, tileBadges, visibleGrid, visibleTileIds, type BrowserLayout } from "../../src/lib/browserLayout";
import { MosaicEditDialog, MosaicManagerDialog } from "../../src/components/MosaicDialogs";
import { applyTheme } from "../../src/theme/applyTheme";
import "../../src/styles.css";
import "../../src/components/BrowserWorkspace.css";
import "./fixture.css";

const noop = () => {};
const pageActions = new Map([["browser-qa-tab-0", { kind: "click", tab: 1, at: Date.now() + 600_000 }]]);
// The page chat opens shared, under linked mode, as a returning user's would.
localStorage.setItem(LINKED_MODE_KEY, "true");
const initialTabs: TilePage[] = ["Research overview", "Evidence and source comparison", "Design notes and decisions", "Implementation reference"].map((title, i) => ({ id: `qa-tab-${i}`, browseId: `qa-page-${i}`, title, url: `https://example.test/source-${i + 1}` }));
const mosaicTabs: TilePage[] = ["Wall Street Journal", "Seeking Alpha", "Yahoo Finance", "MarketWatch", "Barron's", "Financial Times", "Bloomberg", "Reuters Markets", "CNBC"].map((title, i) => ({ id: `qa-mosaic-${i}`, browseId: `qa-mosaic-page-${i}`, title, url: `https://example.test/markets-${i + 1}` }));
const shots = new Map([...initialTabs, ...mosaicTabs].map((tab, i) => [tab.id, "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1100"><rect width="900" height="1100" fill="#faf9f6"/><rect width="900" height="64" fill="#ecebe5"/><text x="42" y="41" fill="#52564d" font-family="system-ui" font-size="18">FIELD NOTES · SOURCE ${i + 1}</text><text x="42" y="132" fill="#222921" font-family="Georgia" font-size="36">${tab.title}</text><text x="42" y="175" fill="#697263" font-family="system-ui" font-size="16">Synthetic local page · actual tile component</text>${Array.from({ length: 21 }, (_, n) => `<rect x="42" y="${225 + n * 30}" width="${n % 3 === 2 ? 620 : 795}" height="10" rx="3" fill="#dddfd6"/>`).join("")}<rect x="42" y="880" width="795" height="130" rx="10" fill="#e6ebe2"/></svg>`)]));

function Fixture() {
  const [tabs, setTabs] = useState(initialTabs), [activeId, setActiveId] = useState(initialTabs[0].id);
  const [address, setAddress] = useState(initialTabs[0].url);
  const [menuOpen, setMenuOpen] = useState(false), [dialog, setDialog] = useState("");
  const [surface, setSurface] = useState("browser"), [chatKind, setChatKind] = useState("room"), [chatOpen, setChatOpen] = useState(true);
  // The page chat's scope goes through the same structure layer the pane's does.
  const { world: chatWorld, dispatch: dispatchChat } = useChatWorld({ workspace: "regular", tabs, activeId }, () => "qa-shared");
  const pageConversation = resolveConversation(chatWorld)!;
  const [organized, setOrganized] = useState(false), [showHome, setShowHome] = useState(false);
  const [islandOpen, setIslandOpen] = useState(false);
  // The composer's text lives in the shared draft, as it does in App.
  const clearDraft = () => writeSharedDraft(FRONT_DOOR_TEXT_KEY, "");
  const [destination, setDestination] = useState<LaunchDestination>("plan");
  const [groups, setGroups] = useState(() => fallbackGroups(initialTabs));
  const [hoveredTileTab, setHoveredTileTab] = useState<string | null>(null);
  const [layout, setLayout] = useState<BrowserLayout>({ preset: "grid", tiles: initialTabs.map((tab) => tab.browseId), horizontal: .5, vertical: .5, maximized: null, focused: initialTabs[0].browseId });
  const [stageWidth, setStageWidth] = useState(1000);
  const [host] = useState(() => createBoundedPortalHost("visual-qa-chat"));
  const stageRef = useRef<HTMLDivElement>(null), slots = useRef(new Map<string, HTMLDivElement>());
  useLayoutEffect(() => {
    const node = stageRef.current; if (!node) return;
    const observer = new ResizeObserver(() => setStageWidth(node.clientWidth));
    observer.observe(node); setStageWidth(node.clientWidth);
    return () => observer.disconnect();
  }, [surface, chatOpen]);
  useEffect(() => {
    const openMosaic = () => { setTabs(mosaicTabs.slice(0, 7)); setActiveId(mosaicTabs[0].id); setLayout({ preset: "grid", grid: { rows: 3, cols: 3 }, tiles: mosaicTabs.slice(0, 7).map((tab) => tab.browseId), horizontal: .5, vertical: .5, maximized: null, focused: mosaicTabs[0].browseId }); };
    (window as any).__qa = { setOrganized, setShowHome, setIslandOpen, setSurface, setDialog, setChatKind, setChatOpen, setLayout, setTabs, openMosaic, host, getState: () => ({ surface, chatKind, chatOpen, layout, stageWidth, tabs }), setTheme: applyTheme };
    document.documentElement.dataset.qaReady = "true";
  }, [host, surface, chatKind, chatOpen, layout, stageWidth, tabs]);
  const ids = visibleTileIds(layout, tabs.map((tab) => tab.browseId), tabs.find((tab) => tab.id === activeId)?.browseId ?? tabs[0].browseId, stageWidth);
  const pages = ids.map((id) => tabs.find((tab) => tab.browseId === id)!).filter(Boolean);
  // The same projection BrowserPane hands its stage.
  const stageLayout = layout.grid ? { ...layout, grid: visibleGrid(layout, tabs.map((tab) => tab.browseId), stageWidth) } : layout;
  function select(id: string) { setActiveId(id); dispatchChat({ type: "user-select-tab", tabId: id }); setAddress(tabs.find((tab) => tab.id === id)?.url ?? ""); }
  // The page chat as the pane mounts it: a running action on the first tab,
  // the Task list and a mission in the rail. "browser-empty" is a new chat.
  const pageChat = chatKind === "browser-empty" ? { ...pageConversation, browseId: "qa-empty" } : pageConversation;
  const conversation = chatKind === "room" ? <ChatRoom companionId="qa-carried" cwd={null} dictationEnabled={false} onSelectChat={noop} onEmpty={noop} onClose={noop} presentation={surface === "room" ? "room" : "browser"}/> : <BrowserChat
    key={pageChat.browseId} conversation={pageChat} workspace="regular" onClose={noop}
    linkedMode={chatWorld.linkedMode} onToggleTabChat={() => dispatchChat({ type: "toggle-tab-chat" })} onToggleLinkedMode={() => dispatchChat({ type: "toggle-linked-mode" })}
    onResearch={noop} pageActions={pageActions} onPickElement={noop} taskList={{ nonce: 0, onOpen: noop }}
    mission={{ title: "Team plan pricing", goal: "Decide whether the team plan beats paying per seat for a five-person team over a year.", findings: 3, onOpen: noop, onSynthesize: noop }}/>;
  return <div className="qa-shell">
    <div className="qa-shell-heading"><strong>Redline</strong><span>Browser workspace · isolated visual fixture</span><small>Native pages are synthetic images</small></div>
    <main className="qa-plate">
      {surface === "browser" ? <div className="rb-workspace">
        <BrowserTabRail tabs={tabs} activeId={activeId} acting={new Set([tabs[0].id])} onSelect={select} onCloseTab={id => { setTabs(old => old.filter(tab => tab.id !== id)); if (activeId === id) setActiveId(tabs.find(tab => tab.id !== id)!.id); }} onNewTab={() => setShowHome(true)} onResize={noop}
          onTabDrag={(event, id) => startTabPointerDrag(event.nativeEvent, event.currentTarget as HTMLElement, { axis:"y", onDragging:noop, onDrop:(over, tile) => flushSync(() => { const tab=tabs.find(tab => tab.id === id)!; if(tile!==null) setLayout(old=>assignVisibleTile(old,ids,tile,tab.browseId)); else if(over && over!==id) setTabs(old=>reorderTabs(old,id,over)); }) })}
          tileBadges={tileBadges(ids)} hoveredTileTab={hoveredTileTab} onHoverTile={setHoveredTileTab} groups={groups} organized={organized} organizing={false} onMode={setOrganized} onOrganize={()=>setGroups(fallbackGroups(tabs))} onToggleGroup={id=>setGroups(old=>old.map(group=>group.id===id?{...group,collapsed:!group.collapsed}:group))}/>
        <div className="rb-workspace-pages">
        <BrowserChrome tabs={tabs} activeId={activeId} address={address} onAddress={setAddress} onAddressFocus={noop} onNavigate={noop} onBack={noop} onForward={noop} onReload={noop} onSelect={select}
          onCloseTab={(id) => { const remaining = tabs.filter((tab) => tab.id !== id); if (remaining.length) { setTabs(remaining); if (id === activeId) select(remaining[0].id); } }} onNewTab={noop} onTabDrag={(event, id) => { if ((event.target as HTMLElement).closest("button")) return; startTabPointerDrag(event.nativeEvent, event.currentTarget as HTMLElement, {
            onDragging: noop, onDrop: (over, tile) => flushSync(() => { const tab = tabs.find(tab => tab.id === id)!; if (tile !== null) setLayout(old => assignVisibleTile(old, ids, tile, tab.browseId));
              else if (over && over !== id) setTabs(old => reorderTabs(old, id, over)); }),
          }); }} tileBadges={tileBadges(ids)} hoveredTileTab={hoveredTileTab} onHoverTile={setHoveredTileTab}
          chatOpen={chatOpen} onToggleChat={() => setChatOpen(!chatOpen)} split={pages.length > 1} onArrange={() => setDialog("layout")} menuOpen={menuOpen} onMenu={setMenuOpen}
          onBookmarks={() => setDialog("bookmarks")} onAppearance={() => setDialog("long")} onPreferences={() => setDialog("preferences")} onInspect={noop} onCloseBrowser={() => setSurface("room")}
          onMosaics={() => setDialog("mosaics")} mosaic={layout.grid ? { name: "Stock News", onClose: noop } : null}/>
        <div className="qa-browser-body">{showHome ? <BrowserHomePage tabs={tabs} onOpen={url => {setAddress(url);setShowHome(false);}} onMission={noop}/> : <BrowserTileStage stageRef={stageRef} slots={slots} pages={pages} tabs={tabs} activeId={activeId} layout={stageLayout} fullscreen={false} shots={shots} showShots onFocus={select} onAssign={(index, id) => setLayout(old => assignVisibleTile(old, ids, index, id))} onSwap={(from, to) => setLayout(old => swapVisibleTiles(old, ids, from, to))} hoveredTileTab={hoveredTileTab} onHoverTile={setHoveredTileTab} onAddPage={noop} onLayout={(patch) => setLayout((old) => ({ ...old, ...patch }))} onDragging={noop}/>}
          {chatOpen && <aside className="qa-chat-dock" aria-label="Browser conversation"><PersistentPortalSlot host={host} name="browser-chat"/></aside>}
        </div>
        </div>
      </div> : surface === "room" ? <div className="qa-room"><PersistentPortalSlot host={host} name="chat-room"/></div> : <div className="qa-other"><h1>Surface switched</h1><p>The chat portal is detached and retains its mounted conversation.</p></div>}
    </main>
    {surface === "browser" && <MonochatIsland busy={false} open={false} onOpenChange={noop} compactOpen={islandOpen} onCompactChange={setIslandOpen} surfaceKey={surface} context={tabs.find(tab => tab.id === activeId)?.title ?? "Browser"}
      compact={islandOpen && <FrontDoor visible floating chips={<div className="rl-context-chips" role="group" aria-label="Attach context"><button aria-pressed="true">This page</button><button aria-pressed="false">Task list</button></div>} allowedDestinations={["plan", "run"]} autoFocusOnShow={false} choice={null} onChoiceChange={noop} projectOptions={[{path:"/tmp/qa-redline",name:"Redline",source:"folder"}]} onResolvedProjectChange={noop} attachments={[]} onAttachmentsChange={noop} readiness={[]} onFix={async()=>true} pending={null} onLaunch={clearDraft} refusal={null} onDrafter={noop} onRun={clearDraft} onChat={noop} chatEnabled={false} destination={destination} onDestinationChange={setDestination} backend={{backend:"claude-code",model:null,effort:null}} onBackendChange={noop} modelCatalogs={{codex:[]}} onNeedModels={noop} onCancelPending={noop} onRevealPending={noop} onCreateProject={async()=>null} focusNonce={0} consumeSeed={()=>""} dictationEnabled={false}/>}>
      {null}
    </MonochatIsland>}
    {createPortal(conversation, host)}
    {dialog === "layout" && <BrowserLayoutDialog layout={layout} available={tabs.length} tabs={tabs} activeBrowseId={pages[0]?.browseId} onChoose={(preset) => setLayout((old) => ({ ...old, preset, maximized: null }))} onSaveDefault={noop} onClose={() => setDialog("")}/>}
    {dialog === "bookmarks" && <BrowserBookmarksDialog bookmarks={Array.from({ length: 28 }, (_, i) => ({ title: `Saved source ${i + 1}: context and evidence for this investigation`, url: `https://example.test/long-source-path/${i}` }))} title={tabs[0].title} url={tabs[0].url} onSave={noop} onRemove={noop} onOpen={noop} onClose={() => setDialog("")}/>}
    {dialog === "mosaics" && <MosaicManagerDialog mosaics={[{ id: "mosaic:news", name: "Stock News", grid: { rows: 3, cols: 3 }, tabCount: 9, updatedAt: Date.now() - 3 * 3_600_000 }, { id: "mosaic:dev", name: "Morning dev dashboards and release notes", grid: { rows: 2, cols: 2 }, tabCount: 4, updatedAt: Date.now() - 2 * 86_400_000 }]}
      error={null} activeId={layout.grid ? "mosaic:news" : null} activeName="Stock News" startupId="mosaic:news" canSaveCurrent onOpen={noop} onEdit={() => setDialog("mosaic-edit")} onNew={() => setDialog("mosaic-edit")} onSaveCurrent={noop} onDelete={noop} onStartup={noop} onLeave={noop} onClose={() => setDialog("")}/>}
    {dialog === "mosaic-edit" && <MosaicEditDialog draft={{ id: "mosaic:news", name: "Stock News", grid: { rows: 3, cols: 3 }, entries: mosaicTabs.slice(0, 7).map((tab, i) => ({ url: tab.url, label: i < 3 ? tab.title : "" })) }} previous={null} createId={() => crypto.randomUUID()} onSave={async () => setDialog("")} onCancel={() => setDialog("")}/>}
    {dialog === "preferences" && <BrowserPreferencesDialog selectionActions onSelectionActions={noop} onClose={() => setDialog("")}/>}
    {dialog === "long" && <BrowserDialog title="Long content fixture" subtitle="The actual dialog component must keep its heading and footer visible while the body scrolls." onClose={() => setDialog("")}>{Array.from({ length: 60 }, (_, i) => <p key={i}>Setting {i + 1}. A deliberately long settings description verifies bounded dialog scrolling and visible dismissal controls.</p>)}</BrowserDialog>}
  </div>;
}
applyTheme("studio");
createRoot(document.getElementById("root")!).render(<Fixture/>);
