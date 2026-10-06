// SPDX-License-Identifier: Apache-2.0
import { getDomain } from "tldts";
export interface GroupTab { browseId: string; title: string; url: string }
export interface TabGroup { id: string; name: string; browseIds: string[]; collapsed?: boolean }
/** Group by the public suffix list, including private hosting domains. */
export function tabHost(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (!host || host.includes(":") || /^[\d.]+$/.test(host)) return host || "New tabs";
    return getDomain(host, { allowPrivateDomains: true }) || host;
  } catch { return "New tabs"; }
}
export function validateGroups(value: unknown, tabs: GroupTab[]): value is TabGroup[] {
  if (!Array.isArray(value) || value.length > 8 || (tabs.length > 0 && !value.length)) return false;
  const expected = new Set(tabs.map(tab => tab.browseId)), seen = new Set<string>(), ids = new Set<string>();
  for (const group of value) {
    if (!group || typeof group.id !== "string" || !/^[\w-]{1,80}$/.test(group.id) || ids.has(group.id) || typeof group.name !== "string" || !group.name.trim() || [...group.name].length > 32 || !Array.isArray(group.browseIds) || (group.collapsed !== undefined && typeof group.collapsed !== "boolean")) return false;
    ids.add(group.id);
    for (const id of group.browseIds) { if (typeof id !== "string" || !expected.has(id) || seen.has(id)) return false; seen.add(id); }
  }
  return seen.size === expected.size;
}
export function fallbackGroups(tabs: GroupTab[]): TabGroup[] {
  const groups: TabGroup[] = [];
  for (const tab of tabs) {
    const host = tabHost(tab.url); let group = groups.find(group => group.name === host);
    if (!group && groups.length < 7) { group = { id: `site-${groups.length}`, name: host.slice(0, 32), browseIds: [] }; groups.push(group); }
    if (!group) { group = groups.find(group => group.id === "other"); if (!group) { group = { id: "other", name: "Other pages", browseIds: [] }; groups.push(group); } }
    group.browseIds.push(tab.browseId);
  }
  return groups;
}
/** Null means an unknown host: batch it with the other arrivals for one agent turn. */
export function fileNewTab(groups: TabGroup[], tab: GroupTab, tabs: GroupTab[]): TabGroup[] | null {
  if (groups.some(group => group.browseIds.includes(tab.browseId))) return groups;
  const host = tabHost(tab.url), target = groups.find(group => group.browseIds.some(id => tabs.some(page => page.browseId === id && tabHost(page.url) === host)));
  return target ? groups.map(group => group === target ? { ...group, browseIds: [...group.browseIds, tab.browseId] } : group) : null;
}
export function moveTabToGroup(groups: TabGroup[], browseId: string, targetId: string): TabGroup[] {
  if (!groups.some(group => group.id === targetId) || !groups.some(group => group.browseIds.includes(browseId))) return groups;
  return groups.map(group => ({ ...group, browseIds: [...group.browseIds.filter(id => id !== browseId), ...(group.id === targetId ? [browseId] : [])] }));
}
/** Preserve human grouping and collapse state while tabs close or quietly arrive. */
export function reconcileGroups(groups: TabGroup[], tabs: GroupTab[]): TabGroup[] {
  const ids = new Set(tabs.map(tab => tab.browseId));
  let next = groups.map(group => ({ ...group, browseIds: group.browseIds.filter(id => ids.has(id)) }));
  for (const tab of tabs) {
    if (next.some(group => group.browseIds.includes(tab.browseId))) continue;
    const filed = fileNewTab(next, tab, tabs);
    if (filed) next = filed;
    else { let index = next.findIndex(group => group.id === "unfiled"); if (index < 0 && next.length < 8) { index = next.length; next.push({ id: "unfiled", name: "New pages", browseIds: [] }); } if (index < 0) index = next.length - 1; next[index] = { ...next[index], browseIds: [...next[index].browseIds, tab.browseId] }; }
  }
  return next.filter(group => group.browseIds.length);
}
