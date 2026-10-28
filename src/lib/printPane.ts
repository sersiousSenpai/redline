// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// File ▸ Print… (⌘⌥P) for the panes that are not a web page: the plan
// document and an open file. The app's own webview is printed (the same
// native print panel a browser page gets), but only what this module puts in
// `#rl-print-root`: a copy of the document, or the file's text. The print
// stylesheet (styles.css, "Print") shows that root alone and lets it run to
// as many pages as it needs; on screen it is never drawn.

import { invoke } from "@tauri-apps/api/core";

export const PRINT_ROOT_ID = "rl-print-root";

export type PrintTarget =
  | { kind: "plan"; element: HTMLElement }
  | { kind: "file"; path: string; text: string };

/** The print root, filled for `target`. Replaces whatever the last print
 *  left (the panel is modal and asynchronous, so the copy stays until the
 *  next print rather than racing it). Exported for the test. */
export function fillPrintRoot(target: PrintTarget, doc: Document = document): HTMLElement {
  doc.getElementById(PRINT_ROOT_ID)?.remove();
  const root = doc.createElement("div");
  root.id = PRINT_ROOT_ID;
  root.setAttribute("aria-hidden", "true");
  if (target.kind === "plan") {
    root.dataset.kind = "plan";
    const copy = target.element.cloneNode(true) as HTMLElement;
    // Nothing in the copy is interactive or identified: no ids to collide
    // with the live document, no controls to print.
    copy.removeAttribute("id");
    for (const el of copy.querySelectorAll("[id]")) el.removeAttribute("id");
    for (const el of copy.querySelectorAll("button, [role=toolbar], [data-rl-no-print]")) el.remove();
    root.append(copy);
  } else {
    root.dataset.kind = "file";
    const heading = doc.createElement("h1");
    heading.textContent = target.path;
    const pre = doc.createElement("pre");
    pre.textContent = target.text;
    root.append(heading, pre);
  }
  doc.body.append(root);
  root.dataset.ready = "";
  return root;
}

/** Print `target` through the native print panel of the app's webview. */
export async function printPane(target: PrintTarget): Promise<void> {
  fillPrintRoot(target);
  await invoke("browser_print", { label: "main" });
}

/** An open file's text for printing, or null when it has none to give
 *  (binary, too large, unreadable). */
export async function readPrintableFile(path: string): Promise<string | null> {
  try {
    const file = await invoke<{ content: string | null }>("read_text_file", { path });
    return file.content ?? null;
  } catch {
    return null;
  }
}
