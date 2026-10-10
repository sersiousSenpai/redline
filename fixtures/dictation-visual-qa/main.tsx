// Two real composers as the app lays them out — the Front Door's box at rest
// and the page chat's capsule in a side column — with the real dictation host
// installed over a scripted mic (services.ts).
// scripts/dictation-visual-qa.mjs holds the key, speaks, and measures that
// the strip moves neither composer.
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { FrontDoor } from "../../src/components/FrontDoor";
import { BrowserChatComposer } from "../../src/components/BrowserChatComposer";
import { composerModel } from "../../src/lib/browserChat/turn";
import { useDictation } from "../../src/lib/useDictation";
import { installDictation } from "../../src/audio/dictationHost";
import { applyTheme } from "../../src/theme/applyTheme";
import "../../src/styles.css";
import "../../src/components/BrowserChat.css";

const noop = () => {};

function PageChat() {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const frameRef = useRef<HTMLElement | null>(null);
  const [draft, setDraft] = useState("");
  const dictation = useDictation(taRef);
  const model = composerModel({ phase: "idle", queued: 0, draft, listening: dictation.listening });
  return (
    <aside ref={frameRef} data-qa="page-chat" style={{ width: 380, display: "flex", flexDirection: "column", justifyContent: "flex-end", borderLeft: "1px solid var(--color-rule)", background: "var(--color-bg-elevated)" }}>
      <p style={{ padding: 16, color: "var(--color-ink-muted)" }}>A page conversation sits above its composer.</p>
      <div data-browser-chat-composer data-dictation-anchor data-dictation-send className="rb-composer shrink-0">
        <BrowserChatComposer taRef={taRef} frameRef={frameRef} draft={draft} setDraft={setDraft} chips={[]} onRemoveChip={noop} model={model}
          dictation={dictation} picker={<span>Sonnet</span>} attach={{ onScreenshot: noop, onImage: noop }} error={null} onSend={noop} onStop={noop}/>
      </div>
    </aside>
  );
}

function Fixture() {
  useEffect(() => {
    installDictation(() => null);
    (window as unknown as { __qa: unknown }).__qa = { setTheme: applyTheme };
    document.documentElement.dataset.qaReady = "true";
  }, []);
  return (
    <main style={{ display: "flex", height: "100vh", overflow: "hidden", background: "var(--color-paper)", color: "var(--color-ink)" }}>
      <section data-qa="door" style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center", padding: 32 }}>
        <FrontDoor floating welcome recents={[]} onOpenRecent={noop} autoFocusOnShow={false}
          visible choice={{ path: "/projects/redline" }} onChoiceChange={noop}
          projectOptions={[{ path: "/projects/redline", name: "Redline", source: "workspace" }]} onResolvedProjectChange={noop}
          attachments={[]} onAttachmentsChange={noop} readiness={[]} onFix={async () => true} pending={null} onLaunch={noop} onRun={noop} refusal={null}
          onDrafter={noop} onChat={noop} chatEnabled={false} destination="plan" onDestinationChange={noop}
          backend={{ backend: "claude-code", model: null, effort: null }} onBackendChange={noop} modelCatalogs={{}} onNeedModels={noop}
          onCancelPending={noop} onRevealPending={noop} onCreateProject={async () => null} focusNonce={0} consumeSeed={() => ""}/>
      </section>
      <PageChat/>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture/>);
