// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { missionFoundation } from "../lib/missionFoundation";
import "./MissionCapturePlayer.css";

interface CaptureFrame {
  at: number;
  mediaRef: string;
  url?: string;
  ocr?: string;
  summary?: string;
  error?: string;
}
interface Capture {
  id: string;
  status: string;
  startedAt: number;
  endedAt: number;
  url?: string;
  error?: string | null;
  recordingError?: string | null;
  ocrFailures?: number;
  keyframes?: CaptureFrame[];
  derivatives?: { ocr?: string; summary?: string; evidenceKind?: string } | null;
}

/** Reads one scoped frame at a time. A mission switch cannot display a late
 * image from the previous mission, and unmounting stops playback immediately. */
export function MissionCapturePlayer({ missionId, captureId }: { missionId: string; captureId: string }) {
  const scope = `${missionId}:${captureId}`;
  const owner = useRef(scope);
  owner.current = scope;
  const generation = useRef(0);
  const [record, setRecord] = useState<{ scope: string; value: Capture } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [image, setImage] = useState<{ identity: string; src: string } | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [retry, setRetry] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const capture = record?.scope === scope ? record.value : null;
  const frames = capture?.status === "expired" ? [] : (capture?.keyframes ?? []).slice(0, 32);
  const frame = frames[Math.min(index, Math.max(frames.length - 1, 0))];
  const identity = frame ? `${scope}:${frame.mediaRef}:${frame.at}` : "";
  const currentImage = image?.identity === identity ? image.src : null;
  const refresh = useCallback(async () => {
    const ticket = ++generation.current;
    try {
      const value = await missionFoundation<Capture>(missionId, { op: "getCapture", captureId });
      if (owner.current === scope && ticket === generation.current) {
        setRecord({ scope, value }); setError(null);
      }
    } catch (e) {
      if (owner.current === scope && ticket === generation.current) {
        setError(String(e)); setRecord(null); setImage(null); setPlaying(false);
      }
    }
  }, [missionId, captureId, scope]);
  useEffect(() => {
    setRecord(null); setIndex(0); setPlaying(false); setError(null); setRetrying(false);
    void refresh();
    const listener = listen<{ missionId: string; captureId?: string }>("mission-capture-changed", ({ payload }) => {
      if (payload.missionId === missionId && (!payload.captureId || payload.captureId === captureId)) void refresh();
    }).catch(() => () => {});
    return () => { generation.current++; void listener.then(stop => stop()).catch(() => {}); };
  }, [missionId, captureId, refresh]);
  useEffect(() => {
    setIndex(value => Math.min(value, Math.max(0, frames.length - 1)));
    if (frames.length < 2) setPlaying(false);
  }, [frames.length]);
  useEffect(() => {
    let cancelled = false;
    setImage(null); setImageError(null); setLoaded(false);
    if (!frame) return;
    const match = /^shot:\/\/([A-Za-z0-9_-]{1,64})$/.exec(frame.mediaRef);
    if (!match) { setImageError("This frame is unavailable."); setPlaying(false); return; }
    void invoke<string>("mission_capture_frame", { missionId, captureId, key: match[1] }).then(src => {
      if (cancelled || owner.current !== scope) return;
      if (!src.startsWith("data:image/png;base64,")) throw new Error("The captured image format is unavailable.");
      setImage({ identity, src });
    }).catch(e => { if (!cancelled && owner.current === scope) { setImageError(String(e)); setPlaying(false); } });
    return () => { cancelled = true; };
  }, [missionId, captureId, scope, identity, frame?.mediaRef, retry]);
  useEffect(() => {
    if (!playing || !loaded || !currentImage) return;
    if (index >= frames.length - 1) { setPlaying(false); return; }
    const delay = Math.max(250, Math.min(5000, frames[index + 1].at - frames[index].at));
    const timer = window.setTimeout(() => setIndex(value => value + 1), delay);
    return () => window.clearTimeout(timer);
  }, [playing, loaded, currentImage, index, frames]);
  const select = (next: number) => { setPlaying(false); setIndex(next); };
  const retryProcessing = async () => {
    if (retrying) return;
    setRetrying(true); setError(null);
    try {
      await invoke("mission_capture_retry", { missionId, captureId });
      if (owner.current === scope) await refresh();
    } catch (e) { if (owner.current === scope) setError(String(e)); }
    finally { if (owner.current === scope) setRetrying(false); }
  };
  return <div className="mission-capture-player" aria-label="Recorded mission activity">
    <div className="mission-capture-player-heading">
      <span>{capture ? `${new Date(capture.startedAt).toLocaleString()} · ${capture.status}` : error ? "Recording unavailable" : "Loading recording…"}</span>
      <button type="button" onClick={() => void refresh()}>Refresh recording</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {capture?.error && <p role="status">{capture.error}</p>}
    {capture?.recordingError && <p role="status">Recording ended early: {capture.recordingError}</p>}
    {(capture?.status === "failed" || (capture?.ocrFailures ?? 0) > 0) && <button type="button" disabled={retrying} onClick={() => void retryProcessing()}>{retrying ? "Queuing text processing…" : "Retry text processing"}</button>}
    {capture?.status === "expired" ? <p>This recording has expired. Its searchable content has been removed.</p> : frame ? <>
      <div className="mission-capture-player-image" aria-busy={!currentImage && !imageError}>
        {currentImage ? <img src={currentImage} alt={`Captured page, frame ${index + 1} of ${frames.length}`} onLoad={() => setLoaded(true)} onError={() => { setImageError("This frame could not be displayed."); setPlaying(false); }}/>
          : !imageError && <span>Loading frame…</span>}
        {imageError && <div role="alert"><p>{imageError}</p><button type="button" onClick={() => setRetry(value => value + 1)}>Retry frame</button></div>}
      </div>
      <div className="mission-capture-player-controls">
        <button type="button" disabled={frames.length < 2 || !!imageError} onClick={() => { if (!playing && index === frames.length - 1) setIndex(0); setPlaying(value => !value); }}>{playing ? "Pause playback" : "Play recording"}</button>
        <button type="button" disabled={index <= 0} onClick={() => select(index - 1)}>Previous frame</button>
        <button type="button" disabled={index >= frames.length - 1} onClick={() => select(index + 1)}>Next frame</button>
        <output aria-live="polite">{index + 1} / {frames.length} · +{Math.max(0, (frame.at - capture!.startedAt) / 1000).toFixed(1)}s</output>
      </div>
      {frames.length > 1 && <input aria-label="Recording frame" type="range" min={0} max={frames.length - 1} value={index} onChange={e => select(Number(e.target.value))}/>}
      {(frame.url || capture?.url) && <small className="mission-capture-player-url">{frame.url || capture?.url}</small>}
      {currentImage && !imageError && (frame.summary || capture?.derivatives?.summary) && <p>{frame.summary || capture?.derivatives?.summary}</p>}
      {frame.error && <p role="status">Text processing: {frame.error}</p>}
      {currentImage && !imageError && (frame.ocr || capture?.derivatives?.ocr) && <details><summary>Text recognized locally</summary><pre>{frame.ocr || capture?.derivatives?.ocr}</pre></details>}
      {capture?.derivatives?.evidenceKind && <small>{capture.derivatives.evidenceKind}</small>}
    </> : capture && <p>No retained frames are available yet.</p>}
  </div>;
}
