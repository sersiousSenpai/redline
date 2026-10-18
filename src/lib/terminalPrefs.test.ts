import { describe, expect, it } from "vitest";
import { DEFAULT_TERMINAL_PREFS, normalizeTerminalPrefs, readTerminalPrefs, TERMINAL_PREFS_KEY } from "./terminalPrefs";
describe("terminal preferences", () => {
  it("recovers invalid storage and bounds numeric settings", () => {
    localStorage.setItem(TERMINAL_PREFS_KEY, "broken");
    expect(readTerminalPrefs()).toEqual(DEFAULT_TERMINAL_PREFS);
    expect(normalizeTerminalPrefs({ family: " ", size: Infinity, lineHeight: -1 })).toEqual({ ...DEFAULT_TERMINAL_PREFS, lineHeight: 1 });
    expect(normalizeTerminalPrefs({ size: 100, lineHeight: 50 }).size).toBe(28);
  });
});
