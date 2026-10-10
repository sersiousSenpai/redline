// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! A chat composer's one primary button (design decision 5): send ↑ when no
//! reply runs; queue ↑ while one runs and there is text to queue; stop ■
//! while one runs and the draft is empty — or, on a thread whose agent can't
//! queue (the discussion forks), whenever one runs. One button in one slot,
//! so the field beside it never changes width, and nothing here ever
//! disables the field. The door's composer morphs its own `.rl-fd-go` the
//! same way (`FrontDoor`).

import { ArrowUp, Square } from "lucide-react";
import "./ChatWorkbench.css";

export type SendState = "send" | "queue" | "stop";

export function sendState(streaming: boolean, hasText: boolean, queueing = true): SendState {
  if (!streaming) return "send";
  return queueing && hasText ? "queue" : "stop";
}

const TITLES: Record<SendState, string> = {
  send: "(⏎)",
  queue: "Queue this — it sends when the reply finishes (⏎)",
  stop: "Stop the current reply",
};

export function SendStopButton({
  state,
  onSend,
  onStop,
  disabled = false,
  label = "Send",
}: {
  state: SendState;
  onSend: () => void;
  onStop: () => void;
  /** Send and queue only: there is nothing to send. Stop is never disabled. */
  disabled?: boolean;
  /** What sending is called here ("Send", "Ask"). */
  label?: string;
}) {
  const stop = state === "stop";
  const name = stop ? "Stop" : state === "queue" ? "Queue" : label;
  return (
    <button
      type="button"
      className="rl-send"
      data-send={state}
      aria-label={name}
      title={state === "send" ? `${label} ${TITLES.send}` : TITLES[state]}
      disabled={!stop && disabled}
      onClick={stop ? onStop : onSend}
    >
      {stop ? <Square size={10} fill="currentColor" aria-hidden /> : <ArrowUp size={15} aria-hidden />}
    </button>
  );
}
