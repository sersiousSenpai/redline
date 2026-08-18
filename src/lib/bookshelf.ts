// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { invoke } from "@tauri-apps/api/core";
import type { JSONContent } from "@tiptap/react";

// The Bookshelf's frontend surface: typed wrappers over the Rust commands, plus
// the one-time localStorage→DB migration.
//
// The document itself now lives in the DB (`drafts.doc_json`). localStorage
// keeps exactly one thing about the drafter: which document is currently open —
// a UI preference, not data.

/** localStorage key that held the TipTap doc before the Bookshelf owned it. */
export const LEGACY_DOC_KEY = "redline.drafter.doc";
/** localStorage key holding the currently-open draft id. Still a preference. */
export const OPEN_DRAFT_KEY = "redline.drafter.draftId";

export interface BookshelfFolder {
  folderId: string;
  parentId: string | null;
  name: string;
  createdAt: number;
}

export interface BookshelfDraft {
  draftId: string;
  title: string | null;
  projectPath: string | null;
  folderId: string | null;
  createdAt: number;
  updatedAt: number;
  sourceCount: number;
  hasDoc: boolean;
  /** ★ — offered under "New from template"; instantiating deep-copies the body. */
  isTemplate: boolean;
  /** Times opened (once per open) — ranks the documents dropdown's FREQUENT. */
  openCount: number;
  /** Epoch ms of the last open; null = never opened since the column existed. */
  lastOpenedAt: number | null;
}

export interface Shelf {
  folders: BookshelfFolder[];
  drafts: BookshelfDraft[];
}

export interface DraftSource {
  id: string;
  draftId: string;
  kind: string;
  refId: string | null;
  url: string | null;
  title: string | null;
  excerpt: string | null;
  filePath: string | null;
  createdAt: number;
}

/** What a delete would destroy — the numbers the confirm dialog names. */
export interface DeleteImpact {
  drafts: number;
  folders: number;
  comments: number;
  pendingSuggestions: number;
  sources: number;
  chatMessages: number;
}

export interface DraftDoc {
  docJson: string | null;
  docMarkdown: string;
  projectPath: string | null;
  /** When the DB last saw a write (0 = row doesn't exist yet) — what the
   *  crash-shadow recovery compares its own stamp against. */
  updatedAt: number;
}

/** A folder plus its children — what `BookshelfView` renders. */
export interface FolderNode extends BookshelfFolder {
  children: FolderNode[];
}

// Build the folder tree from adjacency edges. Same shape as ClassMemoryPane's
// `buildTree` and lib/reviewTree.ts — a folder whose parent is missing (a row
// orphaned by a partial delete) is re-hung at the root rather than vanishing,
// and a cycle can't loop forever because each folder is placed exactly once.
export function buildFolderTree(folders: BookshelfFolder[]): FolderNode[] {
  const nodes = new Map<string, FolderNode>();
  for (const f of folders) nodes.set(f.folderId, { ...f, children: [] });

  // Resolve each folder's *effective* parent before attaching anything, so the
  // result is always a forest. `move_folder`'s cycle guard makes a cycle
  // impossible going forward, but a row written by an older build (or a partial
  // delete leaving a dangling parent) must not be able to hang the renderer.
  const effectiveParent = (f: BookshelfFolder): FolderNode | null => {
    if (!f.parentId || f.parentId === f.folderId) return null;
    const parent = nodes.get(f.parentId);
    if (!parent) return null; // dangling: re-hang at the root, visible and fixable
    const seen = new Set<string>([f.folderId]);
    let cursor: FolderNode | undefined = parent;
    while (cursor) {
      if (seen.has(cursor.folderId)) return null; // cycle: break it at the root
      seen.add(cursor.folderId);
      cursor = cursor.parentId ? nodes.get(cursor.parentId) : undefined;
    }
    return parent;
  };

  const roots: FolderNode[] = [];
  for (const f of folders) {
    const node = nodes.get(f.folderId)!;
    const parent = effectiveParent(f);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const byName = (a: FolderNode, b: FolderNode) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  const sortAll = (list: FolderNode[]) => {
    list.sort(byName);
    for (const n of list) sortAll(n.children);
  };
  sortAll(roots);
  return roots;
}

/** The documents that sit directly in `folderId` (null = the shelf root).
 *  Templates sort ahead of ordinary documents; recency order (the backend's
 *  `updated_at DESC`) is preserved within each group — sort() is stable. */
export function draftsInFolder(
  drafts: BookshelfDraft[],
  folderId: string | null,
): BookshelfDraft[] {
  return drafts
    .filter((d) => (d.folderId ?? null) === folderId)
    .sort((a, b) => Number(b.isTemplate) - Number(a.isTemplate));
}

/** A document's display name: its title, else a stable placeholder. */
export function draftLabel(d: BookshelfDraft): string {
  const t = (d.title ?? "").trim();
  return t.length > 0 ? t : "Untitled document";
}

/** An auto-title for a document the user never named: its first heading or
 *  first real line, stripped of markdown syntax and capped. Null when the
 *  body has no usable line. */
export function draftTitleFromMarkdown(markdown: string): string | null {
  for (const raw of markdown.split("\n")) {
    const line = raw
      .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)/, "")
      .replace(/[*_`]/g, "")
      .trim();
    if (!line) continue;
    const collapsed = line.replace(/\s+/g, " ");
    return collapsed.length > 60
      ? `${collapsed.slice(0, 59).trimEnd()}…`
      : collapsed;
  }
  return null;
}

// --- commands ---------------------------------------------------------------

export const loadShelf = () => invoke<Shelf>("bookshelf_list");

export const loadDraftDoc = (draftId: string) =>
  invoke<DraftDoc>("drafter_get_doc", { draftId });

export const newDraft = (
  folderId: string | null,
  title?: string,
  projectPath?: string | null,
  /** Deep-copy this document's body (template instantiation); the copy is
   *  always an ordinary document with no sources, comments or threads. */
  fromDraftId?: string | null,
) =>
  invoke<string>("bookshelf_new_draft", {
    folderId,
    title: title ?? null,
    projectPath: projectPath ?? null,
    fromDraftId: fromDraftId ?? null,
  });

export const setTemplate = (draftId: string, isTemplate: boolean) =>
  invoke<void>("bookshelf_set_template", { draftId, isTemplate });

/** Count one open — once per open, never on activation-switch of an
 *  already-open document. */
export const touchDraft = (draftId: string) =>
  invoke<void>("bookshelf_touch_draft", { draftId });

export const renameDraft = (draftId: string, title: string) =>
  invoke<void>("bookshelf_rename_draft", { draftId, title });

export const moveDraft = (draftId: string, folderId: string | null) =>
  invoke<void>("bookshelf_move_draft", { draftId, folderId });

export const draftImpact = (draftId: string) =>
  invoke<DeleteImpact>("bookshelf_draft_impact", { draftId });

export const deleteDraft = (draftId: string) =>
  invoke<void>("bookshelf_delete_draft", { draftId });

export const createFolder = (parentId: string | null, name: string) =>
  invoke<string>("bookshelf_create_folder", { parentId, name });

export const renameFolder = (folderId: string, name: string) =>
  invoke<void>("bookshelf_rename_folder", { folderId, name });

export const moveFolder = (folderId: string, parentId: string | null) =>
  invoke<void>("bookshelf_move_folder", { folderId, parentId });

export const folderImpact = (folderId: string) =>
  invoke<DeleteImpact>("bookshelf_folder_impact", { folderId });

export const deleteFolder = (folderId: string) =>
  invoke<void>("bookshelf_delete_folder", { folderId });

export const listSources = (draftId: string) =>
  invoke<DraftSource[]>("draft_source_list", { draftId });

export const deleteSource = (id: string) =>
  invoke<void>("draft_source_delete", { id });

export const importSourceFile = (draftId: string, srcPath: string) =>
  invoke<DraftSource>("draft_source_import_file", { draftId, srcPath });

export const addSource = (s: {
  draftId: string;
  kind: string;
  refId?: string | null;
  url?: string | null;
  title?: string | null;
  excerpt?: string | null;
}) =>
  invoke<DraftSource>("draft_source_add", {
    draftId: s.draftId,
    kind: s.kind,
    refId: s.refId ?? null,
    url: s.url ?? null,
    title: s.title ?? null,
    excerpt: s.excerpt ?? null,
  });

export interface ShipwrightFinding {
  priority: number;
  category: string;
  title: string;
  evidence: string;
  proposal: string;
  guard: string;
  files: string[];
  effort?: string | null;
}

export interface ShipwrightRun {
  summary: string;
  findings: ShipwrightFinding[];
  /** The NEW Bookshelf document the findings landed in. */
  draftId: string;
  shortRev: string;
  /** Findings skipped because they duplicate one already recorded. */
  duplicates: number;
}

/** Run the Shipwright once against `repoPath` and land its findings on the shelf. */
export const runShipwright = (repoPath: string, folderId: string | null) =>
  invoke<ShipwrightRun>("shipwright_agent", { repoPath, folderId });

/** Persist the document + its markdown mirror on the drafter's 400ms debounce. */
export const persistDraftDoc = (
  draftId: string,
  markdown: string,
  docJson: JSONContent | null,
  projectPath: string | null,
) =>
  invoke<void>("drafter_set_doc", {
    draftId,
    markdown,
    docJson: docJson ? JSON.stringify(docJson) : null,
    projectPath,
  });

/**
 * One-time move of the pre-Bookshelf document out of localStorage.
 *
 * Frontend-initiated because only the webview can read localStorage; the
 * "already done" flag lives in the DB, so a cache clear can neither lose nor
 * re-run it. The legacy key is cleared only after the backend confirms the
 * write, and the markdown mirror in the DB is an independent survival copy
 * throughout. Returns the adopted draft id, if there was one.
 */
export async function migrateLegacyDraft(): Promise<string | null> {
  let docJson: string | null = null;
  let draftId: string | null = null;
  try {
    docJson = localStorage.getItem(LEGACY_DOC_KEY);
    const rawId = localStorage.getItem(OPEN_DRAFT_KEY);
    draftId = rawId ? (JSON.parse(rawId) as string) : null;
  } catch {
    /* unreadable localStorage — nothing to migrate */
  }
  try {
    const outcome = await invoke<{ migrated: boolean; draftId: string | null }>(
      "bookshelf_migrate_local",
      { draftId, docJson, projectPath: null },
    );
    if (outcome.migrated) {
      try {
        localStorage.removeItem(LEGACY_DOC_KEY);
      } catch {
        /* the DB copy is authoritative now either way */
      }
    }
    return outcome.draftId;
  } catch {
    // A failed migration leaves the flag unset; the next launch retries.
    return null;
  }
}
