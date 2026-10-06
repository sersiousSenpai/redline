// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { ToastSpec } from "../components/RedlineToast";

/** An address a tab can be reopened at after a restart or a suspension. A
 *  `blob:` or `data:` document lives only inside the webview that made it, so
 *  the URL poll keeps the tab's last http(s) address as its durable one
 *  (`file:` is persisted only when it was asked for explicitly, by
 *  `navigate`, never picked up from a poll). */
export function isDurableTabUrl(url: string): boolean {
  if (url === "redline:newtab") return true;
  return /^https?:\/\//i.test(url);
}

/** What `browser_output.rs` emits when a download or save finishes. */
export interface BrowserDownloadEvent {
  label: string;
  url: string;
  path: string | null;
  name: string | null;
  success: boolean;
}

type Opener = Pick<typeof import("@tauri-apps/plugin-opener"), "openPath" | "revealItemInDir">;
const loadOpener = (): Promise<Opener> => import("@tauri-apps/plugin-opener");

/** The Safari-style notice for a finished download: Open and Show in Finder
 *  when the file landed, a plain warning when it didn't. It sits at the top
 *  edge because the page that started it paints over the lower window. */
export function downloadToast(event: BrowserDownloadEvent, opener: () => Promise<Opener> = loadOpener): ToastSpec {
  const { path } = event;
  if (!event.success || !path) {
    return { message: event.name ? `Couldn't download ${event.name}` : "The download didn't finish", tone: "warning", placement: "top" };
  }
  const name = event.name ?? path.split("/").pop() ?? "File";
  return {
    message: `${name} saved to Downloads`,
    placement: "top",
    action: { label: "Open", onAction: () => void opener().then((o) => o.openPath(path)).catch(() => {}) },
    secondaryAction: { label: "Show in Finder", onAction: () => void opener().then((o) => o.revealItemInDir(path)).catch(() => {}) },
  };
}
