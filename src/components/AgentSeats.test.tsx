// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

// The contract under test is the P3 roster: the Agent Seats dialog is no
// longer only a model picker — each seat row renders its standing charter and
// trigger plus what the seat actually did (seat_stats) and burned (seat_burn,
// tokens only), all flowing from the `get_seat_roster` command. The data in
// the mock is deliberately NOT any built-in default string, so the assertions
// prove the row renders what the backend sent.

const ROSTER = [
  {
    seat: "librarian",
    charter: "Custom librarian charter straight from the DB",
    trigger: "When you press the test survey button",
    lastRunAt: Date.now() - 2.5 * 3_600_000,
    itemsFiled: 0,
    inputTokens: 12_400,
    outputTokens: 3_100,
    cacheReadTokens: 70,
    cacheCreationTokens: 30,
    spawns: 5,
  },
];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === "get_agent_seats") {
      return Promise.resolve({
        seats: {},
        knownSeats: [],
        claudeBin: null,
        canRevert: false,
        blurbs: [],
      });
    }
    if (cmd === "get_seat_roster") return Promise.resolve(ROSTER);
    if (cmd === "get_ui_prefs") {
      return Promise.resolve({ seatAssignPrefs: null });
    }
    return Promise.resolve(null);
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import {
  AgentSeats,
  burnSummary,
  formatLastRun,
  formatTokens,
  type SeatRosterEntry,
} from "./AgentSeats";

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

describe("roster formatting helpers", () => {
  it("formats token counts compactly", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1_000)).toBe("1k");
    expect(formatTokens(12_400)).toBe("12.4k");
    expect(formatTokens(2_000_000)).toBe("2M");
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });

  it("describes last run in coarse human units, never-ran included", () => {
    const now = 1_000_000_000_000;
    expect(formatLastRun(null, now)).toBe("never ran");
    expect(formatLastRun(undefined, now)).toBe("never ran");
    expect(formatLastRun(now - 30_000, now)).toBe("just now");
    expect(formatLastRun(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatLastRun(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatLastRun(now - 49 * 3_600_000, now)).toBe("2d ago");
  });

  it("summarizes burn as tokens only, honestly empty when nothing burned", () => {
    const base: SeatRosterEntry = {
      seat: "s",
      charter: "c",
      trigger: "t",
      lastRunAt: null,
      itemsFiled: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      spawns: 0,
    };
    expect(burnSummary(base)).toBe("no burn recorded");
    expect(
      burnSummary({ ...base, inputTokens: 12_400, outputTokens: 3_100, spawns: 5 }),
    ).toBe("12.4k tok in · 3.1k tok out · 5 spawns");
    expect(burnSummary({ ...base, spawns: 1, inputTokens: 10 })).toBe(
      "10 tok in · 0 tok out · 1 spawn",
    );
  });
});

describe("AgentSeats roster rendering", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("renders charter, trigger, stats and burn for a seat the rollup carries", async () => {
    await act(async () => {
      root.render(createElement(AgentSeats));
    });
    // Open the dialog.
    const openBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Configure"),
    );
    expect(openBtn).toBeTruthy();
    await act(async () => {
      openBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const text = document.body.textContent ?? "";
    // The charter and trigger came from the command, not a built-in string.
    expect(text).toContain("Custom librarian charter straight from the DB");
    expect(text).toContain("When you press the test survey button");
    // Stats: last run + items filed.
    expect(text).toContain("2h ago");
    expect(text).toContain("0 filed");
    // Burn, rendered as tokens (never money).
    expect(text).toContain("12.4k tok in · 3.1k tok out · 5 spawns");
    expect(text).not.toContain("$");
    // A seat absent from the rollup still renders its picker row, blockless.
    expect(text).toContain("Voice agent");
    // The model/effort picker survives the roster growth.
    const picker = Array.from(document.querySelectorAll("button")).find((b) =>
      b.getAttribute("aria-label")?.includes("Librarian model & effort"),
    );
    expect(picker).toBeTruthy();
  });
});
