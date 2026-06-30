// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Chrome-style omnibox: the address bar accepts EITHER a URL or a search query
// and decides which. Typing "best pizza near me" should search, not try to load
// the nonsense host "best pizza near me"; typing "github.com" should navigate.

// Default search engine — matches the browser's HOME (Google). A query is sent
// as ?q=<encoded>.
const SEARCH_URL = "https://www.google.com/search?q=";

// http://, https://, ftp:// … — a scheme followed by an authority.
const SCHEME_WITH_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\//i;
// Schemes that don't use "//" but are still a complete destination, not a query.
const SCHEMELESS = /^(about|mailto|tel|data|file|view-source|chrome):/i;
// A dotted hostname whose final label is a plausible TLD (≥2 letters) and whose
// labels are all non-empty (rejects "foo." / ".com" / "a..b").
const HOSTNAME = /^[^\s/?#]+\.[^\s/?#]+$/;

const hasScheme = (s: string): boolean =>
  SCHEME_WITH_AUTHORITY.test(s) || SCHEMELESS.test(s);

/** Does this input look like something to navigate to, vs. a search query? */
function looksLikeUrl(input: string): boolean {
  if (hasScheme(input)) return true;
  // A query has spaces; a URL (sans scheme) never does.
  if (/\s/.test(input)) return false;
  // localhost, optionally with a port and/or path.
  if (/^localhost(:\d+)?([/?#]|$)/i.test(input)) return true;
  // Bare IPv4, optionally with a port and/or path.
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/.test(input)) return true;
  // Otherwise require a dotted host (host.tld), checked before any path/query.
  const host = input.split(/[/?#]/, 1)[0];
  if (!HOSTNAME.test(host)) return false;
  const tld = host.split(".").pop() ?? "";
  return /^[a-z]{2,}$/i.test(tld);
}

/** Resolve raw address-bar text to a destination URL: navigate a URL-like
 *  entry (adding https:// when it has no scheme), or search anything else.
 *  Returns null for empty input. */
export function resolveOmniboxInput(raw: string): string | null {
  const input = raw.trim();
  if (!input) return null;
  if (looksLikeUrl(input)) {
    return hasScheme(input) ? input : "https://" + input;
  }
  return SEARCH_URL + encodeURIComponent(input);
}
