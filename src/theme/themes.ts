import type { ThemeBase } from "./derive";

export type ThemeName =
  | "basic"
  | "pro"
  | "homebrew"
  | "ocean"
  | "novel"
  | "manpage"
  | "redsand"
  | "silveraerogel"
  | "solidcolors"
  | "grass";

export interface ThemeEntry {
  name: ThemeName;
  label: string;
  base: ThemeBase;
}

// macOS Terminal.app's built-in profiles, as bg / fg / blue / yellow / green.
// The remaining tokens are derived in derive.ts. The "basic" entry must match
// the @theme defaults in styles.css so first paint is correct before JS runs.
export const THEMES: ThemeEntry[] = [
  {
    name: "basic",
    label: "Basic",
    base: { bg: "#ffffff", fg: "#000000", blue: "#0433ff", yellow: "#a68a00", green: "#007f00", selection: "#2f6bff" },
  },
  {
    name: "pro",
    label: "Pro",
    base: { bg: "#000000", fg: "#f2f2f2", blue: "#3b6cd2", yellow: "#c7c400", green: "#28cd41", selection: "#4f9bff" },
  },
  {
    name: "homebrew",
    label: "Homebrew",
    base: { bg: "#000000", fg: "#28fe14", blue: "#3b6cd2", yellow: "#a6a300", green: "#28fe14", selection: "#ff9d28" },
  },
  {
    name: "ocean",
    label: "Ocean",
    base: { bg: "#224fbc", fg: "#ffffff", blue: "#bbdaff", yellow: "#ffe680", green: "#a6e22e", selection: "#ffd400" },
  },
  {
    name: "novel",
    label: "Novel",
    base: { bg: "#dfdbc3", fg: "#3b2322", blue: "#3b5bb5", yellow: "#9c6f1b", green: "#5a7d2a", selection: "#1f6feb" },
  },
  {
    name: "manpage",
    label: "Man Page",
    base: { bg: "#fef49c", fg: "#000000", blue: "#0000b2", yellow: "#8a6d00", green: "#007f00", selection: "#4f46e5" },
  },
  {
    name: "redsand",
    label: "Red Sand",
    base: { bg: "#7a251e", fg: "#bdbdbd", blue: "#7bafd4", yellow: "#e6c200", green: "#8fbf3f", selection: "#ffb020" },
  },
  {
    name: "silveraerogel",
    label: "Silver Aerogel",
    base: { bg: "#929292", fg: "#000000", blue: "#1f3fff", yellow: "#8a6d00", green: "#0f6b0f", selection: "#1430ff" },
  },
  {
    name: "solidcolors",
    label: "Solid Colors",
    base: { bg: "#000000", fg: "#ffffff", blue: "#3b6cd2", yellow: "#c7c400", green: "#28cd41", selection: "#4f9bff" },
  },
  {
    name: "grass",
    label: "Grass",
    base: { bg: "#13773d", fg: "#fff0a5", blue: "#7bafd4", yellow: "#ffd75f", green: "#c7f08a", selection: "#ff7a18" },
  },
];

export const DEFAULT_THEME: ThemeName = "basic";

const BY_NAME = new Map(THEMES.map((t) => [t.name, t]));

export function getTheme(name: string): ThemeEntry {
  return BY_NAME.get(name as ThemeName) ?? THEMES[0];
}

export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === "string" && BY_NAME.has(value as ThemeName);
}
