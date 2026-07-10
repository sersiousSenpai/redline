// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";

// A monospace code chip that copies its text on click and briefly flips to
// "copied ✓". Used for the one-time `/hooks` step so a new user can paste it
// into Claude Code without mistyping.
export function CopyChip({ text, title }: { text: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked — the chip still shows the text to type manually */
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={title ?? "Copy"}
      className="font-mono inline-flex items-center gap-1"
      style={{
        background: "var(--color-anchor-bg)",
        color: copied ? "var(--color-success)" : "var(--color-ink)",
        padding: "1px 5px",
        borderRadius: "3px",
        fontSize: "11px",
        border: "1px solid var(--color-rule)",
        cursor: "pointer",
        verticalAlign: "baseline",
      }}
    >
      {text}
      <span style={{ fontSize: "9px", opacity: 0.8 }}>
        {copied ? "copied ✓" : "⧉"}
      </span>
    </button>
  );
}
