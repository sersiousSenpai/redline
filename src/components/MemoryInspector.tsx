// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { usePersistedState } from "../theme/usePersistedState";

import {
  describeVerdict,
  fmtTime,
  kindLabel,
  KIND_COLOR,
  type ChainVerdict,
  type LedgerEvent,
} from "../lib/ledgerKinds";
import {
  buildTree,
  countDescendants,
  sortObservations,
  type ClassNode,
  type LinkView,
  type Observation,
  type TreeNode,
} from "../lib/classTree";
import {
  mirrorIsBehind,
  mirrorSummary,
  type McpConfig,
  type MirrorStatus,
} from "../lib/portability";
import type { SkillStatus } from "../types";

// The pill's quick inspector — an ephemeral, read-mostly modal for the fast
// glance (the full Memory surface, `MemorySurface.tsx`, is the main-pane home).
// Three tabs: the Lake (the hash-chained record, with Verify + a manual
// Forget), the Catalog (the auto-built class tree, read-only), and Settings
// (mirror / export / MCP), folded away.

interface MemoryInspectorProps {
  onClose: () => void;
  activeSessionId?: string | null;
  activeSessionName?: string | null;
}

type Tab = "lake" | "catalog" | "settings";

export function MemoryInspector({
  onClose,
  activeSessionId,
  activeSessionName,
}: MemoryInspectorProps) {
  const [tab, setTab] = useState<Tab>("lake");
  // Deep catalog trees and long lake prompts need room; the maximize state
  // persists so a user who always wants the big view keeps it.
  const [maximized, setMaximized] = usePersistedState(
    "redline.memory.maximized",
    false,
  );

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: "var(--color-overlay)" }}
      onClick={onClose}
    >
      <div
        className="rounded-md shadow-xl border"
        style={{
          width: maximized ? "98vw" : "min(1180px, 94vw)",
          height: maximized ? "94vh" : "86vh",
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
            onClick={() => setMaximized((v) => !v)}
            aria-label={maximized ? "Restore size" : "Maximize"}
            aria-pressed={maximized}
            title={maximized ? "Restore size" : "Maximize"}
            style={{
              border: "none",
              background: "transparent",
              color: "var(--color-ink-muted)",
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            {maximized ? "⤡" : "⤢"}
          </button>
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

/** Compact model chip text: the stored id minus the family prefix and any
 *  trailing date stamp — "claude-haiku-4-5-20251001" reads "haiku-4-5". The
 *  full id stays in the row title and the detail pane. */
function shortModel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-20\d{6}$/, "");
}

function LakeTab() {
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [verdict, setVerdict] = useState<ChainVerdict | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [selected, setSelected] = useState<LedgerEvent | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // promptId → the model that received it (ground truth: seat flag or
  // transcript backfill; prompts with no recorded model are simply absent).
  const [models, setModels] = useState<Map<number, string>>(() => new Map());
  const [modelFilter, setModelFilter] = useState("");

  const load = useCallback(async () => {
    try {
      setEvents(await invoke<LedgerEvent[]>("ledger_list_events", { limit: 1000 }));
      setModels(new Map(await invoke<[number, string][]>("ledger_prompt_models")));
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

  // The rows on screen: the whole chain, or — under a model filter — only the
  // prompt events that model received.
  const shownEvents = useMemo(
    () =>
      modelFilter
        ? events.filter(
            (e) => e.promptId != null && models.get(e.promptId) === modelFilter,
          )
        : events,
    [events, models, modelFilter],
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
        {models.size > 0 && (
          <select
            value={modelFilter}
            onChange={(e) => setModelFilter(e.target.value)}
            title="Show only prompts a specific model received"
            style={{
              border: "1px solid var(--color-rule)",
              borderRadius: 4,
              padding: "3px 6px",
              fontSize: 12,
              background: "var(--color-bg-elevated)",
              color: "var(--color-ink)",
              cursor: "pointer",
            }}
          >
            <option value="">All models</option>
            {[...new Set(models.values())].sort().map((m) => (
              <option key={m} value={m}>
                {shortModel(m)}
              </option>
            ))}
          </select>
        )}
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
          {shownEvents.length === 0 ? (
            <div style={{ padding: 16, color: "var(--color-ink-muted)", fontSize: 13 }}>
              {modelFilter
                ? "No prompts recorded for that model."
                : "No events yet. Prompts, plan revisions, and decisions appear here as you work."}
            </div>
          ) : (
            shownEvents.map((ev) => {
              const compacted = ev.promptId != null && compactedPromptIds.has(ev.promptId);
              const model = ev.promptId != null ? models.get(ev.promptId) : undefined;
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
                  {model && (
                    <span
                      title={`Received by ${model}`}
                      style={{
                        flex: "0 0 auto",
                        padding: "0 6px",
                        borderRadius: 999,
                        fontSize: 10,
                        border: "1px solid var(--color-rule)",
                        color: "var(--color-ink-muted)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {shortModel(model)}
                    </span>
                  )}
                  {/* The one variable-width field: shrink + ellipsize rather
                      than clipping the fixed-width fields after it. */}
                  <span
                    style={{
                      flex: "0 1 auto",
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={ev.author}
                  >
                    {ev.author}
                  </span>
                  <span style={{ flex: 1 }} />
                  <span
                    style={{
                      color: "var(--color-ink-muted)",
                      flex: "0 0 auto",
                      whiteSpace: "nowrap",
                    }}
                  >
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
              {selected.promptId != null && models.has(selected.promptId) && (
                <Field
                  label="Model"
                  value={models.get(selected.promptId) as string}
                />
              )}
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
                  {/* No inner height cap — the right column already scrolls,
                      so the body can use all of it. */}
                  <pre
                    style={{
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      background: "var(--color-bg-elevated)",
                      padding: 8,
                      borderRadius: 4,
                      margin: 0,
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
  // Collapsed branch ids. Everything starts expanded (nothing hidden by
  // default); the chevrons + Collapse all make deep trees navigable.
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());

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

  const tree = buildTree(nodes);

  const toggleBranch = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const collapseAll = () => {
    const withChildren = new Set<string>();
    const walk = (list: TreeNode[]) => {
      for (const n of list) {
        if (n.children.length > 0) withChildren.add(n.id);
        walk(n.children);
      }
    };
    walk(tree);
    setCollapsedIds(withChildren);
  };

  const treeCtlBtn: React.CSSProperties = {
    border: "1px solid var(--color-rule)",
    background: "transparent",
    color: "var(--color-ink-muted)",
    borderRadius: 3,
    padding: "0 6px",
    fontSize: 11,
    cursor: "pointer",
  };

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      {/* Left column: the Expand/Collapse toolbar stays OUTSIDE the scroll
          container so it's always reachable however deep the tree scrolls. */}
      <div
        style={{
          flex: "1 1 52%",
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          borderRight: "1px solid var(--color-rule)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 12px",
            fontSize: 12,
            color: "var(--color-ink-muted)",
            borderBottom: "1px solid var(--color-rule)",
            flex: "0 0 auto",
          }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>
            {nodes.length} class{nodes.length === 1 ? "" : "es"} · organized automatically
          </span>
          <button style={treeCtlBtn} onClick={() => setCollapsedIds(new Set())} title="Expand every branch">
            Expand all
          </button>
          <button style={treeCtlBtn} onClick={collapseAll} title="Collapse to the root classes">
            Collapse all
          </button>
        </div>
        {error && (
          <div style={{ padding: "6px 12px", color: "var(--color-warning)", fontSize: 13, flex: "0 0 auto" }}>{error}</div>
        )}
        <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
        {tree.length === 0 ? (
          <div style={{ padding: 16, color: "var(--color-ink-muted)", fontSize: 13 }}>
            No classes yet — the keeper builds a class tree over your captured
            prompts on its own once there's enough to organize.
          </div>
        ) : (
          tree.map((n) => (
            <ClassTreeRow
              key={n.id}
              node={n}
              depth={0}
              selected={selected}
              onSelect={openNode}
              collapsedIds={collapsedIds}
              onToggle={toggleBranch}
            />
          ))
        )}
        </div>
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
                      🔎
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

/**
 * One class-tree row (chevron, depth rails, link-count/"n inside" badges).
 * Exported: the Memory surface's Catalog tab renders the same rows (the
 * SettingsTab precedent — one implementation, two mounts). Read-only in both
 * since B3: the gardener curates, and a run is what a person undoes.
 */
export function ClassTreeRow({
  node,
  depth,
  selected,
  onSelect,
  collapsedIds,
  onToggle,
}: {
  node: TreeNode;
  depth: number;
  selected: string | null;
  onSelect: (id: string) => void;
  collapsedIds: Set<string>;
  onToggle: (id: string) => void;
}) {
  const isDigest = node.kind === "digest";
  const hasChildren = node.children.length > 0;
  const collapsed = hasChildren && collapsedIds.has(node.id);
  return (
    <>
      <div
        onClick={() => onSelect(node.id)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 12px 5px 8px",
          borderBottom: "1px solid var(--color-rule)",
          background: selected === node.id ? "var(--color-bg-elevated)" : "transparent",
          cursor: "pointer",
          fontSize: 13,
        }}
      >
        {/* Depth rails — one hairline per ancestor level, so nesting reads
            at a glance even in a deep tree. 12px per level: deep branches
            keep most of the row width for their titles. */}
        {Array.from({ length: depth }, (_, i) => (
          <span
            key={i}
            aria-hidden
            style={{
              flex: "0 0 8px",
              alignSelf: "stretch",
              borderLeft: "1px solid var(--color-rule)",
              marginLeft: 4,
            }}
          />
        ))}
        {hasChildren ? (
          <button
            aria-label={collapsed ? `Expand ${node.title}` : `Collapse ${node.title}`}
            aria-expanded={!collapsed}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.id);
            }}
            style={{
              flex: "0 0 16px",
              border: "none",
              background: "transparent",
              color: "var(--color-ink-muted)",
              fontSize: 10,
              padding: 0,
              cursor: "pointer",
            }}
          >
            {collapsed ? "▸" : "▾"}
          </button>
        ) : (
          <span aria-hidden style={{ flex: "0 0 16px" }} />
        )}
        <span style={{ flexShrink: 0 }}>
          {isDigest ? "🗄️" : hasChildren ? (collapsed ? "📁" : "📂") : "•"}
        </span>
        {/* The title claims all remaining width and ellipsizes; badges after
            it never shrink. The native tooltip carries the full text. */}
        <span
          title={node.title}
          style={{
            flex: "1 1 auto",
            fontWeight: depth === 0 ? 600 : 400,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {node.title}
        </span>
        {node.linkCount > 0 && (
          <span
            style={{
              color: "var(--color-ink-muted)",
              fontSize: 11,
              flexShrink: 0,
            }}
          >
            {node.linkCount}
          </span>
        )}
        {collapsed && (
          <span
            title="Hidden nested classes"
            style={{
              flexShrink: 0,
              fontSize: 10.5,
              color: "var(--color-ink-muted)",
              border: "1px solid var(--color-rule)",
              borderRadius: 999,
              padding: "0 7px",
              whiteSpace: "nowrap",
            }}
          >
            {countDescendants(node)} inside
          </span>
        )}
      </div>
      {!collapsed &&
        node.children.map((c) => (
          <ClassTreeRow
            key={c.id}
            node={c}
            depth={depth + 1}
            selected={selected}
            onSelect={onSelect}
            collapsedIds={collapsedIds}
            onToggle={onToggle}
          />
        ))}
    </>
  );
}

// --- Settings: mirror / export / MCP (folded away) -------------------------
// Exported: the Memory surface's Health tab renders the same sections (one
// implementation, two mounts — inspector modal + main surface).

export function SettingsTab({
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
            <strong>Point the recruit at the daemon's MCP</strong> — the{" "}
            <code>claude mcp add</code> line below, or the snippet into its{" "}
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
          Redline serves MCP itself while it runs — streamable HTTP at{" "}
          <code>{mcp?.url ?? "http://127.0.0.1:7676/mcp"}</code>, loopback only,
          read-only tools (<code>memory_search</code> first). Any external{" "}
          <code>claude</code> session adds it with one line, or with the
          snippet in <code>~/.claude.json</code>. No binary to install.
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
              {mcp.command}
            </pre>
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
