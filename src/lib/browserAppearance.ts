// SPDX-License-Identifier: Apache-2.0
export interface BrowserAppearance {
  website: "default" | "light" | "dark" | "forced";
  brightness: number;
  contrast: number;
  reading: "none" | "sepia" | "gray";
  zoom: number;
}
export const DEFAULT_APPEARANCE: BrowserAppearance = { website: "default", brightness: 1, contrast: 1, reading: "none", zoom: 1 };
export function siteKey(url: string): string { try { return new URL(url).origin; } catch { return "default"; } }
export function normalizeAppearance(input?: Partial<BrowserAppearance>): BrowserAppearance {
  const bounded = (value: number | undefined, min: number, max: number) => Number.isFinite(value) ? Math.max(min, Math.min(max, value!)) : 1;
  return { website: ["default", "light", "dark", "forced"].includes(input?.website ?? "") ? input!.website! : "default",
    brightness: bounded(input?.brightness, .5, 1.5), contrast: bounded(input?.contrast, .5, 2), zoom: bounded(input?.zoom, .5, 3),
    reading: input?.reading === "sepia" || input?.reading === "gray" ? input.reading : "none" };
}
/** Only content is filtered; the inspector and browser chrome keep their colors. */
export function appearanceCss(raw: BrowserAppearance): string {
  const value = normalizeAppearance(raw);
  const filters = [value.website === "forced" ? "invert(1) hue-rotate(180deg)" : "", value.brightness !== 1 ? `brightness(${value.brightness})` : "", value.contrast !== 1 ? `contrast(${value.contrast})` : "", value.reading === "sepia" ? "sepia(.6)" : value.reading === "gray" ? "grayscale(1)" : ""].filter(Boolean);
  return (filters.length ? `body{filter:${filters.join(" ")}!important}` : "") + (value.website === "forced" ? "body img,body video,body canvas,body picture{filter:invert(1) hue-rotate(180deg)}html{background:#181818!important}" : "");
}
