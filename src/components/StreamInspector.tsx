// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The raw-wire pane: what one turn's stream actually said.
//!
//! Reached from a chip on the turn badge — **never a header button**. It is a
//! devtools surface, and Redline's rule is that a new surface is entered
//! through the thing it explains, not through a new top-level radio.
//!
//! Lazy by construction: this module is only imported through `React.lazy`, so
//! none of it is on the boot path (pinned by `boot.test.ts`'s `LAZY_ONLY`).
//! Capture is off in the backend until this pane turns it on, and turning it
//! off frees every ring — see `inspect.rs` for why that is what keeps it
//! inside the perf budget.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** `inspect::InspectView`. */
export interface InspectView {
  on: boolean;
  init: string | null;
  lines: string[];
  dropped: number;
}

/** How often the pane pulls. The backend pushes nothing — a devtools pane that
 *  polls on demand cannot flood the renderer the way a per-line emit would. */
const POLL_MS = 700;

/** Pretty-print one line if it parses, so a 4 KB `init` is readable. */
function pretty(line: string): string {
  try {
    return JSON.stringify(JSON.parse(line), null, 1);
  } catch {
    return line;
  }
}

/** A one-line summary for the collapsed row: the type, and the delta/subtype
 *  discriminator that actually distinguishes one line from the next. */
function summarize(line: string): string {
  try {
    const v = JSON.parse(line) as Record<string, unknown>;
    const type = String(v.type ?? "?");
    if (type === "stream_event") {
      const e = (v.event ?? {}) as Record<string, unknown>;
      const et = String(e.type ?? "?");
      const d = (e.delta ?? e.content_block ?? {}) as Record<string, unknown>;
      const dt = d.type ? `/${String(d.type)}` : "";
      return `${type} · ${et}${dt}`;
    }
    if (type === "system") return `${type} · ${String(v.subtype ?? "?")}`;
    if (type === "result") return `${type} · ${String(v.subtype ?? "?")}`;
    return type;
  } catch {
    return "unparsed";
  }
}

export default function StreamInspector({
  surface,
  turnKey,
  onClose,
}: {
  /** The `thread_table` surface name the reader captures under. */
  surface: string;
  /** That surface's key for this turn (`browseId`, `commentId`, …). */
  turnKey: string;
  onClose: () => void;
}) {
  const [view, setView] = useState<InspectView | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const alive = useRef(true);

  const pull = useCallback(() => {
    void invoke<InspectView>("inspect_read", { surface, key: turnKey })
      .then((v) => {
        if (alive.current) setView(v);
      })
      .catch(() => {});
  }, [surface, turnKey]);

  // Opening the pane is what turns capture ON; closing it turns it off again
  // and frees the ring. The cleanup runs on unmount too, so navigating away
  // cannot leave a buffer filling behind the user's back.
  useEffect(() => {
    alive.current = true;
    void invoke("inspect_set", { on: true }).then(pull).catch(() => {});
    const t = setInterval(pull, POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(t);
      void invoke("inspect_set", { on: false }).catch(() => {});
    };
  }, [pull]);

  const lines = view?.lines ?? [];
  return (
    <div
      className="font-mono flex flex-col gap-1"
      style={{
        border: "1px solid var(--color-rule)",
        borderRadius: "6px",
        background: "var(--color-bg-elevated)",
        padding: "6px 8px",
        maxHeight: "40vh",
        overflowY: "auto",
        // A pane that repaints on a 700ms poll must not invalidate layout for
        // the thread above it. Same reason as the streaming bubble's.
        contain: "content",
        fontSize: "10px",
        lineHeight: 1.45,
      }}
    >
      <div
        className="flex items-center justify-between gap-2 sticky top-0"
        style={{ background: "var(--color-bg-elevated)", paddingBottom: "2px" }}
      >
        <span style={{ fontWeight: 600, color: "var(--color-ink-muted)" }}>
          raw stream · {surface}
          {view?.dropped ? ` · ${view.dropped} earlier lines dropped` : ""}
        </span>
        <button
          type="button"
          onClick={onClose}
          title="Close the inspector — capture stops and the buffer is freed"
          style={{
            border: "1px solid var(--color-rule)",
            borderRadius: "4px",
            padding: "0 5px",
            color: "var(--color-ink-muted)",
            background: "transparent",
          }}
        >
          close
        </button>
      </div>

      {view?.init && (
        <details>
          <summary style={{ cursor: "pointer", color: "var(--color-info)" }}>
            system · init — the configuration the CLI actually resolved
          </summary>
          <pre style={{ whiteSpace: "pre-wrap", margin: "2px 0 4px" }}>
            {pretty(view.init)}
          </pre>
        </details>
      )}

      {lines.length === 0 ? (
        <div style={{ color: "var(--color-ink-muted)" }}>
          {view?.on
            ? "listening — send a turn and the wire appears here"
            : "starting capture…"}
        </div>
      ) : (
        lines.map((line, i) => (
          <div key={`${i}-${line.length}`}>
            <button
              type="button"
              onClick={() => setExpanded(expanded === i ? null : i)}
              style={{
                background: "transparent",
                border: "none",
                padding: 0,
                textAlign: "left",
                color: "var(--color-ink-muted)",
                cursor: "pointer",
                width: "100%",
              }}
            >
              {expanded === i ? "▾" : "▸"} {summarize(line)}
            </button>
            {expanded === i && (
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                  margin: "2px 0 4px 10px",
                  color: "var(--color-ink)",
                }}
              >
                {pretty(line)}
              </pre>
            )}
          </div>
        ))
      )}
    </div>
  );
}
