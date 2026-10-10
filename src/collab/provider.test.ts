// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/**
 * Leaving a live room must leave nothing behind that keeps its Y.Doc alive
 * (docs/perf-budget.md rule 7). PlanEditor drops the doc rather than
 * destroying it, so anything still holding the provider holds the whole plan.
 */
import * as Y from "yjs";
import { afterEach, expect, it, vi } from "vitest";

import { createCollabProvider } from "./provider";

/** Stands in for the relay socket and tracks which ones are still open. */
class FakeSocket {
  static open = new Set<FakeSocket>();
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.open.add(this);
  }
  send() {}
  close() {
    FakeSocket.open.delete(this);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeSocket.open.clear();
});

it("destroying the handle closes the relay socket and stops every timer", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  const ydoc = new Y.Doc();
  const handle = createCollabProvider(ydoc, {
    sessionId: "sess-leak",
    threadStart: 1,
    version: 1,
    signaling: ["wss://relay.test"],
    // No secret: no key derivation, so the room opens on the next microtask.
    secret: "",
    invite: "invite-a",
  });
  handle.awareness.setLocalStateField("user", { name: "owner" });
  await Promise.resolve();
  expect(FakeSocket.open.size).toBe(1);
  // The awareness's outdated-peer check and the socket's liveness check.
  expect(vi.getTimerCount()).toBeGreaterThan(0);

  handle.destroy();
  await Promise.resolve();

  // The shared socket's provider set no longer holds this room, so the socket
  // closed; and no interval is left whose closure reaches the doc.
  expect(FakeSocket.open.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(handle.awareness.getLocalState()).toBeNull();
});
