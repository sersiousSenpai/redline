// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  advance,
  BOOT_FAILSAFE_MS,
  BOOT_FIRST_BREATH_MS,
  BOOT_OPEN_MS,
  holdMs,
  shouldArm,
  SNAPBACK_SETTLE_MS,
} from "./boot";

describe("shouldArm", () => {
  it("arms only a fresh launch with motion allowed", () => {
    expect(shouldArm({ reducedMotion: false, alreadyPlayed: false })).toBe(
      true,
    );
    expect(shouldArm({ reducedMotion: true, alreadyPlayed: false })).toBe(
      false,
    );
    expect(shouldArm({ reducedMotion: false, alreadyPlayed: true })).toBe(
      false,
    );
    expect(shouldArm({ reducedMotion: true, alreadyPlayed: true })).toBe(false);
  });
});

describe("advance", () => {
  it("parts the doors on reveal", () => {
    expect(advance("closed", "reveal")).toBe("opening");
  });
  it("skip settles from any live phase — the user outranks the doors", () => {
    expect(advance("closed", "skip")).toBe("settled");
    expect(advance("opening", "skip")).toBe("settled");
  });
  it("timeout settles from any live phase", () => {
    expect(advance("closed", "timeout")).toBe("settled");
    expect(advance("opening", "timeout")).toBe("settled");
  });
  it("settled is absorbing", () => {
    expect(advance("settled", "reveal")).toBe("settled");
    expect(advance("settled", "skip")).toBe("settled");
    expect(advance("settled", "timeout")).toBe("settled");
  });
  it("a second reveal mid-opening changes nothing", () => {
    expect(advance("opening", "reveal")).toBe("opening");
  });
});

describe("timings", () => {
  it("first launches breathe, replays don't", () => {
    expect(holdMs(true)).toBe(BOOT_FIRST_BREATH_MS);
    expect(holdMs(false)).toBe(0);
  });
  it("the dead-man switch outlasts the longest legitimate run", () => {
    // Breath + opening + generous frame slack must land BEFORE the module
    // failsafe force-removes the attribute, or a healthy boot gets cut off.
    expect(BOOT_FIRST_BREATH_MS + BOOT_OPEN_MS + 300).toBeLessThanOrEqual(
      BOOT_FAILSAFE_MS,
    );
  });
  it("the snap-back fold is brisker than the boot", () => {
    expect(SNAPBACK_SETTLE_MS).toBeLessThan(BOOT_OPEN_MS);
  });
});

// Source invariants on styles.css — the CSS half of the choreography lives
// there and these two contracts cannot be expressed in TypeScript.
describe("boot CSS contract", () => {
  const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");

  it("the doors only ever move under prefers-reduced-motion: no-preference", () => {
    // Every data-rl-boot selector must live inside the doors section, and
    // that section's rules must sit inside its motion-allowed media block —
    // reduced motion means the closed frame never exists, not a fast fade.
    const start = css.indexOf("Doors-open boot");
    const end = css.indexOf("Snap-back settle");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const doors = css.slice(start, end);
    const outside =
      css.slice(0, start).includes("[data-rl-boot") ||
      css.slice(end).includes("[data-rl-boot");
    expect(outside).toBe(false);
    const media = doors.indexOf(
      "@media (prefers-reduced-motion: no-preference)",
    );
    const firstBoot = doors.indexOf("[data-rl-boot");
    expect(media).toBeGreaterThan(-1);
    expect(firstBoot).toBeGreaterThan(media);
  });

  it("the opening stagger finishes inside the hard settle timeout", () => {
    // Longest transition-delay + longest transition duration in the boot
    // block must fit in BOOT_OPEN_MS, or the hard timeout truncates the
    // document plate's resolve. Scoped to the doors section by its markers —
    // the rest of the sheet has its own unrelated transitions.
    const start = css.indexOf("Doors-open boot");
    const end = css.indexOf("Snap-back settle");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const doors = css.slice(start, end);
    const delays = [...doors.matchAll(/transition-delay:\s*(\d+)ms/g)].map(
      (m) => Number(m[1]),
    );
    const durations = [
      ...doors.matchAll(/transition:[^;]*?(\d+)ms cubic-bezier/g),
    ].map((m) => Number(m[1]));
    expect(delays.length).toBeGreaterThan(0);
    expect(durations.length).toBeGreaterThan(0);
    expect(Math.max(...delays) + Math.max(...durations)).toBeLessThanOrEqual(
      BOOT_OPEN_MS,
    );
  });
});
