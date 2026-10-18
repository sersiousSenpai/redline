// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
const KEY = "redline.transparency";
let systemReduced = false;
export function transparencyPreference(): "auto" | "solid" {
  try { return localStorage.getItem(KEY) === "solid" ? "solid" : "auto"; }
  catch { return "auto"; }
}
function apply() {
  document.documentElement.dataset.rlTransparency = systemReduced || transparencyPreference() === "solid" ? "reduced" : "full";
}
export function setTransparencyPreference(preference: "auto" | "solid") {
  try { localStorage.setItem(KEY, preference); } catch { /* Session-only fallback. */ }
  apply();
}
export async function startTransparencyObserver() {
  apply();
  try {
    let generation = 0;
    const unlisten = await listen<boolean>("reduced-transparency-changed", event => { generation++; systemReduced = event.payload; apply(); });
    const before = generation;
    const initial = await invoke<boolean>("reduced_transparency");
    if (before === generation) { systemReduced = initial; apply(); }
    window.addEventListener("pagehide", unlisten, { once: true });
  } catch { /* Web preview has no native bridge. */ }
}
