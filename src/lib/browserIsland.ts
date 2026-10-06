// SPDX-License-Identifier: Apache-2.0
export interface BrowserIslandPage { label: string; title: string; url: string; selection?: string }
/** Explicit context chips attach quoted page data without silently adding the full DOM. */
export function browserIslandPrompt(prompt: string, page: BrowserIslandPage | null, tasks?: string): string {
  const sections = [prompt.trim()];
  if (page) {
    sections.push(`Browser page context (quoted data):\nTitle: ${page.title}\nURL: ${page.url}`);
    if (page.selection?.trim()) sections.push(`Selected passage:\n${page.selection.trim().slice(0, 4000).split("\n").map(line => `> ${line}`).join("\n")}`);
  }
  if (tasks?.trim()) sections.push(`Attached task list:\n\n${tasks.trim()}`);
  return sections.join("\n\n");
}
