// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// A thin hook over the same three invokes and two events `VoicePanel` uses,
// so the front-door composer can be spoken into without pulling the voice
// surface's machinery along with it.
//
// The native constraint that shapes this: there is ONE capture at a time and
// it carries no session id, so two callers pressing the mic would fight over
// the same recognizer. `enabled` is how the caller stands down — the Voice
// panel owns the mic whenever it is open, and this hook must no-op then.

export interface Dictation {
  listening: boolean;
  /** Live transcript while listening — a preview, never committed text. */
  partial: string;
  error: string | null;
  start: () => void;
  /** Stops and hands the finalized transcript to `onFinal`. */
  stop: () => void;
  toggle: () => void;
}

export function useDictation({
  enabled,
  onFinal,
}: {
  enabled: boolean;
  onFinal: (text: string) => void;
}): Dictation {
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<string | null>(null);
  const listeningRef = useRef(false);
  listeningRef.current = listening;
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  // Subscribe once. The partial stream is global (no session id), so the
  // guard is our own listening flag — a Voice-panel capture must not paint
  // its transcript into the composer.
  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    const add = (u: UnlistenFn) => {
      if (disposed) u();
      else unlisteners.push(u);
    };
    void (async () => {
      add(
        await listen<{ text: string }>("dictation-partial", (e) => {
          if (listeningRef.current) setPartial(e.payload.text);
        }),
      );
      add(
        await listen<{ error: string }>("dictation-error", (e) => {
          if (!listeningRef.current) return;
          listeningRef.current = false;
          setListening(false);
          setPartial("");
          setError(e.payload.error);
        }),
      );
    })();
    return () => {
      disposed = true;
      for (const u of unlisteners) u();
    };
  }, []);

  const start = useCallback(() => {
    if (!enabled || listeningRef.current) return;
    setError(null);
    setPartial("");
    listeningRef.current = true;
    setListening(true);
    void invoke("dictation_start").catch((e) => {
      listeningRef.current = false;
      setListening(false);
      setError(String(e));
    });
  }, [enabled]);

  const stop = useCallback(() => {
    if (!listeningRef.current) return;
    listeningRef.current = false;
    setListening(false);
    void invoke<string>("dictation_stop")
      .then((finalText) => {
        setPartial("");
        const text = (finalText || "").trim();
        if (text) onFinalRef.current(text);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const toggle = useCallback(() => {
    if (listeningRef.current) stop();
    else start();
  }, [start, stop]);

  // Never leave the mic hot: an unmount mid-capture (surface switch, a plan
  // arriving) has to release the recognizer, and a Voice panel opening takes
  // the mic away from us by contract.
  useEffect(() => {
    if (enabled) return;
    if (!listeningRef.current) return;
    listeningRef.current = false;
    setListening(false);
    setPartial("");
    void invoke("dictation_kill_all").catch(() => {});
  }, [enabled]);

  useEffect(
    () => () => {
      if (!listeningRef.current) return;
      listeningRef.current = false;
      void invoke("dictation_kill_all").catch(() => {});
    },
    [],
  );

  return { listening, partial, error, start, stop, toggle };
}
