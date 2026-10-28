// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// `file:line` links (W4): the paths a terminal line or a conversation's
// tool row names, found, resolved against where they were said (a
// terminal's cwd, a session's project), checked to exist, and opened as a
// file pane — every route through one window event App turns into the
// workbench's `openFile`.

import { invoke } from "@tauri-apps/api/core";

export interface FileLinkMatch {
  /** The whole match as it appears, `:line:col` included. */
  text: string;
  /** Character offsets in the line, end exclusive. */
  start: number;
  end: number;
  path: string;
  line?: number;
  col?: number;
}

/** The candidate runs: anything between spaces, quotes and brackets. */
const RUN = /[^\s"'`()<>[\]{},;|]+/g;
const LINE_SUFFIX = /^(.*?)(?::(\d+)(?::(\d+))?)?$/;
const EXTENSION = /\.[A-Za-z][A-Za-z0-9_-]{0,11}$/;

/** Every path-looking run in `line`: one with a `/` in it, or a file name
 *  with an extension, optionally `:line` or `:line:col`. URLs are not paths. */
export function findFileLinks(line: string): FileLinkMatch[] {
  const out: FileLinkMatch[] = [];
  for (const m of line.matchAll(RUN)) {
    let text = m[0];
    const start = m.index ?? 0;
    if (text.includes("://") || /^[a-z]+:/i.test(text.replace(/^[A-Za-z]:\\/, ""))) {
      // A URL, or a scheme like `mailto:` — not ours. (`C:\` is not a scheme,
      // but Windows paths are not matched either.)
      if (!/^[^:]+:\d/.test(text)) continue;
    }
    // Trailing sentence punctuation is not part of the path.
    text = text.replace(/[.,:;!?]+$/, "");
    const parts = LINE_SUFFIX.exec(text);
    if (!parts) continue;
    const path = parts[1];
    if (!path || path === "/" || /^\.+$/.test(path) || /^\/+$/.test(path)) continue;
    if (path.includes("@") && !path.includes("/")) continue;
    const pathy = path.includes("/") ? /[A-Za-z0-9_]/.test(path) : EXTENSION.test(path);
    if (!pathy) continue;
    // A version or a number is not a path ("1.2.3", "3.14").
    if (/^v?\d+(\.\d+)+$/.test(path)) continue;
    out.push({
      text,
      start,
      end: start + text.length,
      path,
      ...(parts[2] ? { line: Number(parts[2]) } : {}),
      ...(parts[3] ? { col: Number(parts[3]) } : {}),
    });
  }
  return out;
}

/** `path` made absolute: `~` against home, a relative one against `cwd`,
 *  with `.` and `..` folded. Null when a relative path has no cwd. */
export function resolveFileLink(path: string, cwd: string | null, home: string | null = null): string | null {
  let abs: string;
  if (path.startsWith("~/") || path === "~") {
    if (!home) return null;
    abs = `${home.replace(/\/+$/, "")}/${path.slice(2)}`;
  } else if (path.startsWith("/")) abs = path;
  else if (cwd) abs = `${cwd.replace(/\/+$/, "")}/${path}`;
  else return null;
  const parts: string[] = [];
  for (const seg of abs.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join("/")}`;
}

export const OPEN_FILE_EVENT = "redline:open-file";

export interface OpenFileDetail {
  path: string;
  line?: number;
  mode?: "preview" | "pin" | "tab";
}

/** Ask App to open a file pane. */
export function requestOpenFile(detail: OpenFileDetail): void {
  window.dispatchEvent(new CustomEvent<OpenFileDetail>(OPEN_FILE_EVENT, { detail }));
}

/** Resolve a link and open it when the file exists. `exists` is injected
 *  (App's `list_dir` probe), so a false positive never opens an empty pane. */
export async function openFileLink(
  match: Pick<FileLinkMatch, "path" | "line">,
  where: { cwd: string | null; home: string | null },
  exists: (abs: string) => Promise<boolean>,
  mode: OpenFileDetail["mode"] = "preview",
): Promise<boolean> {
  const abs = resolveFileLink(match.path, where.cwd, where.home);
  if (!abs || !(await exists(abs).catch(() => false))) return false;
  requestOpenFile({ path: abs, line: match.line, mode });
  return true;
}

/** Whether `abs` is a file: its folder's listing names it, not as a folder.
 *  The same `list_dir` the Files rail reads — no new command. */
export async function fileExists(abs: string): Promise<boolean> {
  const slash = abs.lastIndexOf("/");
  if (slash < 0) return false;
  const dir = abs.slice(0, slash) || "/";
  const name = abs.slice(slash + 1);
  const entries = await invoke<{ name: string; isDir: boolean }[]>("list_dir", { path: dir });
  return entries.some((e) => e.name === name && !e.isDir);
}

let homeDir: Promise<string | null> | null = null;
/** The user's home folder, once (for `~/…` links). */
export function homeFolder(): Promise<string | null> {
  if (!homeDir) homeDir = invoke<string>("home_dir").then((h) => h || null, () => null);
  return homeDir;
}
