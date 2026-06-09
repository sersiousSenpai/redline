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

// Small lead before the first tone so a freshly-resumed context never schedules
// a start time in the past (which silently drops the tone — the intermittent
// "no sound" bug).
const LEAD = 0.03;

let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    // A context can end up "closed" (e.g. after the tab/window was torn down
    // and rebuilt); a closed context can't schedule, so recreate it.
    if (ctx && ctx.state === "closed") ctx = null;
    if (!ctx) ctx = new Ctor();
    return ctx;
  } catch {
    return null;
  }
}

// Schedule the motif. Called only once the context is confirmed running, so the
// start time is always valid and every tone actually plays.
function scheduleTones(audio: AudioContext, config: SoundConfig): void {
  const tones =
    Array.isArray(config?.tones) && config.tones.length
      ? config.tones
      : DEFAULT_SOUND.tones;
  const pitch = config?.pitch ?? 1;
  let at = audio.currentTime + LEAD;
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
}

export function playInterceptBeep(config: SoundConfig = DEFAULT_SOUND): void {
  const audio = getContext();
  if (!audio) return;
  // Autoplay policies / a backgrounded window / OS sleep can leave the context
  // suspended. resume() is async — schedule the tones only AFTER it resolves,
  // otherwise they're queued against a frozen clock and never sound. resume()
  // on an already-running context is a no-op that resolves immediately.
  audio
    .resume()
    .then(() => {
      try {
        scheduleTones(audio, config);
      } catch (err) {
        console.warn("intercept beep: scheduling failed", err);
      }
    })
    .catch((err) => {
      console.warn("intercept beep: AudioContext.resume() rejected", err);
    });
}
