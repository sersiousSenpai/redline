// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The page-snapshot the browse agent gets for instant grounding on its first
//! turn. The actual DOM walk lives in one place — the `SNAPSHOT_JS` kernel in
//! the Rust backend, exposed as the `browser_snapshot` command — so the
//! frontend never re-implements it and the two can never drift. This module is
//! the thin TS side: the result shape, a capture wrapper, and a pure summary
//! used for a tab's one-line subtitle.

import { invoke } from "@tauri-apps/api/core";

/** A heading captured from the page outline. */
export interface SnapshotHeading {
  tag: string;
  text: string;
}

/** A link captured from the page. */
export interface SnapshotLink {
  text: string;
  href: string;
}

/** The shape `SNAPSHOT_JS` returns (kept in sync with the Rust kernel). All
 *  fields bounded server-side so the prompt never balloons. */
export interface PageSnapshot {
  url: string;
  title: string;
  selection: string;
  text: string;
  headings: SnapshotHeading[];
  links: SnapshotLink[];
}

/** Capture the active-tab DOM snapshot of a browser tab. `label` is the native
 *  webview label (`browser-<id>`). Returns the raw JSON string the backend
 *  produced — passed straight to `browse_send` as the first-turn context, so
 *  the agent reads exactly what the kernel emitted (no lossy re-encoding). */
export async function captureSnapshot(label: string): Promise<string> {
  return invoke<string>("browser_snapshot", { label });
}

/** Like {@link captureSnapshot}, but falls back to the backend snapshot cache
 *  when the tab's webview isn't live (suspended / not yet materialized), so a
 *  first turn can still ground the agent. Returns undefined if neither is
 *  available. */
export async function captureSnapshotOrCached(
  label: string,
): Promise<string | undefined> {
  try {
    return await captureSnapshot(label);
  } catch {
    const cached = await invoke<string | null>("browser_cached_snapshot", {
      label,
    }).catch(() => null);
    return cached ?? undefined;
  }
}

/** Parse a raw snapshot JSON string, tolerating garbage by returning null. */
export function parseSnapshot(raw: string): PageSnapshot | null {
  try {
    const v = JSON.parse(raw) as Partial<PageSnapshot>;
    if (typeof v.url !== "string") return null;
    return {
      url: v.url,
      title: v.title ?? "",
      selection: v.selection ?? "",
      text: v.text ?? "",
      headings: Array.isArray(v.headings) ? v.headings : [],
      links: Array.isArray(v.links) ? v.links : [],
    };
  } catch {
    return null;
  }
}

/** A compact one-line description of a snapshot — page title plus a count of
 *  what the agent can see. Pure; used as a discussion subtitle. */
export function snapshotSummary(snap: PageSnapshot): string {
  const title = snap.title.trim() || snap.url || "this page";
  const bits: string[] = [];
  if (snap.headings.length) {
    bits.push(`${snap.headings.length} heading${snap.headings.length === 1 ? "" : "s"}`);
  }
  if (snap.links.length) {
    bits.push(`${snap.links.length} link${snap.links.length === 1 ? "" : "s"}`);
  }
  return bits.length ? `${title} — ${bits.join(", ")}` : title;
}
