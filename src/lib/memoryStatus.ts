// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { invoke } from "@tauri-apps/api/core";

// One `memory_status` read at a time for the whole page. The status chip and
// the Memory surface both re-read on the same `memory-changed` and
// `classmem-changed` events, and the surface reads again on every show: each
// used to send its own call, and three at once were the lock holders in the
// 2026-10-29 beach ball. A caller that arrives while a read is out shares it.
// (The backend single-flights and caches too, memstatus.rs; this saves the
// round trips.)
let inFlight: Promise<unknown> | null = null;

export function readMemoryStatus<T>(): Promise<T> {
  if (!inFlight) {
    const read = invoke<T>("memory_status");
    inFlight = read;
    const settle = () => {
      if (inFlight === read) inFlight = null;
    };
    read.then(settle, settle);
  }
  return inFlight as Promise<T>;
}
