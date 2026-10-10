// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! A chat composer's one primary button (design decision 5): send ↑ when no
//! reply runs; queue ↑ while one runs and there is text to queue; stop ■
//! while one runs and the draft is empty — or, on a thread whose agent can't
//! queue (the discussion forks), whenever one runs. A surface that takes
//! speech shows the mic on an empty box instead of a send with nothing to
//! send (the page chat). One button in one slot, so the field beside it
//! never changes width, and nothing here ever disables the field. The door's
//! composer morphs its own `.rl-fd-go` the same way (`FrontDoor`).

import { ArrowUp, Mic, Square } from "lucide-react";
import "./ChatWorkbench.css";

export type SendState = "send" | "queue" | "stop" | "mic";

export function sendState(streaming: boolean, hasText: boolean, queueing = true): SendState {
  if (!streaming) return "send";
  return queueing && hasText ? "queue" : "stop";
}

const TITLES: Record<SendState, string> = {
  send: "(⏎)",
  queue: "Queue this — it sends when the reply finishes (⏎)",
  stop: "Stop the current reply",
  mic: "Speak your message",
};

export function SendStopButton({
  state,
  onSend,
  onStop,
  onMic,
  listening = false,
  disabled = false,
  label = "Send",
}: {
  state: SendState;
  onSend: () => void;
  onStop: () => void;
  /** The mic face: start dictating, or stop and keep what was heard. */
  onMic?: () => void;
  /** The mic is hot. */
  listening?: boolean;
  /** Send and queue only: there is nothing to send. Stop never is. */
  disabled?: boolean;
  /** What sending is called here ("Send", "Ask"). */
  label?: string;
}) {
  const stop = state === "stop";
  const mic = state === "mic";
  const name = stop ? "Stop" : mic ? (listening ? "Stop dictating" : "Dictate") : state === "queue" ? "Queue" : label;
  // Nothing to send is `aria-disabled`, never `disabled`: Stop pressed from
  // the keyboard ends the reply on an empty box, and a focused button that
  // turned `disabled` would drop the focus to the document.
  const idle = !stop && !mic && disabled;
  return (
    <button
      type="button"
      className="rl-send"
      data-send={state}
      data-listening={(mic && listening) || undefined}
      aria-label={name}
      aria-pressed={mic ? listening : undefined}
      title={state === "send" ? `${label} ${TITLES.send}` : mic && listening ? "Stop dictating and keep the text" : TITLES[state]}
      aria-disabled={idle || undefined}
      onClick={stop ? onStop : mic ? onMic : idle ? undefined : onSend}
    >
      {stop ? <Square size={10} fill="currentColor" aria-hidden /> : mic ? <Mic size={14} aria-hidden /> : <ArrowUp size={15} aria-hidden />}
    </button>
  );
}
