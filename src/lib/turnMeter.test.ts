// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { beforeEach, describe, expect, it } from "vitest";

import { resetWindows } from "./modelInfo";
import {
  activityLabel,
  cachedShare,
  contextPressure,
  contextResets,
  emptyMeter,
  formatDuration,
  formatTokens,
  mergeMeter,
  meterBadgeLabel,
  meterFooterLabel,
  totalTokens,
  turnCostUsd,
  wasTruncated,
  type TurnMeter,
} from "./turnMeter";

const meter = (over: Partial<TurnMeter> = {}): TurnMeter => ({
  ...emptyMeter(),
  ...over,
});

describe("mergeMeter", () => {
  it("adopts a newer rev", () => {
    const a = meter({ rev: 1, outputTokens: 10 });
    const b = meter({ rev: 2, outputTokens: 40 });
    expect(mergeMeter(a, b)).toBe(b);
  });

  /** Identity equality IS the guard — a stale event must not churn React. */
  it("returns the CURRENT object for a stale or equal rev", () => {
    const a = meter({ rev: 5, outputTokens: 40 });
    expect(mergeMeter(a, meter({ rev: 4, outputTokens: 9 }))).toBe(a);
    expect(mergeMeter(a, meter({ rev: 5, outputTokens: 9 }))).toBe(a);
  });

  it("takes the first meter it sees, whatever its rev", () => {
    const b = meter({ rev: 3 });
    expect(mergeMeter(null, b)).toBe(b);
  });

  it("is a no-op for a missing payload", () => {
    const a = meter({ rev: 2 });
    expect(mergeMeter(a, null)).toBe(a);
    expect(mergeMeter(a, undefined)).toBe(a);
    expect(mergeMeter(null, null)).toBeNull();
  });

  it("remembers a stated context window for the next turn", () => {
    resetWindows();
    mergeMeter(null, meter({ rev: 1, model: "claude-sonnet-5", contextWindow: 1_000_000 }));
    // A LATER meter with no window of its own still gets a pressure reading.
    const later = meter({ rev: 2, model: "claude-sonnet-5", contextTokens: 250_000 });
    expect(contextPressure(later)?.limit).toBe(1_000_000);
  });
});

describe("contextPressure", () => {
  beforeEach(() => resetWindows());

  it("is null when no limit is known — tokens, never a guessed percentage", () => {
    expect(contextPressure(meter({ model: "claude-opus-5", contextTokens: 5_000 })))
      .toBeNull();
  });

  it("uses the window the CLI stated for this turn", () => {
    const p = contextPressure(
      meter({ model: "claude-sonnet-5", contextTokens: 250_000, contextWindow: 1_000_000 }),
    );
    expect(p).toEqual({ used: 250_000, limit: 1_000_000, fraction: 0.25, high: false });
  });

  it("escalates past 75%", () => {
    const p = contextPressure(
      meter({ model: "x[1m]", contextTokens: 800_000, contextWindow: null }),
    );
    expect(p?.high).toBe(true);
  });

  it("clamps an overrun rather than reading past 100%", () => {
    const p = contextPressure(
      meter({ model: "m", contextTokens: 300_000, contextWindow: 200_000 }),
    );
    expect(p?.fraction).toBe(1);
  });

  it("is null before anything has been read", () => {
    expect(contextPressure(null)).toBeNull();
    expect(contextPressure(meter({ contextTokens: 0, contextWindow: 200_000 }))).toBeNull();
  });
});

describe("cost", () => {
  it("reports the CLI's own figure and nothing else", () => {
    expect(turnCostUsd(meter({ costUsd: 0.0497 }))).toBeCloseTo(0.0497);
  });

  it("is null while a turn streams, and for a harness that reports none", () => {
    expect(turnCostUsd(meter())).toBeNull();
    expect(turnCostUsd(null)).toBeNull();
  });
});

describe("truncation", () => {
  /** A cut-off reply otherwise looks byte-for-byte like a complete one. */
  it("only max_tokens counts", () => {
    expect(wasTruncated(meter({ stopReason: "max_tokens" }))).toBe(true);
    expect(wasTruncated(meter({ stopReason: "end_turn" }))).toBe(false);
    expect(wasTruncated(meter({ stopReason: "tool_use" }))).toBe(false);
    expect(wasTruncated(meter())).toBe(false);
    expect(wasTruncated(null)).toBe(false);
  });
});

describe("labels", () => {
  beforeEach(() => resetWindows());

  it("names the harness, the model and the effort", () => {
    expect(meterBadgeLabel(meter({ model: "claude-opus-5", effort: "xhigh" })))
      .toBe("Claude · opus-5 · xhigh");
    expect(meterBadgeLabel(meter({ model: "gpt-5.6-sol" }))).toBe("Codex · GPT-5.6-sol");
  });

  it("has no badge without an observed model", () => {
    expect(meterBadgeLabel(meter())).toBeNull();
    expect(meterBadgeLabel(null)).toBeNull();
  });

  it("reads the footer as in / cached / out / duration", () => {
    const line = meterFooterLabel(
      meter({
        model: "claude-opus-5",
        effort: "xhigh",
        inputTokens: 6,
        cacheReadTokens: 30_186,
        cacheCreationTokens: 5_983,
        outputTokens: 319,
        durationMs: 4_181,
      }),
    );
    expect(line).toBe("opus-5 · xhigh · 36.2k in (83% cached) · 319 out · 4.2s");
  });

  it("omits what it doesn't have rather than printing zeros", () => {
    expect(meterFooterLabel(meter({ model: "claude-opus-5" }))).toBe("opus-5");
    expect(meterFooterLabel(meter())).toBeNull();
  });

  it("puts the stall ahead of everything else on the activity line", () => {
    const stalled = meter({
      lastToolLabel: "searching the lake…",
      rateLimited: { status: "rejected", resetsAt: 1, kind: "five_hour" },
    });
    expect(activityLabel([], stalled)).toBe("Rate limited (five_hour) · waiting");
  });

  it("shows the newest entry, then falls back to the meter's standing state", () => {
    const m = meter({ lastToolLabel: "searching the lake…" });
    expect(
      activityLabel(
        [
          { at: 1, kind: "requesting", label: "Requesting…" },
          { at: 2, kind: "tool", label: "Grep…" },
        ],
        m,
      ),
    ).toBe("Grep…");
    expect(activityLabel([], m)).toBe("searching the lake…");
    expect(activityLabel([], meter({ thinkingTokens: 75 }))).toBe("Thinking…");
    expect(activityLabel([], meter())).toBeNull();
  });
});

describe("formatters", () => {
  it("compacts token counts", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_400)).toBe("12.4k");
    expect(formatTokens(2_000_000)).toBe("2M");
  });

  it("reads durations the way a person says them", () => {
    expect(formatDuration(420)).toBe("420ms");
    expect(formatDuration(4_181)).toBe("4.2s");
    expect(formatDuration(12_400)).toBe("12.4s");
    expect(formatDuration(185_000)).toBe("3m 05s");
    expect(formatDuration(null)).toBeNull();
  });

  it("sums and shares", () => {
    const m = meter({
      inputTokens: 6,
      outputTokens: 319,
      cacheReadTokens: 30_186,
      cacheCreationTokens: 5_983,
    });
    expect(totalTokens(m)).toBe(36_494);
    expect(cachedShare(m)).toBeCloseTo(30_186 / 36_175);
    expect(cachedShare(meter())).toBeNull();
  });
});

describe("contextResets", () => {
  /** An unlabelled fall from 78% to 12% reads as a broken meter, and the user
   *  stops trusting every other number on the strip with it. */
  it("marks the row where occupancy fell off a cliff", () => {
    const meters = {
      a: meter({ contextTokens: 120_000 }),
      b: meter({ contextTokens: 140_000 }),
      c: meter({ contextTokens: 14_000 }),
      d: meter({ contextTokens: 22_000 }),
    };
    const out = contextResets(["a", "b", "c", "d"], meters);
    expect([...out]).toEqual(["c"]);
  });

  it("ignores ordinary shrinkage and small threads", () => {
    const meters = {
      a: meter({ contextTokens: 60_000 }),
      // A 25% dip is a shorter prompt, not a reset.
      b: meter({ contextTokens: 45_000 }),
      // Big fraction, tiny absolute — early-thread noise.
      c: meter({ contextTokens: 900 }),
    };
    expect(contextResets(["a", "b"], meters).size).toBe(0);
    expect(
      contextResets(["x", "y"], { x: meter({ contextTokens: 3_000 }), y: meters.c }).size,
    ).toBe(0);
  });

  it("skips rows with no meter rather than treating them as zero", () => {
    const meters = {
      a: meter({ contextTokens: 100_000 }),
      c: meter({ contextTokens: 98_000 }),
    };
    // "b" has no meter (a user row): it must not read as a drop to zero and
    // back, which would mark BOTH neighbours.
    expect(contextResets(["a", "b", "c"], meters).size).toBe(0);
  });
});
