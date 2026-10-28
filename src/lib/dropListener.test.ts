// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, describe, expect, it, vi } from "vitest";
import { dropListener } from "./dropListener";

afterEach(() => vi.useRealTimers());

describe("dropListener", () => {
  it("an unlisten that throws in the registration gap is tried again until it goes through, and nothing is left unhandled", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const unlisten = vi.fn(async () => {
      if (++calls < 3) throw new TypeError("undefined is not an object (evaluating 'listeners[eventId].handlerId')");
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    dropListener(unlisten);
    await vi.runAllTimersAsync();
    process.off("unhandledRejection", unhandled);
    expect(unlisten).toHaveBeenCalledTimes(3);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("gives up after a few tries rather than spinning", async () => {
    vi.useFakeTimers();
    const unlisten = vi.fn(() => { throw new Error("gone"); });
    dropListener(unlisten);
    await vi.runAllTimersAsync();
    expect(unlisten).toHaveBeenCalledTimes(5);
  });
});
