// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Whether Redline's own voice is sounding, and since when it has been quiet:
// every speech queue reports here (speech.ts). A capture started while the
// warm mic's pre-roll still holds that voice must start without the pre-roll
// (`PREROLL_CLEAR_MS`, dictationTypes.ts), or it opens with Redline's words.

let sounding = 0;
let quietAt = 0;

export function noteSounding(on: boolean): void {
  if (on) sounding += 1;
  else if (sounding > 0 && --sounding === 0) quietAt = Date.now();
}

/** How long Redline's voice has been quiet, in ms (0 while it sounds). */
export function quietFor(now = Date.now()): number {
  return sounding > 0 ? 0 : now - quietAt;
}
