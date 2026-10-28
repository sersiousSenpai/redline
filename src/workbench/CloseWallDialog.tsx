// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Closing a terminal wall whose terminals are still running asks once:
// terminate them, or keep them running. A kept terminal is never hidden: it
// stays under its session in the sidebar, with its status, and a click puts
// it back on a wall. Redline's own dialog (CloseConfirmModal's card), lazy:
// nothing here is on the boot path.

import { useEffect, useRef } from "react";

export interface CloseWallDialogProps {
  /** The running terminals' labels ("claude 1", "web 2"). */
  running: readonly string[];
  /** How many terminals the wall holds in all. */
  total: number;
  onKeep: () => void;
  onTerminate: () => void;
  onCancel: () => void;
}

export function CloseWallDialog({ running, total, onKeep, onTerminate, onCancel }: CloseWallDialogProps) {
  const keepRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    keepRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);
  const names = running.length <= 3 ? running.join(", ") : `${running.slice(0, 3).join(", ")} and ${running.length - 3} more`;
  const one = running.length === 1;
  return (
    <div className="fixed inset-0 flex items-center justify-center z-50" style={{ background: "var(--color-overlay)" }} onClick={onCancel}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="rl-close-wall-title"
        className="rounded-md shadow-xl border p-6"
        style={{ maxWidth: "420px", borderColor: "var(--color-rule)", background: "var(--color-bg-elevated)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="rl-close-wall-title" className="font-serif font-semibold mb-3" style={{ fontSize: "20px", color: "var(--color-ink)" }}>
          {one ? "A terminal is still running" : `${running.length} terminals are still running`}
        </h2>
        <p style={{ fontSize: "13px", lineHeight: 1.55, color: "var(--color-ink)", marginBottom: 18 }}>
          {names} {one ? "is" : "are"} still at work. Keep {one ? "it" : "them"} running and {one ? "it stays" : "they stay"} under {one ? "its" : "their"} session in the sidebar, a click away from a wall; terminate and {total === 1 ? "the shell ends" : "every shell on this wall ends"}.
        </p>
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded px-3 py-1.5" style={{ background: "var(--color-bg-elevated)", border: "1px solid var(--color-rule)", color: "var(--color-ink-muted)", fontSize: "13px" }}>
            Cancel
          </button>
          <button type="button" onClick={onTerminate} className="rounded px-3 py-1.5" style={{ background: "var(--color-bg-elevated)", border: "1px solid var(--color-rule)", color: "var(--color-ink)", fontSize: "13px" }}>
            Terminate
          </button>
          <button ref={keepRef} type="button" onClick={onKeep} className="rounded px-3 py-1.5 font-medium" style={{ background: "var(--color-info)", color: "var(--color-on-accent)", fontSize: "13px" }}>
            Keep running
          </button>
        </div>
      </div>
    </div>
  );
}
