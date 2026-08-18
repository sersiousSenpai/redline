// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Bot,
  Copy,
  Folder,
  Pencil,
  Play,
  Plus,
  Star,
  Trash2,
  X,
} from "lucide-react";

import {
  cancelDraftTurn,
  createAgent,
  deleteAgent,
  discardPreview,
  duplicateAgent,
  filterAgents,
  listAgents,
  moveAgent,
  previewAgent,
  runAgent,
  runSummary,
  shelfOrder,
  starAgent,
  updateAgent,
  type HarnessAgent,
} from "../lib/agentShelf";
import { loadShelf, type BookshelfFolder } from "../lib/bookshelf";
import { compactEditPreview } from "../editor/wordDiff";
import type { DraftSuggestionRow } from "../editor/drafterSuggestions";
import { Panel, placeUnder } from "./popover";
import type { CSSProperties } from "react";

// The agent shelf (harness program A3): the user's OWN agents — each one a
// name plus a plain-English instruction — run on demand against the document
// open in the Prompt Drafter. Rendered as a sheet over the document, like the
// Bookshelf, and written for someone who cannot code: the builder is two
// fields, the preview rehearses on a COPY, and every run's output lands as
// tracked changes the user accepts or rejects in place (invariant #7 — this
// surface can never auto-apply anything).

interface AgentShelfProps {
  /** The open document agents run against. */
  draftId: string;
  /** The open document's project (rides out as the run's cwd). */
  projectPath: string | null;
  /** The LIVE editor markdown (sidecars on), or undefined when the pane is
   *  not mounted — the backend then falls back to the stored mirror. */
  getLiveMarkdown: () => string | undefined;
  /** A run is live — the host closes the sheet and watches for the agent's
   *  closing line. */
  onRunStarted: (agentName: string) => void;
  onClose: () => void;
}

type View =
  | { kind: "list" }
  | { kind: "builder"; editing: HarnessAgent | null };

interface PreviewState {
  id: string;
  phase: "running" | "done" | "error";
  proposals: DraftSuggestionRow[];
  note: string | null;
}

const OP_LABEL: Record<string, string> = {
  append: "Adds new content at the end",
  replace_block: "Rewrites a block",
  insert_after: "Inserts after a block",
  delete_block: "Removes a block",
};

function whenLabel(ts: number | null): string {
  if (!ts) return "";
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days <= 0) return "today";
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function AgentShelf({
  draftId,
  projectPath,
  getLiveMarkdown,
  onRunStarted,
  onClose,
}: AgentShelfProps) {
  const [agents, setAgents] = useState<HarnessAgent[]>([]);
  const [folders, setFolders] = useState<BookshelfFolder[]>([]);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>({ kind: "list" });
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listAgents()
      .then(setAgents)
      .catch((e) => setError(String(e)));
    // Folders come from the Bookshelf — the drafter area's one folder
    // namespace, which the A2 rows deliberately reuse.
    loadShelf()
      .then((s) => setFolders(s.folders))
      .catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);

  const act = useCallback(
    (fn: () => Promise<unknown>) => {
      setError(null);
      void fn()
        .then(refresh)
        .catch((e) => setError(String(e)));
    },
    [refresh],
  );

  const run = useCallback(
    (a: HarnessAgent) => {
      setError(null);
      runAgent({
        agentId: a.agentId,
        draftId,
        draftMarkdown: getLiveMarkdown() ?? null,
        projectPath,
        cwd: projectPath,
      })
        .then(() => onRunStarted(a.name))
        .catch((e) => setError(String(e)));
    },
    [draftId, getLiveMarkdown, projectPath, onRunStarted],
  );

  const visible = useMemo(
    () => shelfOrder(filterAgents(agents, query)),
    [agents, query],
  );
  const folderName = useCallback(
    (id: string | null) =>
      id ? (folders.find((f) => f.folderId === id)?.name ?? null) : null,
    [folders],
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      style={{ background: "var(--color-paper)" }}
    >
      <div
        data-no-drag="true"
        className="flex items-center gap-2 px-4 py-2"
        style={{
          borderBottom: "1px solid var(--color-rule)",
          background: "var(--color-paper)",
        }}
      >
        <Bot size={15} strokeWidth={2} />
        <span style={{ fontSize: "13px", fontWeight: 600 }}>Your agents</span>
        <span style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}>
          {agents.length === 0
            ? "run against the open document"
            : `${agents.length} — each runs against the open document`}
        </span>
        {view.kind === "list" && (
          <>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="ml-auto rounded-sm px-2 py-1"
              style={{
                fontSize: "11.5px",
                width: "160px",
                border: "1px solid var(--color-rule)",
                background: "var(--color-bg-elevated)",
                color: "var(--color-ink)",
              }}
            />
            <button
              type="button"
              className="flex items-center gap-1 rounded-sm px-2 py-1"
              onClick={() => setView({ kind: "builder", editing: null })}
              style={{
                fontSize: "11.5px",
                border: "1px solid var(--color-rule)",
                background: "var(--color-bg-elevated)",
                color: "var(--color-ink)",
                cursor: "pointer",
              }}
            >
              <Plus size={13} /> New agent
            </button>
          </>
        )}
        <button
          type="button"
          onClick={onClose}
          className={view.kind === "list" ? "" : "ml-auto"}
          title="Back to the open document"
          style={{ color: "var(--color-ink-muted)", cursor: "pointer" }}
        >
          <X size={15} />
        </button>
      </div>

      {error && (
        <div
          className="mx-4 mt-2 rounded-sm px-3 py-1.5"
          style={{
            fontSize: "11.5px",
            border: "1px solid var(--color-rule)",
            background: "var(--color-bg-elevated)",
            color: "var(--color-ink)",
          }}
        >
          {error}
        </div>
      )}

      {view.kind === "list" ? (
        <div className="rl-thin-scroll-y min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {visible.length === 0 ? (
            <div
              className="mx-auto max-w-md py-10 text-center"
              style={{ color: "var(--color-ink-muted)", fontSize: "12.5px" }}
            >
              {agents.length === 0 ? (
                <>
                  <p style={{ marginBottom: "6px" }}>
                    An agent is a standing instruction, written in plain
                    English — "tighten every heading", "check the plan for
                    missing tests". Run one and its edits appear in your
                    document as tracked changes you accept or reject.
                  </p>
                  <button
                    type="button"
                    onClick={() => setView({ kind: "builder", editing: null })}
                    className="rl-fd-fix"
                    style={{ marginTop: "4px" }}
                  >
                    Write your first agent
                  </button>
                </>
              ) : (
                "Nothing matches that search."
              )}
            </div>
          ) : (
            visible.map((a) => (
              <AgentRow
                key={a.agentId}
                agent={a}
                folderLabel={folderName(a.folderId)}
                folders={folders}
                confirming={confirmDelete === a.agentId}
                onRun={() => run(a)}
                onEdit={() => setView({ kind: "builder", editing: a })}
                onStar={() => act(() => starAgent(a.agentId, !a.starred))}
                onDuplicate={() => act(() => duplicateAgent(a.agentId))}
                onMove={(fid) => act(() => moveAgent(a.agentId, fid))}
                onAskDelete={() =>
                  setConfirmDelete(confirmDelete === a.agentId ? null : a.agentId)
                }
                onDelete={() => {
                  setConfirmDelete(null);
                  act(() => deleteAgent(a.agentId));
                }}
              />
            ))
          )}
        </div>
      ) : (
        <AgentBuilder
          editing={view.editing}
          draftId={draftId}
          projectPath={projectPath}
          getLiveMarkdown={getLiveMarkdown}
          onSaved={() => {
            refresh();
            setView({ kind: "list" });
          }}
          onCancel={() => setView({ kind: "list" })}
        />
      )}
    </div>
  );
}

function AgentRow({
  agent,
  folderLabel,
  folders,
  confirming,
  onRun,
  onEdit,
  onStar,
  onDuplicate,
  onMove,
  onAskDelete,
  onDelete,
}: {
  agent: HarnessAgent;
  folderLabel: string | null;
  folders: BookshelfFolder[];
  confirming: boolean;
  onRun: () => void;
  onEdit: () => void;
  onStar: () => void;
  onDuplicate: () => void;
  onMove: (folderId: string | null) => void;
  onAskDelete: () => void;
  onDelete: () => void;
}) {
  const [folderAt, setFolderAt] = useState<CSSProperties | null>(null);
  const iconBtn = {
    display: "inline-flex",
    color: "var(--color-ink-muted)",
    cursor: "pointer",
  } as const;
  return (
    <div
      className="group flex items-start gap-2 rounded-sm px-2 py-2"
      style={{ borderBottom: "1px solid var(--color-rule)" }}
    >
      <button
        type="button"
        onClick={onStar}
        title={agent.starred ? "Unstar" : "Star — starred agents sort first"}
        style={{ ...iconBtn, marginTop: "2px" }}
      >
        <Star
          size={14}
          fill={agent.starred ? "var(--color-anchor-text)" : "none"}
          color={
            agent.starred ? "var(--color-anchor-text)" : "var(--color-ink-muted)"
          }
        />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span
            className="truncate"
            style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-ink)" }}
          >
            {agent.name}
          </span>
          <span style={{ fontSize: "10.5px", color: "var(--color-ink-muted)" }}>
            {runSummary(agent)}
            {agent.lastRunAt ? ` · ${whenLabel(agent.lastRunAt)}` : ""}
            {folderLabel ? ` · ${folderLabel}` : ""}
          </span>
        </div>
        <div
          className="truncate"
          style={{ fontSize: "11.5px", color: "var(--color-ink-muted)" }}
          title={agent.instruction}
        >
          {agent.instruction}
        </div>
      </div>
      <div className="flex items-center gap-1.5" style={{ marginTop: "2px" }}>
        {confirming ? (
          <>
            <span style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}>
              Delete this agent?
            </span>
            <button type="button" onClick={onDelete} className="rl-fd-fix">
              Delete
            </button>
            <button type="button" onClick={onAskDelete} className="rl-fd-quiet">
              Keep
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onRun}
              title="Run against the open document — edits land as tracked changes"
              className="flex items-center gap-1 rounded-sm px-2 py-0.5"
              style={{
                fontSize: "11px",
                border: "1px solid var(--color-rule)",
                background: "var(--color-anchor-bg)",
                color: "var(--color-anchor-text)",
                cursor: "pointer",
              }}
            >
              <Play size={11} /> Run
            </button>
            <button
              type="button"
              onClick={onEdit}
              title="Edit this agent"
              className="opacity-0 group-hover:opacity-100"
              style={iconBtn}
            >
              <Pencil size={13} />
            </button>
            <button
              type="button"
              onClick={onDuplicate}
              title="Duplicate this agent"
              className="opacity-0 group-hover:opacity-100"
              style={iconBtn}
            >
              <Copy size={13} />
            </button>
            {folders.length > 0 && (
              <button
                type="button"
                onClick={(e) =>
                  setFolderAt(placeUnder(e.currentTarget, "left", 180))
                }
                title="Move to a folder"
                className="opacity-0 group-hover:opacity-100"
                style={iconBtn}
              >
                <Folder size={13} />
              </button>
            )}
            <button
              type="button"
              onClick={onAskDelete}
              title="Delete this agent"
              className="opacity-0 group-hover:opacity-100"
              style={iconBtn}
            >
              <Trash2 size={13} />
            </button>
          </>
        )}
      </div>
      {folderAt && (
        <>
          {/* Click-away: covers the sheet (the panel itself portals to body
              and paints above it). */}
          <div
            style={{ position: "fixed", inset: 0, zIndex: 58 }}
            onClick={() => setFolderAt(null)}
          />
          <Panel
            label="Move to folder"
            panelRef={() => {}}
            style={{ ...folderAt, width: "180px" }}
          >
            <div className="flex flex-col p-1">
              {[{ folderId: null as string | null, name: "No folder" }]
                .concat(folders)
                .map((f) => (
                  <button
                    key={f.folderId ?? "none"}
                    type="button"
                    className="rounded-sm px-2 py-1 text-left"
                    style={{
                      fontSize: "11.5px",
                      color: "var(--color-ink)",
                      background:
                        f.folderId === agent.folderId
                          ? "var(--color-bg-elevated)"
                          : "transparent",
                      cursor: "pointer",
                    }}
                    onClick={() => {
                      setFolderAt(null);
                      onMove(f.folderId);
                    }}
                  >
                    {f.name}
                  </button>
                ))}
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}

/** The builder: two fields and a rehearsal. Written for someone who cannot
 *  code — the instruction is the agent, and "Preview on a copy" shows what it
 *  would do to the open document without touching it. */
function AgentBuilder({
  editing,
  draftId,
  projectPath,
  getLiveMarkdown,
  onSaved,
  onCancel,
}: {
  editing: HarnessAgent | null;
  draftId: string;
  projectPath: string | null;
  getLiveMarkdown: () => string | undefined;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? "");
  const [instruction, setInstruction] = useState(editing?.instruction ?? "");
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previewIdRef = useRef<string | null>(null);

  const discard = useCallback(() => {
    const id = previewIdRef.current;
    previewIdRef.current = null;
    if (!id) return;
    // Cancel before delete: a rehearsal thrown away mid-run must not leave a
    // headless agent working against a row that no longer exists.
    void cancelDraftTurn(id)
      .catch(() => {})
      .then(() => discardPreview(id))
      .catch(() => {});
  }, []);
  // The copy dies with the builder, however the builder is left.
  useEffect(() => discard, [discard]);

  useEffect(() => {
    if (!preview || preview.phase !== "running") return;
    let alive = true;
    const subs = [
      listen<DraftSuggestionRow>("drafter-suggestion", (e) => {
        if (!alive || e.payload.draftId !== preview.id) return;
        setPreview((p) =>
          p && p.id === preview.id
            ? { ...p, proposals: [...p.proposals, e.payload] }
            : p,
        );
      }),
      listen<{ draftId: string; body: string }>("draft-chat-done", (e) => {
        if (!alive || e.payload.draftId !== preview.id) return;
        setPreview((p) =>
          p && p.id === preview.id
            ? { ...p, phase: "done", note: e.payload.body.trim() || null }
            : p,
        );
      }),
      listen<{ draftId: string; error: string }>("draft-chat-error", (e) => {
        if (!alive || e.payload.draftId !== preview.id) return;
        setPreview((p) =>
          p && p.id === preview.id
            ? { ...p, phase: "error", note: e.payload.error }
            : p,
        );
      }),
    ];
    return () => {
      alive = false;
      for (const s of subs) void s.then((un) => un());
    };
  }, [preview]);

  const startPreview = useCallback(() => {
    setError(null);
    discard();
    setPreview(null);
    previewAgent({
      name,
      instruction,
      draftId,
      draftMarkdown: getLiveMarkdown() ?? null,
      projectPath,
      cwd: projectPath,
    })
      .then((id) => {
        previewIdRef.current = id;
        setPreview({ id, phase: "running", proposals: [], note: null });
      })
      .catch((e) => setError(String(e)));
  }, [name, instruction, draftId, getLiveMarkdown, projectPath, discard]);

  const save = useCallback(() => {
    setError(null);
    const done = () => {
      discard();
      onSaved();
    };
    (editing
      ? updateAgent(editing.agentId, name, instruction)
      : createAgent(name, instruction).then(() => undefined)
    )
      .then(done)
      .catch((e) => setError(String(e)));
  }, [editing, name, instruction, discard, onSaved]);

  const ready = name.trim().length > 0 && instruction.trim().length > 0;

  return (
    <div className="rl-thin-scroll-y min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <div className="mx-auto flex max-w-2xl flex-col gap-3">
        <label
          className="flex flex-col gap-1"
          style={{ fontSize: "11.5px", color: "var(--color-ink-muted)" }}
        >
          What is it called?
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Header tightener"
            className="rounded-sm px-2 py-1.5"
            style={{
              fontSize: "13px",
              border: "1px solid var(--color-rule)",
              background: "var(--color-bg-elevated)",
              color: "var(--color-ink)",
            }}
          />
        </label>
        <label
          className="flex flex-col gap-1"
          style={{ fontSize: "11.5px", color: "var(--color-ink-muted)" }}
        >
          What should it do, in your own words?
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder={
              "Go through the document and tighten every heading to five words " +
              "or fewer. Don't change the body text."
            }
            rows={6}
            className="rounded-sm px-2 py-1.5"
            style={{
              fontSize: "13px",
              lineHeight: 1.5,
              resize: "vertical",
              border: "1px solid var(--color-rule)",
              background: "var(--color-bg-elevated)",
              color: "var(--color-ink)",
            }}
          />
          <span>
            Write it the way you'd brief a careful colleague: what to look at,
            what to change, what to leave alone. Every edit it makes lands as a
            tracked change you accept or reject — nothing applies by itself.
          </span>
        </label>

        {error && (
          <div
            className="rounded-sm px-3 py-1.5"
            style={{
              fontSize: "11.5px",
              border: "1px solid var(--color-rule)",
              background: "var(--color-bg-elevated)",
              color: "var(--color-ink)",
            }}
          >
            {error}
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!ready || preview?.phase === "running"}
            onClick={startPreview}
            className="rl-fd-quiet"
            style={{ opacity: ready && preview?.phase !== "running" ? 1 : 0.5 }}
            title="Rehearse on a copy of the open document — the document itself is untouched"
          >
            {preview?.phase === "running" ? "Previewing…" : "Preview on a copy"}
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={save}
            className="rl-fd-fix"
            style={{ opacity: ready ? 1 : 0.5 }}
          >
            {editing ? "Save changes" : "Save to shelf"}
          </button>
          <button type="button" onClick={onCancel} className="rl-fd-quiet">
            Cancel
          </button>
        </div>

        {preview && (
          <div
            className="flex flex-col gap-2 rounded-sm p-3"
            style={{
              border: "1px solid var(--color-rule)",
              background: "var(--color-bg-elevated)",
            }}
          >
            <span style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}>
              {preview.phase === "running"
                ? "Your agent is rehearsing on a copy of this document — the document itself is untouched."
                : preview.phase === "error"
                  ? `The rehearsal failed: ${preview.note ?? "unknown error"}`
                  : preview.proposals.length === 0
                    ? "It finished without proposing any edits."
                    : `It would make ${preview.proposals.length} edit${preview.proposals.length === 1 ? "" : "s"} — shown below, none applied.`}
            </span>
            {preview.proposals.map((p) => (
              <div
                key={p.id}
                className="rounded-sm px-2 py-1.5"
                style={{
                  fontSize: "12px",
                  border: "1px solid var(--color-rule)",
                  background: "var(--color-paper)",
                }}
              >
                <div
                  style={{
                    fontSize: "10.5px",
                    color: "var(--color-ink-muted)",
                    marginBottom: "2px",
                  }}
                >
                  {OP_LABEL[p.op] ?? "Proposed an edit"}
                  {p.body?.trim() ? ` — ${p.body.trim()}` : ""}
                </div>
                <div style={{ lineHeight: 1.45 }}>
                  {compactEditPreview(p.original ?? "", p.markdown).map(
                    (part, i) =>
                      part.kind === "delete" ? (
                        <span
                          key={i}
                          className="line-through"
                          style={{ color: "var(--color-ink-muted)" }}
                        >
                          {part.text}
                        </span>
                      ) : part.kind === "insert" ? (
                        <span key={i} style={{ color: "var(--color-info)" }}>
                          {part.text}
                        </span>
                      ) : (
                        <span key={i} style={{ color: "var(--color-ink-muted)" }}>
                          {part.text}
                        </span>
                      ),
                  )}
                </div>
              </div>
            ))}
            {preview.phase === "done" && preview.note && (
              <span style={{ fontSize: "11.5px", color: "var(--color-ink)" }}>
                {preview.note}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
