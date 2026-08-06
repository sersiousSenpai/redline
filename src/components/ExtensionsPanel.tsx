// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MarkdownView } from "./MarkdownView";

// Extensions — the Settings-adjacent management view for the WASM extension
// host (Elevation B3) and its marketplace (B4). Two tabs:
//   Installed — every installed extension (external-process and in-process
//     wasm) with live status, strikes, scopes, events, the sanctioned
//     markdown panel, enable/disable, and two-step uninstall.
//   Browse — the curated index (fetched on demand, SQLite-cached), with a
//     consent dialog spelling out every scope and event in plain language
//     plus the artifact sha256 before anything installs. Installs are
//     hot-registered (no relaunch); updates are NEVER automatic — the same
//     consent dialog re-runs with the new version's grants.

/** Mirror of `extension_host::ExtensionInfo` (snake-case fields are all
 *  single words, so the Rust struct serializes to exactly this shape). */
export interface ExtensionInfo {
  name: string;
  version: string | null;
  kind: string;
  scopes: string[];
  events: string[];
  status: string;
  detail: string | null;
  strikes: number;
  panel: string | null;
  dir: string;
}

/** Mirror of `marketplace::InstallState` (serde snake_case). */
export type InstallState = "installable" | "installed" | "update_available";

/** Mirror of `marketplace::DescribedName`. */
export interface DescribedName {
  name: string;
  description: string;
}

/** Mirror of `marketplace::MarketEntry` (the IndexEntry fields flatten). */
export interface MarketEntry {
  name: string;
  version: string;
  publisher: string;
  repo: string;
  artifact: { url: string; sha256: string; size: number };
  scopes: string[];
  events: string[];
  api_version: number;
  license: string;
  min_redline: string;
  description: string | null;
  changelog: string | null;
  scope_details: DescribedName[];
  event_details: DescribedName[];
  min_redline_ok: boolean;
  installed_version: string | null;
  state: InstallState;
}

/** Mirror of lib.rs `MarketplaceIndexView`. */
export interface MarketplaceIndexView {
  fetched_ms: number | null;
  source: string;
  warnings: string[];
  entries: MarketEntry[];
}

/** Status → chip label + theme color, one place. Exported for tests. */
export function statusChip(info: ExtensionInfo): { label: string; color: string } {
  switch (info.status) {
    case "running":
      return { label: "running", color: "var(--color-success)" };
    case "starting":
      return { label: "starting", color: "var(--color-info)" };
    case "failed":
      return { label: "failed", color: "var(--color-danger)" };
    case "disabled":
      return { label: "disabled", color: "var(--color-ink-muted)" };
    case "external":
      return { label: "external process", color: "var(--color-ink-muted)" };
    default:
      return { label: info.status, color: "var(--color-ink-muted)" };
  }
}

/** Whether the enable/disable toggle applies — only the host-run kind.
 *  Exported for tests. */
export function isToggleable(info: ExtensionInfo): boolean {
  return info.kind === "wasm";
}

/** The Browse row's action for an entry's install state. Exported for
 *  tests: "installed" must never render as a clickable install. */
export function installAction(
  state: InstallState,
): { label: string; actionable: boolean } {
  switch (state) {
    case "installable":
      return { label: "Install…", actionable: true };
    case "update_available":
      return { label: "Update…", actionable: true };
    case "installed":
      return { label: "Installed", actionable: false };
  }
}

/** Human artifact size for the consent dialog. Exported for tests. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function Chip({ text, title }: { text: string; title?: string }) {
  return (
    <span
      title={title}
      className="font-mono"
      style={{
        fontSize: "10px",
        padding: "1px 6px",
        borderRadius: "999px",
        border: "1px solid var(--color-rule)",
        color: "var(--color-ink-muted)",
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
}

const smallButton = (kind: "default" | "accent" | "danger", busy?: boolean) => ({
  fontSize: "10px",
  padding: "2px 10px",
  borderRadius: "var(--rl-radius-control)",
  border: `1px solid ${
    kind === "danger"
      ? "var(--color-danger)"
      : kind === "accent"
        ? "var(--color-info)"
        : "var(--color-rule)"
  }`,
  background: kind === "accent" ? "var(--color-info)" : "transparent",
  color:
    kind === "accent"
      ? "var(--color-paper)"
      : kind === "danger"
        ? "var(--color-danger)"
        : "var(--color-ink)",
  cursor: busy ? "default" : "pointer",
  opacity: busy ? 0.6 : 1,
});

function ExtensionRow({
  info,
  onChanged,
}: {
  info: ExtensionInfo;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chip = statusChip(info);
  const disabled = info.status === "disabled";

  const run = useCallback(
    async (op: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await op();
        onChanged();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  return (
    <div
      style={{
        padding: "10px 14px",
        borderBottom: "1px solid var(--color-rule)",
      }}
    >
      <div className="flex items-center gap-2">
        <span
          className="font-sans"
          style={{ fontSize: "var(--rl-text-sm)", fontWeight: 700 }}
        >
          {info.name}
        </span>
        {info.version && (
          <span
            className="font-mono"
            style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}
          >
            v{info.version}
          </span>
        )}
        <span
          className="font-sans"
          style={{
            fontSize: "10px",
            fontWeight: 600,
            color: chip.color,
            border: `1px solid color-mix(in srgb, ${chip.color} 45%, transparent)`,
            borderRadius: "999px",
            padding: "1px 8px",
          }}
        >
          {chip.label}
        </span>
        {info.strikes > 0 && (
          <span
            className="font-sans"
            title={info.detail ?? undefined}
            style={{ fontSize: "10px", color: "var(--color-danger)" }}
          >
            {info.strikes}/3 strikes
          </span>
        )}
        <span style={{ flex: 1 }} />
        {isToggleable(info) && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              run(() =>
                invoke("extension_set_enabled", {
                  name: info.name,
                  enabled: disabled,
                }),
              )
            }
            style={{
              ...smallButton("default", busy),
              background: "var(--color-bg-elevated)",
            }}
          >
            {disabled ? "Enable" : "Disable"}
          </button>
        )}
        {confirming ? (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              run(() => invoke("extension_uninstall", { name: info.name }))
            }
            style={smallButton("danger", busy)}
          >
            Really uninstall?
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            style={{ ...smallButton("default"), color: "var(--color-ink-muted)" }}
          >
            Uninstall
          </button>
        )}
      </div>
      {info.detail && (
        <div
          className="font-sans"
          style={{
            marginTop: "4px",
            fontSize: "var(--rl-text-xs)",
            color: "var(--color-ink-muted)",
          }}
        >
          {info.detail}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5" style={{ marginTop: "6px" }}>
        {info.scopes.map((s) => (
          <Chip key={`s-${s}`} text={s} title="granted scope" />
        ))}
        {info.events.map((e) => (
          <Chip key={`e-${e}`} text={`⚡ ${e}`} title="event subscription" />
        ))}
      </div>
      {error && (
        <div
          className="font-sans"
          style={{
            marginTop: "6px",
            fontSize: "var(--rl-text-xs)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}
      {info.panel && (
        <div
          style={{
            marginTop: "8px",
            padding: "8px 10px",
            borderRadius: "var(--rl-radius-control)",
            border: "1px solid var(--color-rule)",
            background: "var(--color-paper)",
          }}
        >
          <MarkdownView body={info.panel} compact />
        </div>
      )}
    </div>
  );
}

/** The consent dialog: everything the extension will be able to do and
 *  hear, in plain language, plus the exact artifact hash — BEFORE any bytes
 *  move. The confirm button is the only path into `marketplace_install`,
 *  and it carries the sha256 the user is looking at (the install refuses if
 *  the index has changed underneath it). Updates re-run this dialog with
 *  the new version's grants: nothing ever updates automatically. */
function ConsentDialog({
  entry,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  entry: MarketEntry;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const updating = entry.state === "update_available";
  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: "var(--color-overlay)" }}
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-label={`Install ${entry.name}`}
        onClick={(e) => e.stopPropagation()}
        className="font-sans"
        style={{
          width: "480px",
          maxWidth: "90vw",
          maxHeight: "84vh",
          overflowY: "auto",
          background: "var(--color-bg-elevated)",
          border: "1px solid var(--color-rule)",
          borderRadius: "10px",
          padding: "18px 20px",
        }}
      >
        <div style={{ fontSize: "var(--rl-text-md)", fontWeight: 700 }}>
          {updating
            ? `Update ${entry.name} v${entry.installed_version} → v${entry.version}`
            : `Install ${entry.name} v${entry.version}`}
        </div>
        <div
          style={{
            marginTop: "4px",
            fontSize: "var(--rl-text-xs)",
            color: "var(--color-ink-muted)",
          }}
        >
          by {entry.publisher} ·{" "}
          <a href={entry.repo} style={{ color: "var(--color-info)" }}>
            {entry.repo.replace(/^https:\/\//, "")}
          </a>
          {" · "}
          {entry.license} · {formatBytes(entry.artifact.size)}
          {updating && entry.changelog && (
            <>
              {" · "}
              <a href={entry.changelog} style={{ color: "var(--color-info)" }}>
                changelog
              </a>
            </>
          )}
        </div>
        {entry.description && (
          <div style={{ marginTop: "10px", fontSize: "var(--rl-text-sm)" }}>
            {entry.description}
          </div>
        )}

        <div
          style={{
            marginTop: "14px",
            fontSize: "var(--rl-text-xs)",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            color: "var(--color-ink-muted)",
          }}
        >
          This extension can
        </div>
        {entry.scope_details.map((s) => (
          <div
            key={s.name}
            className="flex items-baseline gap-2"
            style={{ marginTop: "6px" }}
          >
            <Chip text={s.name} />
            <span style={{ fontSize: "var(--rl-text-xs)" }}>{s.description}</span>
          </div>
        ))}

        {entry.event_details.length > 0 && (
          <>
            <div
              style={{
                marginTop: "14px",
                fontSize: "var(--rl-text-xs)",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                color: "var(--color-ink-muted)",
              }}
            >
              It hears about
            </div>
            {entry.event_details.map((e) => (
              <div
                key={e.name}
                className="flex items-baseline gap-2"
                style={{ marginTop: "6px" }}
              >
                <Chip text={`⚡ ${e.name}`} />
                <span style={{ fontSize: "var(--rl-text-xs)" }}>{e.description}</span>
              </div>
            ))}
          </>
        )}

        <div
          style={{
            marginTop: "14px",
            fontSize: "10px",
            color: "var(--color-ink-muted)",
          }}
        >
          Artifact sha256 (verified byte-for-byte before it runs):
          <div
            className="font-mono"
            style={{ wordBreak: "break-all", marginTop: "2px" }}
          >
            {entry.artifact.sha256}
          </div>
        </div>

        {!entry.min_redline_ok && (
          <div
            style={{
              marginTop: "10px",
              fontSize: "var(--rl-text-xs)",
              color: "var(--color-danger)",
            }}
          >
            Needs Redline ≥ {entry.min_redline} — update Redline first.
          </div>
        )}
        {error && (
          <div
            style={{
              marginTop: "10px",
              fontSize: "var(--rl-text-xs)",
              color: "var(--color-danger)",
            }}
          >
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2" style={{ marginTop: "16px" }}>
          <button type="button" onClick={onCancel} style={smallButton("default")}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !entry.min_redline_ok}
            onClick={onConfirm}
            style={smallButton("accent", busy || !entry.min_redline_ok)}
          >
            {busy ? "Installing…" : updating ? "Update" : "Install"}
          </button>
        </div>
      </div>
    </div>
  );
}

function BrowseRow({
  entry,
  onInstall,
}: {
  entry: MarketEntry;
  onInstall: (entry: MarketEntry) => void;
}) {
  const action = installAction(entry.state);
  return (
    <div
      style={{ padding: "10px 14px", borderBottom: "1px solid var(--color-rule)" }}
    >
      <div className="flex items-center gap-2">
        <span
          className="font-sans"
          style={{ fontSize: "var(--rl-text-sm)", fontWeight: 700 }}
        >
          {entry.name}
        </span>
        <span
          className="font-mono"
          style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}
        >
          {entry.state === "update_available"
            ? `v${entry.installed_version} → v${entry.version}`
            : `v${entry.version}`}
        </span>
        <span
          className="font-sans"
          style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}
        >
          by {entry.publisher}
        </span>
        <span style={{ flex: 1 }} />
        {action.actionable ? (
          <button
            type="button"
            onClick={() => onInstall(entry)}
            style={smallButton("accent")}
          >
            {action.label}
          </button>
        ) : (
          <span
            className="font-sans"
            style={{ fontSize: "10px", color: "var(--color-success)" }}
          >
            {action.label}
          </span>
        )}
      </div>
      {entry.description && (
        <div
          className="font-sans"
          style={{
            marginTop: "4px",
            fontSize: "var(--rl-text-xs)",
            color: "var(--color-ink-muted)",
          }}
        >
          {entry.description}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5" style={{ marginTop: "6px" }}>
        {entry.scopes.map((s) => (
          <Chip key={`s-${s}`} text={s} title="requested scope" />
        ))}
        {entry.events.map((e) => (
          <Chip key={`e-${e}`} text={`⚡ ${e}`} title="event subscription" />
        ))}
      </div>
    </div>
  );
}

function BrowseTab() {
  const [view, setView] = useState<MarketplaceIndexView | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [consent, setConsent] = useState<MarketEntry | null>(null);
  const [installBusy, setInstallBusy] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  const load = useCallback((refresh: boolean) => {
    setLoading(true);
    setLoadError(null);
    invoke<MarketplaceIndexView>("marketplace_index", { refresh })
      .then((v) => setView(v))
      .catch((e) => setLoadError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  const confirmInstall = useCallback(() => {
    if (!consent) return;
    setInstallBusy(true);
    setInstallError(null);
    // Consent binding: the sha256 the user just read travels with the
    // install; the backend refuses if the index entry drifted.
    invoke("marketplace_install", {
      name: consent.name,
      sha256: consent.artifact.sha256,
    })
      .then(() => {
        setConsent(null);
        load(false); // recompute install states from the same cache
      })
      .catch((e) => setInstallError(String(e)))
      .finally(() => setInstallBusy(false));
  }, [consent, load]);

  return (
    <>
      <div
        className="flex items-center gap-2"
        style={{
          padding: "8px 14px",
          borderBottom: "1px solid var(--color-rule)",
          fontSize: "10px",
          color: "var(--color-ink-muted)",
        }}
      >
        <span className="font-sans">
          {view
            ? `${view.entries.length} extension(s) · ${view.source === "cache" ? "cached index" : "fresh index"}`
            : "curated index"}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          disabled={loading}
          onClick={() => load(true)}
          style={smallButton("default", loading)}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {loadError && (
        <div
          className="font-sans"
          style={{
            padding: "14px",
            fontSize: "var(--rl-text-xs)",
            color: "var(--color-ink-muted)",
          }}
        >
          Marketplace index unavailable — {loadError}
        </div>
      )}
      {view?.warnings.map((w, i) => (
        <div
          key={i}
          className="font-sans"
          style={{
            padding: "4px 14px",
            fontSize: "10px",
            color: "var(--color-warning, var(--color-ink-muted))",
          }}
        >
          {w}
        </div>
      ))}
      {view && view.entries.length === 0 && !loadError && (
        <div
          className="font-sans"
          style={{
            padding: "18px 14px",
            fontSize: "var(--rl-text-sm)",
            color: "var(--color-ink-muted)",
          }}
        >
          Nothing listed yet. Extensions are curated by pull request — see the
          redline-extensions registry.
        </div>
      )}
      {view?.entries.map((entry) => (
        <BrowseRow
          key={entry.name}
          entry={entry}
          onInstall={(e) => {
            setInstallError(null);
            setConsent(e);
          }}
        />
      ))}
      {consent && (
        <ConsentDialog
          entry={consent}
          busy={installBusy}
          error={installError}
          onConfirm={confirmInstall}
          onCancel={() => {
            if (!installBusy) setConsent(null);
          }}
        />
      )}
    </>
  );
}

/** The Settings-row control: a quiet trigger opening the Extensions dialog
 *  (the same trigger-in-row + hero-dialog language as Agent Seats). */
export function ExtensionsPanel() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"installed" | "browse">("installed");
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    invoke<ExtensionInfo[]>("extensions_list")
      .then((list) => {
        setExtensions(list);
        setLoadError(null);
      })
      .catch((e) => setLoadError(String(e)));
  }, []);

  useEffect(() => {
    if (!open) return;
    refresh();
    // Live updates: the host emits on any status/strike/panel change (and
    // on hot-installs from the Browse tab).
    const un = listen("extensions-changed", refresh);
    return () => {
      void un.then((f) => f());
    };
  }, [open, refresh]);

  const tabButton = (id: "installed" | "browse", label: string) => (
    <button
      type="button"
      onClick={() => setTab(id)}
      className="font-sans"
      style={{
        fontSize: "11px",
        fontWeight: tab === id ? 700 : 400,
        padding: "4px 10px",
        border: "none",
        borderBottom:
          tab === id
            ? "2px solid var(--color-info)"
            : "2px solid transparent",
        background: "transparent",
        color: tab === id ? "var(--color-ink)" : "var(--color-ink-muted)",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Extensions — installed WASM & external extensions"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-sm px-2 py-0.5 font-sans"
        style={{
          fontSize: "11px",
          border: "1px solid var(--color-rule)",
          background: "var(--color-bg-elevated)",
          color: "var(--color-ink)",
          cursor: "pointer",
        }}
      >
        Manage…
      </button>

      {open && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50"
          style={{ background: "var(--color-overlay)" }}
          onClick={() => setOpen(false)}
        >
          <div
            role="dialog"
            aria-label="Extensions"
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
                position: "relative",
                flexShrink: 0,
                padding: "16px 20px 0",
                background:
                  "radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--color-info) 12%, transparent), transparent 60%), linear-gradient(180deg, var(--color-bg-elevated), var(--color-paper))",
              }}
            >
              <div
                className="font-sans flex items-center gap-2"
                style={{
                  fontSize: "11px",
                  fontWeight: 700,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  color: "var(--color-ink-muted)",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: "9px",
                    height: "9px",
                    borderRadius: "2px",
                    background: "var(--color-info)",
                    boxShadow:
                      "0 0 10px color-mix(in srgb, var(--color-info) 70%, transparent)",
                  }}
                />
                Extensions
              </div>
              <div
                className="font-sans"
                style={{
                  marginTop: "6px",
                  fontSize: "var(--rl-text-xs)",
                  color: "var(--color-ink-muted)",
                }}
              >
                Installed under <code>~/.redline/extensions</code>. WASM
                extensions run in-process with per-boot scoped tokens; three
                strikes disable one until relaunch. Enabling applies at the
                next launch.
              </div>
              <div className="flex" style={{ marginTop: "10px" }}>
                {tabButton("installed", "Installed")}
                {tabButton("browse", "Browse")}
              </div>
            </header>
            <div style={{ overflowY: "auto" }}>
              {tab === "installed" && (
                <>
                  {loadError && (
                    <div
                      className="font-sans"
                      style={{
                        padding: "10px 14px",
                        fontSize: "var(--rl-text-xs)",
                        color: "var(--color-danger)",
                      }}
                    >
                      {loadError}
                    </div>
                  )}
                  {!loadError && extensions.length === 0 && (
                    <div
                      className="font-sans"
                      style={{
                        padding: "18px 14px",
                        fontSize: "var(--rl-text-sm)",
                        color: "var(--color-ink-muted)",
                      }}
                    >
                      No extensions installed. Browse the marketplace, or drop
                      a folder with an <code>extension.json</code> under{" "}
                      <code>~/.redline/extensions</code> and relaunch — see{" "}
                      <code>docs/extensions-api.md</code>.
                    </div>
                  )}
                  {extensions.map((info) => (
                    <ExtensionRow key={info.name} info={info} onChanged={refresh} />
                  ))}
                </>
              )}
              {tab === "browse" && <BrowseTab />}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
