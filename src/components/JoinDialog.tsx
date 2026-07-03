// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useState } from "react";

import { decodeJoinCode, type CollabConfig } from "../collab/collabConfig";

interface JoinDialogProps {
  defaultDisplayName: string;
  onJoin: (config: CollabConfig, displayName: string) => void;
  onClose: () => void;
}

/** Join a live session by pasting an invite code. Display-name-on-join is
 *  the whole identity story for now — access control is the code itself
 *  (per-invite, revocable), not who you claim to be. */
export function JoinDialog({
  defaultDisplayName,
  onJoin,
  onClose,
}: JoinDialogProps) {
  const [code, setCode] = useState("");
  const [name, setName] = useState(defaultDisplayName);
  const [error, setError] = useState<string | null>(null);

  const join = () => {
    const config = decodeJoinCode(code);
    if (!config) {
      setError("That doesn’t look like a Redline join code — check the paste and try again.");
      return;
    }
    onJoin(config, name.trim());
  };

  const ready = code.trim().length > 0 && name.trim().length > 0;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: "var(--color-overlay)" }}
      onClick={onClose}
    >
      <div
        className="rounded-md shadow-xl border p-6"
        style={{
          width: "440px",
          maxWidth: "92vw",
          borderColor: "var(--color-rule)",
          background: "var(--color-bg-elevated)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          className="font-serif font-semibold mb-3"
          style={{ fontSize: "20px", color: "var(--color-ink)" }}
        >
          Join a live session
        </h2>
        <label
          className="block mb-3"
          style={{ fontSize: "12px", color: "var(--color-ink)" }}
        >
          Invite code
          <textarea
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setError(null);
            }}
            rows={3}
            placeholder="Paste the code you were sent (RLC1.…)"
            className="mt-1 w-full rounded px-2 py-1.5 font-mono"
            style={{
              border: "1px solid var(--color-rule)",
              background: "var(--color-bg)",
              color: "var(--color-ink)",
              fontSize: "11px",
              resize: "none",
              wordBreak: "break-all",
            }}
          />
        </label>
        <label
          className="block mb-2"
          style={{ fontSize: "12px", color: "var(--color-ink)" }}
        >
          Your display name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Shown on your cursor"
            className="mt-1 w-full rounded px-2 py-1.5"
            style={{
              border: "1px solid var(--color-rule)",
              background: "var(--color-bg)",
              color: "var(--color-ink)",
              fontSize: "13px",
            }}
          />
        </label>
        {error && (
          <p
            role="alert"
            style={{
              fontSize: "12px",
              color: "var(--color-warning)",
              marginBottom: 8,
            }}
          >
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2 mt-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5"
            style={{
              background: "var(--color-bg-elevated)",
              border: "1px solid var(--color-rule)",
              color: "var(--color-ink-muted)",
              fontSize: "12px",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={join}
            className="rounded px-3 py-1.5 font-medium"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-on-accent)",
              fontSize: "12px",
              opacity: ready ? 1 : 0.5,
            }}
          >
            Join
          </button>
        </div>
      </div>
    </div>
  );
}
