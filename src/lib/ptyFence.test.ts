// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { enqueuePtyOp, enqueuePtyOpChecked } from "./ptyFence";

/** A manually-settled promise, so tests control op completion order. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ptyFence ordering", () => {
  it("serializes ops per id: a later op never starts before an earlier one settles", async () => {
    const order: string[] = [];
    const gate = deferred<void>();
    void enqueuePtyOp("t", async () => {
      order.push("spawn1:start");
      await gate.promise;
      order.push("spawn1:end");
    });
    void enqueuePtyOp("t", async () => {
      order.push("kill1");
    });
    const done = enqueuePtyOp("t", async () => {
      order.push("spawn2");
    });
    // Ops start on the microtask queue; flush it, then only the gated first
    // op may have started — the fence must be holding the other two.
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["spawn1:start"]);
    gate.resolve();
    await done;
    expect(order).toEqual(["spawn1:start", "spawn1:end", "kill1", "spawn2"]);
  });

  it("independent ids do not fence each other", async () => {
    const order: string[] = [];
    const gate = deferred<void>();
    void enqueuePtyOp("a", async () => {
      await gate.promise;
      order.push("a");
    });
    await enqueuePtyOp("b", async () => {
      order.push("b");
    });
    expect(order).toEqual(["b"]);
    gate.resolve();
  });
});

describe("enqueuePtyOpChecked", () => {
  it("preserves the op's result", async () => {
    await expect(
      enqueuePtyOpChecked("r", () => Promise.resolve(42)),
    ).resolves.toBe(42);
  });

  it("propagates the op's rejection to the caller", async () => {
    await expect(
      enqueuePtyOpChecked("r", () => Promise.reject(new Error("not running"))),
    ).rejects.toThrow("not running");
  });

  it("a rejected checked op does not poison the fence for later ops", async () => {
    const seen: string[] = [];
    const failed = enqueuePtyOpChecked("p", () =>
      Promise.reject(new Error("dead")),
    );
    await expect(failed).rejects.toThrow("dead");
    await enqueuePtyOp("p", async () => {
      seen.push("after");
    });
    expect(seen).toEqual(["after"]);
  });

  // The lost-restore regression, in miniature: dev StrictMode queues
  // [spawn1, kill1, spawn2] before the handoff's write is released by
  // spawn1's signal. Unfenced, the write raced kill1 and died with the
  // first shell while reporting success. Fenced, it must run AFTER spawn2
  // and deliver into the surviving shell.
  it("a checked write queued during mount churn lands after the respawn", async () => {
    const order: string[] = [];
    const spawn1 = deferred<void>();
    void enqueuePtyOp("s", async () => {
      order.push("spawn1");
      spawn1.resolve(); // the spawn signal the handoff waits on
    });
    void enqueuePtyOp("s", async () => {
      order.push("kill1");
    });
    void enqueuePtyOp("s", async () => {
      order.push("spawn2");
    });
    // The handoff releases its write only once the spawn signal fires.
    await spawn1.promise;
    await enqueuePtyOpChecked("s", async () => {
      order.push("write");
    });
    expect(order).toEqual(["spawn1", "kill1", "spawn2", "write"]);
  });
});
