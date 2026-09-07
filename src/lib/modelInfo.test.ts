// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { beforeEach, describe, expect, it } from "vitest";

import {
  contextWindow,
  modelInfo,
  rememberWindow,
  resetWindows,
  shortModel,
} from "./modelInfo";

describe("shortModel", () => {
  it("drops the family prefix and the date stamp", () => {
    expect(shortModel("claude-haiku-4-5-20251001")).toBe("haiku-4-5");
    expect(shortModel("claude-opus-5")).toBe("opus-5");
  });

  it("keeps the [1m] marker — it is the one thing the id must not lose", () => {
    expect(shortModel("claude-opus-5[1m]")).toBe("opus-5[1m]");
    expect(shortModel("claude-haiku-4-5-20251001[1m]")).toBe("haiku-4-5[1m]");
  });

  it("leaves an id it doesn't recognise alone", () => {
    expect(shortModel("some-other-model")).toBe("some-other-model");
  });
});

describe("modelInfo", () => {
  it("reads the harness family off the id", () => {
    expect(modelInfo("claude-opus-5")?.family).toBe("claude");
    expect(modelInfo("gpt-5.6-sol")?.family).toBe("gpt");
    expect(modelInfo("mystery-model")?.family).toBe("unknown");
  });

  it("is null for an absent model rather than a placeholder", () => {
    expect(modelInfo(null)).toBeNull();
    expect(modelInfo("")).toBeNull();
    expect(modelInfo("   ")).toBeNull();
  });
});

describe("contextWindow", () => {
  beforeEach(() => resetWindows());

  /** The failure mode that would make the whole feature untrustworthy on the
   *  exact sessions where context pressure matters most. */
  it("reads a [1m] id as a 1M window, not 200k", () => {
    expect(contextWindow("claude-opus-5[1m]")).toBe(1_000_000);
    expect(contextWindow("claude-sonnet-5[1M]")).toBe(1_000_000);
  });

  it("returns null for an unknown model rather than guessing a default", () => {
    expect(contextWindow("claude-opus-5")).toBeNull();
    expect(contextWindow("mystery-model")).toBeNull();
    expect(contextWindow(null)).toBeNull();
  });

  it("takes what the CLI stated on this turn, above everything else", () => {
    expect(contextWindow("claude-sonnet-5", 1_000_000)).toBe(1_000_000);
    // …and remembers it, so the NEXT turn's live bar has a limit before its
    // own result line lands.
    expect(contextWindow("claude-sonnet-5")).toBe(1_000_000);
  });

  it("keeps the [1m] rule above a remembered window", () => {
    // A bogus remembered value must not beat the id's own statement.
    rememberWindow("claude-opus-5[1m]", 200_000);
    expect(contextWindow("claude-opus-5[1m]")).toBe(1_000_000);
  });

  it("ignores a nonsense observation", () => {
    expect(contextWindow("claude-opus-5", 0)).toBeNull();
    expect(contextWindow("claude-opus-5", -5)).toBeNull();
    expect(contextWindow("claude-opus-5", Number.NaN)).toBeNull();
  });

  it("keeps windows separate per exact id", () => {
    rememberWindow("claude-sonnet-5", 1_000_000);
    expect(contextWindow("claude-opus-5")).toBeNull();
    expect(contextWindow("claude-sonnet-5")).toBe(1_000_000);
  });
});
