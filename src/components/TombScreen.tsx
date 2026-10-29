// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The last screen of a terminal that exited while Redline was closed (PTY
// helper P3): the helper kept its ring as a tombstone, and this shows what it
// last printed, read-only, with Dismiss to forget it. Lazy: opened from the
// sidebar's "exited while Redline was closed" row.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface TombScreenProps {
  id: string;
  title: string;
  onDismiss: () => void;
  onClose: () => void;
}

export function TombScreen({ id, title, onDismiss, onClose }: TombScreenProps) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    void invoke<string>("pty_screen_tail", { id })
      .then((t) => { if (!gone) setText(t ?? ""); })
      .catch(() => { if (!gone) setText(""); });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      gone = true;
      window.removeEventListener("keydown", onKey, true);
    };
  }, [id, onClose]);
  // The tail's last lines, blank runs folded: a TUI redraws in place.
  const lines = (text ?? "").split("\n").filter((l, i, all) => l.trim() !== "" || (i > 0 && all[i - 1].trim() !== ""));
  return (
    <div className="fixed inset-0 flex items-center justify-center z-50" style={{ background: "var(--color-overlay)" }} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="rl-tomb-title"
        className="rounded-md shadow-xl border p-5 flex flex-col"
        style={{ width: "min(720px, calc(100vw - 32px))", maxHeight: "80vh", borderColor: "var(--color-rule)", background: "var(--color-bg-elevated)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="rl-tomb-title" className="font-serif font-semibold" style={{ fontSize: "17px", color: "var(--color-ink)", marginBottom: 4 }}>
          {title}
        </h2>
        <p style={{ fontSize: "12px", color: "var(--color-ink-muted)", marginBottom: 10 }}>
          Exited while Redline was closed. This is what it last printed.
        </p>
        <pre
          data-tomb-screen=""
          style={{ flex: 1, overflow: "auto", margin: 0, padding: 10, borderRadius: 6, border: "1px solid var(--color-rule)", background: "var(--color-fill-1)", color: "var(--color-ink)", fontSize: "12px", lineHeight: 1.4, fontFamily: "var(--font-mono, ui-monospace, monospace)", whiteSpace: "pre-wrap" }}
        >
          {text === null ? "…" : lines.slice(-200).join("\n") || "(nothing)"}
        </pre>
        <div className="flex items-center justify-end gap-2" style={{ marginTop: 12 }}>
          <button type="button" onClick={onClose} className="rounded px-3 py-1.5" style={{ background: "var(--color-bg-elevated)", border: "1px solid var(--color-rule)", color: "var(--color-ink-muted)", fontSize: "13px" }}>
            Close
          </button>
          <button type="button" onClick={onDismiss} className="rounded px-3 py-1.5 font-medium" style={{ background: "var(--color-info)", color: "var(--color-on-accent)", fontSize: "13px" }}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
