// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Thin frontend client for the Obsidian integration: vault config persistence
//! (backed by `app_settings`), the native folder picker, and writing notes into
//! the vault. Kept separate from the UI so App and BrowserPane share one path.

import { invoke } from "@tauri-apps/api/core";

export interface ObsidianConfig {
  /** Absolute path to the vault root, or null if the user hasn't set one. */
  vaultPath: string | null;
  /** Subfolder (relative to the vault) where web clippings are saved. */
  clippingsSubdir: string;
}

interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export function getObsidianConfig(): Promise<ObsidianConfig> {
  return invoke<ObsidianConfig>("get_obsidian_config");
}

export function setObsidianConfig(
  vaultPath: string,
  clippingsSubdir: string,
): Promise<void> {
  return invoke("set_obsidian_config", { vaultPath, clippingsSubdir });
}

/** Native folder picker. Returns the chosen absolute path, or null if cancelled.
 *  Invokes the dialog plugin directly (no JS wrapper dependency); requires the
 *  `dialog:allow-open` capability. */
export async function pickFolder(title: string): Promise<string | null> {
  const sel = await invoke<string | string[] | null>("plugin:dialog|open", {
    options: { directory: true, multiple: false, title },
  });
  if (Array.isArray(sel)) return sel[0] ?? null;
  return sel ?? null;
}

/** List the `.md` note names already in a directory, for filename de-duplication.
 *  Missing directories (not yet created) return an empty list rather than throw. */
export async function existingNoteNames(dir: string): Promise<string[]> {
  try {
    const entries = await invoke<DirEntry[]>("list_dir", { path: dir });
    return entries.filter((e) => !e.isDir).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Write a note into the vault, creating parent dirs. Returns the saved path. */
export function saveNote(path: string, content: string): Promise<string> {
  return invoke<string>("save_text_file", { path, content });
}

/** Absolute directory a clip lands in: `<vault>/<subdir>` (subdir optional). */
export function vaultDir(vaultPath: string, subdir: string): string {
  const root = vaultPath.replace(/\/+$/, "");
  const sub = subdir.trim().replace(/^\/+|\/+$/g, "");
  return [root, sub].filter(Boolean).join("/");
}

/** Join a vault root, optional subdir, and filename into an absolute .md path. */
export function vaultNotePath(
  vaultPath: string,
  subdir: string,
  filename: string,
): string {
  return `${vaultDir(vaultPath, subdir)}/${filename}.md`;
}
