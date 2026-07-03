// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// The Polis ledger pane (Phase 1): a read view over the append-only,
// hash-chained prompt & decision record, with a one-click chain verification.

interface LedgerEvent {
  seq: number;
  ts: number;
  kind: string;
  author: string;
  promptId: number | null;
  sessionId: string | null;
  versionNumber: number | null;
  refKind: string | null;
  refId: string | null;
  payloadHash: string;
  prevHash: string;
  entryHash: string;
}

interface ChainVerdict {
  ok: boolean;
  checked: number;
  firstBadSeq: number | null;
  headHash: string | null;
}

interface LedgerPaneProps {
  onClose: () => void;
}

const KIND_LABEL: Record<string, string> = {
  prompt: "Prompt",
  revision: "Revision",
  resolution: "Resolution",
  approval: "Approval",
  reopen: "Reopen",
  review_verdict: "Review verdict",
  pin: "Pin",
  source_trust: "Source trust",
  taxonomy_reorg: "Taxonomy reorg",
  class_curate: "Class curate",
};

const KIND_COLOR: Record<string, string> = {
  prompt: "#4f8cff",
  revision: "#7c5cff",
  resolution: "#2fae66",
  approval: "#2fae66",
  reopen: "#e0913a",
  review_verdict: "#c065d0",
  pin: "#d0a52f",
  source_trust: "#d0a52f",
  taxonomy_reorg: "#7c5cff",
  class_curate: "#2f9ea5",
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

/** The verify-banner text for a chain verdict. Pure, so it's unit-tested. */
export function describeVerdict(v: ChainVerdict): string {
  if (v.ok) {
    const base = `✓ Chain intact — ${v.checked} event${v.checked === 1 ? "" : "s"} verified`;
    return v.headHash ? `${base} · head ${v.headHash.slice(0, 12)}…` : base;
  }
  return `✕ Chain broken at seq ${v.firstBadSeq} (verified ${v.checked} before the break)`;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function LedgerPane({ onClose }: LedgerPaneProps) {
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [verdict, setVerdict] = useState<ChainVerdict | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [selected, setSelected] = useState<LedgerEvent | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [captureExternal, setCaptureExternal] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = await invoke<LedgerEvent[]>("ledger_list_events", { limit: 1000 });
      setEvents(rows);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    void invoke<boolean>("ledger_get_capture_external").then(setCaptureExternal).catch(() => {});
    const un = listen("ledger-changed", () => void load());
    return () => {
      void un.then((f) => f());
    };
  }, [load]);

  const verify = useCallback(async () => {
    setVerifying(true);
    try {
      setVerdict(await invoke<ChainVerdict>("ledger_verify"));
    } catch (e) {
      setError(String(e));
    } finally {
      setVerifying(false);
    }
  }, []);

  const openEvent = useCallback(async (ev: LedgerEvent) => {
    setSelected(ev);
    setBody(null);
    if (ev.promptId != null) {
      try {
        setBody(await invoke<string | null>("ledger_prompt_body", { id: ev.promptId }));
      } catch (e) {
        setBody(`(could not load body: ${e})`);
      }
    }
  }, []);

  const toggleExternal = useCallback(async () => {
    const next = !captureExternal;
    setCaptureExternal(next);
    try {
      await invoke("ledger_set_capture_external", { enabled: next });
    } catch {
      setCaptureExternal(!next); // revert on failure
    }
  }, [captureExternal]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--color-paper)",
        color: "var(--color-ink)",
        overflow: "hidden",
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          borderBottom: "1px solid var(--color-rule)",
          flex: "0 0 auto",
        }}
      >
        <span style={{ fontWeight: 600 }}>📒 Ledger</span>
        <span style={{ color: "var(--color-ink-muted)", fontSize: 12 }}>
          {events.length} event{events.length === 1 ? "" : "s"}
        </span>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={verify}
          disabled={verifying}
          style={{
            border: "1px solid var(--color-rule)",
            borderRadius: 4,
            padding: "3px 10px",
            background: "var(--color-bg-elevated)",
            color: "var(--color-ink)",
            cursor: "pointer",
          }}
        >
          {verifying ? "Verifying…" : "Verify chain"}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close ledger"
          title="Close ledger"
          style={{
            border: "none",
            background: "transparent",
            color: "var(--color-ink-muted)",
            cursor: "pointer",
            fontSize: 16,
          }}
        >
          ✕
        </button>
      </div>

      {/* Verdict banner */}
      {verdict && (
        <div
          style={{
            padding: "6px 12px",
            fontSize: 13,
            background: verdict.ok ? "rgba(47,174,102,0.12)" : "rgba(214,69,69,0.14)",
            color: verdict.ok ? "#1f8a4c" : "#c0392b",
            borderBottom: "1px solid var(--color-rule)",
          }}
        >
          {describeVerdict(verdict)}
        </div>
      )}

      {error && (
        <div style={{ padding: "6px 12px", color: "var(--color-warning)", fontSize: 13 }}>{error}</div>
      )}

      {/* Body: event list + detail */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div style={{ flex: "1 1 55%", overflowY: "auto", minWidth: 0 }}>
          {events.length === 0 ? (
            <div style={{ padding: 16, color: "var(--color-ink-muted)", fontSize: 13 }}>
              No events yet. Prompts, plan revisions, and decisions appear here as you work.
            </div>
          ) : (
            events.map((ev) => (
              <button
                key={ev.seq}
                type="button"
                onClick={() => openEvent(ev)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  textAlign: "left",
                  padding: "6px 12px",
                  border: "none",
                  borderBottom: "1px solid var(--color-rule)",
                  background:
                    selected?.seq === ev.seq ? "var(--color-bg-elevated)" : "transparent",
                  color: "var(--color-ink)",
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                <span style={{ color: "var(--color-ink-muted)", width: 40, flex: "0 0 auto" }}>
                  #{ev.seq}
                </span>
                <span
                  style={{
                    flex: "0 0 auto",
                    padding: "1px 7px",
                    borderRadius: 999,
                    fontSize: 11,
                    fontWeight: 600,
                    color: "#fff",
                    background: KIND_COLOR[ev.kind] ?? "var(--color-ink-muted)",
                  }}
                >
                  {kindLabel(ev.kind)}
                </span>
                <span style={{ flex: "0 0 auto" }}>{ev.author}</span>
                <span style={{ flex: 1 }} />
                <span style={{ color: "var(--color-ink-muted)", flex: "0 0 auto" }}>
                  {fmtTime(ev.ts)}
                </span>
                <code
                  style={{
                    color: "var(--color-ink-muted)",
                    flex: "0 0 auto",
                    fontSize: 11,
                  }}
                >
                  {ev.entryHash.slice(0, 8)}
                </code>
              </button>
            ))
          )}
        </div>

        {/* Detail */}
        <div
          style={{
            flex: "1 1 45%",
            borderLeft: "1px solid var(--color-rule)",
            overflowY: "auto",
            padding: 12,
            fontSize: 13,
            minWidth: 0,
          }}
        >
          {selected ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontWeight: 600 }}>
                {kindLabel(selected.kind)} · seq {selected.seq}
              </div>
              <Field label="Author" value={selected.author} />
              <Field label="When" value={fmtTime(selected.ts)} />
              {selected.sessionId && <Field label="Session" value={selected.sessionId} />}
              {selected.versionNumber != null && (
                <Field label="Version" value={String(selected.versionNumber)} />
              )}
              {selected.refKind && (
                <Field label="References" value={`${selected.refKind} · ${selected.refId ?? ""}`} />
              )}
              <Field label="Payload hash" value={selected.payloadHash} mono />
              <Field label="Prev hash" value={selected.prevHash} mono />
              <Field label="Entry hash" value={selected.entryHash} mono />
              {body != null && (
                <div>
                  <div style={{ color: "var(--color-ink-muted)", marginBottom: 4 }}>Body</div>
                  <pre
                    style={{
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      background: "var(--color-bg-elevated)",
                      padding: 8,
                      borderRadius: 4,
                      margin: 0,
                      maxHeight: 320,
                      overflow: "auto",
                      fontSize: 12,
                    }}
                  >
                    {body}
                  </pre>
                </div>
              )}
            </div>
          ) : (
            <div style={{ color: "var(--color-ink-muted)" }}>
              Select an event to inspect its hashes and body.
            </div>
          )}
        </div>
      </div>

      {/* Footer: capture settings */}
      <div
        style={{
          flex: "0 0 auto",
          padding: "8px 12px",
          borderTop: "1px solid var(--color-rule)",
          fontSize: 12,
          color: "var(--color-ink-muted)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input type="checkbox" checked={captureExternal} onChange={toggleExternal} />
          Capture prompts from external Claude sessions
        </label>
        <div style={{ flex: 1 }} />
        <span>Local-only · hash-chained · yours</span>
      </div>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 8 }}>
      <span style={{ color: "var(--color-ink-muted)", flex: "0 0 100px" }}>{label}</span>
      <span
        style={{
          flex: 1,
          wordBreak: "break-word",
          fontFamily: mono ? "var(--font-mono, monospace)" : undefined,
          fontSize: mono ? 11 : undefined,
        }}
      >
        {value}
      </span>
    </div>
  );
}
