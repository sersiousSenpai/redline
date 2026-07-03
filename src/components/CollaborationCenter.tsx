// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/**
 * The Collaboration Center (plan §A.4): a PR-style list of this session's
 * Review Requests — live invites and async encrypted-snapshot requests —
 * with their lifecycle (pending → connected/returned → resolved, revoked),
 * the async creation form, and the signed-return import that re-anchors a
 * reviewer's annotations onto the CURRENT revision. Live + async are two
 * delivery modes of one object, so they share this one home.
 */
import { useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import {
  isConnected,
  isExpired,
  type ImportSummary,
  type ReviewRequest,
} from "../collab/reviewRequest";
import { snapshotLink } from "../collab/snapshot";

interface CollaborationCenterProps {
  /** Display name of the session the requests belong to. */
  sessionLabel: string;
  /** The registry is pinned to the SHARED session while sharing, which may
   *  not be the session in the pane — surfaced so it never reads as a bug. */
  scopedElsewhere: boolean;
  requests: ReviewRequest[];
  ready: boolean;
  connectedHashes: ReadonlySet<string>;
  sharing: boolean;
  currentVersion: number;
  /** Open the live invite dialog (starts sharing when not yet shared). */
  onOpenInvite: () => void;
  /** Create an async request → snapshot token (null when unavailable). */
  onCreateAsync: (
    reviewerName: string,
    expiresDays: number | null,
    note: string,
  ) => Promise<string | null>;
  /** Regenerate an async request's link against the current revision. */
  onRemintAsync: (requestId: string) => Promise<string | null>;
  /** Verify + re-anchor + import a signed return blob. */
  onImportReturn: (
    blob: string,
  ) => Promise<{ summary?: ImportSummary; error?: string }>;
  onRevoke: (requestId: string) => void;
  onResolve: (requestId: string) => void;
  onRemove: (requestId: string) => void;
  /** Join code for a live invite's token (current room state). */
  mintCode: (invite: string) => string | null;
  onClose: () => void;
}

const VIEWER_BASE_KEY = "redline.collab.viewerBase";

function readViewerBase(): string {
  try {
    return localStorage.getItem(VIEWER_BASE_KEY) ?? "";
  } catch {
    return "";
  }
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Deliver a link by handing it to the user's own mail client — nothing
 *  leaves the machine except their normal email. */
function mailtoInvite(reviewerName: string, link: string, session: string) {
  const subject = encodeURIComponent(`Plan review request — ${session}`);
  const body = encodeURIComponent(
    `Hi ${reviewerName},\n\nCould you review this plan? Open the link in any browser — no install needed:\n\n${link}\n\nWhen you're done, use "Send back" in the viewer and reply with the return code it gives you.\n`,
  );
  void openUrl(`mailto:?subject=${subject}&body=${body}`).catch(() => {});
}

export function CollaborationCenter({
  sessionLabel,
  scopedElsewhere,
  requests,
  ready,
  connectedHashes,
  sharing,
  currentVersion,
  onOpenInvite,
  onCreateAsync,
  onRemintAsync,
  onImportReturn,
  onRevoke,
  onResolve,
  onRemove,
  mintCode,
  onClose,
}: CollaborationCenterProps) {
  // ── async creation form ──
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newExpiry, setNewExpiry] = useState("7");
  const [newNote, setNewNote] = useState("");
  const [viewerBase, setViewerBase] = useState(readViewerBase);
  const [busy, setBusy] = useState(false);
  // The freshly minted (or re-minted) async link, shown until dismissed.
  const [freshLink, setFreshLink] = useState<{
    requestId: string;
    reviewerName: string;
    text: string;
    isLink: boolean;
  } | null>(null);
  const [copiedFresh, setCopiedFresh] = useState(false);

  // ── return import ──
  const [importText, setImportText] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState<{
    summary?: ImportSummary;
    error?: string;
  } | null>(null);

  const sorted = useMemo(
    () => [...requests].sort((a, b) => b.createdAt - a.createdAt),
    [requests],
  );

  const persistViewerBase = (value: string) => {
    setViewerBase(value);
    try {
      localStorage.setItem(VIEWER_BASE_KEY, value);
    } catch {
      // localStorage unavailable — the field still works for this session.
    }
  };

  const linkFor = (token: string) =>
    viewerBase.trim()
      ? snapshotLink(viewerBase.trim(), token)
      : token;

  const showToken = (
    requestId: string,
    reviewerName: string,
    token: string,
  ) => {
    setFreshLink({
      requestId,
      reviewerName,
      text: linkFor(token),
      isLink: !!viewerBase.trim(),
    });
    setCopiedFresh(false);
  };

  const createAsync = async () => {
    const reviewer = newName.trim();
    if (!reviewer || busy) return;
    setBusy(true);
    try {
      const days = Number(newExpiry);
      const token = await onCreateAsync(
        reviewer,
        Number.isFinite(days) && days > 0 ? days : null,
        newNote,
      );
      if (token) {
        showToken("", reviewer, token);
        setNewName("");
        setNewNote("");
        setCreating(false);
      }
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    const blob = importText.trim();
    if (!blob || importBusy) return;
    setImportBusy(true);
    setImportResult(null);
    try {
      const result = await onImportReturn(blob);
      setImportResult(result);
      if (result.summary) setImportText("");
    } finally {
      setImportBusy(false);
    }
  };

  const statusChip = (r: ReviewRequest) => {
    const connected = isConnected(r, connectedHashes);
    const expired = r.status === "pending" && isExpired(r, Date.now());
    const label = connected
      ? "connected"
      : expired
        ? "expired"
        : r.status;
    const color =
      label === "connected"
        ? "var(--color-success)"
        : label === "returned"
          ? "var(--color-accent)"
          : label === "revoked" || label === "expired"
            ? "var(--color-warning)"
            : "var(--color-ink-muted)";
    return (
      <span
        style={{
          color,
          border: `1px solid ${color}`,
          borderRadius: "9999px",
          padding: "0 7px",
          fontSize: "9px",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
    );
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: "var(--color-overlay)" }}
      onClick={onClose}
    >
      <div
        className="rounded-md shadow-xl border p-6 flex flex-col"
        style={{
          width: "640px",
          maxWidth: "94vw",
          maxHeight: "88vh",
          borderColor: "var(--color-rule)",
          background: "var(--color-bg-elevated)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between mb-1">
          <h2
            className="font-serif font-semibold"
            style={{ fontSize: "20px", color: "var(--color-ink)" }}
          >
            Collaboration Center
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded px-2"
            style={{
              color: "var(--color-ink-muted)",
              fontSize: "14px",
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>
        <p
          style={{
            fontSize: "12px",
            color: "var(--color-ink-muted)",
            marginBottom: 12,
          }}
        >
          Review requests for <strong>{sessionLabel}</strong> (v
          {currentVersion})
          {scopedElsewhere &&
            " — scoped to the session you're sharing, not the one in the pane"}
          .
        </p>

        {/* Actions row */}
        <div className="flex items-center gap-2 mb-4">
          <button
            type="button"
            onClick={onOpenInvite}
            className="rounded px-3 py-1.5 font-medium"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-on-accent)",
              fontSize: "12px",
            }}
          >
            {sharing ? "Live invites…" : "Start live session…"}
          </button>
          <button
            type="button"
            onClick={() => setCreating((v) => !v)}
            className="rounded px-3 py-1.5 font-medium"
            style={{
              border: "1px solid var(--color-rule)",
              background: "var(--color-bg-elevated)",
              color: "var(--color-ink)",
              fontSize: "12px",
            }}
          >
            New async request…
          </button>
        </div>

        {creating && (
          <div
            className="rounded border p-3 mb-4"
            style={{
              borderColor: "var(--color-rule)",
              background: "var(--color-bg)",
            }}
          >
            <div className="flex items-center gap-2 mb-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Reviewer name (e.g. John Doe)"
                className="flex-1 rounded px-2 py-1.5"
                style={{
                  border: "1px solid var(--color-rule)",
                  background: "var(--color-bg-elevated)",
                  color: "var(--color-ink)",
                  fontSize: "13px",
                }}
              />
              <label
                className="flex items-center gap-1 shrink-0"
                style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}
              >
                expires in
                <input
                  value={newExpiry}
                  onChange={(e) => setNewExpiry(e.target.value)}
                  className="rounded px-1.5 py-1 w-10 text-center"
                  style={{
                    border: "1px solid var(--color-rule)",
                    background: "var(--color-bg-elevated)",
                    color: "var(--color-ink)",
                    fontSize: "12px",
                  }}
                />
                days
              </label>
            </div>
            <input
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              placeholder="Optional note shown to the reviewer"
              className="w-full rounded px-2 py-1.5 mb-2"
              style={{
                border: "1px solid var(--color-rule)",
                background: "var(--color-bg-elevated)",
                color: "var(--color-ink)",
                fontSize: "12px",
              }}
            />
            <div className="flex items-center gap-2">
              <input
                value={viewerBase}
                onChange={(e) => persistViewerBase(e.target.value)}
                placeholder="Viewer URL (where viewer/index.html is hosted) — optional"
                className="flex-1 rounded px-2 py-1.5 font-mono"
                style={{
                  border: "1px solid var(--color-rule)",
                  background: "var(--color-bg-elevated)",
                  color: "var(--color-ink)",
                  fontSize: "11px",
                }}
              />
              <button
                type="button"
                disabled={!newName.trim() || busy}
                onClick={() => void createAsync()}
                className="rounded px-3 py-1.5 font-medium shrink-0"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-on-accent)",
                  fontSize: "12px",
                  opacity: !newName.trim() || busy ? 0.5 : 1,
                }}
              >
                Create
              </button>
            </div>
            <p
              style={{
                fontSize: "10.5px",
                color: "var(--color-ink-muted)",
                marginTop: 6,
                lineHeight: 1.5,
              }}
            >
              The plan travels encrypted inside the link's #fragment — it
              never reaches the server hosting the viewer. Without a viewer
              URL you get the bare snapshot code to paste into a viewer
              manually.
            </p>
          </div>
        )}

        {freshLink && (
          <div
            className="rounded border p-3 mb-4"
            style={{
              borderColor: "var(--color-accent)",
              background: "var(--color-bg)",
            }}
          >
            <div
              className="mb-1"
              style={{ fontSize: "12px", color: "var(--color-ink)" }}
            >
              {freshLink.isLink ? "Review link" : "Snapshot code"} for{" "}
              <strong>{freshLink.reviewerName}</strong>
            </div>
            <textarea
              readOnly
              value={freshLink.text}
              rows={3}
              onFocus={(e) => e.currentTarget.select()}
              className="w-full rounded px-2 py-1.5 font-mono mb-2"
              style={{
                border: "1px solid var(--color-rule)",
                background: "var(--color-bg-elevated)",
                color: "var(--color-ink)",
                fontSize: "10.5px",
                resize: "none",
                wordBreak: "break-all",
              }}
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(freshLink.text);
                  setCopiedFresh(true);
                }}
                className="rounded px-3 py-1.5 font-medium"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-on-accent)",
                  fontSize: "12px",
                }}
              >
                {copiedFresh ? "Copied ✓" : "Copy"}
              </button>
              {freshLink.isLink && (
                <button
                  type="button"
                  onClick={() =>
                    mailtoInvite(
                      freshLink.reviewerName,
                      freshLink.text,
                      sessionLabel,
                    )
                  }
                  className="rounded px-3 py-1.5"
                  style={{
                    border: "1px solid var(--color-rule)",
                    background: "var(--color-bg-elevated)",
                    color: "var(--color-ink)",
                    fontSize: "12px",
                  }}
                >
                  Email…
                </button>
              )}
              <button
                type="button"
                onClick={() => setFreshLink(null)}
                className="rounded px-3 py-1.5"
                style={{
                  border: "1px solid var(--color-rule)",
                  background: "var(--color-bg-elevated)",
                  color: "var(--color-ink-muted)",
                  fontSize: "12px",
                }}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* Requests list */}
        <div className="rl-thin-scroll-y flex-1 overflow-y-auto mb-4">
          {!ready ? (
            <p style={{ fontSize: "12px", color: "var(--color-ink-muted)" }}>
              Loading…
            </p>
          ) : sorted.length === 0 ? (
            <p
              className="italic"
              style={{ fontSize: "12px", color: "var(--color-ink-muted)" }}
            >
              No review requests yet — invite someone live, or send an
              encrypted snapshot to someone who doesn’t run Redline.
            </p>
          ) : (
            <ul>
              {sorted.map((r) => (
                <li
                  key={r.id}
                  className="border-b py-2"
                  style={{ borderColor: "var(--color-rule)" }}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="truncate"
                      style={{
                        fontSize: "13px",
                        fontWeight: 500,
                        color: "var(--color-ink)",
                      }}
                    >
                      Review from {r.reviewerName}
                    </span>
                    <span
                      style={{
                        fontSize: "9px",
                        fontWeight: 600,
                        textTransform: "uppercase",
                        letterSpacing: "0.06em",
                        color: "var(--color-ink-muted)",
                        border: "1px solid var(--color-rule)",
                        borderRadius: "9999px",
                        padding: "0 7px",
                      }}
                    >
                      {r.mode}
                    </span>
                    {statusChip(r)}
                    <span className="flex-1" />
                    <span
                      style={{
                        fontSize: "10px",
                        color: "var(--color-ink-muted)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      v{r.baseVersion} · {formatDate(r.createdAt)}
                    </span>
                  </div>
                  {r.note && (
                    <div
                      style={{
                        fontSize: "11px",
                        color: "var(--color-ink-muted)",
                        marginTop: 2,
                      }}
                    >
                      “{r.note}”
                    </div>
                  )}
                  {r.status === "returned" && (
                    <div
                      style={{
                        fontSize: "11px",
                        color: "var(--color-ink)",
                        marginTop: 2,
                      }}
                    >
                      {r.importedCommentIds?.length ?? 0} comment
                      {(r.importedCommentIds?.length ?? 0) === 1 ? "" : "s"}{" "}
                      imported onto v{r.importedIntoVersion}
                      {(r.orphans?.length ?? 0) > 0 && (
                        <span style={{ color: "var(--color-warning)" }}>
                          {" "}
                          — anchored to v{r.baseVersion}, current is v
                          {r.importedIntoVersion}: {r.orphans!.length} comment
                          {r.orphans!.length === 1 ? "" : "s"} couldn’t
                          re-anchor
                        </span>
                      )}
                    </div>
                  )}
                  {(r.orphans?.length ?? 0) > 0 && (
                    <details style={{ marginTop: 4 }}>
                      <summary
                        style={{
                          fontSize: "11px",
                          color: "var(--color-warning)",
                          cursor: "pointer",
                        }}
                      >
                        Unanchored comments
                      </summary>
                      <ul style={{ marginTop: 4 }}>
                        {r.orphans!.map((o, i) => (
                          <li
                            key={i}
                            style={{
                              fontSize: "11px",
                              color: "var(--color-ink-muted)",
                              padding: "2px 0 2px 12px",
                            }}
                          >
                            [{o.type}] {o.body}
                            {o.selection?.quotedText && (
                              <> — on “{o.selection.quotedText}”</>
                            )}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  <div className="flex items-center gap-2 mt-1.5">
                    {r.mode === "live" &&
                      r.status !== "revoked" &&
                      r.invite && (
                        <RowButton
                          label="Copy code"
                          onClick={() => {
                            const code = mintCode(r.invite!);
                            if (code) {
                              void navigator.clipboard.writeText(code);
                            }
                          }}
                        />
                      )}
                    {r.mode === "async" &&
                      r.status !== "revoked" &&
                      r.status !== "resolved" && (
                        <RowButton
                          label="New link"
                          title="Regenerate the encrypted link against the current revision"
                          onClick={() => {
                            void onRemintAsync(r.id).then((token) => {
                              if (token)
                                showToken(r.id, r.reviewerName, token);
                            });
                          }}
                        />
                      )}
                    {r.status !== "revoked" && r.status !== "resolved" && (
                      <RowButton
                        label={r.mode === "live" ? "Revoke" : "Cancel"}
                        warn
                        title={
                          r.mode === "live"
                            ? "Evict this invite and rotate the room key"
                            : "Stop accepting this request's returns"
                        }
                        onClick={() => onRevoke(r.id)}
                      />
                    )}
                    {(r.status === "returned" ||
                      r.status === "pending") && (
                      <RowButton
                        label="Resolve"
                        onClick={() => onResolve(r.id)}
                      />
                    )}
                    {(r.status === "resolved" || r.status === "revoked") && (
                      <RowButton
                        label="Remove"
                        onClick={() => onRemove(r.id)}
                      />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Return import */}
        <div
          className="rounded border p-3"
          style={{
            borderColor: "var(--color-rule)",
            background: "var(--color-bg)",
          }}
        >
          <div
            className="mb-1"
            style={{ fontSize: "12px", color: "var(--color-ink)" }}
          >
            Import a signed return
          </div>
          <div className="flex items-start gap-2">
            <textarea
              value={importText}
              onChange={(e) => {
                setImportText(e.target.value);
                setImportResult(null);
              }}
              rows={2}
              placeholder="Paste the return code the reviewer sent back (RLR1.…)"
              className="flex-1 rounded px-2 py-1.5 font-mono"
              style={{
                border: "1px solid var(--color-rule)",
                background: "var(--color-bg-elevated)",
                color: "var(--color-ink)",
                fontSize: "10.5px",
                resize: "none",
                wordBreak: "break-all",
              }}
            />
            <button
              type="button"
              disabled={!importText.trim() || importBusy}
              onClick={() => void runImport()}
              className="rounded px-3 py-1.5 font-medium shrink-0"
              style={{
                background: "var(--color-accent)",
                color: "var(--color-on-accent)",
                fontSize: "12px",
                opacity: !importText.trim() || importBusy ? 0.5 : 1,
              }}
            >
              Import
            </button>
          </div>
          {importResult?.error && (
            <p
              role="alert"
              style={{
                fontSize: "11.5px",
                color: "var(--color-warning)",
                marginTop: 6,
              }}
            >
              {importResult.error}
            </p>
          )}
          {importResult?.summary && (
            <p
              style={{
                fontSize: "11.5px",
                color: "var(--color-success)",
                marginTop: 6,
              }}
            >
              Imported {importResult.summary.imported.length} comment
              {importResult.summary.imported.length === 1 ? "" : "s"} onto v
              {importResult.summary.currentVersion}
              {importResult.summary.orphans.length > 0 && (
                <span style={{ color: "var(--color-warning)" }}>
                  {" "}
                  — {importResult.summary.orphans.length} couldn’t re-anchor
                  (listed on the request)
                </span>
              )}
              .
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function RowButton({
  label,
  onClick,
  title,
  warn,
}: {
  label: string;
  onClick: () => void;
  title?: string;
  warn?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="rounded px-2 py-0.5"
      style={{
        border: "1px solid var(--color-rule)",
        background: "var(--color-bg-elevated)",
        color: warn ? "var(--color-warning)" : "var(--color-ink)",
        fontSize: "11px",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}
