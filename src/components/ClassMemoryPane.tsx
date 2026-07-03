// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// The Polis ClassMemory pane (Phase 2): a reviewable, emergent class catalog
// over the Phase 1 lake. Everything the classifier proposes is staged — you
// accept / reject / pin / rename, and review structural reorgs (promote / split
// / merge / collapse) with their digest preview + citations. Nothing enters or
// moves in the tree without your accept.

export interface ClassNode {
  id: string;
  parentId: string | null;
  kind: string; // "node" | "digest"
  title: string;
  summary: string | null;
  projectPath: string | null;
  ipName: string | null;
  status: string; // "proposed" | "accepted"
  pinned: boolean;
  curatedBy: string | null;
  createdAt: number;
  updatedAt: number;
  linkCount: number;
}

export interface TreeNode extends ClassNode {
  children: TreeNode[];
}

interface LinkView {
  id: number;
  nodeId: string;
  targetKind: string;
  targetId: string;
  note: string | null;
  status: string;
  createdAt: number;
  label: string | null;
}

interface Citation {
  seq: number;
  label: string | null;
}

interface ProposalView {
  id: number;
  op: string;
  nodeId: string | null;
  parentId: string | null;
  title: string | null;
  summary: string | null;
  extraJson: string | null;
  rationale: string | null;
  status: string;
  nodeTitle: string | null;
  citations: Citation[];
}

interface ClassRun {
  id: number;
  startedAt: number;
  finishedAt: number | null;
  status: string;
  summary: string | null;
}

/**
 * Build the nested tree from the flat node list (a class is a root — parentId
 * null; a node whose parent is missing is also surfaced as a root so nothing is
 * lost). Pure, so it's unit-tested. Order is preserved from the server (title-
 * sorted), with pinned nodes floated to the top of each sibling group.
 */
export function buildTree(nodes: ClassNode[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const n of nodes) byId.set(n.id, { ...n, children: [] });
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortGroup = (a: TreeNode, b: TreeNode) =>
    Number(b.pinned) - Number(a.pinned) || a.title.localeCompare(b.title);
  const sortRec = (list: TreeNode[]) => {
    list.sort(sortGroup);
    for (const n of list) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

const OP_LABEL: Record<string, string> = {
  promote: "Promote",
  split: "Split",
  merge: "Merge",
  collapse: "Collapse",
};

interface ClassMemoryPaneProps {
  onClose: () => void;
}

export default function ClassMemoryPane({ onClose }: ClassMemoryPaneProps) {
  const [nodes, setNodes] = useState<ClassNode[]>([]);
  const [proposals, setProposals] = useState<ProposalView[]>([]);
  const [run, setRun] = useState<ClassRun | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ links: LinkView[]; children: ClassNode[] } | null>(null);
  const [organizing, setOrganizing] = useState(false);
  const [autoApply, setAutoApply] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [ns, ps, r] = await Promise.all([
        invoke<ClassNode[]>("classmem_tree"),
        invoke<ProposalView[]>("classmem_proposals"),
        invoke<ClassRun | null>("classmem_latest_run"),
      ]);
      setNodes(ns);
      setProposals(ps);
      setRun(r);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    void invoke<boolean>("classmem_get_auto_apply").then(setAutoApply).catch(() => {});
    const un = listen("classmem-changed", () => void load());
    return () => {
      void un.then((f) => f());
    };
  }, [load]);

  const toggleAutoApply = useCallback(async () => {
    const next = !autoApply;
    setAutoApply(next);
    try {
      await invoke("classmem_set_auto_apply", { enabled: next });
    } catch {
      setAutoApply(!next); // revert on failure
    }
  }, [autoApply]);

  const openNode = useCallback(async (id: string) => {
    setSelected(id);
    setDetail(null);
    try {
      const d = await invoke<{ links: LinkView[]; children: ClassNode[] }>("classmem_node", { id });
      setDetail({ links: d.links, children: d.children });
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const organize = useCallback(async () => {
    setOrganizing(true);
    setNotice(null);
    try {
      const res = await invoke<{ summary: string }>("classmem_organize");
      setNotice(res.summary);
    } catch (e) {
      setError(String(e));
    } finally {
      setOrganizing(false);
    }
  }, []);

  const act = useCallback(
    async (cmd: string, args: Record<string, unknown>) => {
      try {
        await invoke(cmd, args);
        if (selected) void openNode(selected);
      } catch (e) {
        setError(String(e));
      }
    },
    [selected, openNode],
  );

  const tree = buildTree(nodes);

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
        <span style={{ fontWeight: 600 }}>🧠 ClassMemory</span>
        <span style={{ color: "var(--color-ink-muted)", fontSize: 12 }}>
          {nodes.length} node{nodes.length === 1 ? "" : "s"}
          {proposals.length > 0 ? ` · ${proposals.length} to review` : ""}
        </span>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={organize}
          disabled={organizing}
          title={
            autoApply
              ? "Organize new lake items into the tree (applied directly; curate below if you like)"
              : "Classify new lake items and stage proposals for review"
          }
          style={{
            border: "1px solid var(--color-rule)",
            borderRadius: 4,
            padding: "3px 10px",
            background: "var(--color-bg-elevated)",
            color: "var(--color-ink)",
            cursor: organizing ? "wait" : "pointer",
          }}
        >
          {organizing ? "Organizing…" : "Organize"}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close ClassMemory"
          title="Close ClassMemory"
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

      {(notice || (run && run.summary)) && (
        <div
          style={{
            padding: "6px 12px",
            fontSize: 13,
            background: "rgba(79,140,255,0.10)",
            color: "var(--color-ink)",
            borderBottom: "1px solid var(--color-rule)",
          }}
        >
          {notice ?? (run ? `Last run: ${run.summary}` : "")}
        </div>
      )}
      {error && (
        <div style={{ padding: "6px 12px", color: "var(--color-warning)", fontSize: 13 }}>{error}</div>
      )}

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Tree + structural proposals */}
        <div style={{ flex: "1 1 52%", overflowY: "auto", minWidth: 0, borderRight: "1px solid var(--color-rule)" }}>
          {tree.length === 0 ? (
            <div style={{ padding: 16, color: "var(--color-ink-muted)", fontSize: 13 }}>
              No classes yet. Click <b>Organize</b> to seed one class per repo and
              let the orchestrator build a tree over your captured prompts
              {autoApply ? " — it organizes on its own; curate here only if you want." : " for you to review."}
            </div>
          ) : (
            tree.map((n) => (
              <TreeRow
                key={n.id}
                node={n}
                depth={0}
                selected={selected}
                onSelect={openNode}
                onAct={act}
              />
            ))
          )}

          {proposals.length > 0 && (
            <div style={{ borderTop: "1px solid var(--color-rule)", marginTop: 8 }}>
              <div style={{ padding: "8px 12px 4px", fontWeight: 600, fontSize: 13 }}>
                Reorganizations to review
              </div>
              {proposals.map((p) => (
                <ProposalCard key={p.id} p={p} onAct={act} />
              ))}
            </div>
          )}
        </div>

        {/* Detail: the selected node's links (leaf → linked lake items) */}
        <div style={{ flex: "1 1 48%", overflowY: "auto", padding: 12, fontSize: 13, minWidth: 0 }}>
          {!selected ? (
            <div style={{ color: "var(--color-ink-muted)" }}>
              Select a class to see what it points at in the lake.
            </div>
          ) : detail == null ? (
            <div style={{ color: "var(--color-ink-muted)" }}>Loading…</div>
          ) : detail.links.length === 0 && detail.children.length === 0 ? (
            <div style={{ color: "var(--color-ink-muted)" }}>
              No links yet — a container class.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {detail.children.length > 0 && (
                <div style={{ color: "var(--color-ink-muted)", marginBottom: 2 }}>
                  {detail.children.length} sub-class{detail.children.length === 1 ? "" : "es"}
                </div>
              )}
              {detail.links.map((l) => (
                <div
                  key={l.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 8px",
                    border: "1px solid var(--color-rule)",
                    borderRadius: 4,
                    background:
                      l.status === "proposed" ? "rgba(224,145,58,0.08)" : "transparent",
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
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {l.label ?? `#${l.targetId}`}
                  </span>
                  {l.status === "proposed" && (
                    <>
                      <MiniBtn label="✓" title="Accept link" onClick={() => act("classmem_accept_link", { linkId: l.id })} />
                      <MiniBtn label="✕" title="Reject link" onClick={() => act("classmem_reject_link", { linkId: l.id })} />
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Footer: how Organize behaves */}
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
          <input type="checkbox" checked={autoApply} onChange={toggleAutoApply} />
          Auto-organize (apply without review)
        </label>
        <div style={{ flex: 1 }} />
        <span>Every change is recorded in the ledger · reversible</span>
      </div>
    </div>
  );
}

type ActFn = (cmd: string, args: Record<string, unknown>) => void;

function TreeRow({
  node,
  depth,
  selected,
  onSelect,
  onAct,
}: {
  node: TreeNode;
  depth: number;
  selected: string | null;
  onSelect: (id: string) => void;
  onAct: ActFn;
}) {
  const isProposed = node.status === "proposed";
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
        <span
          style={{
            fontSize: 10,
            padding: "0 6px",
            borderRadius: 999,
            color: "#fff",
            background: isProposed ? "#e0913a" : "#2fae66",
          }}
        >
          {isProposed ? "proposed" : "accepted"}
        </span>
        {node.linkCount > 0 && (
          <span style={{ color: "var(--color-ink-muted)", fontSize: 11 }}>{node.linkCount}</span>
        )}
        <div style={{ flex: 1 }} />
        {isProposed ? (
          <>
            <MiniBtn label="✓" title="Accept class" onClick={() => onAct("classmem_accept_node", { id: node.id })} />
            <MiniBtn label="✕" title="Reject class" onClick={() => onAct("classmem_reject_node", { id: node.id })} />
          </>
        ) : (
          <>
            <MiniBtn
              label={node.pinned ? "📌" : "📍"}
              title={node.pinned ? "Unpin" : "Pin (anti-decay)"}
              onClick={() => onAct("classmem_pin_node", { id: node.id, pinned: !node.pinned })}
            />
            <MiniBtn
              label="✎"
              title="Rename class"
              onClick={() => {
                const title = window.prompt("Rename class", node.title);
                if (title && title.trim()) onAct("classmem_rename_node", { id: node.id, title: title.trim() });
              }}
            />
          </>
        )}
      </div>
      {node.children.map((c) => (
        <TreeRow key={c.id} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} onAct={onAct} />
      ))}
    </>
  );
}

function ProposalCard({ p, onAct }: { p: ProposalView; onAct: ActFn }) {
  return (
    <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--color-rule)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            padding: "1px 7px",
            borderRadius: 999,
            color: "#fff",
            background: "#7c5cff",
          }}
        >
          {OP_LABEL[p.op] ?? p.op}
        </span>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{p.nodeTitle ?? p.title ?? ""}</span>
        <div style={{ flex: 1 }} />
        <MiniBtn label="✓" title="Accept" onClick={() => onAct("classmem_accept_proposal", { id: p.id })} />
        <MiniBtn label="✕" title="Reject" onClick={() => onAct("classmem_reject_proposal", { id: p.id })} />
      </div>
      {p.rationale && (
        <div style={{ color: "var(--color-ink-muted)", fontSize: 12, marginTop: 4 }}>{p.rationale}</div>
      )}
      {p.op === "collapse" && (
        <div style={{ marginTop: 6 }}>
          {p.summary && (
            <div
              style={{
                fontSize: 12,
                fontStyle: "italic",
                padding: "6px 8px",
                background: "var(--color-bg-elevated)",
                borderRadius: 4,
              }}
            >
              “{p.summary}”
            </div>
          )}
          {p.citations.length > 0 && (
            <div style={{ marginTop: 4, fontSize: 11, color: "var(--color-ink-muted)" }}>
              Cites {p.citations.length} ledger row{p.citations.length === 1 ? "" : "s"}:
              <ul style={{ margin: "2px 0 0 16px", padding: 0 }}>
                {p.citations.map((c) => (
                  <li key={c.seq}>
                    #{c.seq} {c.label ? `— ${c.label}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MiniBtn({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{
        border: "1px solid var(--color-rule)",
        borderRadius: 4,
        background: "var(--color-bg-elevated)",
        color: "var(--color-ink)",
        cursor: "pointer",
        fontSize: 11,
        lineHeight: 1.2,
        padding: "1px 6px",
      }}
    >
      {label}
    </button>
  );
}
