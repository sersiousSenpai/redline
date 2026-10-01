// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

export const BROWSER_HOME_URL = "https://www.google.com";

interface PageTitle { url: string; title: string }

function documentUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch { return url; }
}

/** The default new tab has a known title before its first network response.
 *  Other pages use their host until the page supplies a real title. */
export function initialBrowserTitle(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.origin === new URL(BROWSER_HOME_URL).origin && parsed.pathname === "/" && !parsed.searchParams.has("q")) return "Google";
    return parsed.hostname || url;
  } catch { return url; }
}

/** Empty loading events and URL normalization must not erase a known title.
 *  A different document gets its own fallback; real page titles always win. */
export function browserPageTitle(previous: PageTitle, url: string, reportedTitle?: string): string {
  const title = reportedTitle?.trim();
  if (title) return title;
  if (documentUrl(previous.url) === documentUrl(url) && previous.title.trim()) {
    // Upgrade old hostname-only home tabs saved before the title was known.
    let hostname = "";
    try { hostname = new URL(previous.url).hostname; } catch { /* no host */ }
    if (previous.title !== hostname && previous.title !== previous.url) return previous.title;
  }
  return initialBrowserTitle(url);
}
