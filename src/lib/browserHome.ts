// SPDX-License-Identifier: Apache-2.0
import type { CandidateTab } from "./doorRecents";
export interface HomePage { url: string; title: string; at?: number; shotKey?: string | null; browseId?: string; count?: number }
export interface BrowserHomeFeed { recent: HomePage[]; frequent: HomePage[]; tasks: HomePage[]; missions: { missionId: string; title: string }[] }
export function buildBrowserHome(feed: BrowserHomeFeed, candidates: CandidateTab[], limit = 12): BrowserHomeFeed {
  const pages = (input: HomePage[]) => { const seen = new Set<string>(); return input.filter(page => {
    if (!/^https?:\/\//i.test(page.url) || seen.has(page.url)) return false;
    try { new URL(page.url); } catch { return false; }
    seen.add(page.url); return true;
  }).slice(0, limit).map(page => ({ ...page, title: page.title || new URL(page.url).hostname, browseId: candidates.find(tab => tab.url === page.url)?.browseId })); };
  return { recent: pages([...feed.recent, ...candidates.map(tab => ({ ...tab, title: tab.title || tab.url }))]), frequent: pages(feed.frequent), tasks: pages(feed.tasks), missions: feed.missions.slice(0, limit) };
}
