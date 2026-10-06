// SPDX-License-Identifier: Apache-2.0
import type { ShellContextChip, ShellContextRequest } from "../../components/shell/ShellContextPicker";
export interface QueuedShellPrompt { text: string; chips: ShellContextChip[]; memory: boolean }
export interface ShellDraft { text: string; chips: ShellContextChip[]; queue: QueuedShellPrompt[]; memory: boolean; mode: string }
const PREFIX = "redline.shell.draft.v1:", CACHE_BYTES = 8 * 1024 * 1024;
const cache = new Map<string, { draft: ShellDraft; bytes: number; persisted: boolean }>();
const modes = new Set(["plan", "default", "manual", "acceptEdits", "auto"]);
const kinds = new Set(["plan", "comment", "file", "tab", "selection"]);
function storage(): Storage | null { try { return globalThis.sessionStorage ?? null; } catch { return null; } }
function chips(value: unknown): ShellContextChip[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((item): ShellContextChip[] => {
    if (!item || typeof item !== "object" || typeof item.label !== "string" || !item.request || typeof item.request !== "object" || !kinds.has(item.request.kind)) return [];
    const request = { kind: item.request.kind } as ShellContextRequest;
    for (const key of ["sessionId", "section", "commentId", "path", "label"] as const) {
      const field = item.request[key];
      if (typeof field === "string" && field.length <= 16000) request[key] = field;
    }
    // Persist descriptors, not captured file/browser bodies. Native resolution
    // reads current authorized content when this draft is eventually sent.
    return [{ label: item.label.slice(0, 1000), request, preview: [{kind:request.kind,label:item.label.slice(0,1000),origin:"Saved attachment",body:"This context will be read again when sent."}] }];
  });
}
export function emptyShellDraft(mode = "default"): ShellDraft { return { text: "", chips: [], queue: [], memory: false, mode }; }
export function parseShellDraft(raw: string | null, mode = "default"): ShellDraft {
  if (!raw || raw.length > CACHE_BYTES) return emptyShellDraft(mode);
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object") return emptyShellDraft(mode);
    return {
      text: typeof value.text === "string" && value.text.length <= 1024 * 1024 ? value.text : "",
      chips: chips(value.chips), memory: value.memory === true,
      mode: modes.has(value.mode) ? value.mode : mode,
      queue: Array.isArray(value.queue) ? value.queue.slice(0, 5).flatMap((item: unknown): QueuedShellPrompt[] => {
        if (!item || typeof item !== "object") return [];
        const row = item as Record<string, unknown>;
        return typeof row.text === "string" && row.text.length <= 1024 * 1024 ? [{ text: row.text, memory: row.memory === true, chips: chips(row.chips) }] : [];
      }) : [],
    };
  } catch { return emptyShellDraft(mode); }
}
export function loadShellDraft(id: string, mode = "default"): ShellDraft {
  const memory = cache.get(id);
  if (memory) return memory.draft;
  try { return parseShellDraft(storage()?.getItem(PREFIX + id) ?? null, mode); }
  catch { return emptyShellDraft(mode); }
}
export function saveShellDraft(id: string, draft: ShellDraft): { retained: boolean; reloadSafe: boolean } {
  const candidate = {...draft,chips:chips(draft.chips),queue:draft.queue.map(item=>({...item,chips:chips(item.chips)}))};
  const serialized = JSON.stringify(candidate);
  if(serialized.length > CACHE_BYTES) return {retained:false,reloadSafe:false};
  const clean = parseShellDraft(serialized, draft.mode), raw = JSON.stringify(clean);
  let persisted = false;
  try { const store = storage(); if (store) { store.setItem(PREFIX + id, raw); persisted = true; } } catch { /* Keep a bounded in-memory handoff copy below. */ }
  cache.delete(id);
  let bytes = [...cache.values()].reduce((total, item) => total + item.bytes, 0);
  for (const [key, entry] of cache) {
    if (bytes + raw.length <= CACHE_BYTES && cache.size < 32) break;
    // A stored entry can be read again; never evict the only handoff copy.
    if (entry.persisted) { cache.delete(key); bytes -= entry.bytes; }
  }
  const retained = bytes + raw.length <= CACHE_BYTES && cache.size < 32;
  if (retained) cache.set(id, { draft: clean, bytes: raw.length, persisted });
  return { retained: retained || persisted, reloadSafe: persisted };
}
