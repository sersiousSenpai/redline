// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { playVoiceSample } from "../audio/cloudTts";
import type {
  DictationEngine,
  DictationStatus,
  WhisperModelId,
  WhisperModelStatus,
} from "../audio/dictationTypes";
import {
  describeVoice,
  gradeRank,
  isLowGrade,
  joinBlend,
  KOKORO_VOICES,
  splitBlend,
} from "../audio/kokoroVoices";
import { polishEnabled, setPolishEnabled } from "../audio/dictationPolish";
import { loadVoicePrefs } from "../audio/speech";
import { HOLD_KEYS, loadHoldKey, saveHoldKey, type HoldKey } from "../audio/voiceHotkey";
import {
  addWord,
  forgetPair,
  loadVocabStore,
  onVocabStore,
  removeWord,
  updateVocabStore,
  type VocabStore,
} from "../audio/vocab";
import type { StudioPrefs } from "./StudioVoiceCard";

// The studio voice's card: install, voice and style. A chunk of its own, as
// most people never pick it.
const StudioVoiceCard = lazy(() =>
  import("./StudioVoiceCard").then((m) => ({ default: m.StudioVoiceCard })),
);

/** TTS engines the panel can select. `system` is the built-in (free, robotic)
 *  `speechSynthesis`; `kokoro` is a free natural voice that runs locally;
 *  `studio` is the most natural, a 3 GB local model on Apple Silicon; `openai`
 *  and `elevenlabs` are premium cloud voices (each needs the user's own key). */
export type TtsEngine = "system" | "kokoro" | "studio" | "openai" | "elevenlabs";

interface TtsSettings {
  engine: string;
  hasOpenaiKey: boolean;
  openaiVoice: string;
  kokoroVoice: string;
  hasElevenKey: boolean;
  elevenVoice: string;
  pythonPath: string;
  studioModel?: string;
  studioVoice?: string;
  studioStyle?: string;
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

const WHISPER_MODELS: Record<WhisperModelId, { name: string; note: string }> = {
  base: { name: "Whisper base", note: "quick" },
  turbo: { name: "Whisper large turbo", note: "best with names and code terms" },
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

interface VoiceSettingsProps {
  onClose: () => void;
  /** Called after a successful save with the now-active engine (and the
   *  studio voice's style), so the panel can swap the live speech driver. */
  onSaved: (engine: TtsEngine, studioStyle: string) => void;
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
  // The studio voice is offered only where it can run: Apple Silicon on
  // macOS 14 or later.
  const [studioSupported, setStudioSupported] = useState(false);
  const [studio, setStudio] = useState<StudioPrefs>({
    model: "1.7B-CustomVoice-8bit",
    voice: "ryan",
    style: "",
  });

  // Dictation (microphone → text). Independent of the TTS engine above: this is
  // which recognizer transcribes your speech. `auto` prefers local Whisper once
  // a model is downloaded, else Apple's built-in on-device recognizer.
  const [dictationEngine, setDictationEngine] =
    useState<DictationEngine>("auto");
  const [whisperModel, setWhisperModel] = useState<WhisperModelId>("base");
  const [whisperModels, setWhisperModels] = useState<WhisperModelStatus[]>([]);
  const [whisperInstalling, setWhisperInstalling] = useState(false);
  const [whisperProgress, setWhisperProgress] = useState<KokoroSetup | null>(null);
  // The key held to dictate anywhere (per machine, like the voice prefs).
  const [holdKey, setHoldKey] = useState<HoldKey>(loadHoldKey);
  // The AI polish dictated text gets once it is in (per machine too).
  const [polish, setPolish] = useState(polishEnabled);

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
        setStudio((p) => ({
          model: s.studioModel || p.model,
          voice: s.studioVoice || p.voice,
          style: s.studioStyle ?? p.style,
        }));
      })
      .catch(() => {});
    void invoke<{ supported: boolean }>("tts_studio", { op: "status" })
      .then((s) => alive && setStudioSupported(!!s.supported))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Load the dictation engine, the Whisper model choice and what's installed once.
  useEffect(() => {
    let alive = true;
    void invoke<DictationStatus>("dictation_status")
      .then((s) => {
        if (!alive) return;
        setDictationEngine(s.engine || "auto");
        setWhisperModel(s.whisperModel || "base");
        setWhisperModels(s.whisperModels);
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

  // Live download progress for the one-time Whisper model fetch.
  useEffect(() => {
    let disposed = false;
    let un: UnlistenFn | undefined;
    void listen<KokoroSetup>("whisper-setup", (e) =>
      setWhisperProgress(e.payload),
    ).then((u) => {
      if (disposed) u();
      else un = u;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  const installWhisper = async () => {
    setWhisperInstalling(true);
    setError(null);
    setWhisperProgress(null);
    try {
      await invoke("whisper_install", { model: whisperModel });
      setWhisperModels((await invoke<DictationStatus>("dictation_status")).whisperModels);
    } catch (e) {
      setError(String(e));
    } finally {
      setWhisperInstalling(false);
      setWhisperProgress(null);
    }
  };

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
              : p === "upgrade"
                ? "Downloading the faster voice model…"
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
      if (engine === "studio") {
        await invoke("tts_studio", {
          op: "prefs",
          args: { voice: studio.voice, style: studio.style },
        });
      }
      // Dictation engine is a separate setting from the TTS engine above.
      await invoke("dictation_set_engine", { engine: dictationEngine, whisperModel });
      saveHoldKey(holdKey);
      setPolishEnabled(polish);
      onSaved(engine, studio.style);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const chosenWhisper = whisperModels.find((m) => m.id === whisperModel);
  const whisperPresent = !!chosenWhisper?.present;
  // What dictation runs until the chosen model is downloaded.
  const whisperFallback = whisperModels.find((m) => m.present);

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
          {(studioSupported || engine === "studio") && (
            <option value="studio">Studio — most natural, on-device (3.1 GB download)</option>
          )}
          <option value="openai">OpenAI — premium, natural (needs a key)</option>
          <option value="elevenlabs">ElevenLabs — premium, most natural (needs a key)</option>
        </select>
      </div>

      {engine === "kokoro" && (
        <div className="flex flex-col gap-3">
          <span style={muted}>
            Kokoro runs fully on your Mac — free, no key, offline. The first time,
            Redline sets up a private voice engine and downloads the model
            (~600&nbsp;MB). You don't need to install anything.
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
                {installing ? "Setting up…" : "Enable natural voice (~600 MB)"}
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

          {progress?.phase === "upgrade" && !installing && (
            <span style={muted}>
              Downloading a faster voice model in the background
              {progress.total ? ` — ${mb(progress.received)} / ${mb(progress.total)}` : "…"}
              . The current one keeps talking until it's ready.
            </span>
          )}

          <KokoroVoicePicker
            value={kokoroVoice}
            onChange={setKokoroVoice}
            canSample={kokoroReady}
            onError={setError}
          />
        </div>
      )}

      {engine === "studio" && (
        <Suspense fallback={<span style={muted}>Loading…</span>}>
          <StudioVoiceCard prefs={studio} onChange={setStudio} onError={setError} />
        </Suspense>
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

      <div
        className="flex flex-col gap-2 mt-5 pt-4"
        style={{ borderTop: "1px solid var(--color-rule)" }}
      >
        <span style={label}>Dictation (microphone → text)</span>
        <label className="flex flex-col gap-1">
          <span style={muted}>
            Hold this key anywhere in Redline and speak: your words go into the
            text box you are in, or to the plan's discussion. Double-tap it to
            keep the mic open.
          </span>
          <select
            value={holdKey}
            onChange={(e) => setHoldKey(e.target.value as HoldKey)}
            aria-label="Dictation key"
            style={field}
          >
            {HOLD_KEYS.map((k) => (
              <option key={k.key} value={k.key}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-start gap-2" style={{ cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={polish}
            onChange={(e) => setPolish(e.target.checked)}
            style={{ marginTop: "2px" }}
          />
          <span className="flex flex-col gap-0.5">
            <span style={{ fontSize: "12px", color: "var(--color-ink)" }}>Polish dictated text</span>
            <span style={muted}>
              A moment after longer dictations land, a fast Claude model tidies their
              punctuation and false starts — only the text goes to it, never the
              audio. ⌘Z takes a polish back. Spoken turns are never polished.
            </span>
          </span>
        </label>
        <span style={muted}>
          Which recognizer transcribes your speech when you dictate. Both run
          fully on your Mac — no audio ever leaves the device. Whisper is a
          stronger local model; Apple's built-in recognizer needs no download.
        </span>
        <select
          value={dictationEngine}
          onChange={(e) => setDictationEngine(e.target.value as DictationEngine)}
          style={field}
        >
          <option value="auto">
            Automatic — Whisper if installed, else Apple
          </option>
          <option value="whisper">Whisper — stronger, local (needs model)</option>
          <option value="apple">Apple — built-in, no download</option>
        </select>

        {(dictationEngine === "whisper" || dictationEngine === "auto") && (
          <select
            value={whisperModel}
            onChange={(e) => setWhisperModel(e.target.value as WhisperModelId)}
            // A download in flight belongs to the model it started for.
            disabled={whisperInstalling}
            aria-label="Whisper model"
            style={field}
          >
            {whisperModels.map((m) => (
              <option key={m.id} value={m.id}>
                {`${WHISPER_MODELS[m.id].name} — ${Math.round(m.bytes / 1_000_000)} MB, ${WHISPER_MODELS[m.id].note}`}
              </option>
            ))}
          </select>
        )}
        {(dictationEngine === "whisper" || dictationEngine === "auto") &&
          chosenWhisper &&
          (whisperPresent
            ? statusRow(true, `${WHISPER_MODELS[chosenWhisper.id].name} installed`)
            : (
                <div className="flex flex-col gap-1.5">
                  <button
                    type="button"
                    onClick={installWhisper}
                    disabled={whisperInstalling}
                    className="rounded-sm px-3 py-1.5"
                    style={{
                      fontSize: "13px",
                      fontWeight: 600,
                      border: "1px solid var(--color-rule)",
                      background: "var(--color-anchor-bg)",
                      color: "var(--color-anchor-text)",
                      cursor: whisperInstalling ? "default" : "pointer",
                      opacity: whisperInstalling ? 0.6 : 1,
                      alignSelf: "flex-start",
                    }}
                  >
                    {whisperInstalling
                      ? "Downloading…"
                      : chosenWhisper.partial > 0
                        ? `Resume download (${mb(chosenWhisper.partial)} of ${mb(chosenWhisper.bytes)})`
                        : `Download ${WHISPER_MODELS[chosenWhisper.id].name} (${mb(chosenWhisper.bytes)})`}
                  </button>
                  {whisperInstalling && (
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
                              whisperProgress && whisperProgress.total
                                ? `${Math.min(100, (whisperProgress.received / whisperProgress.total) * 100)}%`
                                : "40%",
                            background: "var(--color-anchor-text)",
                            transition: "width 200ms ease",
                          }}
                        />
                      </div>
                      <span style={muted}>
                        Downloading the Whisper model…
                        {whisperProgress && whisperProgress.total
                          ? ` — ${mb(whisperProgress.received)} / ${mb(whisperProgress.total)}`
                          : ""}
                      </span>
                    </div>
                  )}
                  {!whisperInstalling && whisperFallback ? (
                    <span style={muted}>
                      Until it is downloaded, dictation uses {WHISPER_MODELS[whisperFallback.id].name}.
                    </span>
                  ) : (
                    dictationEngine === "auto" &&
                    !whisperInstalling && (
                      <span style={muted}>
                        Until the model is downloaded, dictation uses Apple.
                      </span>
                    )
                  )}
                </div>
              ))}
      </div>

      <Vocabulary onError={setError} />

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

/** Settings › Vocabulary: the words dictation leans toward and spells the
 *  user's way, and the corrections it has learned from them. Each change is
 *  saved as it is made (and a pair learned meanwhile shows up), since the
 *  dictation host reads the store on its own. */
function Vocabulary({ onError }: { onError: (msg: string) => void }) {
  const [store, setStore] = useState<VocabStore | null>(null);
  const [word, setWord] = useState("");
  useEffect(() => {
    let alive = true;
    void loadVocabStore().then((s) => alive && setStore(s));
    const off = onVocabStore(setStore);
    return () => {
      alive = false;
      off();
    };
  }, []);
  const change = (fn: (s: VocabStore) => VocabStore) =>
    void updateVocabStore(fn).catch((e) => onError(String(e)));
  const add = () => {
    if (!word.trim()) return;
    change((s) => addWord(s, word));
    setWord("");
  };
  const chip: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: "2px",
    fontSize: "12px",
    padding: "1px 2px 1px 8px",
    borderRadius: "10px",
    border: "1px solid var(--color-rule)",
    background: "var(--color-paper)",
    color: "var(--color-ink)",
  };
  const remove: React.CSSProperties = {
    minWidth: "24px",
    minHeight: "24px",
    border: "none",
    background: "transparent",
    color: "var(--color-ink-muted, #888)",
    cursor: "pointer",
  };
  return (
    <div
      className="flex flex-col gap-2 mt-4 pt-4"
      style={{ borderTop: "1px solid var(--color-rule)" }}
      aria-label="Vocabulary"
      role="group"
    >
      <span style={label}>Vocabulary</span>
      <span style={muted}>
        Names and code terms dictation should hear and spell your way. The
        open plan's names are added for you on every dictation.
      </span>
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          value={word}
          onChange={(e) => setWord(e.target.value)}
          placeholder="Add a word or name…"
          aria-label="Add a vocabulary word"
          spellCheck={false}
          style={field}
        />
        <button
          type="submit"
          disabled={!word.trim()}
          className="rounded-sm px-2.5 py-1"
          style={{ fontSize: "12px", border: "1px solid var(--color-rule)", background: "transparent", color: "var(--color-ink)", cursor: "pointer" }}
        >
          Add
        </button>
      </form>
      {store && store.words.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Your words">
          {store.words.map((w) => (
            <li key={w} style={chip}>
              {w}
              <button type="button" style={remove} aria-label={`Remove ${w}`} title="Remove" onClick={() => change((s) => removeWord(s, w))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <span style={{ ...label, fontWeight: 500, marginTop: "4px" }}>Learned from your corrections</span>
      {store && store.pairs.length > 0 ? (
        <ul className="flex flex-col gap-1" aria-label="Learned corrections">
          {store.pairs.map((p) => (
            <li key={p.heard} className="flex items-center gap-1.5" style={{ fontSize: "12px", color: "var(--color-ink)" }}>
              <span style={{ color: "var(--color-ink-muted, #888)" }}>{p.heard}</span>
              <span aria-hidden>→</span>
              <span className="flex-1 min-w-0">{p.meant}</span>
              <button type="button" style={remove} aria-label={`Forget ${p.heard} → ${p.meant}`} title="Forget" onClick={() => change((s) => forgetPair(s, p.heard))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <span style={muted}>
          None yet. Correct a word Redline dictated within half a minute, and
          it learns the spelling for next time.
        </span>
      )}
    </div>
  );
}

/** Kokoro's English voices as a list to audition: each with its published
 *  grade, best first, and a ▶ that plays a sample at the user's speed without
 *  saving anything. The saved voice is only ever changed by the user's pick. */
function KokoroVoicePicker({
  value,
  onChange,
  canSample,
  onError,
}: {
  value: string;
  onChange: (value: string) => void;
  canSample: boolean;
  onError: (msg: string) => void;
}) {
  const [voice, blend] = splitBlend(value);
  const current = describeVoice(voice);
  // A saved voice outside the table (set by hand) still shows, ungraded.
  const rows = KOKORO_VOICES.some((v) => v.id === voice)
    ? KOKORO_VOICES
    : [current, ...KOKORO_VOICES];

  // Keep the chosen voice in view: a saved voice graded low sits far down the
  // list, and it should be seen among its neighbours, not found by scrolling.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector("input:checked")?.parentElement?.parentElement;
    if (!list || !row) return;
    const top = row.offsetTop;
    if (top < list.scrollTop || top + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = top - (list.clientHeight - row.offsetHeight) / 2;
    }
  }, [voice]);

  // The voice value whose sample is playing, and how to stop it. Starting a
  // sample stops the last one; leaving settings stops it too.
  const [sampling, setSampling] = useState<string | null>(null);
  const stopSample = useRef<(() => void) | null>(null);
  useEffect(() => () => stopSample.current?.(), []);
  const sample = (v: string) => {
    stopSample.current?.();
    stopSample.current = null;
    if (sampling === v) {
      setSampling(null);
      return;
    }
    setSampling(v);
    stopSample.current = playVoiceSample(v, loadVoicePrefs().rate, (err) => {
      stopSample.current = null;
      setSampling(null);
      if (err) onError(err);
    });
  };
  const playButton = (v: string, name: string) => (
    <button
      type="button"
      onClick={() => sample(v)}
      disabled={!canSample}
      aria-label={sampling === v ? "Stop the sample" : `Play a sample of ${name}`}
      title={canSample ? undefined : "Set up the natural voice first"}
      className="rounded-sm"
      style={{
        width: "28px",
        height: "28px",
        flexShrink: 0,
        fontSize: "11px",
        color: "var(--color-ink)",
        cursor: canSample ? "pointer" : "default",
        opacity: canSample ? 1 : 0.4,
      }}
    >
      {sampling === v ? "■" : "▶"}
    </button>
  );

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span style={label}>Voice</span>
        <span style={muted}>
          {current.name}
          {current.grade && ` · grade ${current.grade}`}
        </span>
      </div>
      <span style={muted}>
        Kokoro's author grades each voice by its training audio; higher grades
        sound more natural. ▶ plays a sample.
      </span>
      <div
        ref={listRef}
        role="radiogroup"
        aria-label="Kokoro voice"
        className="rl-thin-scroll-y"
        style={{
          position: "relative",
          maxHeight: "216px",
          overflowY: "auto",
          border: "1px solid var(--color-rule)",
          borderRadius: "4px",
        }}
      >
        {rows.map((v) => (
          <div
            key={v.id}
            className="flex items-center pr-1"
            style={{ background: v.id === voice ? "var(--color-anchor-bg)" : undefined }}
          >
            <label
              className="flex items-center gap-2 flex-1"
              style={{
                minHeight: "30px",
                padding: "0 8px",
                fontSize: "12px",
                color: "var(--color-ink)",
                cursor: "pointer",
              }}
            >
              <input
                type="radio"
                name="kokoro-voice"
                checked={v.id === voice}
                onChange={() => onChange(joinBlend(v.id, blend))}
              />
              <span style={{ fontWeight: v.id === voice ? 600 : 400 }}>{v.name}</span>
              <span style={muted}>{v.kind}</span>
              <GradeBadge grade={v.grade} />
            </label>
            {playButton(v.id, v.name)}
          </div>
        ))}
      </div>
      {current.grade && isLowGrade(current.grade) && (
        <span style={muted}>
          {current.name} is graded {current.grade}: it had little clean training
          audio, so it can sound strained. Heart (A) and Bella (A-) are the most
          natural; Fenrir, Michael and Puck (C+) are the strongest male voices.
        </span>
      )}
      <div className="flex items-center gap-2">
        <span style={{ ...label, flexShrink: 0 }}>Blend with</span>
        <select
          value={blend ?? ""}
          onChange={(e) => onChange(joinBlend(voice, e.target.value || null))}
          style={{ ...field, flex: 1, minWidth: 0 }}
        >
          <option value="">Nothing (one voice)</option>
          {KOKORO_VOICES.filter((v) => v.id !== voice).map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}, {v.kind} ({v.grade})
            </option>
          ))}
        </select>
        {blend && playButton(value, `the ${current.name} and ${describeVoice(blend).name} blend`)}
      </div>
    </div>
  );
}

/** A voice's grade as a small badge: framed in the success tone for A–B, the
 *  warning tone below C-. The text carries the meaning; color only echoes it. */
function GradeBadge({ grade }: { grade: string }) {
  if (!grade) return null;
  const tone =
    gradeRank(grade) <= gradeRank("B-")
      ? "var(--color-success)"
      : isLowGrade(grade)
        ? "var(--color-warning)"
        : "var(--color-rule)";
  return (
    <span
      className="ml-auto"
      style={{
        minWidth: "26px",
        textAlign: "center",
        fontSize: "11px",
        fontWeight: 600,
        padding: "0 4px",
        borderRadius: "3px",
        border: `1px solid ${tone}`,
        color: "var(--color-ink)",
      }}
    >
      <span className="sr-only">grade </span>
      {grade}
    </span>
  );
}
