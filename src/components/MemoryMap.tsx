// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { usePersistedState } from "../theme/usePersistedState";
import { DEFAULT_EDGE_TOGGLES, EDGE_KINDS, EDGE_LABEL, visibleEdges, type EdgeKind, type MapEdge, type MemoryMapData } from "../lib/memoryMap";
import { COSMOS_LAYOUT_VERSION, layoutMap3d, nodeFocus, type CosmosLayout, type CosmosView } from "../lib/memoryMap3d";
import type { TimelineFocus } from "../lib/timeline";
import "./memory-cosmos/cosmos.css";
const Scene = lazy(() => import("./memory-cosmos/MemoryCosmosScene"));

export function MemoryMapTab({ onFocus, view: retainedView }: { onFocus: (f: TimelineFocus) => void; view?: MutableRefObject<CosmosView> }) {
  const ownView = useRef<CosmosView>({}); const view = retainedView ?? ownView;
  const [data, setData] = useState<MemoryMapData | null>(null), [error, setError] = useState<string | null>(null);
  const [sceneError, setSceneError] = useState<string | null>(null), [retry, setRetry] = useState(0);
  const [layout, setLayout] = useState<CosmosLayout | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(view.current.selectedId ?? null);
  const [selectedEdge, setSelectedEdge] = useState<MapEdge | null>(null);
  const [toggles, setToggles] = usePersistedState<Record<EdgeKind, boolean>>("redline.memory.mapEdges", DEFAULT_EDGE_TOGGLES);
  const [motion, setMotion] = usePersistedState("redline.memory.cosmosMotion", true);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  const request = useRef(0), worker = useRef<Worker | null>(null), layoutRequest = useRef(0);
  const select = useCallback((id: string | null) => { view.current.selectedId = id; setSelectedId(id); setSelectedEdge(null); }, [view]);
  const load = useCallback(async () => {
    const generation = ++request.current;
    try { const result = await invoke<MemoryMapData>("memory_map"); if (generation === request.current) { setData(result); setError(null); } }
    catch (e) { if (generation === request.current) setError(String(e)); }
  }, []);
  useEffect(() => {
    void load(); let timer: ReturnType<typeof setTimeout>;
    const later = () => { clearTimeout(timer); timer = setTimeout(() => void load(), 800); };
    const unlisteners = [listen("ledger-changed", later), listen("classmem-changed", later)];
    return () => { ++request.current; clearTimeout(timer); for (const un of unlisteners) void un.then(fn => fn()).catch(() => {}); };
  }, [load]);
  useEffect(() => {
    const preference = window.matchMedia?.("(prefers-reduced-motion: reduce)"); if (!preference) return;
    const change = () => setReducedMotion(preference.matches); preference.addEventListener("change", change);
    return () => preference.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    try { worker.current = new Worker(new URL("../lib/memoryMap3d.worker.ts", import.meta.url), { type: "module" }); }
    catch { worker.current = null; }
    return () => { worker.current?.terminate(); worker.current = null; ++layoutRequest.current; };
  }, []);
  useEffect(() => {
    if (!data) return;
    const generation = ++layoutRequest.current;
    const previous = view.current.layoutVersion === COSMOS_LAYOUT_VERSION ? view.current.positions : undefined;
    // Replace retained coordinates from an older geometry once; subsequent
    // refreshes and Timeline round trips preserve the new landmarks.
    if (!previous && view.current.positions?.length) view.current.camera = undefined;
    const apply = (next: CosmosLayout) => {
      if (generation !== layoutRequest.current) return;
      view.current.positions = next.nodes; view.current.layoutVersion = COSMOS_LAYOUT_VERSION; setLayout(next);
      if (view.current.selectedId && !next.nodes.some(n => n.id === view.current.selectedId)) select(null);
    };
    const fallback = () => {
      try { apply(layoutMap3d(data, previous)); } catch (e) { setError(`Unable to arrange memories: ${String(e)}`); }
    };
    if (!worker.current) { fallback(); return; }
    worker.current.onmessage = event => { if (event.data.request !== generation) return; if (event.data.error) setError(event.data.error); else apply(event.data.layout); };
    worker.current.onerror = () => { worker.current?.terminate(); worker.current = null; fallback(); };
    worker.current.postMessage({ request: generation, data, previous: previous ?? [] });
    return () => { if (layoutRequest.current === generation) ++layoutRequest.current; };
  }, [data, view, select]);
  const edges = useMemo(() => data && layout ? visibleEdges(data.edges, toggles, new Set(layout.nodes.map(n => n.id))) : [], [data, layout, toggles]);
  useEffect(() => { if (selectedEdge && !edges.includes(selectedEdge)) setSelectedEdge(null); }, [edges, selectedEdge]);
  const selected = layout?.nodes.find(n => n.id === selectedId);
  const focus = selected ? nodeFocus(selected) : null;
  const related = selected ? edges.filter(e => e.from === selected.id || e.to === selected.id) : [];
  const open = () => { if (focus) onFocus(focus); };
  return <section className="mc-shell" aria-label="Memory Cosmos">
    <div className="mc-toolbar">
      {EDGE_KINDS.map(kind => <button key={kind} aria-pressed={toggles[kind]} onClick={() => setToggles(prev => ({ ...prev, [kind]: !prev[kind] }))} title={kind === "co_occurs" ? "Derived: shared sessions or project; not a direct relationship" : `Show ${EDGE_LABEL[kind]} relationships`}>{EDGE_LABEL[kind]}{kind === "co_occurs" ? " (derived)" : ""}</button>)}
      <button aria-pressed={motion && !reducedMotion} disabled={reducedMotion} title={reducedMotion ? "Reduced motion is enabled in system preferences" : "Toggle ambient animation and smooth camera movement"} onClick={() => setMotion(!motion)}>Motion {motion && !reducedMotion ? "on" : "off"}</button>
      <span className="mc-count">{layout ? `${layout.nodes.length} shown · ${layout.hidden} hidden` : "Loading memories…"}</span>
    </div>
    {error && <div role="alert" className="mc-status">{error} <button onClick={() => void load()}>Retry loading</button></div>}
    <div className="mc-body">
      <div className="mc-scene-slot">
        {sceneError ? <div className="mc-status" role="alert">{sceneError} <button onClick={() => { setSceneError(null); setRetry(value => value + 1); }}>Retry 3D</button></div>
          : !layout ? <div className="mc-status" role="status">Preparing the constellation…</div>
          : !layout.nodes.length ? <div className="mc-status">No memories to map yet. Accept classes in the Catalog to begin a constellation.</div>
          : <Suspense fallback={<div className="mc-status" role="status">Opening Memory Cosmos…</div>}><Scene key={retry} layout={layout} edges={edges} selectedId={selectedId} selectedEdge={selectedEdge} view={view} motion={motion && !reducedMotion} onSelect={select} onEdge={setSelectedEdge} onError={setSceneError} /></Suspense>}
      </div>
      <aside className="mc-inspector" aria-label="Selected memory">
        {selected ? <><h3>{selected.label}</h3><p>{selected.kind} · {selected.mass} memories{selected.pinned ? " · pinned" : ""}</p>
          <button disabled={!focus} onClick={open}>Open in Timeline</button><p>{related.length} visible relationships</p>
          {related.slice(0, 20).map((edge, i) => <button key={i} aria-pressed={edge === selectedEdge} onClick={() => setSelectedEdge(edge)}>{EDGE_LABEL[edge.kind]} {edge.kind === "supersedes" ? "→ " : "· "}{layout?.nodes.find(n => n.id === (edge.from === selected.id ? edge.to : edge.from))?.label ?? "Memory"}</button>)}
          {related.length > 20 && <p>{related.length - 20} more visible connections</p>}
        </> : <><span className="mc-eyebrow">A constellation of thought</span><h3>Your quantum cosmos</h3><p>Select a memory to trace its connections. Approach to explore its neighborhood, or open it in the Timeline.</p><div className="mc-legend"><span><i className="mc-legend-core" />Size reflects memory count</span><span><i className="mc-legend-pin" />Gold marks pinned memories</span><span><i className="mc-legend-fiber" />Arcs follow memory relationships</span></div></>}
        {selectedEdge && <div role="status"><h3>{EDGE_LABEL[selectedEdge.kind]}{selectedEdge.kind === "supersedes" ? " →" : ""}</h3><p>{layout?.nodes.find(n => n.id === selectedEdge.from)?.label} → {layout?.nodes.find(n => n.id === selectedEdge.to)?.label}</p><p>{selectedEdge.basis ?? "A recorded relationship between these memories."}{selectedEdge.kind === "co_occurs" ? " This connection is derived, not an asserted relationship." : ""}</p></div>}
      </aside>
    </div>
    <details className="mc-list" open={!!sceneError}>
      <summary>Memory list · keyboard navigation and Timeline access</summary>
      <div className="mc-list-content"><label htmlFor="cosmos-memory">Memory</label><select id="cosmos-memory" value={selectedId ?? ""} onChange={e => select(e.target.value || null)}><option value="">Choose a memory…</option>{(layout?.nodes ?? []).map(node => <option key={node.id} value={node.id}>{node.label} · {node.kind} · {node.mass}</option>)}</select><button disabled={!focus} onClick={open}>Open in Timeline</button><span className="mc-count">The Timeline contains the full corpus.</span></div>
    </details>
  </section>;
}
