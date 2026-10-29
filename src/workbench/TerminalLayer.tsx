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

import { forwardRef, memo, useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type RefObject } from "react";

import { TerminalTabs, type PeerWall, type TerminalTabsHandle } from "../components/TerminalTabs";
import { rafCoalesce } from "../lib/raf";
import { stageInsets, useStageDock } from "../lib/stageDock";
import { releaseHiddenCaret } from "./caret";
import type { WallData, WorkbenchState } from "./model";
import { primaryWall, selectVisibleWalls, wallFrames, type WallFrame } from "./wall";
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

// ── The layer ──────────────────────────────────────────────────────────────

type PassThrough = Omit<ComponentProps<typeof TerminalTabs>, "ref" | "wallKey" | "wall" | "onWallChange" | "onPlaceTerminal" | "collapsed" | "solo" | "others" | "frame" | "peers" | "onPeerFocus">;

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
  const visibleWalls = useWorkbench(store, selectVisibleWalls);
  // The wall the one TerminalTabs works on (W5: several may be on screen;
  // D7: still ONE layer, never a portal per terminal). It stays put while
  // focus is in a pane that is no wall, so a click into the plan between
  // two walls swaps nothing.
  const lastPrimary = useRef<string | null>(null);
  const pane = primaryWall(visibleWalls, lastPrimary.current);
  lastPrimary.current = pane?.id ?? lastPrimary.current;
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
  // Every wall on screen with its slot registered, in reading order. Two or
  // more (and no CLI view): the layer spans them all.
  const wallIds = visibleWalls.walls.map((w) => w.id).join(" ");
  const slotKey = useSyncExternalStore(subscribeSlots, () => wallIds.split(" ").filter((id) => id && slots.has(id)).join(" "));
  const multi = !cli && slotKey.includes(" ");
  const target = cli?.el ?? slot;
  const onScreen = target !== null;

  const layerRef = useRef<HTMLDivElement | null>(null);
  const targetRef = useMemo(() => ({ current: target }), [target]);
  useStageDock(layerRef, targetRef, onScreen && !multi);
  const frames = useWallsDock(layerRef, multi ? slotKey : "");
  const frame = multi && paneId ? (frames?.get(paneId) ?? null) : null;
  const peers = useMemo<PeerWall[] | undefined>(() => {
    if (!multi || !frames) return undefined;
    return visibleWalls.walls.flatMap((w) => {
      const f = frames.get(w.id);
      return w.id !== paneId && f ? [{ key: w.id, tiles: w.data.tiles, zoomed: w.data.zoomed, frame: f }] : [];
    });
  }, [multi, frames, visibleWalls, paneId]);
  // A press on another wall's tile makes that wall the one worked on.
  const onPeerFocus = useCallback((key: string) => store.dispatch({ type: "focusPane", paneId: key }), [store]);
  // Leaving the terminals (another tab, another session, the Agent pane's
  // Chat view) takes the caret with it: xterm's helper textarea, hidden
  // with the layer, would otherwise keep focus — swallowing keys meant
  // elsewhere, and carrying macOS's input-source bubble to a stray spot
  // mid-pane. A blur alone left the bubble up (the re-walk): the focus goes
  // to the shown tab's pane root, a real visible element (`caret.ts`), and
  // the helper textareas sit off screen while the layer does
  // (`data-offscreen`, styles.css).
  useLayoutEffect(() => {
    if (onScreen) return;
    releaseHiddenCaret(layerRef.current);
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
      data-offscreen={onScreen ? undefined : ""}
      data-walls={multi ? "" : undefined}
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
        frame={frame}
        peers={peers}
        onPeerFocus={onPeerFocus}
      />
    </div>
  );
}));

/** While `ids` (space-separated wall pane ids, two or more) are on screen,
 *  keep `layer` over the union of their slots and report each wall's frame
 *  of it, following every resize of any of them — a divider between two
 *  walls moves both frames, the union stays. Null while off. */
function useWallsDock(layer: RefObject<HTMLElement | null>, ids: string): Map<string, WallFrame> | null {
  const [frames, setFrames] = useState<Map<string, WallFrame> | null>(null);
  useLayoutEffect(() => {
    const el = layer.current;
    const list = ids ? ids.split(" ") : [];
    const els = list.map((id) => slots.get(id)).filter((x): x is HTMLElement => !!x);
    if (!el || els.length < 2) {
      setFrames(null);
      return;
    }
    const host = (el.offsetParent as HTMLElement | null) ?? el.parentElement;
    if (!host) return;
    const place = () => {
      const boxes = new Map<string, DOMRect>();
      list.forEach((id, i) => {
        const slot = els[i];
        if (slot) boxes.set(id, slot.getBoundingClientRect());
      });
      const laid = wallFrames(boxes);
      if (!laid) return;
      const at = stageInsets(host.getBoundingClientRect(), laid.union);
      el.style.top = `${Math.round(at.top)}px`;
      el.style.left = `${Math.round(at.left)}px`;
      el.style.right = `${Math.round(at.right)}px`;
      el.style.bottom = `${Math.round(at.bottom)}px`;
      setFrames((prev) => (prev && sameFrames(prev, laid.frames) ? prev : laid.frames));
    };
    const coalesced = rafCoalesce(place);
    place();
    const ro = new ResizeObserver(() => coalesced());
    for (const slot of els) ro.observe(slot);
    ro.observe(host);
    window.addEventListener("resize", coalesced);
    return () => {
      coalesced.cancel();
      ro.disconnect();
      window.removeEventListener("resize", coalesced);
      for (const side of ["top", "left", "right", "bottom"] as const) el.style[side] = "";
    };
  }, [layer, ids]);
  return ids ? frames : null;
}

function sameFrames(a: ReadonlyMap<string, WallFrame>, b: ReadonlyMap<string, WallFrame>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, f] of a) {
    const g = b.get(id);
    if (!g || Math.abs(f.left - g.left) > 1e-4 || Math.abs(f.top - g.top) > 1e-4 || Math.abs(f.width - g.width) > 1e-4 || Math.abs(f.height - g.height) > 1e-4) return false;
  }
  return true;
}
