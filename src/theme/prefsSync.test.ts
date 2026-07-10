// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { reconcilePick, reconcileTheme } from "./prefsSync";

const resolves = (n: string) => ["studio", "midnight"].includes(n);

describe("reconcileTheme", () => {
  it("DB value wins when it resolves and differs from local", () => {
    const d = reconcileTheme({
      db: "midnight",
      local: "studio",
      resolves,
      appliedAtBoot: true,
      fallback: "studio",
    });
    expect(d.apply).toBe("midnight");
    expect(d.writeDb).toBeUndefined();
  });

  it("no DB value → local pick migrates into the DB, nothing re-applies", () => {
    const d = reconcileTheme({
      db: null,
      local: "studio",
      resolves,
      appliedAtBoot: true,
      fallback: "studio",
    });
    expect(d.apply).toBeUndefined();
    expect(d.writeDb).toBe("studio");
  });

  it("migration is idempotent — once the DB row matches, no actions remain", () => {
    const first = reconcileTheme({
      db: null,
      local: "studio",
      resolves,
      appliedAtBoot: true,
      fallback: "studio",
    });
    // Simulate the next launch: DB now holds what the migration wrote.
    const second = reconcileTheme({
      db: first.writeDb,
      local: "studio",
      resolves,
      appliedAtBoot: true,
      fallback: "studio",
    });
    expect(second.apply).toBeUndefined();
    expect(second.writeDb).toBeUndefined();
  });

  it("a user theme skipped at boot re-applies even when names agree", () => {
    const d = reconcileTheme({
      db: "midnight",
      local: "midnight",
      resolves,
      appliedAtBoot: false, // not a built-in — pre-paint bootstrap skipped it
      fallback: "studio",
    });
    expect(d.apply).toBe("midnight");
  });

  it("a name that resolves nowhere snaps to the fallback and heals the DB", () => {
    const d = reconcileTheme({
      db: "deleted-user-theme",
      local: "deleted-user-theme",
      resolves,
      appliedAtBoot: false,
      fallback: "studio",
    });
    expect(d.apply).toBe("studio");
    expect(d.writeDb).toBe("studio");
  });
});

describe("reconcilePick (font / lint)", () => {
  const isValid = (n: string) => n === "sf-mono" || n.startsWith("custom:");

  it("valid DB value applies over a different local value", () => {
    const d = reconcilePick({
      db: "sf-mono",
      local: "san-francisco",
      hasExplicitLocal: false,
      isValid,
    });
    expect(d.apply).toBe("sf-mono");
  });

  it("matching explicit local pick needs no action", () => {
    const d = reconcilePick({
      db: "sf-mono",
      local: "sf-mono",
      hasExplicitLocal: true,
      isValid,
    });
    expect(d.apply).toBeUndefined();
    expect(d.writeDb).toBeUndefined();
  });

  it("only an explicit local pick migrates; untouched defaults stay untouched", () => {
    const migrated = reconcilePick({
      db: null,
      local: "sf-mono",
      hasExplicitLocal: true,
      isValid,
    });
    expect(migrated.writeDb).toBe("sf-mono");
    const untouched = reconcilePick({
      db: null,
      local: "san-francisco",
      hasExplicitLocal: false,
      isValid,
    });
    expect(untouched.apply).toBeUndefined();
    expect(untouched.writeDb).toBeUndefined();
  });

  it("an invalid DB value is ignored (falls back to local behavior)", () => {
    const d = reconcilePick({
      db: "chalkboard-se",
      local: "sf-mono",
      hasExplicitLocal: true,
      isValid,
    });
    expect(d.apply).toBeUndefined();
    expect(d.writeDb).toBe("sf-mono");
  });
});
