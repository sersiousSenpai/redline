// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";
import {
  applyFont,
  applyLint,
  applyTheme,
  readStoredFont,
  readStoredLint,
  readStoredTheme,
} from "./theme/applyTheme";
import {
  BOOT_ATTR,
  BOOT_FAILSAFE_MS,
  BOOT_PLAYED_KEY,
  shouldArm,
} from "./lib/boot";

// Apply the persisted theme + font + lint before first paint to avoid a flash
// of the default theme/typeface on launch.
applyTheme(readStoredTheme());
applyFont(readStoredFont());
applyLint(readStoredLint());

// Doors-open boot (A2): stamp the closed frame before React mounts, so the
// first frame the hidden window ever paints is the gathered plates —
// useBootChoreography parts them after the reveal. Real launches only (the
// sessionStorage flag survives reloads and HMR remounts in this tab) and
// never under reduced motion. The module-scope timer is the dead-man switch:
// if React never mounts, the attribute comes off and the native 2 s fallback
// show reveals today's static layout — strand-proof with no React involved.
let bootPlayed = true;
try {
  bootPlayed = sessionStorage.getItem(BOOT_PLAYED_KEY) === "1";
} catch {
  // Storage unavailable — treat as played; the boot is pure polish.
}
if (
  shouldArm({
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)")
      .matches,
    alreadyPlayed: bootPlayed,
  })
) {
  document.documentElement.setAttribute(BOOT_ATTR, "closed");
  try {
    sessionStorage.setItem(BOOT_PLAYED_KEY, "1");
  } catch {
    // Same storage; unreachable when the read above succeeded.
  }
  window.setTimeout(() => {
    document.documentElement.removeAttribute(BOOT_ATTR);
  }, BOOT_FAILSAFE_MS);
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* Last-resort boundary. The inner region boundaries in App exist so this
        is never reached — if it IS, the whole tree (terminal dock included)
        has unmounted and every shell session died with it. Be loud. */}
    <ErrorBoundary
      region="root"
      fallback={(err, reset) => (
        <div
          className="h-full flex flex-col items-center justify-center gap-3 p-8 text-center"
          style={{ color: "var(--color-ink, #1a1a1a)" }}
        >
          <div style={{ fontSize: "18px", fontWeight: 600 }}>
            Redline crashed
          </div>
          <div style={{ fontSize: "13px", maxWidth: "560px" }}>
            An unhandled rendering error escaped every inner guard, so the
            whole window — including any open terminal sessions — was torn
            down. Terminal shells do not survive this; restart them after
            recovering.
          </div>
          <pre
            className="text-left overflow-auto p-3 rounded"
            style={{
              fontSize: "11px",
              maxWidth: "640px",
              maxHeight: "200px",
              background: "var(--color-bg-elevated, #f0efe9)",
              border: "1px solid var(--color-rule, #e5e3dd)",
            }}
          >
            {String(err?.stack ?? err)}
          </pre>
          <button
            type="button"
            onClick={reset}
            className="px-4 py-1.5 rounded"
            style={{
              border: "1px solid var(--color-rule, #e5e3dd)",
              background: "var(--color-bg-elevated, #f0efe9)",
              cursor: "pointer",
            }}
          >
            Recover
          </button>
        </div>
      )}
    >
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
