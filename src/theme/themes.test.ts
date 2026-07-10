// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_THEME,
  THEMES,
  allThemes,
  getTheme,
  isThemeName,
  parseUserTheme,
  registerUserThemes,
} from "./themes";

const VALID_JSON = JSON.stringify({
  label: "Midnight Garden",
  base: {
    bg: "#101418",
    fg: "#e6f0e6",
    blue: "#6aa8ff",
    yellow: "#e0c060",
    green: "#66cc88",
    selection: "#ff5c8a",
  },
  ansi: { brightBlack: "#3a4450", bogus: 12 },
});

afterEach(() => {
  // The registry is module-global — leave it empty for the next test file.
  registerUserThemes([]);
});

describe("parseUserTheme", () => {
  it("accepts a valid theme JSON and keeps only valid ansi slots", () => {
    const entry = parseUserTheme("midnight", VALID_JSON);
    expect(entry).not.toBeNull();
    expect(entry?.name).toBe("midnight");
    expect(entry?.label).toBe("Midnight Garden");
    expect(entry?.user).toBe(true);
    expect(entry?.base.bg).toBe("#101418");
    expect(entry?.ansi).toEqual({ brightBlack: "#3a4450" });
  });

  it("rejects bad JSON, missing base keys, and non-hex colors", () => {
    expect(parseUserTheme("broken", "not json {")).toBeNull();
    expect(parseUserTheme("empty", "{}")).toBeNull();
    const missing = JSON.parse(VALID_JSON);
    delete missing.base.selection;
    expect(parseUserTheme("missing", JSON.stringify(missing))).toBeNull();
    const badColor = JSON.parse(VALID_JSON);
    badColor.base.bg = "red";
    expect(parseUserTheme("badcolor", JSON.stringify(badColor))).toBeNull();
  });

  it("rejects a name that shadows a built-in", () => {
    expect(parseUserTheme("studio", VALID_JSON)).toBeNull();
    expect(parseUserTheme("redline", VALID_JSON)).toBeNull();
  });

  it("falls back to the filename stem when label is absent", () => {
    const noLabel = JSON.parse(VALID_JSON);
    delete noLabel.label;
    expect(parseUserTheme("midnight", JSON.stringify(noLabel))?.label).toBe(
      "midnight",
    );
  });
});

describe("registerUserThemes / getTheme / allThemes", () => {
  it("registers valid files, skips invalid ones, and resolves by name", () => {
    const accepted = registerUserThemes([
      { name: "midnight", json: VALID_JSON },
      { name: "broken", json: "not json" },
    ]);
    expect(accepted.map((t) => t.name)).toEqual(["midnight"]);
    expect(isThemeName("midnight")).toBe(true);
    expect(isThemeName("broken")).toBe(false);
    expect(getTheme("midnight").label).toBe("Midnight Garden");
    expect(allThemes().length).toBe(THEMES.length + 1);
  });

  it("re-registration replaces the previous set", () => {
    registerUserThemes([{ name: "midnight", json: VALID_JSON }]);
    registerUserThemes([]);
    expect(isThemeName("midnight")).toBe(false);
    expect(allThemes().length).toBe(THEMES.length);
    // An unregistered name falls back to the default entry, never throws.
    expect(getTheme("midnight").name).toBe(DEFAULT_THEME);
  });
});
