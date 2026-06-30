// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { openUrl } from "@tauri-apps/plugin-opener";

// Without this, clicking an <a> inside rendered markdown (e.g. a link in a
// README shown in the file viewer) navigates the Tauri webview itself — the
// whole window turns into a borderless browser with no back button. We instead
// intercept every link click and either hand the URL to the system browser or,
// for anything that would otherwise replace the webview, swallow it.
const WEB_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

function onDocumentClick(e: MouseEvent) {
  // Let modified clicks and non-primary buttons through untouched.
  if (e.defaultPrevented || e.button !== 0) return;

  const target = e.target as HTMLElement | null;
  const anchor = target?.closest?.("a");
  if (!anchor) return;

  // Links inside the plan editor are owned by Tiptap (openOnClick:false) — a
  // click there places the cursor, it must not open a browser.
  if (target?.closest?.(".ProseMirror")) return;

  const href = anchor.getAttribute("href");
  // Empty hrefs and pure in-page anchors are app/SPA behavior — leave them be.
  if (!href || href.startsWith("#")) return;

  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return;
  }

  if (WEB_SCHEMES.has(url.protocol)) {
    // A view that owns its own link clicks (the page-discussion pane routes them
    // to a Redline browser tab) handles web links itself — don't ALSO open them
    // in the OS browser, or the link opens in two places at once.
    if (anchor.closest(".rl-md-own-links")) return;
    e.preventDefault();
    void openUrl(url.href).catch(() => {});
    return;
  }

  // Any other off-origin destination would still replace the webview — block
  // the navigation, but don't try to open it.
  if (url.origin !== window.location.origin) {
    e.preventDefault();
  }
}

/** Install a single capture-phase click handler that routes external links to
 *  the system browser instead of hijacking the webview. Returns a cleanup fn. */
export function installExternalLinkHandler(): () => void {
  document.addEventListener("click", onDocumentClick, true);
  return () => document.removeEventListener("click", onDocumentClick, true);
}
