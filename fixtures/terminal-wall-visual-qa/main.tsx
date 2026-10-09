import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Footer } from "../../src/components/Footer";
import { TerminalShelf, type ShelfChip } from "../../src/components/TerminalShelf";
import { TerminalTileHeader, type TerminalIdentity } from "../../src/components/TerminalTileHeader";
import type { TileActions } from "../../src/components/TerminalTileMenu";
import type { TermState } from "../../src/lib/termState";
import { TILE_HEADER_H } from "../../src/lib/tileGrid";
import { applyTheme } from "../../src/theme/applyTheme";
import "../../src/styles.css";

// One wall in every state the plan names: a blocked agent (amber, pulsing,
// framed), a finished turn (blue), a working agent (spinner), a dev server
// (green, port), a held plan (intercept red) and a pinned idle shell — over a
// shelf holding the same states, and the footer's "need you" chip.
const noop = () => {};
const actions: TileActions = {
  onPick: noop, onCloseTerminal: noop, onNewHere: noop, onNewHome: noop, onNewRepo: noop,
  onZoomTile: noop, onFocusTile: noop, onHintTile: noop, onRefreshCwds: noop, onTogglePin: noop, onDragStart: noop,
};
const identity = (id: string, label: string): TerminalIdentity => ({
  id, label, dir: `/Users/dev/${label.split(" ")[0]}`, icon: { src: null, mark: { cx: -0.4, cy: 0.6, view: 1.5, rot: 0.3, hue: (label.length * 47) % 360 }, tint: "hsl(200 55% 45%)" },
});
interface Tile { id: string; label: string; state: TermState; text: string | null; port?: number; held?: boolean; pinned?: boolean; focused?: boolean }
const tiles: Tile[] = [
  { id: "a", label: "redline 1", state: "needs-you", text: "Claude needs your permission", focused: true },
  { id: "b", label: "polis 1", state: "your-turn", text: "Which API key should the importer use — the staging one or prod?" },
  { id: "c", label: "redline 2", state: "working", text: "✳ Reworking the tile header" },
  { id: "d", label: "web 1", state: "serving", text: "vite", port: 5173 },
  { id: "e", label: "redline 3", state: "held", text: "Terminal wall: state-aware tiles", held: true },
  { id: "f", label: "zsh 1", state: "idle", text: null, pinned: true },
];
const chips: ShelfChip[] = [
  { id: "s1", label: "api 1", state: "needs-you", text: "Claude needs your permission", port: null, fresh: false },
  { id: "s2", label: "docs 1", state: "your-turn", text: "Done — the README now covers the shelf.", port: null, fresh: false },
  { id: "s3", label: "redline 4", state: "running", text: "cargo test", port: null, fresh: false },
  { id: "s4", label: "web 2", state: "serving", text: null, port: 3000, fresh: true },
  { id: "s5", label: "zsh 2", state: "exited", text: null, port: null, fresh: false },
];

function Fixture() {
  useEffect(() => {
    (window as unknown as { __qa: unknown }).__qa = { setTheme: applyTheme };
    document.documentElement.dataset.qaReady = "true";
  }, []);
  const cols = 3;
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--color-paper)" }}>
      <div className="rl-qa-dock" style={{ height: 420, display: "flex", flexDirection: "column", borderTop: "1px solid var(--color-rule)" }}>
        <TerminalShelf chips={chips} onPlace={noop} onDragStart={noop} />
        <div style={{ position: "relative", flex: 1 }}>
          {tiles.map((t, i) => (
            <div key={t.id} className="rl-tile-wrap" data-term-state={t.state} data-qa-tile={t.id}
              style={{ position: "absolute", left: `${(i % cols) * (100 / cols)}%`, top: `${Math.floor(i / cols) * 50}%`, width: `${100 / cols}%`, height: "50%", overflow: "hidden" }}>
              <TerminalTileHeader tile={i} identity={identity(t.id, t.label)} focused={!!t.focused} zoomed={false} state={t.state}
                port={t.port ?? null} workText={t.text} workHeld={!!t.held} pinned={!!t.pinned} actions={actions} />
              <div style={{ position: "absolute", top: TILE_HEADER_H, left: 0, right: 0, bottom: 0, padding: "6px 8px", background: "var(--color-paper)", color: "var(--color-ink)", fontFamily: "var(--font-mono)", fontSize: 13, borderRight: "1px solid var(--color-rule)", borderBottom: "1px solid var(--color-rule)" }}>
                ~/dev/{t.label.split(" ")[0]} $ {t.state === "serving" ? "npm run dev" : t.state === "idle" ? "" : "claude"}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ flex: 1 }} />
      <Footer comments={[]} sessionReady canSubmit canApprove waiting={false} waitingAsk={false}
        onSubmit={noop} onApprove={noop} onApproveLater={noop}
        termCollapsed termTabCount={11} termNeedYou={2} onJumpToNeedsYou={noop} onExpandTerminal={noop} />
    </div>
  );
}
applyTheme("basic");
createRoot(document.getElementById("root")!).render(<Fixture />);
