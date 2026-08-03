// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  dismissSuggestion,
  emptyNudgeState,
  parseNudgeState,
  recordLaunch,
  serializeNudgeState,
  suggestLanding,
  NUDGE_HISTORY,
} from "./nudge";
import {
  defaultWorkspace,
  setLanding,
  setSurfaceEnabled,
} from "../config/workspace";
import type { NudgeState } from "./nudge";

function launches(surfaces: string[]): NudgeState {
  return { launches: surfaces, dismissed: [] };
}

describe("nudge state round-trip", () => {
  it("parses its own serialization and caps history", () => {
    let state = emptyNudgeState();
    for (let i = 0; i < NUDGE_HISTORY + 3; i++) {
      state = recordLaunch(state, "drafter");
    }
    expect(state.launches.length).toBe(NUDGE_HISTORY);
    const back = parseNudgeState(serializeNudgeState(state));
    expect(back).toEqual(state);
  });

  it("bad JSON and junk shapes degrade to empty", () => {
    for (const text of [null, "", "nope", "[1]", '{"launches":"x"}']) {
      expect(parseNudgeState(text)).toEqual(emptyNudgeState());
    }
  });
});

describe("suggestLanding", () => {
  const habitual = launches(["drafter", "drafter", "drafter", "drafter"]);

  it("fires when the recent launches agree", () => {
    const s = suggestLanding(habitual, defaultWorkspace());
    expect(s?.surface).toBe("drafter");
    expect(s?.id).toBe("landing:drafter");
    expect(s?.message).toContain("Prompt Drafter");
  });

  it("stays quiet below the threshold or with mixed habits", () => {
    expect(
      suggestLanding(launches(["drafter", "drafter", "drafter"]), defaultWorkspace()),
    ).toBeNull();
    expect(
      suggestLanding(
        launches(["drafter", "browser", "drafter", "review", "drafter"]),
        defaultWorkspace(),
      ),
    ).toBeNull();
  });

  it("fires at most once — a dismissal retires the suggestion forever", () => {
    const s = suggestLanding(habitual, defaultWorkspace());
    const dismissed = dismissSuggestion(habitual, s!.id);
    expect(suggestLanding(dismissed, defaultWorkspace())).toBeNull();
    // Dismissing twice is idempotent.
    expect(dismissSuggestion(dismissed, s!.id)).toEqual(dismissed);
  });

  it("an explicit landing choice silences the whole family", () => {
    const ws = setLanding(defaultWorkspace(), "drafter");
    expect(suggestLanding(habitual, ws)).toBeNull();
    // Accepting IS an explicit choice — so acceptance also ends the nudging.
  });

  it("never suggests landing on a disabled surface", () => {
    const ws = setSurfaceEnabled(defaultWorkspace(), "drafter", false);
    expect(suggestLanding(habitual, ws)).toBeNull();
  });

  it("only the last NUDGE_HISTORY launches count", () => {
    const state = launches([
      "browser",
      "browser",
      "browser",
      "browser",
      ...Array(NUDGE_HISTORY).fill("document"),
    ]);
    const s = suggestLanding(state, defaultWorkspace());
    expect(s?.surface ?? null).not.toBe("browser");
  });
});
