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

// Apply the persisted theme + font + lint before first paint to avoid a flash
// of the default theme/typeface on launch.
applyTheme(readStoredTheme());
applyFont(readStoredFont());
applyLint(readStoredLint());

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
