// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The quit dialog (PTY helper plan §5): Quit · Quit and Stop Terminals ·
// Cancel, with "Don't ask again". Redline's own dialog card, lazy: nothing
// here is on the boot path. The choice is the page's; quit.rs carries it out.

import { useEffect, useRef, useState } from "react";
import { heldLine, quitTitle, type QuitAsk } from "../lib/quitFlow";

export interface QuitDialogProps {
  ask: QuitAsk;
  onQuit: (stopTerminals: boolean, dontAskAgain: boolean) => void;
  onCancel: () => void;
}

export function QuitDialog({ ask, onQuit, onCancel }: QuitDialogProps) {
  const quitRef = useRef<HTMLButtonElement | null>(null);
  const [dontAsk, setDontAsk] = useState(false);
  useEffect(() => {
    quitRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);
  const { keeping, ending, held } = ask;
  return (
    <div className="fixed inset-0 flex items-center justify-center z-50" style={{ background: "var(--color-overlay)" }} onClick={onCancel}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="rl-quit-title"
        className="rounded-md shadow-xl border p-6"
        style={{ maxWidth: "440px", borderColor: "var(--color-rule)", background: "var(--color-bg-elevated)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="rl-quit-title" className="font-serif font-semibold mb-3" style={{ fontSize: "20px", color: "var(--color-ink)" }}>
          {quitTitle(ask)}
        </h2>
        {keeping > 0 && (
          <p style={{ fontSize: "13px", lineHeight: 1.55, color: "var(--color-ink)", marginBottom: 12 }}>
            {keeping === 1 ? "It keeps" : "They keep"} working while Redline is closed and {keeping === 1 ? "is" : "are"} back where you left {keeping === 1 ? "it" : "them"}, with {keeping === 1 ? "its" : "their"} output, when Redline opens again. Quit and Stop Terminals ends every terminal now.
            {ending > 0 && ` ${ending === 1 ? "One terminal" : `${ending} terminals`} closed to end with Redline will end.`}
          </p>
        )}
        {held.map((name) => (
          <p key={name} data-held="" style={{ fontSize: "13px", lineHeight: 1.55, color: "var(--color-ink)", marginBottom: 12, paddingLeft: 10, borderLeft: "2px solid var(--color-warning)" }}>
            {heldLine(name)}
          </p>
        ))}
        <div className="flex items-center justify-between gap-2" style={{ marginTop: 18 }}>
          {keeping > 0 ? (
            <label className="flex items-center gap-2" style={{ fontSize: "12px", color: "var(--color-ink-muted)" }}>
              <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
              Don&rsquo;t ask again
            </label>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <button type="button" onClick={onCancel} className="rounded px-3 py-1.5" style={{ background: "var(--color-bg-elevated)", border: "1px solid var(--color-rule)", color: "var(--color-ink-muted)", fontSize: "13px" }}>
              Cancel
            </button>
            <button type="button" onClick={() => onQuit(true, dontAsk)} className="rounded px-3 py-1.5" style={{ background: "var(--color-bg-elevated)", border: "1px solid var(--color-rule)", color: "var(--color-ink)", fontSize: "13px" }}>
              Quit and Stop Terminals
            </button>
            <button ref={quitRef} type="button" onClick={() => onQuit(false, dontAsk)} className="rounded px-3 py-1.5 font-medium" style={{ background: "var(--color-info)", color: "var(--color-on-accent)", fontSize: "13px" }}>
              Quit
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
