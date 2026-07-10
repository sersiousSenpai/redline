// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { describeVerdict, kindLabel, KIND_COLOR } from "./LedgerPane";
import {
  buildTree,
  sortObservations,
  type ClassNode,
  type Observation,
  type TreeNode,
} from "./ClassMemoryPane";
import {
  mirrorIsBehind,
  mirrorSummary,
  type McpConfig,
  type MirrorStatus,
} from "../lib/portability";
import type { SkillStatus } from "../types";

// The one slim, read-mostly memory surface — replacing the four Polis toolbar
// panes (ledger / ClassMemory / Librarian / portability). Memory organizes and
// compacts itself in the background now, so this is for the rare curious glance,
// not a console to manage. Three tabs: the Lake (the hash-chained record, with
// Verify + a manual Forget), the Catalog (the auto-built class tree, read-only),
// and Settings (mirror / export / MCP), folded away.

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

interface LinkView {
  id: number;
  targetKind: string;
  targetId: string;
  label: string | null;
  /** The decision seq that superseded this link's target (null = current). */
  supersededBy: number | null;
}

interface MemoryInspectorProps {
  onClose: () => void;
  activeSessionId?: string | null;
  activeSessionName?: string | null;
}

type Tab = "lake" | "catalog" | "settings";

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function MemoryInspector({
  onClose,
  activeSessionId,
  activeSessionName,
}: MemoryInspectorProps) {
  const [tab, setTab] = useState<Tab>("lake");

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: "var(--color-overlay)" }}
      onClick={onClose}
    >
      <div
        className="rounded-md shadow-xl border"
        style={{
          width: "860px",
          maxWidth: "94vw",
          height: "78vh",
          display: "flex",
          flexDirection: "column",
          borderColor: "var(--color-rule)",
          background: "var(--color-paper)",
          color: "var(--color-ink)",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header + tab strip */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 14px",
            borderBottom: "1px solid var(--color-rule)",
            flex: "0 0 auto",
          }}
        >
          <span className="font-serif font-semibold" style={{ fontSize: 17 }}>
            Memory
          </span>
          <div style={{ display: "flex", gap: 4 }}>
            {(["lake", "catalog", "settings"] as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                style={{
                  fontSize: 12,
                  border: "1px solid var(--color-rule)",
                  borderRadius: 999,
                  padding: "3px 12px",
                  cursor: "pointer",
                  textTransform: "capitalize",
                  background: tab === t ? "var(--color-anchor-bg)" : "var(--color-bg-elevated)",
                  color: tab === t ? "var(--color-anchor-text)" : "var(--color-ink)",
                }}
              >
                {t}
              </button>
            ))}
          </div>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close memory"
            title="Close"
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

        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          {tab === "lake" && <LakeTab />}
          {tab === "catalog" && <CatalogTab />}
          {tab === "settings" && (
            <SettingsTab
              activeSessionId={activeSessionId}
              activeSessionName={activeSessionName}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// --- Lake: the hash-chained record (read + Verify + Forget) ----------------

function LakeTab() {
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [verdict, setVerdict] = useState<ChainVerdict | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [selected, setSelected] = useState<LedgerEvent | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setEvents(await invoke<LedgerEvent[]>("ledger_list_events", { limit: 1000 }));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const un = listen("ledger-changed", () => void load());
    return () => void un.then((f) => f());
  }, [load]);

  // Prompts that have already been compacted/forgotten — their body is a gist.
  const compactedPromptIds = useMemo(
    () =>
      new Set(
        events
          .filter((e) => e.kind === "compaction" && e.promptId != null)
          .map((e) => e.promptId as number),
      ),
    [events],
  );

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

  const forget = useCallback(
    async (promptId: number) => {
      if (!window.confirm(
        "Forget this prompt's words? The fact that it happened stays in the ledger; only the text is released.",
      )) return;
      try {
        await invoke("memory_forget", { promptId });
        await load();
        setBody(await invoke<string | null>("ledger_prompt_body", { id: promptId }));
      } catch (e) {
        setError(String(e));
      }
    },
    [load],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          borderBottom: "1px solid var(--color-rule)",
          flex: "0 0 auto",
          fontSize: 12,
          color: "var(--color-ink-muted)",
        }}
      >
        <span>
          {events.length} event{events.length === 1 ? "" : "s"} · local-only · hash-chained
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
      </div>

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

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div style={{ flex: "1 1 55%", overflowY: "auto", minWidth: 0 }}>
          {events.length === 0 ? (
            <div style={{ padding: 16, color: "var(--color-ink-muted)", fontSize: 13 }}>
              No events yet. Prompts, plan revisions, and decisions appear here as you work.
            </div>
          ) : (
            events.map((ev) => {
              const compacted = ev.promptId != null && compactedPromptIds.has(ev.promptId);
              return (
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
                  {compacted && ev.kind === "prompt" && (
                    <span
                      title="This prompt's body has been compacted to a gist"
                      style={{ fontSize: 11, color: "var(--color-ink-muted)" }}
                    >
                      🗜 gist
                    </span>
                  )}
                  <span style={{ flex: "0 0 auto" }}>{ev.author}</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ color: "var(--color-ink-muted)", flex: "0 0 auto" }}>
                    {fmtTime(ev.ts)}
                  </span>
                  <code style={{ color: "var(--color-ink-muted)", flex: "0 0 auto", fontSize: 11 }}>
                    {ev.entryHash.slice(0, 8)}
                  </code>
                </button>
              );
            })
          )}
        </div>

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
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ fontWeight: 600 }}>
                  {kindLabel(selected.kind)} · seq {selected.seq}
                </div>
                <div style={{ flex: 1 }} />
                {selected.kind === "prompt" &&
                  selected.promptId != null &&
                  !compactedPromptIds.has(selected.promptId) && (
                    <button
                      type="button"
                      onClick={() => forget(selected.promptId as number)}
                      title="Release this prompt's words (keeps the ledger record)"
                      style={{
                        border: "1px solid var(--color-rule)",
                        borderRadius: 4,
                        padding: "2px 8px",
                        fontSize: 11,
                        background: "var(--color-bg-elevated)",
                        color: "var(--color-ink)",
                        cursor: "pointer",
                      }}
                    >
                      Forget
                    </button>
                  )}
              </div>
              <Field label="Author" value={selected.author} />
              <Field label="When" value={fmtTime(selected.ts)} />
              {selected.sessionId && <Field label="Session" value={selected.sessionId} />}
              {selected.refKind && (
                <Field label="References" value={`${selected.refKind} · ${selected.refId ?? ""}`} />
              )}
              <Field label="Payload hash" value={selected.payloadHash} mono />
              <Field label="Entry hash" value={selected.entryHash} mono />
              {body != null && (
                <div>
                  <div style={{ color: "var(--color-ink-muted)", marginBottom: 4 }}>
                    {selected.promptId != null && compactedPromptIds.has(selected.promptId)
                      ? "Gist (original words released; hash retained as proof)"
                      : "Body"}
                  </div>
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
    </div>
  );
}

// --- Catalog: the auto-built class tree (read-only) ------------------------

function CatalogTab() {
  const [nodes, setNodes] = useState<ClassNode[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [links, setLinks] = useState<LinkView[] | null>(null);
  const [observations, setObservations] = useState<Observation[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setNodes(await invoke<ClassNode[]>("classmem_tree"));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const un = listen("classmem-changed", () => void load());
    return () => void un.then((f) => f());
  }, [load]);

  const openNode = useCallback(async (id: string) => {
    setSelected(id);
    setLinks(null);
    setObservations([]);
    try {
      const d = await invoke<{ links: LinkView[]; observations: Observation[] }>(
        "classmem_node",
        { id },
      );
      setLinks(d.links);
      setObservations(d.observations ?? []);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // Supervisor override on the always-on gardener: unfile a link it auto-added.
  // The rollback appends a compensating ledger event (never deletes one), so the
  // hash chain stays intact.
  const revertLink = useCallback(
    async (linkId: number) => {
      try {
        await invoke<boolean>("memory_revert_link", { linkId });
        if (selected) {
          const d = await invoke<{ links: LinkView[] }>("classmem_node", { id: selected });
          setLinks(d.links);
        }
      } catch (e) {
        setError(String(e));
      }
    },
    [selected],
  );

  const tree = buildTree(nodes);

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <div style={{ flex: "1 1 52%", overflowY: "auto", minWidth: 0, borderRight: "1px solid var(--color-rule)" }}>
        <div style={{ padding: "6px 12px", fontSize: 12, color: "var(--color-ink-muted)", borderBottom: "1px solid var(--color-rule)" }}>
          {nodes.length} class{nodes.length === 1 ? "" : "es"} · organized automatically
        </div>
        {error && (
          <div style={{ padding: "6px 12px", color: "var(--color-warning)", fontSize: 13 }}>{error}</div>
        )}
        {tree.length === 0 ? (
          <div style={{ padding: 16, color: "var(--color-ink-muted)", fontSize: 13 }}>
            No classes yet — the keeper builds a class tree over your captured
            prompts on its own once there's enough to organize.
          </div>
        ) : (
          tree.map((n) => (
            <TreeRow key={n.id} node={n} depth={0} selected={selected} onSelect={openNode} />
          ))
        )}
      </div>
      <div style={{ flex: "1 1 48%", overflowY: "auto", padding: 12, fontSize: 13, minWidth: 0 }}>
        {!selected ? (
          <div style={{ color: "var(--color-ink-muted)" }}>
            Select a class to see what it points at in the lake.
          </div>
        ) : links == null ? (
          <div style={{ color: "var(--color-ink-muted)" }}>Loading…</div>
        ) : links.length === 0 && observations.length === 0 ? (
          <div style={{ color: "var(--color-ink-muted)" }}>No links yet — a container class.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {links.map((l) => (
              <div
                key={l.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 8px",
                  border: "1px solid var(--color-rule)",
                  borderRadius: 4,
                }}
              >
                <span
                  style={{
                    flex: "0 0 auto",
                    fontSize: 10,
                    textTransform: "uppercase",
                    color: "var(--color-ink-muted)",
                  }}
                >
                  {l.targetKind}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: l.supersededBy != null ? "var(--color-ink-muted)" : undefined,
                  }}
                >
                  {l.label ?? `#${l.targetId}`}
                </span>
                {l.supersededBy != null && (
                  <span
                    title={`Superseded by ledger event #${l.supersededBy} (kept as history)`}
                    style={{
                      flex: "0 0 auto",
                      fontSize: 10,
                      padding: "0 6px",
                      borderRadius: 999,
                      color: "#fff",
                      background: "#8a8f98",
                    }}
                  >
                    superseded → #{l.supersededBy}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => void revertLink(l.id)}
                  title="Unfile this link (rolls back the gardener; keeps the ledger intact)"
                  style={{
                    flex: "0 0 auto",
                    fontSize: 11,
                    border: "1px solid var(--color-rule)",
                    background: "var(--color-bg-elevated)",
                    color: "var(--color-ink-muted)",
                    borderRadius: 3,
                    padding: "1px 6px",
                    cursor: "pointer",
                  }}
                >
                  Unfile
                </button>
              </div>
            ))}
            {observations.length > 0 && (
              <>
                <div style={{ color: "var(--color-ink-muted)", marginTop: 8, marginBottom: 2 }}>
                  Patterns (agent-derived)
                </div>
                {sortObservations(observations).map((o) => (
                  <div
                    key={o.id}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      padding: "6px 8px",
                      border: "1px dashed var(--color-rule)",
                      borderRadius: 4,
                    }}
                  >
                    <span style={{ flex: "0 0 auto" }} title="Agent-derived pattern">
                      {o.pinned ? "📌" : "🔎"}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      {o.summary}
                      <span style={{ display: "block", fontSize: 11, color: "var(--color-ink-muted)" }}>
                        cites {o.citeSeqs.map((s) => `#${s}`).join(", ")}
                      </span>
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TreeRow({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const isDigest = node.kind === "digest";
  return (
    <>
      <div
        onClick={() => onSelect(node.id)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 12px",
          paddingLeft: 12 + depth * 16,
          borderBottom: "1px solid var(--color-rule)",
          background: selected === node.id ? "var(--color-bg-elevated)" : "transparent",
          cursor: "pointer",
          fontSize: 13,
        }}
      >
        <span>{isDigest ? "🗄️" : depth === 0 ? "📁" : "•"}</span>
        <span style={{ fontWeight: depth === 0 ? 600 : 400 }}>{node.title}</span>
        {node.pinned && <span title="Pinned (anti-decay)">📌</span>}
        {node.linkCount > 0 && (
          <span style={{ color: "var(--color-ink-muted)", fontSize: 11 }}>{node.linkCount}</span>
        )}
      </div>
      {node.children.map((c) => (
        <TreeRow key={c.id} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} />
      ))}
    </>
  );
}

// --- Settings: mirror / export / MCP (folded away) -------------------------

function SettingsTab({
  activeSessionId,
  activeSessionName,
}: {
  activeSessionId?: string | null;
  activeSessionName?: string | null;
}) {
  const [mirror, setMirror] = useState<MirrorStatus | null>(null);
  const [mcp, setMcp] = useState<McpConfig | null>(null);
  const [skill, setSkill] = useState<SkillStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [m, c, s] = await Promise.all([
        invoke<MirrorStatus>("mirror_status"),
        invoke<McpConfig>("mcp_config_snippet"),
        invoke<SkillStatus>("get_skill_status"),
      ]);
      setMirror(m);
      setMcp(c);
      setSkill(s);
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
    run("clear", async () => setMirror(await invoke<MirrorStatus>("set_mirror_dir", { dir: "" })));
  const rebuild = () =>
    run("rebuild", async () => {
      setMirror(await invoke<MirrorStatus>("mirror_rebuild"));
      setMsg("Mirror rebuilt from the ledger.");
    });
  const syncNow = () =>
    run("sync", async () => setMirror(await invoke<MirrorStatus>("mirror_sync")));
  const createVault = () =>
    run("vault", async () => {
      const st = await invoke<MirrorStatus | null>("create_memory_vault");
      if (st) {
        setMirror(st);
        setMsg(`Created a dedicated Redline Memory vault at ${st.dir}.`);
      } else {
        setMsg("Vault creation cancelled.");
      }
    });
  const installSkills = () =>
    run("skills", async () => {
      setSkill(await invoke<SkillStatus>("install_skill"));
      setMsg("Recruit skills installed to ~/.claude/skills.");
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

  const btn: React.CSSProperties = {
    fontSize: 12,
    border: "1px solid var(--color-rule)",
    background: "var(--color-bg-elevated)",
    color: "var(--color-ink)",
    borderRadius: 3,
    padding: "3px 10px",
    cursor: "pointer",
  };
  const sectionTitle: React.CSSProperties = { fontSize: 13, fontWeight: 600, marginBottom: 6 };
  const note: React.CSSProperties = { fontSize: 12, lineHeight: 1.45, color: "var(--color-ink-muted)" };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
      <p style={{ ...note, marginBottom: 16 }}>
        Memory organizes and compacts itself — nothing to configure. These are
        the portability escape hatches: mirror to plain markdown, export a
        self-verifying bundle, or let an external Claude query it over MCP.
      </p>
      {msg && (
        <div
          className="rounded-sm p-2 mb-3"
          style={{ fontSize: 12, border: "1px solid var(--color-rule)", background: "var(--color-bg-elevated)" }}
        >
          {msg}
        </div>
      )}

      {/* Dojo — the recruit-onboarding flow, tying skills + MCP + warm start together */}
      <section className="mb-5">
        <div style={sectionTitle}>🥋 Dojo — train a recruit</div>
        <p style={{ ...note, marginBottom: 8 }}>
          Point an outside model — any <code>claude</code> or local LLM — at your
          memory so it works <em>like you</em>. The recruit grounds{" "}
          <em>classes-first</em> on your lake and its ClassMemory catalog over MCP,
          then fetches what it needs. Three steps:
        </p>
        <ol style={{ ...note, marginBottom: 10, paddingLeft: 18, listStyle: "decimal" }}>
          <li style={{ marginBottom: 4 }}>
            <strong>Install the recruit skills</strong> (the <code>sensei</code>{" "}
            training contract + <code>context-analysis</code> tools).
          </li>
          <li style={{ marginBottom: 4 }}>
            <strong>Wire the MCP snippet</strong> below into the recruit's{" "}
            <code>~/.claude.json</code>.
          </li>
          <li>
            <strong>Hand it a warm start</strong> — <em>Export everything</em>{" "}
            below, or open the dedicated vault as its reference.
          </li>
        </ol>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={installSkills}
            disabled={!!busy || skill?.installed === true}
            style={btn}
          >
            {busy === "skills"
              ? "Installing…"
              : skill?.installed
                ? "Recruit skills installed ✓"
                : skill?.outdated
                  ? "Update recruit skills"
                  : "Install recruit skills"}
          </button>
          <button type="button" onClick={createVault} disabled={!!busy} style={btn}>
            {busy === "vault" ? "Creating…" : "Create Redline Memory vault"}
          </button>
        </div>
      </section>

      <section className="mb-5">
        <div style={sectionTitle}>Portable memory mirror</div>
        <p style={{ ...note, marginBottom: 8 }}>{mirrorSummary(mirror)}</p>
        {mirror?.dir && (
          <p style={{ ...note, marginBottom: 8, wordBreak: "break-all", fontFamily: "var(--font-mono, monospace)" }}>
            {mirror.dir}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={pickDir} disabled={!!busy} style={btn}>
            {busy === "pick" ? "Choosing…" : mirror?.enabled ? "Change folder…" : "Choose folder…"}
          </button>
          {mirror?.enabled && (
            <>
              <button type="button" onClick={syncNow} disabled={!!busy} style={btn}>
                {busy === "sync" ? "Syncing…" : mirrorIsBehind(mirror) ? "Sync now (behind)" : "Sync now"}
              </button>
              <button type="button" onClick={rebuild} disabled={!!busy} style={btn}>
                {busy === "rebuild" ? "Rebuilding…" : "Rebuild mirror"}
              </button>
              <button type="button" onClick={clearDir} disabled={!!busy} style={btn}>
                Turn off
              </button>
            </>
          )}
        </div>
      </section>

      <section className="mb-5">
        <div style={sectionTitle}>Export a verifiable bundle</div>
        <p style={{ ...note, marginBottom: 8 }}>
          A self-contained JSON that re-verifies from itself — the handoff unit
          for another agent, harness, or person.
        </p>
        <div className="flex flex-wrap gap-2">
          {activeSessionId && (
            <button type="button" onClick={() => exportBundle("session", activeSessionId)} disabled={!!busy} style={btn}>
              {busy === "export:session"
                ? "Exporting…"
                : `Export this plan${activeSessionName ? ` (${activeSessionName})` : ""}`}
            </button>
          )}
          <button type="button" onClick={() => exportBundle("full")} disabled={!!busy} style={btn}>
            {busy === "export:full" ? "Exporting…" : "Export everything"}
          </button>
        </div>
      </section>

      <section>
        <div style={sectionTitle}>Query from an external Claude (MCP)</div>
        <p style={{ ...note, marginBottom: 8 }}>
          Add this to <code>~/.claude.json</code> to give any external{" "}
          <code>claude</code> session read-only tools over your Redline memory.
        </p>
        {mcp && (
          <>
            <pre
              style={{
                fontSize: 11,
                fontFamily: "var(--font-mono, monospace)",
                background: "var(--color-bg-elevated)",
                border: "1px solid var(--color-rule)",
                borderRadius: 3,
                padding: 10,
                overflowX: "auto",
                marginBottom: 8,
              }}
            >
              {mcp.snippet}
            </pre>
            <button type="button" onClick={copySnippet} style={btn}>
              {copied ? "Copied ✓" : "Copy snippet"}
            </button>
          </>
        )}
      </section>
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
