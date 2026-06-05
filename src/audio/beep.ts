// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Short synthesized "intercept" sounds via the Web Audio API — no asset files,
// no dependencies. A sound is a small sequence of tones (a motif) so the
// curated voices in SoundPicker have real character. A single AudioContext is
// reused; each tone gets an attack/decay envelope so it never clicks. All of
// it is wrapped so a missing/blocked AudioContext degrades silently.

export interface Tone {
  freq: number; // hertz
  dur: number; // seconds
  type: OscillatorType;
  gain: number; // peak amplitude 0..1
}

export interface SoundConfig {
  /** Selected voice id — for highlighting and reset. */
  id: string;
  /** The motif to play. */
  tones: Tone[];
  /** Global pitch multiplier (transpose). 1 = as authored. */
  pitch: number;
}

export const DEFAULT_SOUND: SoundConfig = {
  id: "ping",
  tones: [{ freq: 800, dur: 0.2, type: "sine", gain: 0.25 }],
  pitch: 1,
};

const GAP = 0.03; // small silence between tones in a motif

let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    if (!ctx) ctx = new Ctor();
    // Autoplay policies can leave the context suspended until a user gesture;
    // resume() is a no-op if already running.
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

export function playInterceptBeep(config: SoundConfig = DEFAULT_SOUND): void {
  try {
    const audio = getContext();
    if (!audio) return;
    const tones =
      Array.isArray(config?.tones) && config.tones.length
        ? config.tones
        : DEFAULT_SOUND.tones;
    const pitch = config?.pitch ?? 1;
    let at = audio.currentTime;
    for (const tone of tones) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = tone.type;
      osc.frequency.value = tone.freq * pitch;
      const edge = Math.min(0.02, tone.dur * 0.25);
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(tone.gain, at + edge);
      gain.gain.linearRampToValueAtTime(tone.gain, at + tone.dur - edge);
      gain.gain.linearRampToValueAtTime(0, at + tone.dur);
      osc.connect(gain);
      gain.connect(audio.destination);
      osc.start(at);
      osc.stop(at + tone.dur);
      at += tone.dur + GAP;
    }
  } catch {
    /* audio unavailable — silent */
  }
}
