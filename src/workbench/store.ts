// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// A tiny external store over the reducer, read with `useSyncExternalStore`.
// This is the only piece of `src/workbench/` meant for the boot path: it
// holds one state object, hands out the same one until an action changes
// it, and tells listeners. No React import beyond the hook at the bottom,
// and no static import of the reducer: App hands it a loader, and the
// actions dispatched before the chunk lands (none, in practice — it is
// fetched as the app boots) queue and apply in order once it has.

import { useSyncExternalStore } from "react";

import type { WorkbenchState } from "./model";
import type { WorkbenchAction } from "./reducer";

export type Reducer = (state: WorkbenchState, action: WorkbenchAction) => WorkbenchState;

export interface WorkbenchStore {
  getState(): WorkbenchState;
  dispatch(action: WorkbenchAction): void;
  /** Replace the whole state (a boot read, a test). Notifies when changed. */
  replace(next: WorkbenchState): void;
  subscribe(listener: () => void): () => void;
}

export function createWorkbenchStore(initial: WorkbenchState, reducer: Reducer | (() => Promise<Reducer>)): WorkbenchStore {
  let state = initial;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const l of Array.from(listeners)) l();
  };
  let reduce: Reducer | null = typeof reducer === "function" && reducer.length === 2 ? (reducer as Reducer) : null;
  const queue: WorkbenchAction[] = [];
  if (!reduce) {
    void (reducer as () => Promise<Reducer>)().then((fn) => {
      reduce = fn;
      let next = state;
      for (const action of queue.splice(0)) next = fn(next, action);
      if (next === state) return;
      state = next;
      notify();
    });
  }
  return {
    getState: () => state,
    dispatch(action) {
      if (!reduce) {
        queue.push(action);
        return;
      }
      const next = reduce(state, action);
      if (next === state) return;
      state = next;
      notify();
    },
    replace(next) {
      if (next === state) return;
      state = next;
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const identity = (s: WorkbenchState) => s;

/** Read the store from React. The selector must return a referentially
 *  stable value for an unchanged state (a slice, a primitive), or the
 *  component re-renders on every notification. */
export function useWorkbench<T = WorkbenchState>(store: WorkbenchStore, selector: (s: WorkbenchState) => T = identity as (s: WorkbenchState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()), () => selector(store.getState()));
}
