// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import {
  mirrorIsBehind,
  mirrorSummary,
  type McpConfig,
  type MirrorStatus,
} from "../lib/portability";

interface PortabilitySettingsProps {
  onClose: () => void;
  /** The active plan session id, enabling one-click "export this plan". */
  activeSessionId?: string | null;
  /** A human name for the active plan (for the button label). */
  activeSessionName?: string | null;
}

const btn = (): React.CSSProperties => ({
  fontSize: "12px",
  border: "1px solid var(--color-rule)",
  background: "var(--color-bg-elevated)",
  color: "var(--color-ink)",
  borderRadius: "3px",
  padding: "3px 10px",
  cursor: "pointer",
});

const sectionTitle = (): React.CSSProperties => ({
  fontSize: "13px",
  fontWeight: 600,
  color: "var(--color-ink)",
  marginBottom: 6,
});

const note = (): React.CSSProperties => ({
  fontSize: "12px",
  lineHeight: 1.45,
  color: "var(--color-ink-muted)",
});

/**
 * The Phase 4 portability surface: the portable memory mirror (a plain-markdown,
 * one-way, Obsidian-compatible directory), the verifiable export bundle, and the
 * copyable MCP snippet an external `claude` session installs to query Redline's
 * memory. No dashboard — stats are agent/MCP-facing only.
 */
export default function PortabilitySettings({
  onClose,
  activeSessionId,
  activeSessionName,
}: PortabilitySettingsProps) {
  const [mirror, setMirror] = useState<MirrorStatus | null>(null);
  const [mcp, setMcp] = useState<McpConfig | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [m, c] = await Promise.all([
        invoke<MirrorStatus>("mirror_status"),
        invoke<McpConfig>("mcp_config_snippet"),
      ]);
      setMirror(m);
      setMcp(c);
    } catch (e) {
      setMsg(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(null);
    }
  };

  const pickDir = () =>
    run("pick", async () => {
      const st = await invoke<MirrorStatus | null>("pick_mirror_dir");
      if (st) setMirror(st);
    });

  const clearDir = () =>
    run("clear", async () => {
      const st = await invoke<MirrorStatus>("set_mirror_dir", { dir: "" });
      setMirror(st);
    });

  const rebuild = () =>
    run("rebuild", async () => {
      const st = await invoke<MirrorStatus>("mirror_rebuild");
      setMirror(st);
      setMsg("Mirror rebuilt from the ledger.");
    });

  const syncNow = () =>
    run("sync", async () => {
      const st = await invoke<MirrorStatus>("mirror_sync");
      setMirror(st);
    });

  const exportBundle = (scope: string, id?: string | null) =>
    run(`export:${scope}`, async () => {
      const path = await invoke<string | null>("export_context_bundle", { scope, id: id ?? null });
      setMsg(path ? `Bundle written to ${path}` : "Export cancelled.");
    });

  const copySnippet = async () => {
    if (!mcp) return;
    try {
      await navigator.clipboard.writeText(mcp.snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setMsg("Could not copy to clipboard.");
    }
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
          width: "620px",
          maxWidth: "94vw",
          maxHeight: "88vh",
          overflowY: "auto",
          borderColor: "var(--color-rule)",
          background: "var(--color-bg-elevated)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="font-serif font-semibold" style={{ fontSize: "20px", color: "var(--color-ink)" }}>
            💾 Memory & portability
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" style={btn()}>
            ✕
          </button>
        </div>
        <p style={{ ...note(), marginBottom: 16 }}>
          Your Redline memory is verifiably yours (the hash-chained ledger) and
          verifiably portable — mirror it to plain markdown, export a
          self-verifying bundle, or let an external Claude query it over MCP.
        </p>

        {msg && (
          <div
            className="rounded-sm p-2 mb-3"
            style={{ fontSize: "12px", border: "1px solid var(--color-rule)", background: "var(--color-bg)", color: "var(--color-ink)" }}
          >
            {msg}
          </div>
        )}

        {/* Portable memory mirror */}
        <section className="mb-5">
          <div style={sectionTitle()}>Portable memory mirror</div>
          <p style={{ ...note(), marginBottom: 8 }}>{mirrorSummary(mirror)}</p>
          {mirror?.dir && (
            <p style={{ ...note(), marginBottom: 8, wordBreak: "break-all", fontFamily: "var(--font-mono, monospace)" }}>
              {mirror.dir}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={pickDir} disabled={!!busy} style={btn()}>
              {busy === "pick" ? "Choosing…" : mirror?.enabled ? "Change folder…" : "Choose folder…"}
            </button>
            {mirror?.enabled && (
              <>
                <button type="button" onClick={syncNow} disabled={!!busy} style={btn()}>
                  {busy === "sync" ? "Syncing…" : mirrorIsBehind(mirror) ? "Sync now (behind)" : "Sync now"}
                </button>
                <button type="button" onClick={rebuild} disabled={!!busy} style={btn()}>
                  {busy === "rebuild" ? "Rebuilding…" : "Rebuild mirror"}
                </button>
                <button type="button" onClick={clearDir} disabled={!!busy} style={btn()}>
                  Turn off
                </button>
              </>
            )}
          </div>
          <p style={{ ...note(), marginTop: 8 }}>
            One-way and fully regenerable: Redline writes, never reads your edits
            back. Open the folder as an Obsidian vault — it's just markdown.
          </p>
        </section>

        {/* Export bundle */}
        <section className="mb-5">
          <div style={sectionTitle()}>Export a verifiable bundle</div>
          <p style={{ ...note(), marginBottom: 8 }}>
            A self-contained JSON that re-verifies from itself (each event
            self-certifies via its hash) — the handoff unit for another agent,
            harness, or person.
          </p>
          <div className="flex flex-wrap gap-2">
            {activeSessionId && (
              <button
                type="button"
                onClick={() => exportBundle("session", activeSessionId)}
                disabled={!!busy}
                style={btn()}
              >
                {busy === "export:session"
                  ? "Exporting…"
                  : `Export this plan${activeSessionName ? ` (${activeSessionName})` : ""}`}
              </button>
            )}
            <button type="button" onClick={() => exportBundle("full")} disabled={!!busy} style={btn()}>
              {busy === "export:full" ? "Exporting…" : "Export everything"}
            </button>
          </div>
        </section>

        {/* MCP snippet */}
        <section>
          <div style={sectionTitle()}>Query from an external Claude (MCP)</div>
          <p style={{ ...note(), marginBottom: 8 }}>
            Add this to <code>~/.claude.json</code> to give any external{" "}
            <code>claude</code> session read-only tools over your Redline memory
            (works while Redline is running). Redline's own agents don't use MCP.
          </p>
          {mcp && (
            <>
              <pre
                style={{
                  fontSize: "11px",
                  fontFamily: "var(--font-mono, monospace)",
                  background: "var(--color-bg)",
                  border: "1px solid var(--color-rule)",
                  borderRadius: "3px",
                  padding: "10px",
                  overflowX: "auto",
                  color: "var(--color-ink)",
                  marginBottom: 8,
                }}
              >
                {mcp.snippet}
              </pre>
              <div className="flex items-center gap-2">
                <button type="button" onClick={copySnippet} style={btn()}>
                  {copied ? "Copied ✓" : "Copy snippet"}
                </button>
                <span style={note()}>
                  Then install the <code>context-analysis</code> skill in that
                  session.
                </span>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
