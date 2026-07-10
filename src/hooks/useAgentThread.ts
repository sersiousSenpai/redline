// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Generic streaming/thread state for a per-key agent discussion on the
// `<prefix>-delta/-done/-error/-cancelled` Tauri event family (the browse /
// linked / mission / draft-chat backend contract). Parameterized by the event
// prefix + command names so each surface stops re-implementing the same
// listener plumbing: DrafterChat uses it now; BrowserChat/LinkedChat can
// migrate later.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface AgentThreadMessage {
  id: string;
  role: "user" | "assistant";
  body: string;
  /** "complete" | "error" */
  status: string;
  createdAt: number;
}

export type AgentThreadStatus = "idle" | "streaming" | "error";

export interface UseAgentThreadOptions {
  /** The thread key (draft id / browse id / …). */
  threadKey: string;
  /** The camelCase field carrying the key in event payloads AND invoke args
   *  (e.g. `"draftId"`). */
  keyField: string;
  /** Event family prefix (e.g. `"draft-chat"` → `draft-chat-delta` …). */
  eventPrefix: string;
  /** Command returning the persisted thread rows. */
  loadCommand: string;
  /** Command spawning a turn. */
  sendCommand: string;
  /** Command cancelling the in-flight turn. */
  cancelCommand: string;
}

let tmpSeq = 0;
const tmpId = () => `atmp-${++tmpSeq}`;

export function useAgentThread(opts: UseAgentThreadOptions) {
  const { threadKey, keyField, eventPrefix, loadCommand, sendCommand, cancelCommand } = opts;
  const [messages, setMessages] = useState<AgentThreadMessage[]>([]);
  const [liveText, setLiveText] = useState("");
  const [status, setStatus] = useState<AgentThreadStatus>("idle");
  const [loaded, setLoaded] = useState(false);

  // Load persisted turns + subscribe. Keyed on the thread key only.
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setMessages([]);
    setLiveText("");
    setStatus("idle");

    void invoke<AgentThreadMessage[]>(loadCommand, { [keyField]: threadKey })
      .then((rows) => {
        if (!alive) return;
        setMessages(rows);
        setLoaded(true);
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });

    const mine = (p: Record<string, unknown>) => p[keyField] === threadKey;

    const deltaP = listen<Record<string, unknown>>(`${eventPrefix}-delta`, (e) => {
      if (!alive || !mine(e.payload)) return;
      setStatus("streaming");
      setLiveText((t) => t + String(e.payload.text ?? ""));
    });
    const doneP = listen<Record<string, unknown>>(`${eventPrefix}-done`, (e) => {
      if (!alive || !mine(e.payload)) return;
      setMessages((m) => [
        ...m,
        {
          id: String(e.payload.messageId ?? tmpId()),
          role: "assistant",
          body: String(e.payload.body ?? ""),
          status: "complete",
          createdAt: Date.now(),
        },
      ]);
      setLiveText("");
      setStatus("idle");
    });
    const errorP = listen<Record<string, unknown>>(`${eventPrefix}-error`, (e) => {
      if (!alive || !mine(e.payload)) return;
      setMessages((m) => [
        ...m,
        {
          id: tmpId(),
          role: "assistant",
          body: String(e.payload.error ?? "unknown error"),
          status: "error",
          createdAt: Date.now(),
        },
      ]);
      setLiveText("");
      setStatus("error");
    });
    const cancelP = listen<Record<string, unknown>>(`${eventPrefix}-cancelled`, (e) => {
      if (!alive || !mine(e.payload)) return;
      setLiveText("");
      setStatus("idle");
    });

    return () => {
      alive = false;
      void deltaP.then((un) => un());
      void doneP.then((un) => un());
      void errorP.then((un) => un());
      void cancelP.then((un) => un());
    };
  }, [threadKey, keyField, eventPrefix, loadCommand]);

  /** Send a turn: pushes the local user bubble, invokes the send command with
   *  `{ [keyField]: threadKey, text, ...extraArgs }`. */
  const send = useCallback(
    (text: string, extraArgs: Record<string, unknown> = {}) => {
      const trimmed = text.trim();
      if (!trimmed || status === "streaming") return;
      setMessages((m) => [
        ...m,
        {
          id: tmpId(),
          role: "user",
          body: trimmed,
          status: "complete",
          createdAt: Date.now(),
        },
      ]);
      setLiveText("");
      setStatus("streaming");
      void invoke(sendCommand, {
        [keyField]: threadKey,
        text: trimmed,
        ...extraArgs,
      }).catch((err) => {
        setStatus("error");
        setMessages((m) => [
          ...m,
          {
            id: tmpId(),
            role: "assistant",
            body: `Couldn't reach the agent: ${err}`,
            status: "error",
            createdAt: Date.now(),
          },
        ]);
      });
    },
    [threadKey, keyField, sendCommand, status],
  );

  const cancel = useCallback(() => {
    void invoke(cancelCommand, { [keyField]: threadKey }).catch(() => {});
  }, [threadKey, keyField, cancelCommand]);

  return { messages, liveText, status, loaded, send, cancel };
}
