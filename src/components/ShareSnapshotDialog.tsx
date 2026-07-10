// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/**
 * Share a plan as a self-contained encrypted snapshot (async delivery).
 *
 * The owner mints an `RLS1.` token — the plan, AES-256-GCM encrypted under a
 * random key that rides IN the link `#fragment`, so the plan never reaches a
 * server. The recipient opens it in the zero-install browser viewer
 * (`http://localhost:7676/viewer/` locally), annotates, and sends back a
 * signed `RLR1.` return blob. The owner pastes that here: it's verified
 * against the per-request key (derived from the owner secret) and re-anchored
 * by `blockId` onto the CURRENT revision as real comments/suggestions.
 *
 * This is the async half of the hybrid share — richer than thin margin notes
 * because returns become full track-change suggestions and questions, not
 * read-only annotations. Owner-local share metadata lives in localStorage; the
 * cryptographic round-trip needs no server-side registry (the signing key is
 * deterministic from the owner secret + request id).
 */
import { useCallback, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

import type { NewCommentRequest, Section } from "../types";
import { anchorByBlockId } from "../editor/docModel";
import {
  encodeSnapshot,
  snapshotLink,
  type SnapshotPayload,
} from "../collab/snapshot";
import {
  deriveSigningKey,
  peekReturn,
  reanchorReturn,
  verifyReturn,
} from "../collab/returnBlob";

/** The daemon serves the viewer here for the sender's local preview. */
const LOCAL_VIEWER_BASE = "http://localhost:7676/viewer/";

/** Owner-local record of one minted share — non-secret metadata so the owner
 *  can see what's outstanding and re-open a preview. The key never lives here
 *  (it's regenerated per mint and only ever rides the link fragment). */
interface SharedSnapshot {
  requestId: string;
  reviewerName: string;
  note: string;
  baseVersion: number;
  createdAt: number;
}

interface Built {
  requestId: string;
  reviewerName: string;
  link: string;
  token: string;
}

interface ImportResult {
  reviewerName: string;
  placed: number;
  orphans: number;
}

interface ShareSnapshotDialogProps {
  sessionId: string;
  version: number;
  ownerName: string;
  /** The CURRENT revision's sections — returns re-anchor by blockId onto it. */
  currentSections: Section[];
  /** Persist one re-anchored annotation as a native comment/suggestion. */
  addComment: (req: NewCommentRequest) => Promise<unknown>;
  onClose: () => void;
}

function storeKey(sessionId: string): string {
  return `rl-owner-shares.${sessionId}`;
}

function loadShares(sessionId: string): SharedSnapshot[] {
  try {
    const raw = localStorage.getItem(storeKey(sessionId));
    const parsed = raw ? (JSON.parse(raw) as SharedSnapshot[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveShares(sessionId: string, shares: SharedSnapshot[]): void {
  try {
    localStorage.setItem(storeKey(sessionId), JSON.stringify(shares));
  } catch {
    // Private-mode browsers — the list survives the tab, not a reload.
  }
}

export function ShareSnapshotDialog({
  sessionId,
  version,
  ownerName,
  currentSections,
  addComment,
  onClose,
}: ShareSnapshotDialogProps) {
  const [tab, setTab] = useState<"mint" | "import">("mint");
  const [shares, setShares] = useState<SharedSnapshot[]>(() =>
    loadShares(sessionId),
  );

  const persist = useCallback(
    (next: SharedSnapshot[]) => {
      setShares(next);
      saveShares(sessionId, next);
    },
    [sessionId],
  );

  return (
    <div className="rl-modal-overlay" onClick={onClose}>
      <div
        className="rl-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "560px",
          maxWidth: "94vw",
          maxHeight: "88vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--color-bg-elevated)",
          border: "1px solid var(--color-rule)",
          borderRadius: "10px",
          overflow: "hidden",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 18px",
            borderBottom: "1px solid var(--color-rule)",
          }}
        >
          <div>
            <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-ink)" }}>
              Share a snapshot
            </div>
            <div style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}>
              Send an encrypted, zero-install plan link — v{version}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              border: "none",
              background: "transparent",
              color: "var(--color-ink-muted)",
              fontSize: "18px",
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </header>

        <div
          role="tablist"
          style={{ display: "flex", borderBottom: "1px solid var(--color-rule)" }}
        >
          <TabButton active={tab === "mint"} onClick={() => setTab("mint")}>
            Create link
          </TabButton>
          <TabButton active={tab === "import"} onClick={() => setTab("import")}>
            Import returns
          </TabButton>
        </div>

        <div style={{ padding: "18px", overflow: "auto" }}>
          {tab === "mint" ? (
            <MintPanel
              sessionId={sessionId}
              version={version}
              ownerName={ownerName}
              shares={shares}
              persist={persist}
            />
          ) : (
            <ImportPanel
              currentSections={currentSections}
              addComment={addComment}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        flex: 1,
        padding: "10px 12px",
        border: "none",
        background: "transparent",
        cursor: "pointer",
        fontSize: "12px",
        fontWeight: 600,
        color: active ? "var(--color-ink)" : "var(--color-ink-muted)",
        borderBottom: active
          ? "2px solid var(--color-info)"
          : "2px solid transparent",
      }}
    >
      {children}
    </button>
  );
}

function MintPanel({
  sessionId,
  version,
  ownerName,
  shares,
  persist,
}: {
  sessionId: string;
  version: number;
  ownerName: string;
  shares: SharedSnapshot[];
  persist: (next: SharedSnapshot[]) => void;
}) {
  const [reviewerName, setReviewerName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [built, setBuilt] = useState<Built | null>(null);
  const [copied, setCopied] = useState<"link" | "code" | null>(null);
  // The plan's depth (discussion + decisions) makes the shared viewer feel
  // rich, so default both on — but they leave the sender's machine for the
  // recipient, so they're the sharer's call and easy to turn off.
  const [includeDiscussion, setIncludeDiscussion] = useState(true);
  const [includeDecisions, setIncludeDecisions] = useState(true);

  const create = async () => {
    const who = reviewerName.trim() || "reviewer";
    setBusy(true);
    setError(null);
    setCopied(null);
    try {
      const [snap, ownerSecret] = await Promise.all([
        invoke<
          Pick<
            SnapshotPayload,
            | "markdown"
            | "revisionTimeline"
            | "discussion"
            | "decisions"
            | "stats"
            | "toc"
          > & {
            planTitle: string | null;
            projectName: string;
            baseVersion: number;
          }
        >("build_plan_snapshot", {
          sessionId,
          versionNumber: version,
          includeDiscussion,
          includeDecisions,
        }),
        invoke<string>("get_owner_secret"),
      ]);
      const requestId =
        globalThis.crypto?.randomUUID?.() ??
        `req-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
      const signingKey = await deriveSigningKey(ownerSecret, requestId);
      const payload: SnapshotPayload = {
        v: 1,
        requestId,
        baseVersion: snap.baseVersion,
        reviewerName: who,
        ownerName: ownerName || undefined,
        projectName: snap.projectName || undefined,
        planTitle: snap.planTitle || undefined,
        markdown: snap.markdown,
        signingKey,
        note: note.trim() || undefined,
        createdAt: Date.now(),
        // Enrichment — guarded so empty collections stay `undefined` (they'd
        // be skipped by the backend anyway; this keeps the token minimal).
        ...(snap.revisionTimeline?.length
          ? { revisionTimeline: snap.revisionTimeline }
          : {}),
        ...(snap.discussion?.length ? { discussion: snap.discussion } : {}),
        ...(snap.decisions?.length ? { decisions: snap.decisions } : {}),
        ...(snap.stats ? { stats: snap.stats } : {}),
        ...(snap.toc?.length ? { toc: snap.toc } : {}),
      };
      const token = await encodeSnapshot(payload);
      const link = snapshotLink(LOCAL_VIEWER_BASE, token);
      setBuilt({ requestId, reviewerName: who, link, token });
      persist([
        {
          requestId,
          reviewerName: who,
          note: note.trim(),
          baseVersion: snap.baseVersion,
          createdAt: Date.now(),
        },
        ...shares,
      ]);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const copy = (text: string, which: "link" | "code") => {
    void navigator.clipboard.writeText(text);
    setCopied(which);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <p style={{ fontSize: "12px", color: "var(--color-ink-muted)", margin: 0 }}>
        The whole plan is encrypted into the link. It never touches a server —
        only the person you send it to can open it. They review in the browser
        and send back signed feedback you import here.
      </p>

      <Field label="Who's it for? (shows in their header)">
        <input
          value={reviewerName}
          onChange={(e) => setReviewerName(e.target.value)}
          placeholder="e.g. Jordan"
          style={inputStyle}
        />
      </Field>
      <Field label="A note for them (optional)">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="What you'd like a look at…"
          style={{ ...inputStyle, resize: "vertical" }}
        />
      </Field>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "8px",
          padding: "10px 12px",
          border: "1px solid var(--color-rule)",
          borderRadius: "8px",
          background: "var(--color-paper)",
        }}
      >
        <div
          style={{
            fontSize: "11px",
            fontWeight: 600,
            color: "var(--color-ink-muted)",
          }}
        >
          Include with the plan
        </div>
        <Check
          checked={includeDiscussion}
          onChange={setIncludeDiscussion}
          label="Discussion history"
          hint="Prior comments and their resolutions, shown read-only in the viewer."
        />
        <Check
          checked={includeDecisions}
          onChange={setIncludeDecisions}
          label="Decision summary"
          hint="A digest of what was resolved on this plan."
        />
        <div style={{ fontSize: "10.5px", color: "var(--color-ink-muted)" }}>
          Revision history and stats are always included. Anything you turn off
          never leaves your machine — it's not in the link.
        </div>
      </div>

      <button
        onClick={create}
        disabled={busy}
        style={{
          ...primaryBtn,
          opacity: busy ? 0.6 : 1,
          cursor: busy ? "default" : "pointer",
          alignSelf: "flex-start",
        }}
      >
        {busy ? "Building…" : built ? "Create another link" : "Create link"}
      </button>

      {error && (
        <div style={{ fontSize: "12px", color: "var(--color-warning)" }}>
          {error}
        </div>
      )}

      {built && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            padding: "12px",
            border: "1px solid var(--color-rule)",
            borderRadius: "8px",
            background: "var(--color-paper)",
          }}
        >
          <div style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}>
            Link for <strong>{built.reviewerName}</strong>
          </div>
          <textarea
            readOnly
            value={built.link}
            rows={3}
            onFocus={(e) => e.currentTarget.select()}
            style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: "11px" }}
          />
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <button style={secondaryBtn} onClick={() => copy(built.link, "link")}>
              {copied === "link" ? "Copied ✓" : "Copy link"}
            </button>
            <button style={secondaryBtn} onClick={() => copy(built.token, "code")}>
              {copied === "code" ? "Copied ✓" : "Copy code only"}
            </button>
            <button
              style={secondaryBtn}
              onClick={() => void openUrl(built.link).catch(() => {})}
              title="Preview the link the way your reviewer will see it (local only)"
            >
              Open local preview
            </button>
          </div>
          <div style={{ fontSize: "10.5px", color: "var(--color-ink-muted)" }}>
            The local preview only works on this machine. To send it to someone
            else, share the link or code — they open it in any modern browser.
          </div>
        </div>
      )}

      {shares.length > 0 && (
        <div>
          <div
            style={{
              fontSize: "11px",
              fontWeight: 600,
              color: "var(--color-ink-muted)",
              marginBottom: "6px",
            }}
          >
            Shared so far
          </div>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "4px" }}>
            {shares.map((s) => (
              <li
                key={s.requestId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  fontSize: "11.5px",
                  color: "var(--color-ink)",
                  padding: "4px 0",
                }}
              >
                <span>
                  {s.reviewerName} · v{s.baseVersion}
                  {s.note ? ` — “${s.note}”` : ""}
                </span>
                <button
                  title="Forget this share"
                  onClick={() =>
                    persist(shares.filter((x) => x.requestId !== s.requestId))
                  }
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "var(--color-ink-muted)",
                    cursor: "pointer",
                    fontSize: "12px",
                  }}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ImportPanel({
  currentSections,
  addComment,
}: {
  currentSections: Section[];
  addComment: (req: NewCommentRequest) => Promise<unknown>;
}) {
  const [blob, setBlob] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const anchors = useMemo(
    () => anchorByBlockId(currentSections),
    [currentSections],
  );

  const importReturn = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const peeked = peekReturn(blob.trim());
      if (!peeked) {
        setError(
          "That doesn't look like a Redline return code — it should start with RLR1.",
        );
        return;
      }
      const ownerSecret = await invoke<string>("get_owner_secret");
      const signingKey = await deriveSigningKey(ownerSecret, peeked.requestId);
      const verified = await verifyReturn(blob.trim(), signingKey);
      if (!verified) {
        setError(
          "Couldn't verify this return — it may have been tampered with, or it's for a link this Redline didn't mint.",
        );
        return;
      }
      const { placed, orphans } = reanchorReturn(verified, anchors);
      for (const req of placed) {
        await addComment(req);
      }
      setResult({
        reviewerName: verified.reviewerName,
        placed: placed.length,
        orphans: orphans.length,
      });
      setBlob("");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <p style={{ fontSize: "12px", color: "var(--color-ink-muted)", margin: 0 }}>
        Paste the signed return code your reviewer sent back. Their comments and
        suggestions land on your current version, re-anchored by block — even if
        you've revised since you shared.
      </p>
      <textarea
        value={blob}
        onChange={(e) => setBlob(e.target.value)}
        rows={5}
        placeholder="RLR1.…"
        style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: "11px" }}
      />
      <button
        onClick={importReturn}
        disabled={busy || !blob.trim()}
        style={{
          ...primaryBtn,
          alignSelf: "flex-start",
          opacity: busy || !blob.trim() ? 0.6 : 1,
          cursor: busy || !blob.trim() ? "default" : "pointer",
        }}
      >
        {busy ? "Importing…" : "Import feedback"}
      </button>
      {error && (
        <div style={{ fontSize: "12px", color: "var(--color-warning)" }}>{error}</div>
      )}
      {result && (
        <div
          style={{
            fontSize: "12px",
            color: "var(--color-ink)",
            padding: "10px 12px",
            border: "1px solid var(--color-rule)",
            borderRadius: "8px",
            background: "var(--color-paper)",
          }}
        >
          Imported {result.placed} annotation{result.placed === 1 ? "" : "s"} from{" "}
          {result.reviewerName}.
          {result.orphans > 0 && (
            <div style={{ color: "var(--color-ink-muted)", marginTop: "4px" }}>
              {result.orphans} couldn't be placed — the block they were on is
              gone from your current version.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
      <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--color-ink-muted)" }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function Check({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "8px",
        cursor: "pointer",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: "2px", cursor: "pointer" }}
      />
      <span style={{ display: "flex", flexDirection: "column", gap: "1px" }}>
        <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-ink)" }}>
          {label}
        </span>
        <span style={{ fontSize: "10.5px", color: "var(--color-ink-muted)" }}>
          {hint}
        </span>
      </span>
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: "12px",
  color: "var(--color-ink)",
  background: "var(--color-paper)",
  border: "1px solid var(--color-rule)",
  borderRadius: "6px",
  boxSizing: "border-box",
};

const primaryBtn: React.CSSProperties = {
  padding: "8px 16px",
  fontSize: "12px",
  fontWeight: 600,
  color: "var(--color-on-accent)",
  background: "var(--color-info)",
  border: "none",
  borderRadius: "6px",
};

const secondaryBtn: React.CSSProperties = {
  padding: "7px 12px",
  fontSize: "11px",
  fontWeight: 600,
  color: "var(--color-ink)",
  background: "var(--color-bg-elevated)",
  border: "1px solid var(--color-rule)",
  borderRadius: "6px",
  cursor: "pointer",
};
