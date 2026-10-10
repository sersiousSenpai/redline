// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The studio voice in Voice settings: what it costs, whether this Mac can run
// it, the install (about 3 GB, in the background, cancellable and resumable),
// and once it is in, the voice, the style and the model, each with a ▶ to hear
// it. Its own chunk, loaded when "Studio" is picked as the engine. Everything
// it does goes through the one `tts_studio` command (tts_studio.rs).
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { playStudioSample, STUDIO_TONES, STUDIO_VOICES } from "../audio/studioTts";

/** What the card edits; saved with the rest of Voice settings, except the
 *  model, which is saved when picked because the install fetches it. */
export interface StudioPrefs {
  model: string;
  voice: string;
  style: string;
}

interface Status {
  supported: boolean;
  model: string;
  installed: boolean;
  models: Record<string, { speedRatio?: number }> | null;
  runtimeCurrent: boolean;
  state: string;
  installing: boolean;
  speedRatio: number | null;
  slow: boolean;
}

interface Preflight {
  blockers: string[];
  ramBytes: number;
  freeMemoryBytes: number;
  freeDiskBytes: number;
  needDiskBytes: number;
  needMemoryBytes: number;
}

interface Setup {
  phase: string;
  received?: number;
  total?: number;
  speedRatio?: number;
  slow?: boolean;
  message?: string;
}

const MODELS = [
  {
    id: "1.7B-CustomVoice-8bit",
    name: "Best quality",
    download: "3.1 GB",
    memory: "4.2 GB",
    note: "Reads numbers and names reliably.",
  },
  {
    id: "1.7B-CustomVoice-4bit",
    name: "Low memory",
    download: "2.3 GB",
    memory: "3.4 GB",
    note: "0.8 GB lighter; garbles some numbers and names.",
  },
];

const SAMPLE =
  "Here's how I'll sound reading your plan back to you. Tell me what to change, and we'll work through it.";
const READY = "Studio voice ready.";

const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`;

const PHASES: Record<string, string> = {
  preflight: "Checking this Mac…",
  uv: "Fetching the voice toolchain…",
  python: "Downloading a private Python…",
  deps: "Installing the voice engine…",
  model: "Downloading the voice model…",
  warm: "Warming up — the very first time takes a minute…",
  speed: "Checking how fast it speaks here…",
};

const label: React.CSSProperties = { fontSize: "12px", fontWeight: 600, color: "var(--color-ink)" };
const muted: React.CSSProperties = { fontSize: "11px", color: "var(--color-ink-muted, #888)" };
const button: React.CSSProperties = {
  fontSize: "12px",
  minHeight: "26px",
  padding: "3px 10px",
  border: "1px solid var(--color-rule)",
  borderRadius: "4px",
  color: "var(--color-ink)",
  background: "transparent",
  cursor: "pointer",
  alignSelf: "flex-start",
};
const primary: React.CSSProperties = {
  ...button,
  fontSize: "13px",
  fontWeight: 600,
  background: "var(--color-anchor-bg)",
  color: "var(--color-anchor-text)",
};

/** A preflight blocker, in words. */
function blocker(code: string, p: Preflight): string {
  switch (code) {
    case "unsupported":
      return "Needs a Mac with Apple Silicon on macOS 14 or later.";
    case "ram":
      return `Needs 16 GB of memory; this Mac has ${gb(p.ramBytes)}.`;
    case "disk":
      return `Needs ${gb(p.needDiskBytes)} of free disk; ${gb(p.freeDiskBytes)} is free.`;
    case "memory":
      return `Needs about ${gb(p.needMemoryBytes)} of free memory to speak; ${gb(p.freeMemoryBytes)} is free right now. Quit something heavy, then check again.`;
    default:
      return code;
  }
}

export function StudioVoiceCard({
  prefs,
  onChange,
  onError,
}: {
  prefs: StudioPrefs;
  onChange: (prefs: StudioPrefs) => void;
  onError: (msg: string) => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [sampling, setSampling] = useState<string | null>(null);
  const stopSample = useRef<(() => void) | null>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const refresh = () => {
    void invoke<Status>("tts_studio", { op: "status" })
      .then(setStatus)
      .catch(() => {});
    void invoke<Preflight>("tts_studio", { op: "preflight" })
      .then(setPreflight)
      .catch(() => {});
  };

  const sample = (voice: string, text: string) => {
    stopSample.current?.();
    stopSample.current = null;
    if (sampling === voice && text === SAMPLE) {
      setSampling(null);
      return;
    }
    setSampling(voice);
    stopSample.current = playStudioSample(voice, text, (err) => {
      stopSample.current = null;
      setSampling(null);
      if (err) onError(`The studio voice couldn't play the sample (${err}).`);
    });
  };

  useEffect(() => {
    refresh();
    const subs = [
      listen<Setup>("studio-setup", (e) => {
        const s = e.payload;
        setSetup(s);
        if (s.phase !== "done" && s.phase !== "error") return;
        refresh();
        // The install ends warm: say so in the voice the user is choosing.
        if (s.phase === "done") sample(prefsRef.current.voice, READY);
      }),
      listen("studio-status", refresh),
    ];
    return () => {
      for (const p of subs) void p.then((un) => un());
      stopSample.current?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount
  }, []);

  const model = MODELS.find((m) => m.id === prefs.model) ?? MODELS[0];
  const installing =
    !!status?.installing ||
    (!!setup && setup.phase !== "done" && setup.phase !== "error");
  const installed = !!status?.runtimeCurrent && !!status.models?.[model.id];
  const stoppedEarly = setup?.phase === "error" ? setup.message ?? "" : null;
  const speed = status?.models?.[model.id]?.speedRatio ?? null;

  const install = () => {
    setSetup({ phase: "preflight" });
    void invoke("tts_studio", { op: "install" }).catch((e) => {
      setSetup(null);
      onError(String(e));
    });
  };

  const pickModel = (id: string) => {
    onChange({ ...prefs, model: id });
    // Saved now: it is what an install fetches, and what the sidecar loads.
    void invoke("tts_studio", { op: "prefs", args: { model: id } })
      .then(refresh)
      .catch((e) => onError(String(e)));
  };

  const remove = () => {
    setConfirmRemove(false);
    stopSample.current?.();
    void invoke("tts_studio", { op: "remove" })
      .then(() => {
        setSetup(null);
        refresh();
      })
      .catch((e) => onError(String(e)));
  };

  const pct =
    setup?.phase === "model" && setup.total
      ? Math.min(100, ((setup.received ?? 0) / setup.total) * 100)
      : null;

  return (
    <div className="flex flex-col gap-3" data-studio-card>
      <span style={muted}>
        Studio voice — {model.download} download, about {model.memory} memory while
        speaking. The most natural voice Redline has, running fully on this Mac. It
        reads replies as they stream; until it has warmed up, Kokoro (or the system
        voice) reads in its place.
      </span>

      <div role="radiogroup" aria-label="Studio voice model" className="flex flex-col gap-1">
        {MODELS.map((m) => (
          <label key={m.id} className="flex items-start gap-2" style={{ fontSize: "12px", color: "var(--color-ink)", cursor: "pointer" }}>
            <input
              type="radio"
              name="studio-model"
              checked={m.id === model.id}
              disabled={installing}
              onChange={() => pickModel(m.id)}
              style={{ marginTop: "2px" }}
            />
            <span>
              <span style={{ fontWeight: m.id === model.id ? 600 : 400 }}>{m.name}</span>{" "}
              <span style={muted}>
                · {m.download} · {m.memory} while speaking · {m.note}
              </span>
            </span>
          </label>
        ))}
      </div>

      {status?.state === "disabled" && (
        <span style={{ ...muted, color: "var(--color-warning)" }}>
          The studio voice stopped after crashing twice, so Kokoro is reading until
          Redline restarts. Installing again resets it.
        </span>
      )}

      {installed && !installing ? (
        <div className="flex flex-col gap-1">
          <span style={{ fontSize: "12px", color: "var(--color-ink)" }}>✓ Installed</span>
          {speed !== null && (
            <span style={speed > 0.5 ? { ...muted, color: "var(--color-warning)" } : muted}>
              {speed > 0.5
                ? `It spoke at ${speed.toFixed(2)}× real time here — slower than it plays, so replies may pause. Kokoro is the safer choice on this Mac.`
                : `Speed check passed: on this Mac it makes speech ${(1 / speed).toFixed(1)} times faster than it plays.`}
            </span>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {preflight && preflight.blockers.length > 0 ? (
            <>
              {preflight.blockers.map((b) => (
                <span key={b} style={{ ...muted, color: "var(--color-warning)" }}>
                  {blocker(b, preflight)}
                </span>
              ))}
              {preflight.blockers.includes("memory") && (
                <button type="button" onClick={refresh} style={button}>
                  Check again
                </button>
              )}
            </>
          ) : (
            preflight && (
              <span style={muted}>
                ✓ This Mac can run it: {gb(preflight.freeDiskBytes)} of disk and{" "}
                {gb(preflight.freeMemoryBytes)} of memory free.
              </span>
            )
          )}

          {installing ? (
            <div className="flex flex-col gap-1">
              <div
                role="progressbar"
                aria-label="Studio voice install"
                aria-valuenow={pct === null ? undefined : Math.round(pct)}
                aria-valuemin={0}
                aria-valuemax={100}
                style={{ height: "6px", borderRadius: "3px", background: "var(--color-rule)", overflow: "hidden" }}
              >
                <div
                  style={{
                    height: "100%",
                    width: pct === null ? "40%" : `${pct}%`,
                    background: "var(--color-anchor-text)",
                    transition: "width 200ms ease",
                  }}
                />
              </div>
              <span style={muted}>
                {PHASES[setup?.phase ?? ""] ?? "Working…"}
                {pct !== null && setup?.total
                  ? ` ${gb(setup.received ?? 0)} of ${gb(setup.total)}`
                  : ""}
              </span>
              <button
                type="button"
                onClick={() => void invoke("tts_studio", { op: "cancel" }).catch(() => {})}
                style={button}
              >
                Cancel
              </button>
            </div>
          ) : (
            <>
              {stoppedEarly !== null && (
                <span style={muted}>
                  {stoppedEarly === "cancelled"
                    ? "Install paused. What it downloaded is kept."
                    : `The install stopped: ${stoppedEarly}`}
                </span>
              )}
              <button
                type="button"
                onClick={install}
                disabled={!!preflight?.blockers.length}
                style={{ ...primary, opacity: preflight?.blockers.length ? 0.5 : 1 }}
              >
                {stoppedEarly !== null ? "Resume install" : `Install the studio voice (${model.download})`}
              </button>
            </>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <span style={label}>Voice</span>
        <div role="radiogroup" aria-label="Studio voice" className="flex flex-col">
          {STUDIO_VOICES.map((v) => (
            <div key={v.id} className="flex items-center">
              <label
                className="flex items-center gap-2 flex-1"
                style={{ minHeight: "28px", fontSize: "12px", color: "var(--color-ink)", cursor: "pointer" }}
              >
                <input
                  type="radio"
                  name="studio-voice"
                  checked={v.id === prefs.voice}
                  onChange={() => onChange({ ...prefs, voice: v.id })}
                />
                <span style={{ fontWeight: v.id === prefs.voice ? 600 : 400 }}>{v.name}</span>
                <span style={muted}>{v.kind}</span>
              </label>
              <button
                type="button"
                onClick={() => sample(v.id, SAMPLE)}
                disabled={!installed || installing}
                aria-label={sampling === v.id ? "Stop the sample" : `Play a sample of ${v.name}`}
                title={installed ? undefined : "Install the studio voice first"}
                style={{
                  width: "28px",
                  height: "28px",
                  fontSize: "11px",
                  color: "var(--color-ink)",
                  cursor: installed ? "pointer" : "default",
                  opacity: installed && !installing ? 1 : 0.4,
                }}
              >
                {sampling === v.id ? "■" : "▶"}
              </button>
            </div>
          ))}
        </div>
      </div>

      <label className="flex flex-col gap-1.5">
        <span style={label}>Style</span>
        <select
          value={prefs.style}
          onChange={(e) => onChange({ ...prefs, style: e.target.value })}
          style={{
            fontSize: "12px",
            background: "var(--color-paper)",
            color: "var(--color-ink)",
            border: "1px solid var(--color-rule)",
            borderRadius: "4px",
            padding: "5px 7px",
          }}
        >
          <option value="">Natural</option>
          {Object.entries(STUDIO_TONES).map(([id, t]) => (
            <option key={id} value={id}>
              {t.label}
            </option>
          ))}
        </select>
        <span style={muted}>
          How it reads when the agent doesn't ask for a tone itself. Each style is an
          instruction tested on this model; Slow and Brisk stand in for the speed slider.
        </span>
      </label>

      {installed && !installing && (
        confirmRemove ? (
          <div className="flex items-center gap-2" role="group" aria-label="Remove the studio voice">
            <span style={{ fontSize: "12px", color: "var(--color-ink)" }}>
              Remove the studio voice and everything it downloaded?
            </span>
            <button type="button" onClick={remove} style={button}>
              Remove
            </button>
            <button type="button" onClick={() => setConfirmRemove(false)} style={button}>
              Keep
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirmRemove(true)} style={button}>
            Remove the studio voice…
          </button>
        )
      )}

      <details style={muted}>
        <summary style={{ cursor: "pointer" }}>About the studio voice</summary>
        <p style={{ marginTop: "6px" }}>
          Studio voice uses Qwen3-TTS by the Qwen team (Alibaba Cloud, Apache-2.0),
          running on MLX.
        </p>
        <p style={{ marginTop: "6px" }}>
          The model is Qwen3-TTS-12Hz-1.7B-CustomVoice, converted for MLX by
          mlx-community (both Apache-2.0). It runs on MLX (Apple, MIT) through
          mlx-audio (MIT), in a private CPython (PSF-2.0) installed with uv (Apache-2.0
          or MIT), in Redline's own data folder, apart from Redline itself. Its Python
          packages are under permissive licenses (Apache-2.0, BSD, MIT, ISC, PSF-2.0,
          MPL-2.0); numpy's is BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0.
          scipy's macOS build ships the GCC runtime libraries (GPL-3.0-or-later with
          the GCC runtime library exception) and libquadmath (LGPL-2.1-or-later),
          downloaded as scipy publishes them. Every file is pinned by its SHA-256; the
          full list is VOICE_ENGINE_NOTICES.md in Redline's source.
        </p>
      </details>
    </div>
  );
}
