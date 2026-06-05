// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { DEFAULT_SOUND, type SoundConfig, type Tone } from "../audio/beep";

interface SoundPickerProps {
  config: SoundConfig;
  onChange: (next: SoundConfig) => void;
  /** Preview the given voice (called on select / transpose / reset). */
  onPreview: (config: SoundConfig) => void;
}

// Curated voices — each a tiny motif with its own character. The first is the
// original beep (and what Reset restores).
const VOICES: { id: string; name: string; tones: Tone[] }[] = [
  {
    id: "ping",
    name: "Ping",
    tones: [{ freq: 800, dur: 0.2, type: "sine", gain: 0.25 }],
  },
  {
    id: "chime",
    name: "Chime",
    tones: [
      { freq: 880, dur: 0.12, type: "sine", gain: 0.22 },
      { freq: 1318, dur: 0.24, type: "sine", gain: 0.22 },
    ],
  },
  {
    id: "rise",
    name: "Rise",
    tones: [
      { freq: 440, dur: 0.06, type: "sine", gain: 0.22 },
      { freq: 660, dur: 0.06, type: "sine", gain: 0.22 },
      { freq: 988, dur: 0.14, type: "sine", gain: 0.24 },
    ],
  },
  {
    id: "blip",
    name: "Blip",
    tones: [
      { freq: 520, dur: 0.05, type: "triangle", gain: 0.26 },
      { freq: 940, dur: 0.12, type: "triangle", gain: 0.26 },
    ],
  },
  {
    id: "knock",
    name: "Knock",
    tones: [
      { freq: 190, dur: 0.07, type: "triangle", gain: 0.32 },
      { freq: 150, dur: 0.1, type: "triangle", gain: 0.32 },
    ],
  },
  {
    id: "coin",
    name: "Coin",
    tones: [
      { freq: 988, dur: 0.07, type: "square", gain: 0.16 },
      { freq: 1319, dur: 0.18, type: "square", gain: 0.16 },
    ],
  },
];

// Mini piano-roll: each tone is a horizontal bar, placed by time (x) and pitch
// (y, log-scaled). Gives every voice a recognizable little glyph.
const ICON_W = 46;
const ICON_H = 16;
const F_LO = 120;
const F_HI = 1400;

function pitchY(freq: number): number {
  const n =
    Math.log(Math.max(F_LO, Math.min(F_HI, freq)) / F_LO) /
    Math.log(F_HI / F_LO);
  return ICON_H - 2 - n * (ICON_H - 4);
}

function VoiceIcon({ tones, active }: { tones: Tone[]; active: boolean }) {
  const total = tones.reduce((s, t) => s + t.dur, 0);
  const stroke = active ? "#fff" : "var(--color-info)";
  let x = 1;
  const bars = tones.map((t, i) => {
    const w = ((ICON_W - 2) * t.dur) / total;
    const x1 = x;
    x += w;
    const y = pitchY(t.freq);
    return (
      <line
        key={i}
        x1={x1.toFixed(1)}
        y1={y.toFixed(1)}
        x2={(x1 + w).toFixed(1)}
        y2={y.toFixed(1)}
        stroke={stroke}
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    );
  });
  return (
    <svg width={ICON_W} height={ICON_H} viewBox={`0 0 ${ICON_W} ${ICON_H}`}>
      {bars}
    </svg>
  );
}

// A fun, low-fuss voice picker: tap a tile to audition + select; nudge Pitch to
// transpose your pick; Reset restores the original beep.
export function SoundPicker({ config, onChange, onPreview }: SoundPickerProps) {
  const pitch = config.pitch ?? 1;

  const selectVoice = (v: (typeof VOICES)[number]) => {
    const next: SoundConfig = { id: v.id, tones: v.tones, pitch };
    onChange(next);
    onPreview(next);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-3 gap-1.5">
        {VOICES.map((v) => {
          const active = v.id === config.id;
          return (
            <button
              key={v.id}
              type="button"
              title={`Play ${v.name}`}
              aria-pressed={active}
              onClick={() => selectVoice(v)}
              className="flex flex-col items-center gap-0.5 rounded-sm py-1"
              style={{
                background: active
                  ? "var(--color-info)"
                  : "var(--color-bg-elevated)",
                border: "1px solid var(--color-rule)",
                cursor: active ? "default" : "pointer",
              }}
            >
              <VoiceIcon tones={v.tones} active={active} />
              <span
                style={{
                  fontSize: "9px",
                  color: active ? "#fff" : "var(--color-ink-muted)",
                }}
              >
                {v.name}
              </span>
            </button>
          );
        })}
      </div>

      <label
        className="flex items-center gap-2"
        style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}
      >
        <span style={{ width: "30px" }}>Pitch</span>
        <input
          type="range"
          min={0.5}
          max={2}
          step={0.01}
          value={pitch}
          onChange={(e) =>
            onChange({ ...config, pitch: Number(e.target.value) })
          }
          onPointerUp={() => onPreview(config)}
          onKeyUp={() => onPreview(config)}
          style={{ flex: 1, accentColor: "var(--color-info)", cursor: "pointer" }}
        />
        <button
          type="button"
          onClick={() => {
            onChange(DEFAULT_SOUND);
            onPreview(DEFAULT_SOUND);
          }}
          className="rounded-sm px-2 py-0.5"
          style={{
            fontSize: "10px",
            background: "var(--color-bg-elevated)",
            border: "1px solid var(--color-rule)",
            color: "var(--color-ink-muted)",
            cursor: "pointer",
          }}
        >
          Reset
        </button>
      </label>
    </div>
  );
}
