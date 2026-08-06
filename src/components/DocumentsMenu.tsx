// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useRef, useState } from "react";
import { FilePlus2, Star, X } from "lucide-react";

import {
  draftLabel,
  loadShelf,
  newDraft,
  type BookshelfDraft,
} from "../lib/bookshelf";
import { Panel, useClickPopover } from "./popover";

// The documents dropdown: one menu that answers "what can I open, what do I
// have open, what do I keep coming back to". Ordering per the design: template
// entries at the top, then what's open, then what's used most.
//
// Built on the extracted popover primitives (Panel portals to document.body,
// `useClickPopover` calls `useMenuOverlay` internally) — the embedded browser
// is a native child webview painted above all React DOM, so a menu that
// skipped the overlay registration would be occluded by it.

/** FREQUENT stops earning rows past this — a menu, not an archive. */
const MAX_FREQUENT = 8;

interface DocumentsMenuProps {
  /** Documents currently open in the drafter (the OPEN section). */
  openIds: string[];
  /** The active document, marked in OPEN. */
  activeId: string | null;
  /** Repo tag for a fresh blank document. */
  defaultProject?: string | null;
  /** Where a new document is filed (the shelf's selected folder); a template
   *  copy prefers the template's own folder. */
  folderId?: string | null;
  /** "above" for bottom-anchored triggers (the drafter footer). */
  side?: "above" | "below";
  /** Open/activate a document (the host adds it to the open set). */
  onActivate: (id: string) => void;
  /** Remove a document from the open set (the ✕ on an OPEN row). */
  onCloseDoc: (id: string) => void;
}

export function DocumentsMenu({
  openIds,
  activeId,
  defaultProject = null,
  folderId = null,
  side = "below",
  onActivate,
  onCloseDoc,
}: DocumentsMenuProps) {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const { open, panelProps, toggle, close } = useClickPopover(
    btnRef,
    "left",
    side,
  );
  const [drafts, setDrafts] = useState<BookshelfDraft[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    loadShelf()
      .then((s) => {
        setDrafts(s.drafts);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  };

  const byId = new Map(drafts.map((d) => [d.draftId, d]));
  const templates = drafts.filter((d) => d.isTemplate);
  const frequent = drafts
    .filter(
      (d) => d.openCount > 0 && !d.isTemplate && !openIds.includes(d.draftId),
    )
    .sort(
      (a, b) =>
        b.openCount - a.openCount ||
        (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0),
    )
    .slice(0, MAX_FREQUENT);

  const pick = (id: string) => {
    close();
    onActivate(id);
  };

  const mintBlank = () => {
    close();
    void newDraft(folderId, undefined, defaultProject)
      .then(onActivate)
      .catch((e) => setError(String(e)));
  };

  const mintFromTemplate = (t: BookshelfDraft) => {
    close();
    // The copy is filed beside its template — an ordinary document from birth.
    void newDraft(t.folderId ?? folderId, undefined, null, t.draftId)
      .then(onActivate)
      .catch((e) => setError(String(e)));
  };

  const heading = (text: string) => (
    <div className="rl-menu-heading" style={{ marginTop: "4px" }}>
      {text}
    </div>
  );

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        onClick={() => {
          if (!open) refresh();
          toggle();
        }}
        title="New document, open documents, and the ones you use most"
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1 rounded-sm px-2 py-1"
        style={{
          fontSize: "11.5px",
          border: "1px solid var(--color-rule)",
          background: "var(--color-anchor-bg)",
          color: "var(--color-anchor-text)",
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        <FilePlus2 size={13} /> New document ▾
      </button>
      {open && (
        <Panel label="Documents" {...panelProps}>
          <div
            className="rl-thin-scroll-y py-1"
            style={{ maxHeight: "60vh", overflowY: "auto" }}
          >
            {error && (
              <div
                className="px-3 py-1"
                style={{ fontSize: "11px", color: "var(--color-warning)" }}
              >
                {error}
              </div>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={mintBlank}
              className="rl-menu-item w-full text-left px-3 py-1.5 font-sans"
              style={{
                display: "block",
                fontSize: "12px",
                color: "var(--color-ink)",
                cursor: "pointer",
              }}
            >
              ＋ New blank document
            </button>
            {templates.length > 0 && (
              <>
                {heading("New from template")}
                {templates.map((t) => (
                  <button
                    key={t.draftId}
                    type="button"
                    role="menuitem"
                    onClick={() => mintFromTemplate(t)}
                    title={`New document from “${draftLabel(t)}”`}
                    className="rl-menu-item w-full text-left px-3 py-1.5 font-sans flex items-center gap-2"
                    style={{
                      fontSize: "12px",
                      color: "var(--color-ink)",
                      cursor: "pointer",
                    }}
                  >
                    <Star
                      size={11}
                      fill="currentColor"
                      style={{ color: "var(--color-warning)", flexShrink: 0 }}
                    />
                    <span className="truncate">{draftLabel(t)}</span>
                  </button>
                ))}
              </>
            )}
            {openIds.length > 0 && (
              <>
                {heading("Open")}
                {openIds.map((id) => {
                  const d = byId.get(id);
                  const isActive = id === activeId;
                  return (
                    <div
                      key={id}
                      className="rl-menu-item flex items-center gap-2 px-3 py-1.5 font-sans"
                      style={{ fontSize: "12px", cursor: "pointer" }}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => pick(id)}
                        className="min-w-0 flex-1 text-left flex items-center gap-2"
                        style={{
                          color: "var(--color-ink)",
                          cursor: "pointer",
                          fontWeight: isActive ? 600 : 400,
                        }}
                      >
                        <span
                          aria-hidden
                          style={{
                            width: "6px",
                            height: "6px",
                            borderRadius: "50%",
                            flexShrink: 0,
                            background: isActive
                              ? "var(--color-info)"
                              : "var(--color-ink-muted)",
                          }}
                        />
                        <span className="truncate">
                          {d ? draftLabel(d) : "Untitled document"}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => onCloseDoc(id)}
                        title="Close (the document stays on your shelf)"
                        aria-label="Close document"
                        style={{
                          color: "var(--color-ink-muted)",
                          cursor: "pointer",
                          flexShrink: 0,
                        }}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  );
                })}
              </>
            )}
            {frequent.length > 0 && (
              <>
                {heading("Frequent")}
                {frequent.map((d) => (
                  <button
                    key={d.draftId}
                    type="button"
                    role="menuitem"
                    onClick={() => pick(d.draftId)}
                    className="rl-menu-item w-full text-left px-3 py-1.5 font-sans flex items-baseline gap-2"
                    style={{
                      fontSize: "12px",
                      color: "var(--color-ink)",
                      cursor: "pointer",
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {draftLabel(d)}
                    </span>
                    <span
                      style={{
                        color: "var(--color-ink-muted)",
                        fontSize: "10.5px",
                        fontVariantNumeric: "tabular-nums",
                        flexShrink: 0,
                      }}
                    >
                      {d.openCount}×
                    </span>
                  </button>
                ))}
              </>
            )}
          </div>
        </Panel>
      )}
    </>
  );
}
