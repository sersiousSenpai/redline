// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// What the listener has actually heard. `SpeechQueue` hands its driver one
// clip (a sentence or a clause) at a time and the driver plays them in order,
// so wrapping the driver tells us which clip is sounding right now — the one
// thing three features need and the queue never knew:
//
// - a barge-in tells the agent where playback was cut ("you were interrupted
//   after saying …"): it remembers its whole reply, the user heard only part;
// - a section marker lights its plan section when the sentence it follows
//   starts playing, and read-aloud knows which section it has reached;
// - a clip that never ends (a suspended audio context, a wedged engine) is
//   noticed, instead of leaving "speaking" — and hands-free with it — stuck.
//
// A cancel starts a new epoch. Callbacks from the old epoch's clips are
// dropped rather than passed on, so a cancelled clip finishing late can
// neither mark the next reply's clip done nor end the next reply early.

import type { SpeechDriver } from "./speech";

/** A plan section to point at when the clip carrying it starts playing. */
export interface NarrationMark {
  /** Offset into the text handed to `narrate`. */
  at: number;
  anchorId: string;
  /** `point`: the agent named the section. `read`: read-aloud reached it. */
  kind: "point" | "read";
}

export interface Clip {
  seq: number;
  text: string;
  marks: NarrationMark[];
}

interface Queued extends Clip {
  rate: number;
  /** Where the clip ends in the narration; -1 when it could not be found. */
  end: number;
}

export interface PlaybackOptions {
  onClipStart?: (clip: Clip) => void;
  /** Sections reached: a clip carrying marks started, or a mark arrived for
   *  a sentence that is already sounding. */
  onPoint?: (marks: NarrationMark[]) => void;
  /** Nothing is playing or waiting to play any more (also after a cancel). */
  onIdle?: () => void;
  /** The playing clip has run far past its length: the engine is stuck. */
  onStall?: (clip: Clip) => void;
}

/** Spoken characters per second at rate 1 — a slow speaker, so the stall
 *  estimate errs long. */
const CHARS_PER_SECOND = 14;

/** How long a clip may sound before it counts as stuck: twice its estimated
 *  length plus slack for synthesis, which the clip's clock includes. */
export function stallMs(text: string, rate: number): number {
  return 8000 + (2000 * text.length) / (CHARS_PER_SECOND * Math.max(0.5, rate));
}

/** Consumed narration kept before it is trimmed off the front. */
const NARRATION_KEEP = 4096;

export class Playback {
  private narration = "";
  private marks: NarrationMark[] = [];
  private cursor = 0;
  private queue: Queued[] = [];
  private epoch = 0;
  private seq = 0;
  private paused = false;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: PlaybackOptions = {}) {}

  /** Record text that is about to be enqueued on the speech queue, with its
   *  marks (offsets into `text`). Must mirror every `enqueue`, string for
   *  string, so each clip can be found in it.
   *
   *  A mark can arrive after its sentence was already cut into a clip — a
   *  streamed reply's first clause goes out at its period, before the marker
   *  after it has streamed in. It joins that clip if the clip is still
   *  waiting, and points right away if it is already sounding. */
  narrate(text: string, marks: readonly NarrationMark[] = []): void {
    const base = this.narration.length;
    this.narration += text;
    const now: NarrationMark[] = [];
    for (const m of marks) {
      const mark = { ...m, at: base + m.at };
      if (mark.at > this.cursor) {
        this.marks.push(mark);
        continue;
      }
      const owner = this.queue.find((c) => c.end >= mark.at);
      if (owner && owner !== this.queue[0]) owner.marks.push(mark);
      else now.push(mark);
    }
    if (now.length) this.opts.onPoint?.(now);
  }

  /** The clip sounding now (or about to), if any. */
  current(): Clip | null {
    return this.queue[0] ?? null;
  }

  busy(): boolean {
    return this.queue.length > 0;
  }

  wrap(driver: SpeechDriver): SpeechDriver {
    return {
      speak: (text, opts, onDone) => {
        const epoch = this.epoch;
        const clip: Queued = { seq: ++this.seq, text, marks: [], rate: opts.rate, end: -1 };
        this.locate(clip);
        this.queue.push(clip);
        if (this.queue.length === 1) this.start(clip);
        driver.speak(text, opts, () => {
          // A clip of a cancelled run: the queue already forgot it.
          if (epoch !== this.epoch) return;
          this.finish(clip.seq);
          onDone();
        });
      },
      cancel: () => {
        this.reset();
        driver.cancel();
      },
      pause: () => {
        this.paused = true;
        this.clearStall();
        driver.pause();
      },
      resume: () => {
        this.paused = false;
        const head = this.queue[0];
        if (head) this.armStall(head);
        driver.resume();
      },
    };
  }

  /** Find a clip in the narration, past the last one found, and hand it the
   *  marks it covers — every one not yet claimed up to its end, so a marker
   *  right after a sentence goes with that sentence. A clip that cannot be
   *  found carries none and leaves the cursor where it was. */
  private locate(clip: Queued): void {
    const at = this.narration.indexOf(clip.text, this.cursor);
    if (at === -1) return;
    clip.end = at + clip.text.length;
    this.cursor = clip.end;
    clip.marks = this.marks.filter((m) => m.at <= clip.end);
    this.marks = this.marks.filter((m) => m.at > clip.end);
    if (this.cursor > NARRATION_KEEP) {
      const cut = this.cursor;
      this.narration = this.narration.slice(cut);
      this.marks = this.marks.map((m) => ({ ...m, at: m.at - cut }));
      for (const c of this.queue) if (c.end !== -1) c.end -= cut;
      clip.end -= cut;
      this.cursor = 0;
    }
  }

  private start(clip: Queued): void {
    if (!this.paused) this.armStall(clip);
    this.opts.onClipStart?.(clip);
    if (clip.marks.length) this.opts.onPoint?.(clip.marks);
  }

  private finish(seq: number): void {
    const i = this.queue.findIndex((c) => c.seq === seq);
    if (i === -1) return;
    this.queue.splice(i, 1);
    if (i !== 0) return;
    this.clearStall();
    const next = this.queue[0];
    if (next) this.start(next);
    else this.opts.onIdle?.();
  }

  private reset(): void {
    this.epoch += 1;
    this.queue = [];
    this.narration = "";
    this.marks = [];
    this.cursor = 0;
    this.paused = false;
    this.clearStall();
    this.opts.onIdle?.();
  }

  private armStall(clip: Queued): void {
    this.clearStall();
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      this.opts.onStall?.(clip);
    }, stallMs(clip.text, clip.rate));
  }

  private clearStall(): void {
    if (this.stallTimer !== null) clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }
}
