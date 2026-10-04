import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { EditorContent, useEditor } from "@tiptap/react";
import { DrafterToolbar } from "../../src/components/DrafterToolbar";
import { DocWidthToggle } from "../../src/components/DocWidthToggle";
import { MenuOverlayProvider } from "../../src/components/menuOverlay";
import { drafterExtensions } from "../../src/editor/extensions/drafterExtensions";
import { docArticleWidth } from "../../src/lib/docControl";
import { isResizing } from "../../src/lib/resizeSession";
import { applyTheme } from "../../src/theme/applyTheme";
import "../../src/styles.css";
import "./fixture.css";
const log: { commits: unknown[]; toggles: number; overlays: number } = { commits: [], toggles: 0, overlays: 0 };
const register = (delta: number) => { log.overlays += delta; };
function Fixture() {
  const editor = useEditor({ extensions: drafterExtensions(), content: "<h2>A plan worth reviewing</h2><p>Use the formatting ribbon to shape a document. The controls below resize this real article without rerendering its text on every pointer frame.</p>" + "<p>Redline keeps the reviewer's comments and discussion beside the plan. A reading column gives long passages a comfortable measure; wider views make structured documents and tables easier to compare.</p>".repeat(5) });
  const articleRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState({ wide: false, measure: 1000 });
  const [paneWidth, setPaneWidth] = useState<number | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  useEffect(() => {
    (window as any).__qa = {
      editor, reset: (value = { wide: false, measure: 1000 }) => { log.commits = []; log.toggles = 0; setWidth(value); },
      setPaneWidth, getState: () => ({ ...width, ...log, resizing: isResizing(), selection: editor ? { from: editor.state.selection.from, to: editor.state.selection.to } : null }),
      setTheme: applyTheme,
    };
    document.documentElement.dataset.qaReady = editor ? "true" : "false";
  }, [editor, width]);
  return <MenuOverlayProvider value={register}>
    <header className="qa-heading"><strong>Redline</strong><span>Document controls · actual components with a local editor</span></header>
    <DrafterToolbar editor={editor} suggesting={suggesting} onSetSuggesting={setSuggesting} onToggleSidecar={() => {}} onGenerate={() => {}}/>
    <main className="qa-document-viewport" style={{ width: paneWidth ?? "calc(100% - 48px)" }}>
      <article ref={articleRef} style={docArticleWidth(width.wide, width.measure)}><EditorContent editor={editor}/></article>
    </main>
    <div className="qa-width-control"><DocWidthToggle wide={width.wide} measure={width.measure} articleRef={articleRef}
      onToggle={() => { log.toggles++; setWidth((previous) => ({ ...previous, wide: !previous.wide })); }}
      onCommit={(value) => { log.commits.push(value); setWidth(value); }}/></div>
    <footer className="qa-caption">Drag the width control up to widen the article. Tap to alternate between the saved measure and full width.</footer>
  </MenuOverlayProvider>;
}
applyTheme("studio");
createRoot(document.getElementById("root")!).render(<Fixture/>);
