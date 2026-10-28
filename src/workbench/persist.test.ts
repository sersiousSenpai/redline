// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FRONT_DOOR_TEXT_KEY } from "../lib/frontDoor";
import { DOC_PINNED_KEY, MAIN_SURFACE_KEY } from "../lib/mainSurface";
import { HOME_KEY, SET_CAP, emptyWorkbench, type WorkbenchState } from "./model";
import {
  LEGACY_DOC_PINNED_KEY,
  LEGACY_MAIN_SURFACE_KEY,
  LEGACY_SPLIT_RATIO_KEY,
  LEGACY_SPLIT_VERTICAL_KEY,
  WORKBENCH_KEY,
  bootToHome,
  migrateToWorkbenchOnce,
  parseWorkbench,
  persistWorkbench,
  readWorkbench,
  trimSets,
  writeWorkbench,
} from "./persist";
import { DEFAULT_DOOR_DRAFT_KEY, reduce } from "./reducer";
import { createWorkbenchStore } from "./store";

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

const sample = (): WorkbenchState => {
  let s = reduce(emptyWorkbench(), { type: "ensureDefaults", key: HOME_KEY, tabIds: ["t1"], paneIds: ["p1"] });
  s = reduce(s, { type: "splitPane", paneId: "p1", direction: "row", pane: { kind: "browser", data: { workspace: "regular" } }, newPaneId: "b" });
  s = reduce(s, { type: "selectSession", key: "plan:s1", defaults: { agentTerminalId: "ag" } });
  s = reduce(s, { type: "revealTerminal", ptyId: "sh", key: "plan:s1" });
  s = reduce(s, { type: "openTab", pane: { kind: "review", data: { repo: "/r", source: "lastCommit" } }, tabId: "rv" });
  s = reduce(s, { type: "openTab", pane: { kind: "file", data: { path: "/a.ts", line: 3 }, preview: true }, tabId: "f", paneId: "fp" });
  s = reduce(s, { type: "closeTab", tabId: "f" });
  return s;
};

describe("the stored shape", () => {
  it("keys and draft key match App's own constants", () => {
    expect(WORKBENCH_KEY).toBe("redline.workbench.v1");
    expect(DEFAULT_DOOR_DRAFT_KEY).toBe(FRONT_DOOR_TEXT_KEY);
    expect(LEGACY_MAIN_SURFACE_KEY).toBe(MAIN_SURFACE_KEY);
    expect(LEGACY_DOC_PINNED_KEY).toBe(DOC_PINNED_KEY);
  });

  it("keeps a set's filled-agent marker, and reads a hostile one as strings only, deduped and capped", () => {
    const s = sample();
    expect(s.sets["plan:s1"]?.agentsFilled).toEqual(["ag"]);
    const raw = JSON.parse(JSON.stringify(s));
    raw.sets["plan:s1"].agentsFilled = ["a", 7, "a", null, "", ...Array.from({ length: 12 }, (_, i) => `t${i}`)];
    const parsed = parseWorkbench(raw)!;
    const filled = parsed.sets["plan:s1"]!.agentsFilled!;
    expect(filled).toHaveLength(8);
    expect(filled.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(filled).size).toBe(filled.length);
    raw.sets["plan:s1"].agentsFilled = "t1";
    expect(parseWorkbench(raw)!.sets["plan:s1"]!.agentsFilled).toBeUndefined();
  });

  it("round-trips through JSON unchanged", () => {
    const storage = new MemoryStorage();
    const s = sample();
    expect(writeWorkbench(storage, s)).toBe(true);
    expect(readWorkbench(storage)).toEqual(s);
  });

  it("reads an empty workbench when the key is absent, not JSON, or not a workbench", () => {
    const storage = new MemoryStorage();
    expect(readWorkbench(storage)).toEqual(emptyWorkbench());
    storage.setItem(WORKBENCH_KEY, "{nope");
    expect(readWorkbench(storage)).toEqual(emptyWorkbench());
    storage.setItem(WORKBENCH_KEY, JSON.stringify({ v: 2, sets: {} }));
    expect(readWorkbench(storage)).toEqual(emptyWorkbench());
    storage.setItem(WORKBENCH_KEY, JSON.stringify([1, 2]));
    expect(readWorkbench(storage)).toEqual(emptyWorkbench());
    const throwing = { getItem: () => { throw new Error("quota"); }, setItem: () => { throw new Error("quota"); } };
    expect(readWorkbench(throwing)).toEqual(emptyWorkbench());
    expect(writeWorkbench(throwing, emptyWorkbench())).toBe(false);
  });

  it("repairs damage pane by pane instead of failing the whole read", () => {
    const parsed = parseWorkbench({
      v: 1,
      activeKey: "plan:dead",
      sets: {
        home: {
          order: ["t1", "ghost", "t1"],
          activeTabId: "ghost",
          tabs: {
            t1: { id: "t1", root: { split: true, direction: "sideways", children: [{ pane: "p1" }, { pane: "bad" }, { pane: "p1" }], weights: ["x"] }, focusedPaneId: "bad" },
            t2: { id: "t2", root: { pane: "p1" } },
            t3: { id: "t3", root: { pane: "orphan" } },
          },
          panes: {
            p1: { id: "p1", kind: "door", data: { draftKey: "" } },
            bad: { id: "bad", kind: "plan", data: {} },
            unused: { id: "unused", kind: "memory", data: {} },
            wrong: { id: "other", kind: "servers", data: {} },
            // The Runs place was cut: a stored runs pane is dropped like any unknown kind.
            runs: { id: "runs", kind: "runs", data: {} },
            t: { id: "t", kind: "terminals", data: { tiles: ["a", "a", 3, "b"], focus: 9, zoomed: "zz", pinned: ["b", "q"] } },
          },
          closed: [{ tab: { id: "c", root: { pane: "cp" } }, panes: [{ id: "cp", kind: "file", data: { path: "/f", line: -1 } }], index: 1.5 }, "junk"],
        },
        "plan:": { order: [] },
        "launch:l": { order: [], tabs: {}, panes: {} },
      },
      mru: ["launch:l", "plan:nope", "launch:l", 7],
      owners: { a: "launch:l", b: "plan:nope", "": "home" },
      stowed: ["x", "x", 1],
    });
    expect(parsed).not.toBeNull();
    const home = parsed!.sets.home!;
    // The split lost its unknown and duplicate leaves and collapsed to the one pane.
    expect(home.tabs.t1.root).toEqual({ pane: "p1" });
    expect(home.tabs.t1.focusedPaneId).toBe("p1");
    // t2 claimed a pane t1 already shows; t3 named a pane that does not exist.
    expect(Object.keys(home.tabs)).toEqual(["t1"]);
    expect(home.order).toEqual(["t1"]);
    expect(home.activeTabId).toBe("t1");
    expect(Object.keys(home.panes)).toEqual(["p1"]);
    expect(home.panes.p1.data).toEqual({ draftKey: DEFAULT_DOOR_DRAFT_KEY });
    expect(home.closed).toHaveLength(1);
    expect(home.closed[0].panes[0].data).toEqual({ path: "/f" });
    expect(home.closed[0].index).toBe(0);
    expect(Object.keys(parsed!.sets).sort()).toEqual(["home", "launch:l"]);
    expect(parsed!.activeKey).toBe(HOME_KEY);
    expect(parsed!.mru).toEqual(["launch:l", "home"]);
    expect(parsed!.owners).toEqual({ a: "launch:l" });
    expect(parsed!.stowed).toEqual(["x"]);
  });

  it("keeps a review on every DiffSource and drops one on none", () => {
    const review = (source: unknown) => parseWorkbench({ v: 1, sets: { home: { order: ["t"], tabs: { t: { id: "t", root: { pane: "r" } } }, panes: { r: { id: "r", kind: "review", data: { repo: "/r", source } } } } } })!.sets.home!.panes.r;
    for (const source of ["uncommitted", "staged", "unstagedPlusUntracked", "lastCommit", "vsBase", "commitSha"]) expect(review(source)?.data).toEqual({ repo: "/r", source });
    expect(review("nope")).toBeUndefined();
    // The queued run branch left with the run feature (D16).
    expect(review("runBranch")).toBeUndefined();
  });

  it("clamps a wall's tiles, focus, zoom and pins to what exists", () => {
    const parsed = parseWorkbench({
      v: 1,
      sets: { home: { order: ["t"], tabs: { t: { id: "t", root: { pane: "w" } } }, panes: { w: { id: "w", kind: "terminals", data: { tiles: ["a", "a", 3, "b"], focus: 9, zoomed: "zz", pinned: ["b", "q"] } } } } },
    });
    expect(parsed!.sets.home!.panes.w.data).toEqual({ tiles: ["a", "b"], focus: 1, zoomed: null, pinned: ["b"] });
  });

  it("keeps Home plus the 40 most recently used sets, oldest out first", () => {
    let s = emptyWorkbench();
    for (let i = 0; i < SET_CAP + 5; i++) s = reduce(s, { type: "selectSession", key: `plan:s${i}` });
    s = { ...s, owners: { pty0: "plan:s0", ptyN: `plan:s${SET_CAP + 4}` } };
    const trimmed = trimSets(s);
    expect(Object.keys(trimmed.sets)).toHaveLength(SET_CAP);
    expect(trimmed.sets.home).toBeDefined();
    expect(trimmed.sets["plan:s0"]).toBeUndefined();
    expect(trimmed.sets[`plan:s${SET_CAP + 4}`]).toBeDefined();
    expect(trimmed.owners).toEqual({ pty0: HOME_KEY, ptyN: `plan:s${SET_CAP + 4}` });
    expect(trimmed.mru).toHaveLength(SET_CAP);
    const small = emptyWorkbench();
    expect(trimSets(small)).toBe(small);
    const storage = new MemoryStorage();
    writeWorkbench(storage, s);
    expect(Object.keys(readWorkbench(storage).sets)).toHaveLength(SET_CAP);
  });
});

describe("persistWorkbench", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("writes 250 ms after the last change, flushes on pagehide, and on stop", () => {
    const storage = new MemoryStorage();
    const store = createWorkbenchStore(emptyWorkbench(), reduce);
    const listeners = new Map<string, () => void>();
    const target = {
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
    } as unknown as Window;
    const stop = persistWorkbench(store, storage, { target });
    store.dispatch({ type: "openTab", pane: { kind: "memory", data: {} }, tabId: "m" });
    vi.advanceTimersByTime(200);
    expect(storage.getItem(WORKBENCH_KEY)).toBeNull();
    store.dispatch({ type: "openTab", pane: { kind: "servers", data: {} }, tabId: "r" });
    vi.advanceTimersByTime(200);
    expect(storage.getItem(WORKBENCH_KEY)).toBeNull();
    vi.advanceTimersByTime(60);
    expect(readWorkbench(storage).sets.home!.order).toEqual(["m", "r"]);

    store.dispatch({ type: "closeTab", tabId: "r" });
    listeners.get("pagehide")!();
    expect(readWorkbench(storage).sets.home!.order).toEqual(["m"]);

    store.dispatch({ type: "closeTab", tabId: "m" });
    stop();
    expect(readWorkbench(storage).sets.home!.order).toHaveLength(1);
    expect(listeners.has("pagehide")).toBe(false);
    // Stopped: a later change never writes.
    store.dispatch({ type: "openTab", pane: { kind: "servers", data: {} }, tabId: "sv" });
    vi.advanceTimersByTime(1000);
    expect(readWorkbench(storage).sets.home!.tabs.sv).toBeUndefined();
  });
});

describe("migrateToWorkbenchOnce", () => {
  it("is a no-op once the workbench key exists", () => {
    const storage = new MemoryStorage();
    storage.setItem(WORKBENCH_KEY, "{}");
    storage.setItem(LEGACY_MAIN_SURFACE_KEY, JSON.stringify("browser"));
    expect(migrateToWorkbenchOnce(storage)).toBeNull();
    expect(storage.getItem(WORKBENCH_KEY)).toBe("{}");
  });

  it("a fresh install, or the document surface, lands on a door sharing the Front Door's sentence", () => {
    const storage = new MemoryStorage();
    const fresh = migrateToWorkbenchOnce(storage)!;
    expect(fresh.sets.home!.order).toHaveLength(1);
    const pane = fresh.sets.home!.panes[fresh.sets.home!.tabs[fresh.sets.home!.order[0]].focusedPaneId];
    expect(pane).toMatchObject({ kind: "door", data: { draftKey: FRONT_DOOR_TEXT_KEY } });
    expect(readWorkbench(storage)).toEqual(fresh);
    // The legacy keys stay: App reads them while the two models coexist.
    const second = new MemoryStorage();
    second.setItem(LEGACY_MAIN_SURFACE_KEY, JSON.stringify("document"));
    second.setItem(LEGACY_DOC_PINNED_KEY, "true");
    const doc = migrateToWorkbenchOnce(second)!;
    expect(Object.values(doc.sets.home!.panes).map((p) => p.kind)).toEqual(["door"]);
    expect(second.getItem(LEGACY_MAIN_SURFACE_KEY)).toBe(JSON.stringify("document"));
  });

  it("a surface becomes the first tab; pinned, it splits with the door by split.*", () => {
    const solo = new MemoryStorage();
    solo.setItem(LEGACY_MAIN_SURFACE_KEY, JSON.stringify("memory"));
    const m = migrateToWorkbenchOnce(solo, { tabIds: ["t"], paneIds: ["d", "s"] })!;
    expect(m.sets.home!.tabs.t.root).toEqual({ pane: "s" });
    expect(m.sets.home!.panes.s.kind).toBe("memory");
    expect(m.sets.home!.panes.d).toBeUndefined();

    const pinned = new MemoryStorage();
    pinned.setItem(LEGACY_MAIN_SURFACE_KEY, JSON.stringify("browser"));
    pinned.setItem(LEGACY_DOC_PINNED_KEY, "true");
    pinned.setItem(LEGACY_SPLIT_VERTICAL_KEY, "true");
    pinned.setItem(LEGACY_SPLIT_RATIO_KEY, "0.25");
    const b = migrateToWorkbenchOnce(pinned, { tabIds: ["t"], paneIds: ["d", "s"] })!;
    expect(b.sets.home!.tabs.t.root).toEqual({ split: true, direction: "column", children: [{ pane: "d" }, { pane: "s" }], weights: [0.25, 0.75] });
    expect(b.sets.home!.tabs.t.focusedPaneId).toBe("s");
    expect(b.sets.home!.panes.s.data).toEqual({ workspace: "regular" });
    expect(b.sets.home!.panes.d.data).toEqual({ draftKey: FRONT_DOOR_TEXT_KEY });

    // A drafter, review or chat has state these keys never held: the door.
    const drafter = new MemoryStorage();
    drafter.setItem(LEGACY_MAIN_SURFACE_KEY, JSON.stringify("drafter"));
    drafter.setItem(LEGACY_SPLIT_RATIO_KEY, "garbage");
    expect(Object.values(migrateToWorkbenchOnce(drafter)!.sets.home!.panes).map((p) => p.kind)).toEqual(["door"]);
  });
});

// ── W1: boot lands on Home's door ───────────────────────────────────────────

describe("bootToHome", () => {
  it("selects Home and its first door tab, leaving the other sets' tabs alone", () => {
    let s = reduce(emptyWorkbench(), { type: "ensureDefaults", key: "home", tabIds: ["door-tab"], paneIds: ["door"] });
    s = reduce(s, { type: "openSurface", key: "home", kind: "browser", tabId: "browser-tab", paneId: "browser" });
    s = reduce(s, { type: "selectSession", key: "plan:S", defaults: {} });
    expect(s.activeKey).toBe("plan:S");
    expect(s.sets.home?.activeTabId).toBe("browser-tab");
    const booted = bootToHome(s);
    expect(booted.activeKey).toBe("home");
    expect(booted.sets.home?.activeTabId).toBe("door-tab");
    expect(booted.sets["plan:S"]?.order).toHaveLength(1);
  });
  it("opens a door in front when Home has none", () => {
    let s = reduce(emptyWorkbench(), { type: "openSurface", key: "home", kind: "browser", tabId: "browser-tab", paneId: "browser" });
    s = bootToHome(s, { tabId: "new-door", paneId: "new-door-pane" });
    expect(s.sets.home?.order).toEqual(["new-door", "browser-tab"]);
    expect(s.sets.home?.activeTabId).toBe("new-door");
    expect(s.sets.home?.panes["new-door-pane"]?.kind).toBe("door");
  });
  it("accepts a drafter with no draft yet and a review with no repo yet", () => {
    const parsed = parseWorkbench({
      v: 1,
      activeKey: "home",
      sets: { home: { order: ["a", "b"], activeTabId: "a", tabs: { a: { id: "a", root: { pane: "d" }, focusedPaneId: "d" }, b: { id: "b", root: { pane: "r" }, focusedPaneId: "r" } }, panes: { d: { id: "d", kind: "drafter", data: { draftId: "" } }, r: { id: "r", kind: "review", data: { repo: "", source: "uncommitted" } } }, closed: [] } },
      mru: ["home"],
      owners: {},
      stowed: [],
    });
    expect(parsed?.sets.home?.order).toEqual(["a", "b"]);
  });
});
