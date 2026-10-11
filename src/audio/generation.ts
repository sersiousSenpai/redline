// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Generations are unique across every driver in the app, because `tts_cancel`
// is app-wide: cancelling the voice panel's reply must never drop a chat's read
// aloud, nor a dictation's polish. Seeding from the clock keeps two windows'
// counters apart as well. A module of its own, so the dictation chunk, which
// loads with the terminal, draws from the counter without the speech engines.

let lastGeneration = Date.now();
export const nextGeneration = () => ++lastGeneration;
