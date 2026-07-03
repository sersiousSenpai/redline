// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useState } from "react";

import type { CollabConfig } from "../collab/collabConfig";
import { isConnected, type ReviewRequest } from "../collab/reviewRequest";

interface InviteDialogProps {
  /** Active share for the current session, if one is running. */
  sharing: CollabConfig | null;
  /** Live remote-peer count (from provider awareness), for the status line. */
  peerCount: number;
  /** Persisted relay settings to prefill the form. */
  defaultDisplayName: string;
  defaultSignaling: string[];
  /** Live-mode Review Requests for this session — one per invited person. */
  liveRequests: ReviewRequest[];
  /** Invite hashes currently present in the room (connected chips). */
  connectedHashes: ReadonlySet<string>;
  /** Mint a named per-invite code (creates the Review Request). */
  onCreateInvite: (reviewerName: string) => Promise<string | null>;
  /** Revoke an invite — transport-side eviction + room key rotation. */
  onRevoke: (requestId: string) => void;
  /** Re-encode the join code for an existing invite (current room state). */
  mintCode: (invite: string) => string | null;
  /** Mint the room and start sharing (also persists the settings). */
  onStart: (displayName: string, signaling: string[]) => void;
  onStop: () => void;
  onClose: () => void;
}

/**
 * Live-mode invites (the Review Request model's live delivery): every person
 * gets their OWN join code — the per-invite token inside it is both their
 * identity on the roster and the owner's revocation handle. Codes never
 * contain plan content — only room identity, signaling coords, and the room
 * secret that end-to-end encrypts signaling.
 */
export function InviteDialog({
  sharing,
  peerCount,
  defaultDisplayName,
  defaultSignaling,
  liveRequests,
  connectedHashes,
  onCreateInvite,
  onRevoke,
  mintCode,
  onStart,
  onStop,
  onClose,
}: InviteDialogProps) {
  const [name, setName] = useState(defaultDisplayName);
  const [signaling, setSignaling] = useState(defaultSignaling.join(", "));
  const [inviteName, setInviteName] = useState("");
  const [minting, setMinting] = useState(false);
  // The code being shown (freshly minted or re-opened from the list).
  const [shownCode, setShownCode] = useState<{
    requestId: string;
    code: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    setCopied(false);
    if (!shownCode) {
      setQr(null);
      return;
    }
    let cancelled = false;
    // qrcode is only needed while an invite is on screen — load it lazily.
    void import("qrcode").then(async (QRCode) => {
      const url = await QRCode.toDataURL(shownCode.code, {
        margin: 1,
        width: 180,
      });
      if (!cancelled) setQr(url);
    });
    return () => {
      cancelled = true;
    };
  }, [shownCode]);

  const parsedSignaling = signaling
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const copy = async () => {
    if (!shownCode) return;
    await navigator.clipboard.writeText(shownCode.code);
    setCopied(true);
  };

  const createInvite = async () => {
    const reviewer = inviteName.trim();
    if (!reviewer || minting) return;
    setMinting(true);
    try {
      const code = await onCreateInvite(reviewer);
      if (code) {
        // The request was just created; find it by the code's invite token
        // via mintCode identity — simplest is to show the fresh code without
        // a request id until the list re-renders (revoke works from rows).
        setShownCode({ requestId: "", code });
        setInviteName("");
      }
    } finally {
      setMinting(false);
    }
  };

  const visibleRequests = liveRequests.filter((r) => r.status !== "revoked");
  const revokedCount = liveRequests.length - visibleRequests.length;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: "var(--color-overlay)" }}
      onClick={onClose}
    >
      <div
        className="rounded-md shadow-xl border p-6"
        style={{
          width: "520px",
          maxWidth: "92vw",
          maxHeight: "86vh",
          overflowY: "auto",
          borderColor: "var(--color-rule)",
          background: "var(--color-bg-elevated)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          className="font-serif font-semibold mb-3"
          style={{ fontSize: "20px", color: "var(--color-ink)" }}
        >
          {sharing ? "Live session invites" : "Invite to live session"}
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
              Start a live room for this plan. Each collaborator gets their
              own one-time code — the document syncs peer-to-peer, end-to-end
              encrypted; the signaling server only introduces peers and sees
              ciphertext. You can revoke any invite mid-session.
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
              Mint a personal code for each collaborator —{" "}
              {peerCount === 0
                ? "no one has connected yet."
                : `${peerCount} ${peerCount === 1 ? "peer" : "peers"} connected.`}
            </p>
            <div className="flex items-center gap-2 mb-3">
              <input
                value={inviteName}
                onChange={(e) => setInviteName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createInvite();
                }}
                placeholder="Who is this invite for? (e.g. John Doe)"
                className="flex-1 rounded px-2 py-1.5"
                style={{
                  border: "1px solid var(--color-rule)",
                  background: "var(--color-bg)",
                  color: "var(--color-ink)",
                  fontSize: "13px",
                }}
              />
              <button
                type="button"
                disabled={!inviteName.trim() || minting}
                onClick={() => void createInvite()}
                className="rounded px-3 py-1.5 font-medium shrink-0"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-on-accent)",
                  fontSize: "12px",
                  opacity: !inviteName.trim() || minting ? 0.5 : 1,
                }}
              >
                New code
              </button>
            </div>
            {visibleRequests.length > 0 && (
              <ul className="mb-3">
                {visibleRequests.map((r) => {
                  const connected = isConnected(r, connectedHashes);
                  return (
                    <li
                      key={r.id}
                      className="flex items-center gap-2 py-1.5 border-b"
                      style={{
                        borderColor: "var(--color-rule)",
                        fontSize: "12px",
                        color: "var(--color-ink)",
                      }}
                    >
                      <span className="flex-1 truncate">{r.reviewerName}</span>
                      <span
                        style={{
                          fontSize: "10px",
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                          color: connected
                            ? "var(--color-success)"
                            : "var(--color-ink-muted)",
                        }}
                      >
                        {connected ? "connected" : r.status}
                      </span>
                      <button
                        type="button"
                        title={`Show ${r.reviewerName}'s join code`}
                        onClick={() => {
                          const code = r.invite ? mintCode(r.invite) : null;
                          if (code) setShownCode({ requestId: r.id, code });
                        }}
                        className="rounded px-2 py-0.5"
                        style={{
                          border: "1px solid var(--color-rule)",
                          background: "var(--color-bg-elevated)",
                          color: "var(--color-ink)",
                          fontSize: "11px",
                          cursor: "pointer",
                        }}
                      >
                        Code
                      </button>
                      <button
                        type="button"
                        title={`Revoke ${r.reviewerName}'s access — evicts them and rotates the room key`}
                        onClick={() => {
                          onRevoke(r.id);
                          if (shownCode?.requestId === r.id) setShownCode(null);
                        }}
                        className="rounded px-2 py-0.5"
                        style={{
                          border: "1px solid var(--color-rule)",
                          background: "var(--color-bg-elevated)",
                          color: "var(--color-warning)",
                          fontSize: "11px",
                          cursor: "pointer",
                        }}
                      >
                        Revoke
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {revokedCount > 0 && (
              <p
                style={{
                  fontSize: "11px",
                  color: "var(--color-ink-muted)",
                  marginBottom: 10,
                }}
              >
                {revokedCount} revoked{" "}
                {revokedCount === 1 ? "invite" : "invites"} (see the
                Collaboration Center).
              </p>
            )}
            {shownCode && (
              <>
                <textarea
                  readOnly
                  value={shownCode.code}
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
                      The code contains no plan content — the document only
                      ever travels encrypted between peers.
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
              </>
            )}
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
