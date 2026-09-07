// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Read a streamed agent reply aloud, for any conversation that wants it.
//
// The voice panel has spoken its replies since the voice agent shipped, but the
// machinery to do it was welded into that one component: a `SpeechQueue`, the
// engine lookup, the delta bookkeeping and the barge-in rules, ~80 lines deep
// inside a 1,200-line panel. The conversation dock made that a problem worth
// fixing — the Companion is a conversation in the same column, and it should be
// able to talk without becoming a voice-panel session.
//
// It very deliberately does NOT go through `voice.rs`. A `companion:<id>` voice
// key would have been the cheap way in — the backend already dispatches on key
// SHAPE — but voice sessions persist to `voice_messages` and the Companion to
// `companion_messages` (`db.rs`' thread_table). One conversation would have
// become two threads with two transcripts, which is the precise disagreement
// the dock exists to end. Speech is a client capability; `tts_synth` is already
// a standalone command; so this reads the conversation the room already has.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import {
  loadVoicePrefs,
  readAloudStep,
  READ_ALOUD_START,
  SpeechQueue,
  type ReadAloudState,
} from "./speech";
import { cloudTtsDriver } from "./cloudTts";

export interface ReadAloud {
  /** Something is being spoken right now (drives the Stop affordance). */
  speaking: boolean;
  /** Stop immediately and drop what is queued — barge-in, close, Stop. */
  stop: () => void;
}

export function useReadAloud(opts: {
  /** The user's toggle. Turning it off stops mid-sentence, as Stop does. */
  enabled: boolean;
  /** The reply in flight, cumulative. Empty between turns. */
  liveText: string;
  /** True while a turn is streaming. */
  streaming: boolean;
  /** The conversation's identity. A change is a hard stop: nothing from the
   *  last conversation may keep talking over the new one. */
  threadKey: string;
  /** Reported when a sentence fails to synthesize — silence with no
   *  explanation reads as a broken feature. */
  onError?: (msg: string) => void;
}): ReadAloud {
  const { enabled, liveText, streaming, threadKey, onError } = opts;
  const queueRef = useRef<SpeechQueue | null>(null);
  const [speaking, setSpeaking] = useState(false);
  // Where the reading is between frames. Every rule that governs it —
  // cumulative deltas, the muted watermark, the once-only flush — lives in
  // `readAloudStep`, which is pure and pinned by tests.
  const step = useRef<ReadAloudState>(READ_ALOUD_START);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // One queue for the hook's life; the engine is resolved once and swapped in
  // when the answer lands (the default system driver speaks in the meantime).
  useEffect(() => {
    const q = new SpeechQueue({ onState: (s) => setSpeaking(s === "speaking") });
    q.setPrefs(loadVoicePrefs());
    queueRef.current = q;
    let alive = true;
    void invoke<{ engine: string }>("tts_get_settings")
      .then((s) => {
        if (!alive || (s.engine || "system") === "system") return;
        q.setDriver(cloudTtsDriver((m) => onErrorRef.current?.(m)));
        if (s.engine === "kokoro")
          void invoke("tts_kokoro_warm").catch(() => {});
      })
      .catch(() => {
        /* the system voice is the fallback, and it is already installed */
      });
    return () => {
      alive = false;
      q.cancel();
      queueRef.current = null;
    };
  }, []);

  // Muting, and switching conversations, both mean "stop talking now".
  useEffect(() => {
    if (enabled) return;
    queueRef.current?.cancel();
  }, [enabled]);
  useEffect(() => {
    queueRef.current?.cancel();
    step.current = READ_ALOUD_START;
  }, [threadKey]);

  useEffect(() => {
    const q = queueRef.current;
    if (!q) return;
    const s = readAloudStep(step.current, { liveText, streaming, enabled });
    step.current = { spokenLen: s.spokenLen, wasStreaming: s.wasStreaming };
    if (s.prime) q.primeTurn();
    if (s.delta) q.enqueue(s.delta);
    if (s.flush) q.flush();
  }, [liveText, streaming, enabled]);

  return {
    speaking,
    stop: () => queueRef.current?.cancel(),
  };
}
