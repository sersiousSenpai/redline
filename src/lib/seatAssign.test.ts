// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFS,
  EFFORT_OPTIONS,
  MODEL_OPTIONS,
  applyPick,
  changedPicks,
  discretionBand,
  distinctPreflightModels,
  isNoOp,
  needsPreflight,
  parsePrefs,
  pickTransition,
  seatSummary,
  traitLabel,
  type SeatConfig,
  type SeatPick,
} from "./seatAssign";

const pick = (over: Partial<SeatPick> = {}): SeatPick => ({
  seat: "browse",
  rationale: "47 turns in window",
  deviates: false,
  ...over,
});

describe("the offered menu", () => {
  it("matches what the CLI documents", () => {
    // `claude --help`: --effort (low, medium, high, xhigh, max); --model
    // aliases include 'fable'. Both were missing from the picker before.
    expect(EFFORT_OPTIONS).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(MODEL_OPTIONS).toContain("fable");
    expect(MODEL_OPTIONS).toContain("haiku");
  });
});

describe("discretionBand", () => {
  it("splits at the same boundaries as the Rust rubric", () => {
    expect(discretionBand(0).label).toBe(discretionBand(20).label);
    expect(discretionBand(20).label).not.toBe(discretionBand(21).label);
    expect(discretionBand(21).label).toBe(discretionBand(60).label);
    expect(discretionBand(60).label).not.toBe(discretionBand(61).label);
    expect(discretionBand(61).label).toBe(discretionBand(100).label);
  });

  it("clamps rather than throwing on out-of-range input", () => {
    expect(discretionBand(-40).label).toBe(discretionBand(0).label);
    expect(discretionBand(9999).label).toBe(discretionBand(100).label);
  });
});

describe("applyPick", () => {
  it("preserves the fields the agent may never touch", () => {
    const current: SeatConfig = {
      model: "opus",
      effort: "max",
      fallback: "sonnet",
      backend: "claude-code",
      binaryPath: "/opt/claude",
      extraFlags: ["--verbose-tools"],
    };
    const out = applyPick(current, pick({ model: "haiku" }));
    expect(out.backend).toBe("claude-code");
    expect(out.binaryPath).toBe("/opt/claude");
    expect(out.extraFlags).toEqual(["--verbose-tools"]);
  });

  it("clears an omitted reach field rather than keeping the old value", () => {
    // The card shows the resulting state, so a row displaying no effort must
    // apply as "no effort" — silently keeping `max` would be a lie.
    const current: SeatConfig = { model: "opus", effort: "max", fallback: "sonnet" };
    const out = applyPick(current, pick({ model: "haiku" }));
    expect(out.model).toBe("haiku");
    expect(out.effort).toBeUndefined();
    expect(out.fallback).toBeUndefined();
  });

  it("treats a whitespace-only value as absent", () => {
    const out = applyPick({}, pick({ model: "sonnet", effort: "   " }));
    expect(out.model).toBe("sonnet");
    expect(out.effort).toBeUndefined();
  });
});

describe("changedPicks", () => {
  it("drops picks that would change nothing", () => {
    const seats: Record<string, SeatConfig> = {
      browse: { model: "sonnet" },
      voice: { model: "opus", effort: "high" },
    };
    const picks = [
      pick({ seat: "browse", model: "sonnet" }), // identical → dropped
      pick({ seat: "voice", model: "opus", effort: "max" }), // effort differs
      pick({ seat: "keeper", model: "haiku" }), // unconfigured → a change
    ];
    expect(changedPicks(seats, picks).map((p) => p.seat)).toEqual([
      "voice",
      "keeper",
    ]);
  });

  it("counts dropping a field as a change", () => {
    const seats: Record<string, SeatConfig> = { browse: { model: "opus", effort: "max" } };
    expect(isNoOp(seats.browse, pick({ model: "opus" }))).toBe(false);
    expect(isNoOp(seats.browse, pick({ model: "opus", effort: "max" }))).toBe(true);
  });

  it("ignores backend/binaryPath/extraFlags when judging sameness", () => {
    // Those are outside the pick's reach, so a difference there is not a
    // change the card should offer to apply.
    const seats: Record<string, SeatConfig> = {
      browse: { model: "sonnet", binaryPath: "/opt/claude", extraFlags: ["--x"] },
    };
    expect(changedPicks(seats, [pick({ model: "sonnet" })])).toEqual([]);
  });
});

describe("preflight scoping", () => {
  it("never probes a documented alias", () => {
    for (const alias of MODEL_OPTIONS) {
      expect(needsPreflight(alias)).toBe(false);
    }
    expect(needsPreflight("claude-fable-5")).toBe(true);
    expect(needsPreflight("  ")).toBe(false);
    expect(needsPreflight(undefined)).toBe(false);
  });

  it("dedups a whole chart down to the ids actually worth spawning", () => {
    const picks = [
      pick({ seat: "browse", model: "sonnet" }),
      pick({ seat: "voice", model: "opus" }),
      pick({ seat: "mission", model: "claude-fable-5" }),
      pick({ seat: "keeper", model: "claude-fable-5" }),
      pick({ seat: "drafter", model: "claude-other-3" }),
      pick({ seat: "linked" }),
    ];
    // Six picks, four aliases-or-empty, two distinct custom ids → two spawns.
    expect(distinctPreflightModels(picks)).toEqual([
      "claude-fable-5",
      "claude-other-3",
    ]);
  });

  it("costs zero spawns for an all-alias chart", () => {
    const picks = MODEL_OPTIONS.map((m, i) => pick({ seat: `s${i}`, model: m }));
    expect(distinctPreflightModels(picks)).toEqual([]);
  });

  it("is stable across edits, so callers can skip ids they already probed", () => {
    // A probe of a valid custom id is a real billed turn. The component keeps a
    // probed-set and diffs against this; that only works if the same chart
    // yields the same ids rather than, say, re-ordering them.
    const before = [
      pick({ seat: "mission", model: "claude-fable-5" }),
      pick({ seat: "keeper", model: "claude-other-3" }),
    ];
    const afterFallbackEdit = [
      pick({ seat: "mission", model: "claude-fable-5", fallback: "haiku" }),
      pick({ seat: "keeper", model: "claude-other-3" }),
    ];
    expect(distinctPreflightModels(afterFallbackEdit)).toEqual(
      distinctPreflightModels(before),
    );
    // Editing only the fallback introduces no new id to probe at all.
    const already = new Set(distinctPreflightModels(before));
    expect(
      distinctPreflightModels(afterFallbackEdit).filter((m) => !already.has(m)),
    ).toEqual([]);
  });
});

describe("traitLabel", () => {
  it("humanizes the trait names the tooltip renders", () => {
    expect(traitLabel("latency_sensitive")).toBe("Latency-sensitive");
    expect(traitLabel("long_context")).toBe("Long context");
    expect(traitLabel("write_capable")).toBe("Can write");
  });

  it("degrades readably for a trait added in Rust but not mapped here", () => {
    // Falling back to the raw name keeps a new trait visible rather than
    // silently dropping it from the chip row.
    expect(traitLabel("needs_network")).toBe("needs network");
  });
});

describe("re-filtering against live seat state", () => {
  it("drops a pick the user hand-applied while the agent was still running", () => {
    // The run takes minutes and the dialog stays editable. Filtering against
    // the seats captured when Run was clicked would leave a row reading
    // "sonnet → sonnet" whose Apply writes nothing.
    const proposed = [
      pick({ seat: "browse", model: "sonnet" }),
      pick({ seat: "voice", model: "opus", effort: "high" }),
    ];
    const seatsAtRunStart: Record<string, SeatConfig> = {};
    expect(changedPicks(seatsAtRunStart, proposed)).toHaveLength(2);

    // …the user sets browse to sonnet by hand mid-run.
    const seatsNow: Record<string, SeatConfig> = { browse: { model: "sonnet" } };
    expect(changedPicks(seatsNow, proposed).map((p) => p.seat)).toEqual(["voice"]);
  });
});

describe("seatSummary and pickTransition", () => {
  it("shows the fallback with an arrow and hides an empty config", () => {
    expect(seatSummary(undefined)).toBeNull();
    expect(seatSummary({})).toBeNull();
    expect(seatSummary({ binaryPath: "/opt/claude" })).toBeNull();
    expect(seatSummary({ model: "opus", effort: "high" })).toBe("opus · high");
    expect(seatSummary({ model: "opus", fallback: "haiku" })).toBe("opus · ↳haiku");
  });

  it("reads as from → to against the row's default label", () => {
    expect(pickTransition(undefined, pick({ model: "opus", effort: "high" }), "Default"))
      .toEqual({ from: "Default", to: "opus · high" });
    expect(pickTransition({ model: "opus" }, pick({ model: "haiku" }), "Inherit"))
      .toEqual({ from: "opus", to: "haiku" });
  });
});

describe("parsePrefs", () => {
  it("falls back to defaults on missing, corrupt or out-of-range input", () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("not json")).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('{"posture":"wat","discretion":"x"}')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('{"posture":"cost","discretion":500}')).toEqual({
      posture: "cost",
      discretion: 100,
    });
    expect(parsePrefs('{"posture":"quality","discretion":-3}')).toEqual({
      posture: "quality",
      discretion: 0,
    });
  });

  it("round-trips a valid blob", () => {
    const prefs = { posture: "cost" as const, discretion: 25 };
    expect(parsePrefs(JSON.stringify(prefs))).toEqual(prefs);
  });
});
