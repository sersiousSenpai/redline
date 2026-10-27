// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The flow store, reached from App without the module on the boot path.
//! App's three `useFlow` reads are hooks and must stay synchronous, so this
//! shim answers them with the store's defaults until `loadFlowState` has
//! fetched `./flowState` (the flow shell loads it at mount; the classic
//! shell never does), then re-subscribes every listener to the real store
//! and notifies once. Writers go through `withFlowState`, which loads on
//! demand. Deleted with the flow shell in W2.

import { useSyncExternalStore } from "react";
import type { FlowState } from "./flowState";

type FlowModule = typeof import("./flowState");

const DEFAULT: FlowState = { stage: "conversation", planPose: {}, panelTab: "chat", sidebar: true };

let mod: FlowModule | null = null;
let loading: Promise<FlowModule> | null = null;
const listeners = new Map<() => void, (() => void) | null>();

/** Fetch the store once; later calls return the same promise. */
export function loadFlowState(): Promise<FlowModule> {
  if (!loading) {
    loading = import("./flowState").then((m) => {
      mod = m;
      for (const [listener] of listeners) listeners.set(listener, m.subscribeFlow(listener));
      for (const [listener] of listeners) listener();
      return m;
    });
  }
  return loading;
}

/** The state now: the real store's once loaded, the defaults before. */
export function flowStateNow(): FlowState {
  return mod ? mod.getFlowState() : DEFAULT;
}

function subscribe(listener: () => void): () => void {
  listeners.set(listener, mod ? mod.subscribeFlow(listener) : null);
  return () => {
    listeners.get(listener)?.();
    listeners.delete(listener);
  };
}

/** `useFlow` without the module: one slice, re-rendered when it changes. */
export function useFlowLazy<T>(select: (s: FlowState) => T): T {
  return useSyncExternalStore(subscribe, () => select(flowStateNow()), () => select(flowStateNow()));
}

/** Run a writer against the store, loading it first when needed. */
export function withFlowState(fn: (m: FlowModule) => void): void {
  if (mod) fn(mod);
  else void loadFlowState().then(fn).catch(() => {});
}
