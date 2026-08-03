// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FolderPlus,
  Hammer,
  Library,
  Paperclip,
  Pencil,
  Trash2,
  X,
} from "lucide-react";

import {
  buildFolderTree,
  createFolder,
  deleteDraft,
  deleteFolder,
  draftImpact,
  draftLabel,
  draftsInFolder,
  folderImpact,
  loadShelf,
  moveDraft,
  moveFolder,
  newDraft,
  renameDraft,
  renameFolder,
  runShipwright,
  type BookshelfDraft,
  type DeleteImpact,
  type FolderNode,
  type Shelf,
} from "../lib/bookshelf";

// The shelf: the folder tree plus the documents in it. Rendered *inside* the
// document surface rather than as a fourth pane, so it inherits that pane's
// fullscreen and zoom for free.
//
// Two of these commands are not idempotent — deleting a document and deleting a
// folder both cascade through the chat thread, comments, suggestions and
// sources with no undo, and now through the only copy of the document itself.
// Both go through a typed-name confirm that names exactly what will go. Every
// other shelf command is safe to fire without ceremony.

interface BookshelfViewProps {
  /** The currently-open document, highlighted in the list. */
  openDraftId: string | null;
  /** Open a document in the editor (also closes the shelf). */
  onOpen: (draftId: string) => void;
  /** Close the shelf and return to the open document. */
  onClose: () => void;
  /** The repo the new-document button should tag a fresh document with, and the
   *  repo the Shipwright surveys. Null disables the Shipwright — it has to know
   *  which tree it is measuring, and guessing would be worse than asking. */
  defaultProject?: string | null;
}

function formatWhen(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days <= 0) {
    return d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function projectName(path: string | null): string {
  if (!path) return "";
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/** The one-line summary of a pending delete, in the confirm dialog. */
export function describeImpact(impact: DeleteImpact): string {
  const bits: string[] = [];
  const plural = (n: number, one: string, many = `${one}s`) =>
    `${n} ${n === 1 ? one : many}`;
  if (impact.folders > 0) bits.push(plural(impact.folders, "folder"));
  if (impact.drafts > 0) bits.push(plural(impact.drafts, "document"));
  if (impact.comments > 0) bits.push(plural(impact.comments, "comment"));
  if (impact.pendingSuggestions > 0)
    bits.push(
      `${impact.pendingSuggestions} pending suggestion${impact.pendingSuggestions === 1 ? "" : "s"}`,
    );
  if (impact.sources > 0) bits.push(plural(impact.sources, "source"));
  if (impact.chatMessages > 0)
    bits.push(plural(impact.chatMessages, "discussion message"));
  return bits.length > 0 ? bits.join(", ") : "nothing";
}

interface PendingDelete {
  kind: "draft" | "folder";
  id: string;
  name: string;
  impact: DeleteImpact;
}

export function BookshelfView({
  openDraftId,
  onOpen,
  onClose,
  defaultProject = null,
}: BookshelfViewProps) {
  const [shelf, setShelf] = useState<Shelf>({ folders: [], drafts: [] });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The document being dragged onto a folder row, if any.
  const [dragDraft, setDragDraft] = useState<string | null>(null);
  // The Shipwright run in flight, and the last run's one-line read.
  const [shipwrightBusy, setShipwrightBusy] = useState(false);
  const [shipwrightNote, setShipwrightNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setShelf(await loadShelf());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const tree = useMemo(() => buildFolderTree(shelf.folders), [shelf.folders]);
  const visible = useMemo(
    () => draftsInFolder(shelf.drafts, selectedFolder),
    [shelf.drafts, selectedFolder],
  );
  const folderName = useCallback(
    (id: string | null) =>
      id === null
        ? "Shelf"
        : (shelf.folders.find((f) => f.folderId === id)?.name ?? "Shelf"),
    [shelf.folders],
  );

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(String(e));
      }
      await refresh();
    },
    [refresh],
  );

  const askDelete = useCallback(
    async (kind: "draft" | "folder", id: string, name: string) => {
      try {
        const impact =
          kind === "draft" ? await draftImpact(id) : await folderImpact(id);
        setConfirmText("");
        setPendingDelete({ kind, id, name, impact });
      } catch (e) {
        setError(String(e));
      }
    },
    [],
  );

  // Run the Shipwright: it surveys the repo against a ground-truth digest and
  // lands at most five findings as a NEW document. Your open document is never
  // touched — you trim the new one and launch it.
  const runShipwrightNow = useCallback(async () => {
    if (!defaultProject || shipwrightBusy) return;
    setShipwrightBusy(true);
    setError(null);
    setShipwrightNote(null);
    try {
      const run = await runShipwright(defaultProject, selectedFolder);
      const dupes =
        run.duplicates > 0
          ? ` (${run.duplicates} already recorded or dismissed)`
          : "";
      setShipwrightNote(
        `${run.findings.length} finding(s) at ${run.shortRev}${dupes} — ${run.summary}`,
      );
      await refresh();
      onOpen(run.draftId);
    } catch (e) {
      setError(String(e));
    } finally {
      setShipwrightBusy(false);
    }
  }, [defaultProject, shipwrightBusy, selectedFolder, refresh, onOpen]);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const { kind, id } = pendingDelete;
    setPendingDelete(null);
    await run(() => (kind === "draft" ? deleteDraft(id) : deleteFolder(id)));
    if (kind === "folder" && selectedFolder === id) setSelectedFolder(null);
  }, [pendingDelete, run, selectedFolder]);

  const renderFolder = (node: FolderNode, depth: number) => {
    const isOpen = expanded.has(node.folderId);
    const count = draftsInFolder(shelf.drafts, node.folderId).length;
    return (
      <div key={node.folderId}>
        <div
          className="group flex items-center gap-1 rounded-sm px-1.5 py-1"
          style={{
            paddingLeft: `${6 + depth * 14}px`,
            background:
              selectedFolder === node.folderId
                ? "var(--color-bg-elevated)"
                : "transparent",
            cursor: "pointer",
          }}
          onClick={() => setSelectedFolder(node.folderId)}
          onDragOver={(e) => {
            if (dragDraft) e.preventDefault();
          }}
          onDrop={() => {
            if (!dragDraft) return;
            void run(() => moveDraft(dragDraft, node.folderId));
            setDragDraft(null);
          }}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(node.folderId)) next.delete(node.folderId);
                else next.add(node.folderId);
                return next;
              });
            }}
            style={{
              display: "inline-flex",
              opacity: node.children.length > 0 ? 1 : 0.25,
              color: "var(--color-ink-muted)",
              cursor: "pointer",
            }}
            aria-label={isOpen ? "Collapse" : "Expand"}
          >
            {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
          <span
            className="min-w-0 flex-1 truncate"
            style={{ fontSize: "12.5px", color: "var(--color-ink)" }}
          >
            {node.name}
          </span>
          <span
            style={{ fontSize: "10.5px", color: "var(--color-ink-muted)" }}
          >
            {count || ""}
          </span>
          <button
            type="button"
            className="opacity-0 group-hover:opacity-100"
            title="Rename this folder"
            onClick={(e) => {
              e.stopPropagation();
              const name = window.prompt("Rename folder", node.name);
              if (name?.trim()) void run(() => renameFolder(node.folderId, name));
            }}
            style={{ color: "var(--color-ink-muted)", cursor: "pointer" }}
          >
            <Pencil size={12} />
          </button>
          <button
            type="button"
            className="opacity-0 group-hover:opacity-100"
            title="Delete this folder and everything in it"
            onClick={(e) => {
              e.stopPropagation();
              void askDelete("folder", node.folderId, node.name);
            }}
            style={{ color: "var(--color-ink-muted)", cursor: "pointer" }}
          >
            <Trash2 size={12} />
          </button>
        </div>
        {isOpen && node.children.map((c) => renderFolder(c, depth + 1))}
      </div>
    );
  };

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
        <Library size={15} strokeWidth={2} />
        <span style={{ fontSize: "13px", fontWeight: 600 }}>Bookshelf</span>
        <span style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}>
          {shelf.drafts.length}{" "}
          {shelf.drafts.length === 1 ? "document" : "documents"}
        </span>
        <button
          type="button"
          className="ml-auto flex items-center gap-1 rounded-sm px-2 py-1"
          disabled={!defaultProject || shipwrightBusy}
          onClick={() => void runShipwrightNow()}
          title={
            defaultProject
              ? `Survey ${defaultProject} against a ground-truth digest and land up to five findings as a new document`
              : "Pick a project in the document footer first — the Shipwright has to know which tree it's measuring"
          }
          style={{
            fontSize: "11.5px",
            border: "1px solid var(--color-rule)",
            background: "var(--color-bg-elevated)",
            color: "var(--color-ink)",
            opacity: defaultProject && !shipwrightBusy ? 1 : 0.5,
            cursor: defaultProject && !shipwrightBusy ? "pointer" : "default",
          }}
        >
          <Hammer size={13} />
          {shipwrightBusy ? "Surveying…" : "Shipwright"}
        </button>
        <button
          type="button"
          className="flex items-center gap-1 rounded-sm px-2 py-1"
          onClick={() => {
            const name = window.prompt("New folder name", "Untitled folder");
            if (name?.trim()) void run(() => createFolder(selectedFolder, name));
          }}
          style={{
            fontSize: "11.5px",
            border: "1px solid var(--color-rule)",
            background: "var(--color-bg-elevated)",
            color: "var(--color-ink)",
            cursor: "pointer",
          }}
        >
          <FolderPlus size={13} /> New folder
        </button>
        <button
          type="button"
          className="flex items-center gap-1 rounded-sm px-2 py-1"
          onClick={() =>
            void run(async () => {
              const id = await newDraft(selectedFolder, undefined, defaultProject);
              onOpen(id);
            })
          }
          style={{
            fontSize: "11.5px",
            border: "1px solid var(--color-rule)",
            background: "var(--color-anchor-bg)",
            color: "var(--color-anchor-text)",
            cursor: "pointer",
          }}
        >
          <FilePlus2 size={13} /> New document
        </button>
        <button
          type="button"
          onClick={onClose}
          title="Back to the open document"
          style={{ color: "var(--color-ink-muted)", cursor: "pointer" }}
        >
          <X size={15} />
        </button>
      </div>

      {error && (
        <div
          className="px-4 py-1.5"
          style={{
            fontSize: "11.5px",
            color: "var(--color-danger, #b00)",
            borderBottom: "1px solid var(--color-rule)",
          }}
        >
          {error}
        </div>
      )}
      {shipwrightNote && (
        <div
          className="px-4 py-1.5"
          style={{
            fontSize: "11.5px",
            color: "var(--color-ink-muted)",
            borderBottom: "1px solid var(--color-rule)",
          }}
        >
          {shipwrightNote}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Folder tree */}
        <div
          className="min-h-0 shrink-0 overflow-y-auto py-2"
          style={{
            width: "220px",
            borderRight: "1px solid var(--color-rule)",
          }}
        >
          <div
            className="flex items-center gap-1 rounded-sm px-1.5 py-1"
            style={{
              paddingLeft: "6px",
              background:
                selectedFolder === null
                  ? "var(--color-bg-elevated)"
                  : "transparent",
              cursor: "pointer",
              fontSize: "12.5px",
            }}
            onClick={() => setSelectedFolder(null)}
            onDragOver={(e) => {
              if (dragDraft) e.preventDefault();
            }}
            onDrop={() => {
              if (!dragDraft) return;
              void run(() => moveDraft(dragDraft, null));
              setDragDraft(null);
            }}
          >
            <Library size={12} style={{ color: "var(--color-ink-muted)" }} />
            <span className="flex-1">Shelf</span>
            <span
              style={{ fontSize: "10.5px", color: "var(--color-ink-muted)" }}
            >
              {draftsInFolder(shelf.drafts, null).length || ""}
            </span>
          </div>
          {tree.map((n) => renderFolder(n, 1))}
          {tree.length > 0 && (
            <div
              className="mt-2 px-2"
              style={{ fontSize: "10.5px", color: "var(--color-ink-muted)" }}
            >
              Drag a document onto a folder to file it.
            </div>
          )}
        </div>

        {/* Documents in the selected folder */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div
            className="px-4 py-2"
            style={{
              fontSize: "11px",
              color: "var(--color-ink-muted)",
              borderBottom: "1px solid var(--color-rule)",
            }}
          >
            {folderName(selectedFolder)}
            {selectedFolder !== null && (
              <button
                type="button"
                className="ml-2"
                onClick={() => void run(() => moveFolder(selectedFolder, null))}
                style={{
                  fontSize: "10.5px",
                  color: "var(--color-info)",
                  cursor: "pointer",
                  textDecoration: "underline",
                }}
              >
                move to shelf root
              </button>
            )}
          </div>
          {visible.length === 0 ? (
            <div
              className="px-4 py-6"
              style={{ fontSize: "12px", color: "var(--color-ink-muted)" }}
            >
              No documents here yet. Folders hold documents only — a file you
              drop attaches to the document it informs, not to the folder.
            </div>
          ) : (
            visible.map((d: BookshelfDraft) => (
              <div
                key={d.draftId}
                className="group flex items-center gap-2 px-4 py-2"
                draggable
                onDragStart={() => setDragDraft(d.draftId)}
                onDragEnd={() => setDragDraft(null)}
                onDoubleClick={() => onOpen(d.draftId)}
                style={{
                  borderBottom: "1px solid var(--color-rule)",
                  background:
                    d.draftId === openDraftId
                      ? "var(--color-bg-elevated)"
                      : "transparent",
                  cursor: "pointer",
                }}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => onOpen(d.draftId)}
                >
                  <div
                    className="truncate"
                    style={{ fontSize: "13px", color: "var(--color-ink)" }}
                  >
                    {draftLabel(d)}
                    {d.draftId === openDraftId && (
                      <span
                        style={{
                          marginLeft: "8px",
                          fontSize: "10px",
                          color: "var(--color-ink-muted)",
                        }}
                      >
                        open
                      </span>
                    )}
                  </div>
                  <div
                    className="flex items-center gap-2 truncate"
                    style={{
                      fontSize: "11px",
                      color: "var(--color-ink-muted)",
                    }}
                  >
                    {projectName(d.projectPath) && (
                      <span>{projectName(d.projectPath)}</span>
                    )}
                    <span>{formatWhen(d.updatedAt)}</span>
                    {d.sourceCount > 0 && (
                      <span className="flex items-center gap-0.5">
                        <Paperclip size={10} /> {d.sourceCount}
                      </span>
                    )}
                    {!d.hasDoc && <span>empty</span>}
                  </div>
                </button>
                <button
                  type="button"
                  className="opacity-0 group-hover:opacity-100"
                  title="Rename this document"
                  onClick={() => {
                    const title = window.prompt("Rename document", draftLabel(d));
                    if (title?.trim())
                      void run(() => renameDraft(d.draftId, title));
                  }}
                  style={{ color: "var(--color-ink-muted)", cursor: "pointer" }}
                >
                  <Pencil size={13} />
                </button>
                <button
                  type="button"
                  className="opacity-0 group-hover:opacity-100"
                  title="Delete this document"
                  onClick={() =>
                    void askDelete("draft", d.draftId, draftLabel(d))
                  }
                  style={{ color: "var(--color-ink-muted)", cursor: "pointer" }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {pendingDelete && (
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.35)", zIndex: 40 }}
        >
          <div
            className="flex flex-col gap-3 rounded p-4"
            style={{
              width: "min(460px, 90%)",
              background: "var(--color-paper)",
              border: "1px solid var(--color-rule)",
            }}
          >
            <div style={{ fontSize: "13px", fontWeight: 600 }}>
              Delete “{pendingDelete.name}”?
            </div>
            <div
              style={{ fontSize: "12px", color: "var(--color-ink-muted)" }}
            >
              This removes {describeImpact(pendingDelete.impact)}. There is no
              undo, and for a document this is the only copy.
            </div>
            <label
              style={{ fontSize: "11.5px", color: "var(--color-ink-muted)" }}
            >
              Type the name to confirm:
              <input
                autoFocus
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                className="mt-1 w-full rounded px-2 py-1"
                style={{
                  fontSize: "12.5px",
                  border: "1px solid var(--color-rule)",
                  background: "var(--color-bg-elevated)",
                  color: "var(--color-ink)",
                }}
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="rounded px-3 py-1"
                style={{
                  fontSize: "12px",
                  border: "1px solid var(--color-rule)",
                  background: "var(--color-paper)",
                  color: "var(--color-ink)",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={confirmText.trim() !== pendingDelete.name}
                onClick={() => void confirmDelete()}
                className="rounded px-3 py-1"
                style={{
                  fontSize: "12px",
                  border: "1px solid var(--color-rule)",
                  background: "var(--color-danger, #b00)",
                  color: "#fff",
                  opacity:
                    confirmText.trim() === pendingDelete.name ? 1 : 0.4,
                  cursor:
                    confirmText.trim() === pendingDelete.name
                      ? "pointer"
                      : "default",
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
