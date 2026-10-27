// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
// Synthetic Tauri boundary for the flow conversation fixture: the real
// SessionConversation, SessionComposer and AskCard, fed scripted ConvoEvents
// through a fake `convo_subscribe` channel. Every command a component sends
// is recorded on `window.__qaCalls` so the script can assert on it.
import type { ConvoEvent } from "../../src/components/agent/convo/types";

const noop = () => {};
type Page = Window & {
  __qaCalls?: { command: string; args: unknown }[];
  __qaChannel?: Channel<unknown>;
  __qaSnapshot?: ConvoEvent[];
  __qaSwitch?: "sent" | "terminal";
  __qaSubmit?: "sent" | "blocked";
};
const page = window as Page;

export class Channel<T> {
  onmessage: (message: T) => void = noop;
}

export async function invoke(command: string, args: Record<string, unknown> = {}) {
  (page.__qaCalls ??= []).push({ command, args: command === "convo_subscribe" ? { terminalId: args.terminalId } : args });
  switch (command) {
    case "convo_subscribe":
      page.__qaChannel = args.onBatch as Channel<unknown>;
      return { subscriptionId: "qa-sub", events: page.__qaSnapshot ?? [], hasOlder: false };
    case "convo_unsubscribe":
    case "convo_expect":
    case "pty_interrupt":
    case "convo_answer_ask":
      return null;
    case "convo_page":
      return { events: [], hasOlder: false };
    case "pty_submit":
      return page.__qaSubmit === "blocked" ? { status: "blocked", blocker: "native_dialog" } : { status: "sent" };
    case "convo_set_mode":
    case "convo_set_model":
      return page.__qaSwitch === "sent" ? { status: "sent" } : { status: "terminal", reason: "a turn is running" };
    case "model_catalog_snapshot":
      return {
        models: [
          // As the CLI's catalog names its aliases: the version it resolves to.
          { slug: "opus", displayName: "Opus 4.5", description: "Most capable", defaultEffort: "high", efforts: ["low", "medium", "high", "xhigh", "max"] },
          { slug: "sonnet", displayName: "Sonnet", description: "Fast and capable", defaultEffort: "medium", efforts: ["low", "medium", "high"] },
          { slug: "haiku", displayName: "Haiku", description: "Fastest", defaultEffort: null, efforts: [] },
        ],
        checkedAt: 1_790_000_000_000,
        source: "harness",
        warning: null,
      };
    default:
      return null;
  }
}

export async function listen() { return noop; }
export async function emit() {}
export async function emitTo() {}
export async function once() { return noop; }
export async function open() { return null; }
export async function openUrl() {}
export function convertFileSrc(path: string) { return path; }
export function isTauri() { return false; }
export function getCurrentWebview() { return { onDragDropEvent: async () => noop }; }
export function getCurrentWindow() { return { startDragging: async () => {}, toggleMaximize: async () => {} }; }
