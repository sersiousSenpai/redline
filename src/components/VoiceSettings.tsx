// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** TTS engines the panel can select. `system` is the built-in (free, robotic)
 *  `speechSynthesis`; `kokoro` is a free natural voice that runs locally; `openai`
 *  and `elevenlabs` are premium cloud voices (each needs the user's own key). */
export type TtsEngine = "system" | "kokoro" | "openai" | "elevenlabs";

interface TtsSettings {
  engine: string;
  hasOpenaiKey: boolean;
  openaiVoice: string;
  kokoroVoice: string;
  hasElevenKey: boolean;
  elevenVoice: string;
  pythonPath: string;
}

interface KokoroStatus {
  modelPresent: boolean;
  pythonReady: boolean;
  pythonPath: string;
  detail: string;
}

interface KokoroSetup {
  phase: string;
  received: number;
  total: number;
}

// gpt-4o-mini-tts voices.
const OPENAI_VOICES = [
  "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage",
  "shimmer", "verse",
];

// A curated subset of Kokoro-82M's voices (it ships many more).
const KOKORO_VOICES: { id: string; label: string }[] = [
  { id: "af_heart", label: "Heart — US female (warm)" },
  { id: "af_bella", label: "Bella — US female" },
  { id: "af_nicole", label: "Nicole — US female (soft)" },
  { id: "af_sarah", label: "Sarah — US female" },
  { id: "am_adam", label: "Adam — US male" },
  { id: "am_michael", label: "Michael — US male" },
  { id: "am_puck", label: "Puck — US male (lively)" },
  { id: "bf_emma", label: "Emma — UK female" },
  { id: "bf_isabella", label: "Isabella — UK female" },
  { id: "bm_george", label: "George — UK male" },
  { id: "bm_lewis", label: "Lewis — UK male" },
];

// A few ElevenLabs stock voices (IDs are stable across accounts). Any voice ID
// from the user's ElevenLabs library can be pasted in instead.
const ELEVEN_VOICES: { id: string; label: string }[] = [
  { id: "21m00Tcm4TlvDq8ikWAM", label: "Rachel — US female (calm)" },
  { id: "EXAVITQu4vr4xnSDxMaL", label: "Bella — US female (soft)" },
  { id: "ErXwobaYiN019PkySvjV", label: "Antoni — US male (warm)" },
  { id: "pNInz6obpgDQGcFmaJgB", label: "Adam — US male (deep)" },
  { id: "TxGEqnHWrfWFTfGW9XjX", label: "Josh — US male (young)" },
];

// Display only — must match ELEVEN_MODEL in src-tauri/src/tts.rs.
const ELEVEN_MODEL = "eleven_turbo_v2_5";

const mb = (n: number) => `${(n / 1_000_000).toFixed(1)} MB`;

interface VoiceSettingsProps {
  onClose: () => void;
  /** Called after a successful save with the now-active engine, so the panel
   *  can swap the live speech driver. */
  onSaved: (engine: TtsEngine) => void;
}

export function VoiceSettings({ onClose, onSaved }: VoiceSettingsProps) {
  const [engine, setEngine] = useState<TtsEngine>("system");
  const [hasKey, setHasKey] = useState(false);
  const [voice, setVoice] = useState("alloy");
  const [keyInput, setKeyInput] = useState("");
  const [kokoroVoice, setKokoroVoice] = useState("af_heart");
  const [hasElevenKey, setHasElevenKey] = useState(false);
  const [elevenVoice, setElevenVoice] = useState("21m00Tcm4TlvDq8ikWAM");
  const [elevenKeyInput, setElevenKeyInput] = useState("");
  const [kokoroStatus, setKokoroStatus] = useState<KokoroStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<KokoroSetup | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void invoke<TtsSettings>("tts_get_settings")
      .then((s) => {
        if (!alive) return;
        setEngine((s.engine as TtsEngine) || "system");
        setHasKey(s.hasOpenaiKey);
        setVoice(s.openaiVoice || "alloy");
        setKokoroVoice(s.kokoroVoice || "af_heart");
        setHasElevenKey(s.hasElevenKey);
        setElevenVoice(s.elevenVoice || "21m00Tcm4TlvDq8ikWAM");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Check the local Kokoro engine's readiness whenever it's the selected engine.
  useEffect(() => {
    if (engine !== "kokoro") return;
    let alive = true;
    void invoke<KokoroStatus>("tts_kokoro_status")
      .then((s) => {
        if (alive) setKokoroStatus(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [engine]);

  // Live download progress for the one-time model fetch.
  useEffect(() => {
    let disposed = false;
    let un: UnlistenFn | undefined;
    void listen<KokoroSetup>("kokoro-setup", (e) => setProgress(e.payload)).then(
      (u) => {
        if (disposed) u();
        else un = u;
      },
    );
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  const installKokoro = async () => {
    setInstalling(true);
    setError(null);
    setProgress(null);
    try {
      await invoke("tts_kokoro_install");
      const s = await invoke<KokoroStatus>("tts_kokoro_status");
      setKokoroStatus(s);
    } catch (e) {
      setError(String(e));
    } finally {
      setInstalling(false);
      setProgress(null);
    }
  };

  const phaseLabel = (p: string | undefined) =>
    p === "uv"
      ? "Fetching the voice toolchain…"
      : p === "python"
        ? "Downloading a private Python 3.12…"
        : p === "deps"
          ? "Installing the voice engine… (a minute or two)"
          : p === "model"
            ? "Downloading the voice model…"
            : p === "voices"
              ? "Downloading voices…"
              : "Working…";

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await invoke("tts_set_settings", {
        engine,
        // Only send a key when the user typed one, so saving the engine/voice
        // doesn't clobber a stored key (which we never read back).
        openaiKey: keyInput.trim() ? keyInput.trim() : null,
        openaiVoice: voice,
        kokoroVoice,
        elevenKey: elevenKeyInput.trim() ? elevenKeyInput.trim() : null,
        elevenVoice,
      });
      onSaved(engine);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const label: React.CSSProperties = {
    fontSize: "12px",
    fontWeight: 600,
    color: "var(--color-ink)",
  };
  const field: React.CSSProperties = {
    fontSize: "12px",
    background: "var(--color-paper)",
    color: "var(--color-ink)",
    border: "1px solid var(--color-rule)",
    borderRadius: "4px",
    padding: "5px 7px",
    width: "100%",
  };
  const muted: React.CSSProperties = {
    fontSize: "11px",
    color: "var(--color-ink-muted, #888)",
  };

  const kokoroReady =
    !!kokoroStatus && kokoroStatus.modelPresent && kokoroStatus.pythonReady;

  const statusRow = (ok: boolean, text: string) => (
    <div className="flex items-center gap-2" style={{ fontSize: "12px" }}>
      <span
        style={{
          color: ok ? "var(--color-anchor-text)" : "var(--color-ink-muted, #888)",
        }}
      >
        {ok ? "✓" : "○"}
      </span>
      <span style={{ color: "var(--color-ink)" }}>{text}</span>
    </div>
  );

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between mb-3">
        <span style={{ fontWeight: 600, color: "var(--color-ink)" }}>
          Voice settings
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded-sm px-2 py-0.5"
          style={{ color: "var(--color-ink)", cursor: "pointer", fontSize: "13px" }}
        >
          ← Back
        </button>
      </div>

      <div className="flex flex-col gap-2 mb-4">
        <span style={label}>Voice engine</span>
        <select
          value={engine}
          onChange={(e) => setEngine(e.target.value as TtsEngine)}
          style={field}
        >
          <option value="system">System voice (free, on-device)</option>
          <option value="kokoro">Kokoro — natural, on-device &amp; free (no key)</option>
          <option value="openai">OpenAI — premium, natural (needs a key)</option>
          <option value="elevenlabs">ElevenLabs — premium, most natural (needs a key)</option>
        </select>
      </div>

      {engine === "kokoro" && (
        <div className="flex flex-col gap-3">
          <span style={muted}>
            Kokoro runs fully on your Mac — free, no key, offline. The first time,
            Redline sets up a private voice engine and downloads the model
            (~250&nbsp;MB). You don't need to install anything.
          </span>

          {kokoroStatus &&
            statusRow(
              kokoroReady,
              kokoroReady ? "Natural voice is ready" : "Not set up yet",
            )}

          {!kokoroReady && (
            <div className="flex flex-col gap-1.5">
              <button
                type="button"
                onClick={installKokoro}
                disabled={installing}
                className="rounded-sm px-3 py-1.5"
                style={{
                  fontSize: "13px",
                  fontWeight: 600,
                  border: "1px solid var(--color-rule)",
                  background: "var(--color-anchor-bg)",
                  color: "var(--color-anchor-text)",
                  cursor: installing ? "default" : "pointer",
                  opacity: installing ? 0.6 : 1,
                  alignSelf: "flex-start",
                }}
              >
                {installing ? "Setting up…" : "Enable natural voice (~250 MB)"}
              </button>
              {installing && (
                <div className="flex flex-col gap-1">
                  <div
                    style={{
                      height: "6px",
                      borderRadius: "3px",
                      background: "var(--color-rule)",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width:
                          progress && progress.total
                            ? `${Math.min(100, (progress.received / progress.total) * 100)}%`
                            : "40%",
                        background: "var(--color-anchor-text)",
                        transition: "width 200ms ease",
                      }}
                    />
                  </div>
                  <span style={muted}>
                    {phaseLabel(progress?.phase)}
                    {progress && progress.total
                      ? ` — ${mb(progress.received)} / ${mb(progress.total)}`
                      : ""}
                  </span>
                </div>
              )}
              {kokoroStatus && !installing && (
                <span style={{ ...muted, color: "var(--color-warn, #b8860b)" }}>
                  {kokoroStatus.detail}
                </span>
              )}
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <span style={label}>Voice</span>
            <select
              value={kokoroVoice}
              onChange={(e) => setKokoroVoice(e.target.value)}
              style={field}
            >
              {KOKORO_VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {engine === "openai" && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <span style={label}>OpenAI API key</span>
            <input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder={hasKey ? "•••• saved — leave blank to keep" : "sk-…"}
              autoComplete="off"
              spellCheck={false}
              style={field}
            />
            <span style={muted}>
              Stored locally on this Mac only; the call is made from Redline, not
              the browser. Used with the cheap <code>gpt-4o-mini-tts</code> model.
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <span style={label}>Voice</span>
            <select value={voice} onChange={(e) => setVoice(e.target.value)} style={field}>
              {OPENAI_VOICES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {engine === "elevenlabs" && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <span style={label}>ElevenLabs API key</span>
            <input
              type="password"
              value={elevenKeyInput}
              onChange={(e) => setElevenKeyInput(e.target.value)}
              placeholder={hasElevenKey ? "•••• saved — leave blank to keep" : "sk_…"}
              autoComplete="off"
              spellCheck={false}
              style={field}
            />
            <span style={muted}>
              Stored locally on this Mac only; the call is made from Redline, not
              the browser. Uses the low-latency <code>{ELEVEN_MODEL}</code> model.
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <span style={label}>Voice</span>
            <select
              value={elevenVoice}
              onChange={(e) => setElevenVoice(e.target.value)}
              style={field}
            >
              {ELEVEN_VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
              {!ELEVEN_VOICES.some((v) => v.id === elevenVoice) && (
                <option value={elevenVoice}>{elevenVoice} (custom)</option>
              )}
            </select>
            <span style={muted}>
              Pick a stock voice, or paste any voice ID from your ElevenLabs
              library.
            </span>
          </div>
        </div>
      )}

      {error && (
        <p style={{ color: "var(--color-danger, #c0392b)", fontSize: "12px", marginTop: "10px" }}>
          {error}
        </p>
      )}

      <div className="flex items-center gap-2 mt-5">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-sm px-3 py-1.5"
          style={{
            fontSize: "13px",
            fontWeight: 600,
            border: "1px solid var(--color-rule)",
            background: "var(--color-anchor-bg)",
            color: "var(--color-anchor-text)",
            cursor: saving ? "default" : "pointer",
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-sm px-3 py-1.5"
          style={{
            fontSize: "13px",
            border: "1px solid var(--color-rule)",
            background: "transparent",
            color: "var(--color-ink)",
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
