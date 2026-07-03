// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useMemo, useState } from "react";

import { encodeJoinCode, type CollabConfig } from "../collab/collabConfig";

interface InviteDialogProps {
  /** Active share for the current session, if one is running. */
  sharing: CollabConfig | null;
  /** Live remote-peer count (from provider awareness), for the status line. */
  peerCount: number;
  /** Persisted relay settings to prefill the form. */
  defaultDisplayName: string;
  defaultSignaling: string[];
  /** Mint the room and start sharing (also persists the settings). */
  onStart: (displayName: string, signaling: string[]) => void;
  onStop: () => void;
  onClose: () => void;
}

/**
 * Live-mode invite (the Review Request model's live delivery): mint a
 * per-invite join code and hand it over by copy-paste or QR. The code never
 * contains plan content — only room identity, signaling coords, and the
 * room secret that end-to-end encrypts signaling.
 */
export function InviteDialog({
  sharing,
  peerCount,
  defaultDisplayName,
  defaultSignaling,
  onStart,
  onStop,
  onClose,
}: InviteDialogProps) {
  const [name, setName] = useState(defaultDisplayName);
  const [signaling, setSignaling] = useState(defaultSignaling.join(", "));
  const [copied, setCopied] = useState(false);
  const [qr, setQr] = useState<string | null>(null);

  const code = useMemo(
    () => (sharing ? encodeJoinCode(sharing) : null),
    [sharing],
  );

  useEffect(() => {
    setCopied(false);
    if (!code) {
      setQr(null);
      return;
    }
    let cancelled = false;
    // qrcode is only needed while an invite is on screen — load it lazily.
    void import("qrcode").then(async (QRCode) => {
      const url = await QRCode.toDataURL(code, { margin: 1, width: 180 });
      if (!cancelled) setQr(url);
    });
    return () => {
      cancelled = true;
    };
  }, [code]);

  const parsedSignaling = signaling
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const copy = async () => {
    if (!code) return;
    await navigator.clipboard.writeText(code);
    setCopied(true);
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: "var(--color-overlay)" }}
      onClick={onClose}
    >
      <div
        className="rounded-md shadow-xl border p-6"
        style={{
          width: "480px",
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
          {sharing ? "Live session invite" : "Invite to live session"}
        </h2>
        {!sharing ? (
          <>
            <p
              style={{
                fontSize: "13px",
                lineHeight: 1.55,
                color: "var(--color-ink-muted)",
                marginBottom: 14,
              }}
            >
              Start a live room for this plan. Collaborators join with a
              one-time code — the document syncs peer-to-peer, end-to-end
              encrypted; the signaling server only introduces peers and sees
              ciphertext.
            </p>
            <label
              className="block mb-3"
              style={{ fontSize: "12px", color: "var(--color-ink)" }}
            >
              Your display name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Yusuf"
                className="mt-1 w-full rounded px-2 py-1.5"
                style={{
                  border: "1px solid var(--color-rule)",
                  background: "var(--color-bg)",
                  color: "var(--color-ink)",
                  fontSize: "13px",
                }}
              />
            </label>
            <label
              className="block mb-4"
              style={{ fontSize: "12px", color: "var(--color-ink)" }}
            >
              Signaling server (reachable by your collaborators)
              <input
                value={signaling}
                onChange={(e) => setSignaling(e.target.value)}
                placeholder="ws://192.168.1.10:4444"
                className="mt-1 w-full rounded px-2 py-1.5 font-mono"
                style={{
                  border: "1px solid var(--color-rule)",
                  background: "var(--color-bg)",
                  color: "var(--color-ink)",
                  fontSize: "12px",
                }}
              />
            </label>
            <div className="flex items-center justify-end gap-2">
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
                disabled={!name.trim() || parsedSignaling.length === 0}
                onClick={() => onStart(name.trim(), parsedSignaling)}
                className="rounded px-3 py-1.5 font-medium"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-on-accent)",
                  fontSize: "12px",
                  opacity:
                    !name.trim() || parsedSignaling.length === 0 ? 0.5 : 1,
                }}
              >
                Start sharing
              </button>
            </div>
          </>
        ) : (
          <>
            <p
              style={{
                fontSize: "13px",
                lineHeight: 1.55,
                color: "var(--color-ink-muted)",
                marginBottom: 12,
              }}
            >
              Send this code to your collaborator. They open Redline, press
              Join, and paste it —{" "}
              {peerCount === 0
                ? "no one has connected yet."
                : `${peerCount} ${peerCount === 1 ? "peer" : "peers"} connected.`}
            </p>
            <textarea
              readOnly
              value={code ?? ""}
              rows={3}
              onFocus={(e) => e.currentTarget.select()}
              className="w-full rounded px-2 py-1.5 font-mono mb-2"
              style={{
                border: "1px solid var(--color-rule)",
                background: "var(--color-bg)",
                color: "var(--color-ink)",
                fontSize: "11px",
                resize: "none",
                wordBreak: "break-all",
              }}
            />
            <div className="flex items-start justify-between gap-4 mb-4">
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => void copy()}
                  className="rounded px-3 py-1.5 font-medium"
                  style={{
                    background: "var(--color-accent)",
                    color: "var(--color-on-accent)",
                    fontSize: "12px",
                  }}
                >
                  {copied ? "Copied ✓" : "Copy code"}
                </button>
                <span
                  style={{
                    fontSize: "11px",
                    color: "var(--color-ink-muted)",
                    maxWidth: 220,
                    lineHeight: 1.5,
                  }}
                >
                  The code contains no plan content — the document only ever
                  travels encrypted between peers.
                </span>
              </div>
              {qr && (
                <img
                  src={qr}
                  alt="Join code QR"
                  width={140}
                  height={140}
                  style={{
                    borderRadius: 4,
                    border: "1px solid var(--color-rule)",
                    background: "#fff",
                  }}
                />
              )}
            </div>
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={onStop}
                className="rounded px-3 py-1.5"
                style={{
                  background: "var(--color-bg-elevated)",
                  border: "1px solid var(--color-rule)",
                  color: "var(--color-warning)",
                  fontSize: "12px",
                }}
              >
                Stop sharing
              </button>
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
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
