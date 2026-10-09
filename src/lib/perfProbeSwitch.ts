// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Whether the responsiveness probe (`perfProbe.ts`) runs: on in a dev build,
// opt-in on a release one — the build perf is judged on, which has no Web
// Inspector, so the switch is a ⌘K command and the readout is `GET /v1/perf`.
// Either default can be overridden and the choice persists. This module is
// all main.tsx and App import; the probe itself loads lazily, so a release
// that never opts in never fetches it.

export const PERF_PROBE_KEY = "redline.perfProbe";

/** The stored choice wins; with none, a dev build measures and a release
 *  build doesn't. */
export function perfProbeWanted(stored: string | null, dev: boolean): boolean {
  if (stored === "on") return true;
  if (stored === "off") return false;
  return dev;
}

export function perfProbeOn(): boolean {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(PERF_PROBE_KEY);
  } catch {
    // Storage unavailable — fall back to the build's default.
  }
  return perfProbeWanted(stored, import.meta.env.DEV);
}

/** Start or stop the probe to match `on`. Infallible: measurement must never
 *  cost the app a boot. */
export function syncPerfProbe(on: boolean): Promise<void> {
  return import("./perfProbe")
    .then((m) => {
      if (on) m.startPerfProbe();
      else m.stopPerfProbe();
    })
    .catch(() => {});
}

/** Persist the choice and apply it now. */
export function setPerfProbe(on: boolean): Promise<void> {
  try {
    localStorage.setItem(PERF_PROBE_KEY, on ? "on" : "off");
  } catch {
    // Applies for this session only.
  }
  return syncPerfProbe(on);
}
