// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The terminal wall in a centre tab. One `TerminalTabs` serves every
// terminals pane: it never moves to another parent — that would rebuild every
// xterm and replay each PTY's 256 KB of history, and give a PTY a second
// attachment — so the pane holds an empty slot (`TerminalWallSlot`) and this
// layer, mounted once beside the stage in `<main>`, is pinned over whichever
// slot is on screen (`useStageDock`). The pane's data is the wall: `wallKey`
// is its id, its tiles, focus, zoom and pins come in as `wall` and go back as
// `setWall`. An Agent pane's CLI view is the same layer over that pane's box,
// showing its one terminal alone (`solo`): the attachment the layer already
// holds, never a second one.
//
// Lazy, like the panes' bodies: nothing here is on the boot path.

import { forwardRef, memo, useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ComponentProps } from "react";

import { TerminalTabs, type TerminalTabsHandle } from "../components/TerminalTabs";
import { useStageDock } from "../lib/stageDock";
import { activeTabOf, paneIdsOf, type Pane, type WallData, type WorkbenchState } from "./model";
import { useWorkbench, type WorkbenchStore } from "./store";

// ── Slots ──────────────────────────────────────────────────────────────────

const slots = new Map<string, HTMLElement>();
const slotListeners = new Set<() => void>();
function publishSlots(): void {
  for (const listener of Array.from(slotListeners)) listener();
}
function subscribeSlots(listener: () => void): () => void {
  slotListeners.add(listener);
  return () => {
    slotListeners.delete(listener);
  };
}

/** A terminals pane's body: an empty box the layer is pinned over. It
 *  registers only while its tab is the active one, so a slot in a hidden kept
 *  tab never holds the wall. */
export function TerminalWallSlot({ paneId, active }: { paneId: string; active: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    slots.set(paneId, el);
    publishSlots();
    return () => {
      if (slots.get(paneId) !== el) return;
      slots.delete(paneId);
      publishSlots();
    };
  }, [paneId, active]);
  return <div ref={ref} className="rl-wb-wall-slot" data-wb-wall-slot={paneId} />;
}

/** The terminals pane on screen: the active tab's, in the active set. */
export function selectVisibleWall(state: WorkbenchState): Pane<"terminals"> | null {
  const set = state.sets[state.activeKey];
  const tab = set ? activeTabOf(set) : null;
  if (!set || !tab) return null;
  for (const id of paneIdsOf(tab.root)) {
    const pane = set.panes[id];
    if (pane?.kind === "terminals") return pane;
  }
  return null;
}

// ── The layer ──────────────────────────────────────────────────────────────

type PassThrough = Omit<ComponentProps<typeof TerminalTabs>, "ref" | "wallKey" | "wall" | "onWallChange" | "onPlaceTerminal" | "collapsed" | "solo" | "others">;

export interface TerminalLayerProps extends PassThrough {
  store: WorkbenchStore;
  /** An Agent pane showing its PTY (its CLI view): the layer goes over that
   *  box and shows that one terminal alone. Wins over a wall. */
  cli?: { terminalId: string; el: HTMLElement } | null;
  /** Each plan session's name, by its set key: the tile menu says whose a
   *  terminal from another session is. */
  sessionLabels?: ReadonlyMap<string, string>;
}

const selectOwners = (s: WorkbenchState) => s.owners;
const selectActiveKey = (s: WorkbenchState) => s.activeKey;

// Memoized: App renders often, and every prop it passes is stable.
export const TerminalLayer = memo(forwardRef<TerminalTabsHandle, TerminalLayerProps>(function TerminalLayer({ store, cli = null, sessionLabels, ...rest }, ref) {
  const pane = useWorkbench(store, selectVisibleWall);
  // The tile menu's two groups: this set's terminals, then every other
  // session's, named (picking one moves it here, `setWall`).
  const owners = useWorkbench(store, selectOwners);
  const activeKey = useWorkbench(store, selectActiveKey);
  const others = useMemo(() => {
    const out = new Map<string, string>();
    for (const [id, key] of Object.entries(owners)) {
      if (key === activeKey) continue;
      out.set(id, sessionLabels?.get(key) ?? (key === "home" ? "Home" : key.startsWith("launch:") ? "A launch" : "Another session"));
    }
    return out;
  }, [owners, activeKey, sessionLabels]);
  const paneId = pane?.id ?? null;
  const slot = useSyncExternalStore(subscribeSlots, () => (paneId ? (slots.get(paneId) ?? null) : null));
  const target = cli?.el ?? slot;
  const onScreen = target !== null;

  const layerRef = useRef<HTMLDivElement | null>(null);
  const targetRef = useMemo(() => ({ current: target }), [target]);
  useStageDock(layerRef, targetRef, onScreen);
  // Leaving the terminals (another tab, another session, the Agent pane's
  // Chat view) takes the caret with it: xterm's helper textarea, hidden
  // with the layer, would otherwise keep focus — swallowing keys meant
  // elsewhere, and carrying macOS's input-source bubble to a stray spot
  // mid-pane. The tab now shown places its own caret (WorkbenchStage).
  useLayoutEffect(() => {
    if (onScreen) return;
    const held = document.activeElement;
    if (held instanceof HTMLElement && layerRef.current?.contains(held)) held.blur();
  }, [onScreen]);

  const onWallChange = useCallback(
    (key: string, data: WallData) => store.dispatch({ type: "setWall", paneId: key, data }),
    [store],
  );
  // On this wall while it has room, else a new Terminals tab in the set on
  // screen (the reducer's `showOnWall`).
  const onPlaceTerminal = useCallback(
    (id: string) => store.dispatch({ type: "revealTerminal", ptyId: id, key: store.getState().activeKey }),
    [store],
  );

  return (
    <div
      ref={layerRef}
      className="rl-wb-terminal-layer"
      // Off screen the layer is out of layout altogether; its terminals keep
      // running (each stashes its output unparsed until shown).
      style={onScreen ? undefined : { display: "none" }}
    >
      <TerminalTabs
        ref={ref}
        {...rest}
        wallKey={paneId}
        wall={pane?.data ?? null}
        onWallChange={onWallChange}
        onPlaceTerminal={onPlaceTerminal}
        solo={cli?.terminalId ?? null}
        others={others}
        collapsed={!onScreen}
      />
    </div>
  );
}));
