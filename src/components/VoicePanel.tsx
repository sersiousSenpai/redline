// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { Section } from "../types";
import {
  SpeechQueue,
  loadVoices,
  loadVoicePrefs,
  saveVoicePrefs,
  loadCleanupEnabled,
  saveCleanupEnabled,
  browserSpeechDriver,
  type SpeechState,
  type VoicePrefs,
} from "../audio/speech";
import { cloudTtsDriver } from "../audio/cloudTts";
import { UtteranceDetector, DEFAULT_VAD_SILENCE_MS } from "../audio/vad";
import {
  markdownToSpeakable,
  flattenSections,
} from "../lib/markdownToSpeakable";
import { VoiceSettings, type TtsEngine } from "./VoiceSettings";

interface VoiceDeltaEvent {
  sessionId: string;
  text: string;
}
interface VoiceDoneEvent {
  sessionId: string;
  body: string;
}
interface VoiceErrorEvent {
  sessionId: string;
  error: string;
}
interface VoiceReadyEvent {
  sessionId: string;
}
interface VoiceExitEvent {
  sessionId: string;
}

// Push-to-talk dictation events (no sessionId — one capture at a time).
interface DictationTextEvent {
  text: string;
}
interface DictationErrEvent {
  error: string;
}

interface TranscriptLine {
  role: "you" | "agent" | "note";
  text: string;
}

interface VoicePanelProps {
  sessionId: string;
  /** Latest revision's raw plan markdown (sidecars included). */
  markdown: string;
  /** Section tree — drives the structure-aware read and the walkthrough. */
  sections: Section[];
  onClose: () => void;
}

const SUMMARY_PROMPT =
  "Give me a short spoken summary of this whole plan — the gist in a few " +
  "sentences, for the ear.";

function explainPrompt(title: string, body: string): string {
  return (
    `Explain this section of the plan to me conversationally, for the ear — ` +
    `the gist and why it matters, not a verbatim read.\n\nSection "${title}":\n\n${body}`
  );
}

export function VoicePanel({
  sessionId,
  markdown,
  sections,
  onClose,
}: VoicePanelProps) {
  const [speechState, setSpeechState] = useState<SpeechState>("idle");
  /** A turn is in flight (sent, awaiting the agent's reply). */
  const [thinking, setThinking] = useState(false);
  const [sessionUp, setSessionUp] = useState(false);
  // Mirror of `sessionUp` for the readiness-timeout closure (avoids stale state).
  const sessionUpRef = useRef(false);
  sessionUpRef.current = sessionUp;
  // Latest plan markdown, read inside effects/callbacks without restarting the
  // session on every revision change.
  const markdownRef = useRef(markdown);
  markdownRef.current = markdown;
  // Pending (deferred) session teardown, so a StrictMode/dev mount→cleanup→mount
  // doesn't close the warm child's stdin and kill a healthy session.
  const pendingStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [streaming, setStreaming] = useState("");
  // The last thing spoken aloud — lets the idle transport button offer "▶ Start"
  // to replay it (so Stop toggles to Start rather than staying Stop).
  const [lastSpoken, setLastSpoken] = useState("");
  const [prefs, setPrefs] = useState<VoicePrefs>(() => loadVoicePrefs());
  // Run raw dictation through the AI cleanup pass before sending (Wispr-style
  // polish). `cleanupEnabledRef` mirrors it for sync reads inside callbacks.
  const [cleanupEnabled, setCleanupEnabled] = useState(() => loadCleanupEnabled());
  const cleanupEnabledRef = useRef(cleanupEnabled);
  cleanupEnabledRef.current = cleanupEnabled;
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  // Active TTS engine (system speechSynthesis vs cloud premium) + settings view.
  const [engine, setEngine] = useState<TtsEngine>("system");
  const [showSettings, setShowSettings] = useState(false);

  // Push-to-talk (Phase 2). `listening` drives the indicator + button; `partial`
  // is the live transcript shown while the talk button is held. `talkingRef`
  // dedupes the hold (mouse + Space autorepeat both fire repeatedly).
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState("");
  const talkingRef = useRef(false);
  // Pending end-of-capture timer. On release we keep the recognizer running a
  // short beat so it finishes transcribing the tail of speech (the last word
  // lags the audio); re-pressing within that window cancels it and keeps going.
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hands-free (Step 3): converse without holding a button. The mic listens, a
  // silence pause ends the utterance (VAD), the transcript auto-sends, the reply
  // is spoken, then it listens again. It's HALF-DUPLEX on purpose: the mic is
  // only armed while the agent is idle and is torn down the moment an utterance
  // ends, so it can't transcribe the agent's own TTS (acoustic echo). Push-to-
  // talk is suspended while hands-free is on (one mic owner, no races) and is the
  // fallback when it's off. `hfArmedRef` = the mic is currently live for
  // hands-free; `handsFreeRef` mirrors the toggle for sync reads in callbacks.
  const [handsFree, setHandsFree] = useState(false);
  const handsFreeRef = useRef(false);
  handsFreeRef.current = handsFree;
  const hfArmedRef = useRef(false);
  // End-of-utterance detector, fed by the `dictation-partial` stream. Built once;
  // its callback dispatches through a ref so it always runs the latest handler.
  const onUtteranceRef = useRef<(text: string) => void>(() => {});
  const vadRef = useRef<UtteranceDetector | null>(null);
  if (!vadRef.current) {
    vadRef.current = new UtteranceDetector({
      silenceMs: DEFAULT_VAD_SILENCE_MS,
      onUtteranceEnd: (text) => onUtteranceRef.current(text),
    });
  }

  // Walkthrough cursor. It's an opt-in starter ("Walk me through it") that
  // explains one section at a time and waits — the user taps "Next section" to
  // advance (no auto-running). `walkActive` shows the inline walk controls.
  const segments = useMemo(() => flattenSections(sections), [sections]);
  const [walkIndex, setWalkIndex] = useState(0);
  const [walkActive, setWalkActive] = useState(false);

  const queueRef = useRef<SpeechQueue | null>(null);
  const streamingRef = useRef("");
  // When the user barges in (holds to talk), we mute the *rest* of the reply
  // that's still streaming in — otherwise new deltas keep getting spoken and the
  // open mic transcribes the agent talking over itself. Cleared when a new turn
  // begins (its reply is what we now want to hear).
  const discardSpeechRef = useRef(false);
  // A backend turn is live (we're expecting/accepting its `voice-delta`/`-done`
  // events). Set when a turn is sent; cleared on done/error or a hard stop. Gates
  // out stale events from a turn the user interrupted (whose child we killed).
  const turnLiveRef = useRef(false);
  // True while we're deliberately killing + re-warming the session for an
  // interrupt — used to swallow the `voice-exit`/`voice-error` that the kill
  // produces so a hard stop doesn't surface as a spurious error or "not ready".
  const interruptingRef = useRef(false);

  // One SpeechQueue for the panel's lifetime; state drives the indicator.
  if (!queueRef.current) {
    queueRef.current = new SpeechQueue({
      prefs,
      onState: (s) => setSpeechState(s),
    });
  }

  // Populate the system-voice list (async on first call in some engines).
  useEffect(() => {
    let alive = true;
    void loadVoices().then((vs) => {
      if (alive) setVoices(vs);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Keep the queue's prefs in sync and persist them.
  useEffect(() => {
    queueRef.current?.setPrefs(prefs);
    saveVoicePrefs(prefs);
  }, [prefs]);

  // Apply a TTS engine by swapping the queue's driver. `system` uses the WebView
  // `speechSynthesis`; every other engine (cloud OpenAI or local Kokoro) is
  // synthesized in Rust via `tts_synth` and played through the same Web-Audio
  // driver — the engine choice is resolved server-side per call.
  // Surface a synthesis failure (e.g. a bad key, a 429, an out-of-credits error
  // from a cloud engine) into the transcript so a silent voice has a visible
  // reason. Deduped on the message itself: a streamed reply fails the SAME way on
  // every sentence over many seconds, so we show one note per DISTINCT error and
  // suppress repeats of it (no time window — a long turn must still collapse to
  // one). Every occurrence is still logged by the driver (console) and Rust
  // (`error` level, with the provider's full response).
  const lastSynthErrRef = useRef<string>("");
  const reportSynthError = useCallback((msg: string) => {
    if (lastSynthErrRef.current === msg) return;
    lastSynthErrRef.current = msg;
    const short = msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
    setTranscript((t) => [
      ...t,
      { role: "note", text: `🔇 Voice synthesis failed — ${short}` },
    ]);
  }, []);

  const applyEngine = useCallback(
    (e: TtsEngine) => {
      setEngine(e);
      queueRef.current?.setDriver(
        e === "system" ? browserSpeechDriver() : cloudTtsDriver(reportSynthError),
      );
      // Pre-load Kokoro's model so the first sentence doesn't pay cold-start.
      if (e === "kokoro") void invoke("tts_kokoro_warm").catch(() => {});
    },
    [reportSynthError],
  );

  // Stop all speech, then close the panel (don't let a still-streaming reply keep
  // talking after it's gone).
  const handleClose = useCallback(() => {
    discardSpeechRef.current = true;
    queueRef.current?.cancel();
    onClose();
  }, [onClose]);

  // Open/close settings; opening stops any current speech so it doesn't keep
  // talking from behind the settings view (where there's no Stop button).
  const toggleSettings = useCallback(() => {
    setShowSettings((s) => {
      if (!s) {
        discardSpeechRef.current = true;
        queueRef.current?.cancel();
      }
      return !s;
    });
  }, []);

  // Load the configured engine on open.
  useEffect(() => {
    void invoke<{ engine: string }>("tts_get_settings")
      .then((s) => applyEngine((s.engine as TtsEngine) || "system"))
      .catch(() => {});
  }, [applyEngine]);

  // Warm Kokoro's model the instant the panel opens (a no-op for other engines),
  // so its ~seconds of first-load happen while you're reading, not after you
  // press a button. The sidecar then stays warm for the rest of the app session.
  useEffect(() => {
    void invoke("tts_kokoro_warm").catch(() => {});
  }, []);

  // Pre-warm the warm Claude session on open so the first agent turn is fast.
  // Verbatim never needs it, but opening the panel signals intent to discuss.
  useEffect(() => {
    let alive = true;
    // Cancel any deferred teardown from a just-unmounted pass (StrictMode in dev
    // mounts→cleans up→mounts; without this the cleanup would kill the session
    // we're about to reuse).
    if (pendingStopRef.current) {
      clearTimeout(pendingStopRef.current);
      pendingStopRef.current = null;
    }
    // Spawn the warm child and mark it ready once spawned. (A fresh `claude
    // --input-format stream-json` doesn't emit `init` until its first turn, so
    // we can't wait on `voice-ready` to show Ready — but `voice-exit` /
    // `voice-error` flip it back if the child actually dies, and the deferred
    // teardown below stops a StrictMode remount from killing a healthy child.)
    void invoke("voice_session_start", {
      sessionId,
      planMarkdown: markdownRef.current,
    })
      .then(() => alive && setSessionUp(true))
      .catch((e) => alive && setError(String(e)));
    // If the warm child never reports `init` (no `voice-ready`), don't sit on
    // "Warming up…" forever — probe the child and surface what it printed so a
    // stuck/failed spawn is actionable instead of a silent dead-end.
    const readyTimer = setTimeout(() => {
      if (!alive || sessionUpRef.current) return;
      void invoke<{ alive: boolean; stderrTail: string }>("voice_session_probe", {
        sessionId,
      })
        .then((p) => {
          if (!alive || sessionUpRef.current) return;
          const base = p.alive
            ? "The voice session is taking longer than expected to start."
            : "The voice session failed to start — the `claude` process exited.";
          const detail = p.stderrTail
            ? `\n\nClaude reported:\n${p.stderrTail}`
            : " Check that Claude Code runs in this project, or launch Redline " +
              "from a terminal so it inherits your PATH.";
          setError(base + detail);
        })
        .catch(() => {
          if (alive && !sessionUpRef.current) {
            setError("The voice session hasn't started yet.");
          }
        });
    }, 15000);
    return () => {
      alive = false;
      clearTimeout(readyTimer);
      queueRef.current?.cancel();
      // Defer teardown (memory persists in the DB → resumes on reopen). A real
      // close lets this fire; a quick StrictMode/remount cancels it on re-entry,
      // so a healthy warm child isn't killed by its own stdin closing.
      pendingStopRef.current = setTimeout(() => {
        void invoke("voice_session_stop", { sessionId }).catch(() => {});
        void invoke("dictation_kill_all").catch(() => {});
      }, 300);
    };
  }, [sessionId]);

  // Send one turn to the warm session, self-healing if it died: a
  // "voice session not started" means the child is gone, so restart it once and
  // retry. Any other error (or a second failure) propagates to the caller.
  const sendToSession = useCallback(
    async (text: string) => {
      // This turn is now live: accept its streamed events until it completes,
      // errors, or the user interrupts it.
      turnLiveRef.current = true;
      try {
        await invoke("voice_send", { sessionId, text });
      } catch (e) {
        if (!String(e).includes("not started")) throw e;
        await invoke("voice_session_start", {
          sessionId,
          planMarkdown: markdownRef.current,
        });
        await invoke("voice_send", { sessionId, text });
      }
    },
    [sessionId],
  );

  const advanceWalk = useCallback(
    (index: number) => {
      const seg = segments[index];
      if (!seg) {
        setWalkActive(false);
        return;
      }
      setWalkActive(true);
      setWalkIndex(index);
      setThinking(true);
      setStreaming("");
      streamingRef.current = "";
      discardSpeechRef.current = false; // speak this new section's explanation
      queueRef.current?.primeTurn(); // start speaking at the first clause
      setTranscript((t) => [
        ...t,
        { role: "you", text: `▶ ${seg.title || `Section ${index + 1}`}` },
      ]);
      void sendToSession(explainPrompt(seg.title, seg.bodyMarkdown)).catch(
        (e) => {
          setThinking(false);
          setError(String(e));
        },
      );
    },
    [segments, sendToSession],
  );

  // Stream events from the warm session.
  useEffect(() => {
    // `listen()` is async; under StrictMode the cleanup runs before these
    // resolve, so guard with `disposed` and immediately unlisten anything that
    // resolves after teardown — otherwise the dev mount→cleanup→mount leaves
    // TWO live listener sets and every event fires twice (duplicate transcript
    // + doubled, jerky speech).
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    const add = (u: UnlistenFn) => {
      if (disposed) u();
      else unlisteners.push(u);
    };
    const wire = async () => {
      add(
        await listen<VoiceReadyEvent>("voice-ready", (e) => {
          if (e.payload.sessionId !== sessionId) return;
          setSessionUp(true);
        }),
      );
      add(
        await listen<VoiceDeltaEvent>("voice-delta", (e) => {
          if (e.payload.sessionId !== sessionId) return;
          // Drop deltas from a turn the user stopped/interrupted (its child is
          // being killed) so the transcript doesn't keep growing after Stop.
          if (!turnLiveRef.current) return;
          streamingRef.current += e.payload.text;
          setStreaming(streamingRef.current);
          // Still show the text, but don't speak it if the user barged in.
          if (!discardSpeechRef.current) {
            queueRef.current?.enqueue(e.payload.text);
          }
        }),
      );
      add(
        await listen<VoiceDoneEvent>("voice-done", (e) => {
          if (e.payload.sessionId !== sessionId) return;
          // Ignore the completion of an interrupted turn (we already moved on).
          if (!turnLiveRef.current) return;
          turnLiveRef.current = false;
          if (!discardSpeechRef.current) queueRef.current?.flush();
          const body = e.payload.body || streamingRef.current;
          streamingRef.current = "";
          setStreaming("");
          setThinking(false);
          setTranscript((t) => [...t, { role: "agent", text: body }]);
          if (!discardSpeechRef.current) setLastSpoken(body);
        }),
      );
      add(
        await listen<VoiceErrorEvent>("voice-error", (e) => {
          if (e.payload.sessionId !== sessionId) return;
          turnLiveRef.current = false;
          // A hard stop kills the child, which emits an error — swallow it (it's
          // expected, not a failure the user should see).
          if (interruptingRef.current) return;
          streamingRef.current = "";
          setStreaming("");
          setThinking(false);
          setWalkActive(false);
          setError(e.payload.error);
        }),
      );
      add(
        await listen<VoiceExitEvent>("voice-exit", (e) => {
          if (e.payload.sessionId !== sessionId) return;
          // The deliberate kill of an interrupt re-warms immediately; don't flash
          // "not ready" or tear down the UI for it.
          if (interruptingRef.current) return;
          setSessionUp(false);
          setThinking(false);
          setWalkActive(false);
        }),
      );
      add(
        // When the agent captures a change as a tracked feedback comment (or any
        // comment otherwise changes on this plan), reflect it in the transcript.
        // The comment pane itself updates live via App's global listener; this is
        // just the in-conversation acknowledgment. Best-effort attribution.
        await listen<{ sessionId: string }>("comments-changed", (e) => {
          if (e.payload.sessionId !== sessionId) return;
          setTranscript((t) => [
            ...t,
            { role: "note", text: "📝 Captured as feedback on the plan." },
          ]);
        }),
      );
    };
    void wire();
    return () => {
      disposed = true;
      for (const u of unlisteners) u();
    };
  }, [sessionId]);

  const stopSpeaking = useCallback(() => {
    // Stop what's playing AND stop feeding the queue — otherwise the reply that's
    // still streaming in keeps re-enqueueing sentences and playback resumes.
    discardSpeechRef.current = true;
    queueRef.current?.cancel();
  }, []);

  // Hard stop: cut the audio AND abort the in-flight reply. Muting the speech
  // queue alone isn't enough — the warm `claude` turn keeps generating, so the
  // transcript keeps growing and the persistent session stays busy (the next
  // turn would be rejected as "a reply is still streaming"). A stream-json turn
  // can't be interrupted mid-generation, so we kill the child (discarding the
  // in-flight reply) and re-warm it; resuming our own prior fork keeps memory up
  // to the last completed turn. `turnLiveRef` drops the killed turn's trailing
  // events; `interruptingRef` swallows the deliberate exit/error.
  const interruptTurn = useCallback(() => {
    stopSpeaking();
    const hadLiveTurn = turnLiveRef.current;
    turnLiveRef.current = false;
    setThinking(false);
    setStreaming("");
    streamingRef.current = "";
    if (!hadLiveTurn || interruptingRef.current) return;
    interruptingRef.current = true;
    void invoke("voice_session_stop", { sessionId })
      .catch(() => {})
      .finally(() => {
        void invoke("voice_session_start", {
          sessionId,
          planMarkdown: markdownRef.current,
        }).catch(() => {});
      });
    // Keep swallowing the killed child's exit/error past its stdout EOF, then
    // let the re-warmed session report normally again.
    window.setTimeout(() => {
      interruptingRef.current = false;
    }, 1500);
  }, [stopSpeaking, sessionId]);

  // Replay the last spoken reply (the idle "▶ Start" action).
  const replayLast = useCallback(() => {
    const text = lastSpoken.trim();
    if (!text) return;
    setError(null);
    discardSpeechRef.current = false;
    queueRef.current?.cancel();
    queueRef.current?.enqueue(text);
    queueRef.current?.flush();
  }, [lastSpoken]);

  // Send a one-shot agent turn (Summary / Bullets) or a walkthrough interjection.
  const sendTurn = useCallback(
    (text: string, youLabel: string) => {
      setError(null);
      setThinking(true);
      setStreaming("");
      streamingRef.current = "";
      discardSpeechRef.current = false; // speak the reply to this new turn
      queueRef.current?.primeTurn(); // start speaking at the first clause
      setTranscript((t) => [...t, { role: "you", text: youLabel }]);
      void sendToSession(text).catch((e) => {
        turnLiveRef.current = false;
        setThinking(false);
        setError(String(e));
      });
    },
    [sendToSession],
  );

  // Send a *dictated* turn: polish the raw transcript through the AI cleanup
  // pass first (the Wispr-style layer), then hand it to `sendTurn`. Best-effort
  // — on any cleanup error/timeout we fall back to the raw text so a turn is
  // never blocked. Both `setThinking(true)` is already set by the caller, so the
  // round-trip happens under the existing "thinking" state. Canned turns
  // (Summary/Bullets, walkthrough) call `sendTurn` directly and skip this.
  const sendDictatedTurn = useCallback(
    async (raw: string) => {
      const t = raw.trim();
      if (!t) {
        setThinking(false);
        return;
      }
      let text = t;
      if (cleanupEnabledRef.current) {
        try {
          const cleaned = (await invoke<string>("voice_clean", { text: t })).trim();
          if (cleaned) text = cleaned;
        } catch {
          /* best-effort: fall back to the raw transcript */
        }
      }
      sendTurn(text, text);
    },
    [sendTurn],
  );

  // --- Hands-free turn-taking (Step 3) -------------------------------------

  // Arm the mic for the next hands-free utterance. No-op unless hands-free is on
  // and not already armed. Reuses the push-to-talk capture (`dictation_start`)
  // and feeds its partial stream into the VAD detector.
  const armHandsFree = useCallback(() => {
    if (!handsFreeRef.current || hfArmedRef.current) return;
    hfArmedRef.current = true;
    vadRef.current?.reset();
    setError(null);
    setListening(true);
    setPartial("");
    void invoke("dictation_start").catch((e) => {
      hfArmedRef.current = false;
      handsFreeRef.current = false;
      setHandsFree(false);
      setListening(false);
      setError(String(e));
    });
  }, []);

  // Tear the mic down and stop detecting (toggle off, error, or unmount).
  const disarmHandsFree = useCallback(() => {
    hfArmedRef.current = false;
    vadRef.current?.reset();
    setListening(false);
    setPartial("");
    void invoke("dictation_kill_all").catch(() => {});
  }, []);

  // VAD says the user paused → this is the end of an utterance. Close the mic
  // (half-duplex: it stays off through the agent's reply so it can't transcribe
  // the TTS) and send the turn. `setThinking(true)` up front claims the turn so
  // the re-arm effect can't reopen the mic during the stop→send gap. The reply
  // plays; the effect re-arms once the agent is idle again.
  const handleUtteranceEnd = useCallback(
    (vadText: string) => {
      if (!handsFreeRef.current) return;
      hfArmedRef.current = false;
      setListening(false);
      setThinking(true);
      void invoke<string>("dictation_stop")
        .then((finalText) => {
          setPartial("");
          const text = ((finalText || vadText) || "").trim();
          if (text) void sendDictatedTurn(text);
          else setThinking(false); // nothing usable → let the effect re-arm
        })
        .catch((e) => {
          setThinking(false);
          handsFreeRef.current = false;
          setHandsFree(false);
          setError(String(e));
        });
    },
    [sendDictatedTurn],
  );
  onUtteranceRef.current = handleUtteranceEnd;

  // Toggle hands-free. Turning it off tears the mic down; turning it on lets the
  // re-arm effect open the mic once the agent is idle.
  const toggleHandsFree = useCallback(() => {
    setHandsFree((on) => {
      const next = !on;
      handsFreeRef.current = next;
      if (!next) disarmHandsFree();
      return next;
    });
  }, [disarmHandsFree]);

  // The hands-free status button doubles as manual barge-in: since the mic is
  // half-duplex, a tap interrupts the agent (hard stop, so the next utterance
  // isn't rejected by a still-busy session) and the re-arm effect drops back to
  // listening once idle.
  const onHandsFreeButton = useCallback(() => {
    if (thinking || speechState !== "idle") interruptTurn();
  }, [thinking, speechState, interruptTurn]);

  // Re-arm the mic whenever hands-free is on and the agent is fully idle (not
  // generating, not speaking). The short delay debounces the brief idle blips
  // between spoken sentences (so a gap mid-reply doesn't reopen the mic) and
  // leaves a natural beat before listening resumes.
  useEffect(() => {
    if (!handsFree || hfArmedRef.current || thinking || speechState !== "idle") {
      return;
    }
    const t = setTimeout(() => armHandsFree(), 300);
    return () => clearTimeout(t);
  }, [handsFree, listening, thinking, speechState, armHandsFree]);

  // Live partial transcript + dictation errors from the native mic.
  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    const add = (u: UnlistenFn) => {
      if (disposed) u();
      else unlisteners.push(u);
    };
    const wire = async () => {
      add(
        await listen<DictationTextEvent>("dictation-partial", (e) => {
          setPartial(e.payload.text);
          // In hands-free, the partial stream drives end-of-utterance detection.
          if (handsFreeRef.current && hfArmedRef.current) {
            vadRef.current?.feed(e.payload.text);
          }
        }),
      );
      add(
        await listen<DictationErrEvent>("dictation-error", (e) => {
          talkingRef.current = false;
          // A mic error can't be auto-recovered cleanly, and re-arming would
          // just loop, so drop out of hands-free and surface the error.
          hfArmedRef.current = false;
          handsFreeRef.current = false;
          setHandsFree(false);
          vadRef.current?.reset();
          setListening(false);
          setPartial("");
          setError(e.payload.error);
        }),
      );
    };
    void wire();
    return () => {
      disposed = true;
      for (const u of unlisteners) u();
      if (stopTimerRef.current) {
        clearTimeout(stopTimerRef.current);
        stopTimerRef.current = null;
      }
      hfArmedRef.current = false;
      vadRef.current?.reset();
    };
  }, []);

  // How long to keep the recognizer running after release so it can transcribe
  // the tail of speech (Apple's partial results lag the audio by a beat).
  const CAPTURE_TAIL_MS = 350;

  // Push-to-talk: press → listen + barge-in; release → (after a short tail) →
  // transcribe + send.
  const startTalk = useCallback(() => {
    // Hands-free owns the mic while it's on — manual push-to-talk is suspended.
    if (handsFreeRef.current) return;
    if (talkingRef.current) return;
    // Re-pressing during the post-release tail: cancel the pending stop and keep
    // the same capture going (the recognizer never actually stopped).
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
      talkingRef.current = true;
      setListening(true);
      return;
    }
    // Dictation is independent of the warm session — let the user talk now; the
    // release path (`sendToSession`) starts/retries the session as needed.
    talkingRef.current = true;
    setError(null);
    // Barge-in: cut off whatever's being spoken and abort the in-flight reply, so
    // the turn we're about to send isn't rejected by a still-busy session.
    interruptTurn();
    setListening(true);
    setPartial("");
    void invoke("dictation_start").catch((e) => {
      talkingRef.current = false;
      setListening(false);
      setError(String(e));
    });
  }, [interruptTurn]);

  const stopTalk = useCallback(() => {
    if (handsFreeRef.current) return;
    if (!talkingRef.current) return;
    talkingRef.current = false;
    // Don't stop the recognizer the instant the button is released — give it a
    // beat to catch the last word, then read the finalized transcript.
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    stopTimerRef.current = setTimeout(() => {
      stopTimerRef.current = null;
      setListening(false);
      void invoke<string>("dictation_stop")
        .then((finalText) => {
          setPartial("");
          const text = (finalText || "").trim();
          // Feed the transcribed turn to the warm session (in any mode — in the
          // Walkthrough this is exactly the §1e interjection signal). Polished
          // through the cleanup pass first.
          if (text) void sendDictatedTurn(text);
        })
        .catch((e) => setError(String(e)));
    }, CAPTURE_TAIL_MS);
  }, [sendDictatedTurn]);

  // Space = hold-to-talk, as long as focus isn't in a form control.
  useEffect(() => {
    const isTypingTarget = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el || !el.tagName) return false;
      const tag = el.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el.isContentEditable
      );
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // Space hold-to-talk is suspended while hands-free runs the mic.
      if (handsFreeRef.current) return;
      if (e.code !== "Space" || e.repeat || isTypingTarget(e.target)) return;
      e.preventDefault();
      startTalk();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (handsFreeRef.current) return;
      if (e.code !== "Space" || isTypingTarget(e.target)) return;
      e.preventDefault();
      stopTalk();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [startTalk, stopTalk]);

  // Starters — quick ways to begin; after any of them you just hold-to-talk to
  // keep the conversation going.
  const readAloud = useCallback(() => {
    setError(null);
    setWalkActive(false);
    queueRef.current?.cancel();
    const speakable = markdownToSpeakable(markdownRef.current);
    if (!speakable) {
      setError("Nothing to read — the plan is empty.");
      return;
    }
    setTranscript((t) => [...t, { role: "you", text: "▶ Read the plan" }]);
    setLastSpoken(speakable);
    queueRef.current?.enqueue(speakable);
    queueRef.current?.flush();
  }, []);

  const summarize = useCallback(() => {
    setWalkActive(false);
    queueRef.current?.cancel();
    sendTurn(SUMMARY_PROMPT, "▶ Summarize the plan");
  }, [sendTurn]);

  const startWalkthrough = useCallback(() => {
    queueRef.current?.cancel();
    advanceWalk(0);
  }, [advanceWalk]);

  const busy = thinking;
  const indicator: { label: string; color: string } = listening
    ? { label: "Listening…", color: "var(--color-danger, #c0392b)" }
    : thinking
    ? { label: "Thinking…", color: "var(--color-warn, #b8860b)" }
    : speechState === "speaking"
      ? { label: "Speaking…", color: "var(--color-anchor-text)" }
      : speechState === "paused"
        ? { label: "Paused", color: "var(--color-ink-muted, #888)" }
        : { label: sessionUp ? "Ready" : "Warming up…", color: "var(--color-ink-muted, #888)" };

  return (
    <div
      className="absolute right-0 top-0 bottom-0 flex flex-col"
      style={{
        width: "min(380px, 92%)",
        background: "var(--color-bg-elevated)",
        borderLeft: "1px solid var(--color-rule)",
        boxShadow: "-8px 0 24px rgba(0,0,0,0.16)",
        zIndex: 30,
      }}
      data-tour="voice"
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3"
        style={{ borderBottom: "1px solid var(--color-rule)" }}
      >
        <div className="flex items-center gap-2">
          <span style={{ fontSize: "15px" }}>🎙️</span>
          <span style={{ fontWeight: 600, color: "var(--color-ink)" }}>
            Talk to the plan
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={toggleSettings}
            title="Voice settings"
            aria-label="Voice settings"
            aria-pressed={showSettings}
            className="rounded-sm px-2 py-0.5"
            style={{
              color:
                engine !== "system"
                  ? "var(--color-anchor-text)"
                  : "var(--color-ink)",
              cursor: "pointer",
            }}
          >
            ⚙
          </button>
          <button
            type="button"
            onClick={handleClose}
            title="Close voice"
            aria-label="Close voice"
            className="rounded-sm px-2 py-0.5"
            style={{ color: "var(--color-ink)", cursor: "pointer" }}
          >
            ✕
          </button>
        </div>
      </div>

      {showSettings ? (
        <div className="flex-1 overflow-y-auto rl-thin-scroll-y">
          <VoiceSettings
            onClose={() => setShowSettings(false)}
            onSaved={applyEngine}
          />
          <div
            className="px-4 pb-4 pt-3 flex flex-col gap-3"
            style={{ borderTop: "1px solid var(--color-rule)" }}
          >
            {/* Speed — applies to every engine (system + cloud). */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-ink)" }}>
                  Speech speed
                </span>
                <span style={{ fontSize: "11px", color: "var(--color-ink-muted, #888)" }}>
                  {prefs.rate.toFixed(1)}×
                </span>
              </div>
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.1}
                value={prefs.rate}
                onChange={(e) =>
                  setPrefs((p) => ({ ...p, rate: Number(e.target.value) }))
                }
                style={{ width: "100%" }}
                aria-label="Speech speed"
              />
              <span style={{ fontSize: "11px", color: "var(--color-ink-muted, #888)" }}>
                1.0× is normal; most voices feel natural around 1.2–1.4×.
              </span>
            </div>

            {/* Dictation cleanup — polish raw transcripts before sending. */}
            <div className="flex flex-col gap-1.5">
              <label
                className="flex items-center justify-between cursor-pointer"
                style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-ink)" }}
              >
                <span>Clean up dictation with AI</span>
                <input
                  type="checkbox"
                  checked={cleanupEnabled}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setCleanupEnabled(on);
                    saveCleanupEnabled(on);
                  }}
                  aria-label="Clean up dictation with AI"
                />
              </label>
              <span style={{ fontSize: "11px", color: "var(--color-ink-muted, #888)" }}>
                Polishes what you say — punctuation, removing “um”/“uh”, and
                spoken corrections — before sending. Speech stays on-device; only
                the text is cleaned up.
              </span>
            </div>

            {/* Voice name — only the system engine exposes named voices here;
                the cloud voice is chosen above in the engine settings. */}
            {engine === "system" && (
              <div className="flex flex-col gap-1.5">
                <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-ink)" }}>
                  System voice
                </span>
                <select
                  value={prefs.voiceURI ?? ""}
                  onChange={(e) =>
                    setPrefs((p) => ({ ...p, voiceURI: e.target.value || null }))
                  }
                  className="rounded-sm"
                  style={{
                    width: "100%",
                    minWidth: 0,
                    fontSize: "12px",
                    background: "var(--color-paper)",
                    color: "var(--color-ink)",
                    border: "1px solid var(--color-rule)",
                    padding: "4px 6px",
                  }}
                >
                  <option value="">System default</option>
                  {(() => {
                    const enhanced = voices.filter(isEnhancedVoice);
                    const standard = voices.filter((v) => !isEnhancedVoice(v));
                    return (
                      <>
                        {enhanced.length > 0 && (
                          <optgroup label="Enhanced (neural) — much better">
                            {enhanced.map((v) => (
                              <option key={v.voiceURI} value={v.voiceURI}>
                                {v.name}
                              </option>
                            ))}
                          </optgroup>
                        )}
                        <optgroup label="System voices">
                          {standard.map((v) => (
                            <option key={v.voiceURI} value={v.voiceURI}>
                              {v.name}
                            </option>
                          ))}
                        </optgroup>
                      </>
                    );
                  })()}
                </select>
                {!voices.some(isEnhancedVoice) && (
                  <p style={{ fontSize: "11px", color: "var(--color-ink-muted, #888)" }}>
                    Tip: the default system voice sounds robotic. For a far more
                    natural voice (free, offline), download an{" "}
                    <strong>Enhanced</strong> voice in System&nbsp;Settings →
                    Accessibility → Spoken&nbsp;Content → System&nbsp;Voice →
                    Manage Voices, then pick it here.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
          {/* Conversation — the whole panel is one running transcript. */}
          <div
            className="flex-1 overflow-y-auto px-4 py-3 rl-thin-scroll-y"
            style={{ fontSize: "13px", lineHeight: 1.5 }}
          >
            {transcript.length === 0 && !streaming && (
              <p style={{ color: "var(--color-ink-muted, #888)" }}>
                Hold the button below (or hold <strong>Space</strong>) and ask
                anything about the plan — you're talking to the same Claude that
                wrote it, and it can see your repo. Replies are spoken aloud. Turn
                on <strong>Hands-free</strong> to just talk — it sends when you
                pause and listens again after each reply. Or tap a starter to
                begin.
              </p>
            )}
            {transcript.map((line, i) =>
              line.role === "note" ? (
                <div
                  key={i}
                  className="mb-2"
                  style={{
                    color: "var(--color-ink-muted, #888)",
                    fontStyle: "italic",
                    fontSize: "0.9em",
                  }}
                >
                  {line.text}
                </div>
              ) : (
                <div key={i} className="mb-2">
                  <span
                    style={{
                      fontWeight: 600,
                      color:
                        line.role === "you"
                          ? "var(--color-anchor-text)"
                          : "var(--color-ink)",
                    }}
                  >
                    {line.role === "you" ? "You" : "Claude"}:
                  </span>{" "}
                  <span style={{ color: "var(--color-ink)" }}>{line.text}</span>
                </div>
              ),
            )}
            {streaming && (
              <div className="mb-2">
                <span style={{ fontWeight: 600, color: "var(--color-ink)" }}>
                  Claude:
                </span>{" "}
                <span style={{ color: "var(--color-ink)" }}>{streaming}</span>
              </div>
            )}
            {error && (
              <p style={{ color: "var(--color-danger, #c0392b)", marginTop: "8px" }}>
                {error}
              </p>
            )}
          </div>

          {/* Control dock — talk, starters, status — all at the bottom. */}
          <div
            className="px-4 py-3 flex flex-col gap-2"
            style={{ borderTop: "1px solid var(--color-rule)" }}
          >
            {/* Hands-free toggle — converse without holding a button. */}
            <div className="flex items-center justify-between">
              <span style={{ fontSize: "12px", color: "var(--color-ink-muted, #888)" }}>
                {handsFree
                  ? "Hands-free — just talk; it sends on a pause"
                  : "Hold to talk, or go hands-free"}
              </span>
              <button
                type="button"
                onClick={toggleHandsFree}
                role="switch"
                aria-checked={handsFree}
                title="Toggle hands-free conversation"
                className="rounded-full px-2.5 py-1 select-none"
                style={{
                  fontSize: "12px",
                  fontWeight: 600,
                  border: "1px solid var(--color-rule)",
                  background: handsFree
                    ? "var(--color-anchor-bg)"
                    : "transparent",
                  color: handsFree
                    ? "var(--color-anchor-text)"
                    : "var(--color-ink)",
                  cursor: "pointer",
                }}
              >
                {handsFree ? "🎧 Hands-free: on" : "🎧 Hands-free: off"}
              </button>
            </div>

            {/* Primary control: hands-free status (tap to interrupt) when on,
                else the push-to-talk hold button. */}
            {handsFree ? (
              <button
                type="button"
                onClick={onHandsFreeButton}
                title="Hands-free — tap to interrupt and listen"
                aria-label="Hands-free status"
                className="w-full rounded-md px-3 py-2.5 select-none"
                style={{
                  fontSize: "14px",
                  fontWeight: 600,
                  border: "1px solid var(--color-rule)",
                  background: listening
                    ? "var(--color-danger, #c0392b)"
                    : "var(--color-anchor-bg)",
                  color: listening ? "#fff" : "var(--color-anchor-text)",
                  cursor: "pointer",
                  transition: "background 120ms ease",
                }}
              >
                {listening
                  ? "● Listening — just talk"
                  : thinking
                    ? "Thinking… (tap to interrupt)"
                    : speechState === "speaking" || speechState === "paused"
                      ? "🔊 Speaking… (tap to interrupt)"
                      : "🎧 Hands-free on — getting ready to listen"}
              </button>
            ) : (
              <button
                type="button"
                onMouseDown={startTalk}
                onMouseUp={stopTalk}
                onMouseLeave={stopTalk}
                onTouchStart={(e) => {
                  e.preventDefault();
                  startTalk();
                }}
                onTouchEnd={(e) => {
                  e.preventDefault();
                  stopTalk();
                }}
                title="Hold to talk (or hold Space)"
                aria-label="Hold to talk"
                aria-pressed={listening}
                className="w-full rounded-md px-3 py-2.5 select-none"
                style={{
                  fontSize: "14px",
                  fontWeight: 600,
                  border: "1px solid var(--color-rule)",
                  background: listening
                    ? "var(--color-danger, #c0392b)"
                    : "var(--color-anchor-bg)",
                  color: listening ? "#fff" : "var(--color-anchor-text)",
                  cursor: "pointer",
                  transition: "background 120ms ease",
                }}
              >
                {listening ? "● Listening — release to send" : "🎙️ Hold to talk"}
              </button>
            )}
            {listening && (
              <p
                style={{
                  fontSize: "12px",
                  fontStyle: "italic",
                  color: "var(--color-ink-muted, #888)",
                  minHeight: "1.2em",
                }}
              >
                {partial || "Listening…"}
              </p>
            )}

            {/* Walkthrough controls — only while a guided walk is running. It
                waits here for "Next section" instead of auto-running. */}
            {walkActive && (
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => advanceWalk(walkIndex + 1)}
                  className="rounded-full px-2.5 py-1"
                  style={{
                    fontSize: "12px",
                    fontWeight: 600,
                    border: "1px solid var(--color-rule)",
                    background: "var(--color-anchor-bg)",
                    color: "var(--color-anchor-text)",
                    cursor: busy ? "default" : "pointer",
                    opacity: busy ? 0.5 : 1,
                  }}
                >
                  Next section ▸
                </button>
                {(
                  [
                    ["Simpler", "That's a bit much — explain it more simply, like I'm new to this."],
                    ["Again", "Wait, can you explain that part again?"],
                  ] as [string, string][]
                ).map(([label, prompt]) => (
                  <button
                    key={label}
                    type="button"
                    disabled={busy}
                    onClick={() => sendTurn(prompt, label)}
                    className="rounded-full px-2.5 py-1"
                    style={{
                      fontSize: "12px",
                      border: "1px solid var(--color-rule)",
                      background: "transparent",
                      color: "var(--color-ink)",
                      cursor: busy ? "default" : "pointer",
                      opacity: busy ? 0.5 : 1,
                    }}
                  >
                    {label}
                  </button>
                ))}
                <span style={{ fontSize: "11px", color: "var(--color-ink-muted, #888)" }}>
                  {segments.length
                    ? `§${Math.min(walkIndex + 1, segments.length)} / ${segments.length}`
                    : "no sections"}
                </span>
                <button
                  type="button"
                  onClick={() => setWalkActive(false)}
                  title="End walkthrough"
                  className="rounded-full px-2 py-1 ml-auto"
                  style={{
                    fontSize: "11px",
                    border: "1px solid var(--color-rule)",
                    background: "transparent",
                    color: "var(--color-ink-muted, #888)",
                    cursor: "pointer",
                  }}
                >
                  End
                </button>
              </div>
            )}

            {/* Starters — quick ways in; the conversation continues by talking. */}
            {!walkActive && (
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    ["▸ Read it to me", readAloud],
                    ["▸ Summarize", summarize],
                    ["▸ Walk me through it", startWalkthrough],
                  ] as [string, () => void][]
                ).map(([label, fn]) => (
                  <button
                    key={label}
                    type="button"
                    disabled={busy}
                    onClick={fn}
                    className="rounded-full px-2.5 py-1"
                    style={{
                      fontSize: "12px",
                      border: "1px solid var(--color-rule)",
                      background: "transparent",
                      color: "var(--color-ink)",
                      cursor: busy ? "default" : "pointer",
                      opacity: busy ? 0.5 : 1,
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}

            {/* Status + transport. The primary button toggles Stop⇄Start: it
                cancels while a turn is in flight or speaking, and replays the
                last reply when idle. Leftmost + always rendered so its position
                never shifts as speech flaps between sentences. */}
            <div className="flex items-center gap-2">
              {(() => {
                const active =
                  thinking ||
                  speechState === "speaking" ||
                  speechState === "paused";
                const canStart = !active && !!lastSpoken;
                return (
                  <button
                    type="button"
                    onClick={active ? interruptTurn : replayLast}
                    disabled={!active && !canStart}
                    title={active ? "Stop" : "Replay the last reply"}
                    className="rounded-sm px-2 py-1"
                    style={{
                      ...transportBtn,
                      cursor: !active && !canStart ? "default" : "pointer",
                      opacity: !active && !canStart ? 0.5 : 1,
                    }}
                  >
                    {active ? "⏹ Stop" : "▶ Start"}
                  </button>
                );
              })()}
              {speechState === "speaking" ? (
                <button
                  type="button"
                  onClick={() => queueRef.current?.pause()}
                  className="rounded-sm px-2 py-1"
                  style={transportBtn}
                >
                  ⏸
                </button>
              ) : speechState === "paused" ? (
                <button
                  type="button"
                  onClick={() => queueRef.current?.resume()}
                  className="rounded-sm px-2 py-1"
                  style={transportBtn}
                >
                  ▶
                </button>
              ) : null}
              <span
                className="ml-auto"
                style={{ fontSize: "12px", color: indicator.color }}
              >
                ● {indicator.label}
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** macOS "Enhanced"/"Premium" voices are downloadable neural voices — far more
 *  natural than the default, and exposed through the same `speechSynthesis` API
 *  once installed. Detect them by their parenthetical name suffix. */
function isEnhancedVoice(v: SpeechSynthesisVoice): boolean {
  return /\((enhanced|premium)\)/i.test(v.name);
}

const transportBtn: React.CSSProperties = {
  fontSize: "13px",
  border: "1px solid var(--color-rule)",
  background: "transparent",
  color: "var(--color-ink)",
  cursor: "pointer",
};
