import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { MapEdge } from "../../lib/memoryMap";
import type { CosmosLayout, CosmosView } from "../../lib/memoryMap3d";
import { CosmosScene } from "./scene";
import "./cosmos.css";

export default function MemoryCosmosScene({ layout, edges, selectedId, selectedEdge, view, motion, onSelect, onEdge, onError }: {
  layout: CosmosLayout; edges: MapEdge[]; selectedId: string | null; selectedEdge: MapEdge | null;
  view: MutableRefObject<CosmosView>; motion: boolean;
  onSelect: (id: string | null) => void; onEdge: (edge: MapEdge | null) => void; onError: (message: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null), engine = useRef<CosmosScene | null>(null);
  const callbacks = useRef({ onSelect, onEdge, onError }); callbacks.current = { onSelect, onEdge, onError };
  const [fly, setFly] = useState(false), [captureError, setCaptureError] = useState<string | null>(null);
  const [stats, setStats] = useState<{ median: number; p95: number } | null>(null);
  useEffect(() => {
    try {
      engine.current = new CosmosScene(host.current!, {
        select: id => callbacks.current.onSelect(id), edge: edge => callbacks.current.onEdge(edge),
        camera: camera => { view.current.camera = camera; }, error: message => callbacks.current.onError(message),
        orbit: () => setFly(false), stats: value => setStats(value),
      }, view.current.camera);
    } catch (error) { callbacks.current.onError(String(error)); }
    return () => { engine.current?.dispose(); engine.current = null; };
  }, [view]);
  useEffect(() => { engine.current?.setData(layout, edges); }, [layout, edges]);
  useEffect(() => { engine.current?.setSelection(selectedId, selectedEdge); }, [selectedId, selectedEdge, layout, edges]);
  useEffect(() => { engine.current?.setMotion(motion); }, [motion]);
  return <div className={`mc-stage${motion ? "" : " mc-still"}`}>
    <div ref={host} className="mc-render" />
    <div className="mc-visor" aria-hidden />
    <div className="mc-controls" aria-label="Cosmos navigation">
      <button aria-pressed={!fly} onClick={() => { engine.current?.setFly(false); setFly(false); }}>Orbit</button>
      <button aria-pressed={fly} onClick={() => { engine.current?.setFly(true); setFly(true); }}>Fly</button>
      <button onClick={() => engine.current?.home()}>Home</button>
      {selectedId && <button onClick={() => engine.current?.approach(selectedId)}>Approach</button>}
      {fly && <button onClick={() => { setCaptureError(null); void engine.current?.capture().catch(error => setCaptureError(String(error))); }}>Capture mouse</button>}
    </div>
    <p className="mc-hint">{fly ? "Drag to look · WASD move · Q/E rise / descend · Shift faster · Esc returns to Orbit" : "Drag to orbit · Shift-drag or right-drag to pan · Scroll to travel · Double-click to approach"}</p>
    {captureError && <p role="status" className="mc-capture-error">{captureError}</p>}
    {stats && <span className="mc-stats" title={`Median frame ${stats.median.toFixed(1)} ms; p95 ${stats.p95.toFixed(1)} ms`}>{Math.round(1000 / stats.median)} fps</span>}
  </div>;
}
