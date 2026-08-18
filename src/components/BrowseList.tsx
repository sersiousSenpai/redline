// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GripVertical, PenLine, MessageSquare, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { BrowseListItem, BrowseListView } from "../types";
import {
  KIND_LABEL,
  nextKind,
  quoteItem,
  renderListMarkdown,
  sectionFor,
  templateFor,
  TEMPLATES,
  type ItemKind,
  type ListTemplate,
} from "../lib/browseList";

interface BrowseListProps {
  /** Stable per-tab id — the same durable key as the tab's discussion, so the
   *  list reattaches to its tab the way the conversation does. */
  browseId: string;
  /** The tab the list is being built against, for the provenance line on the
   *  handoff document. */
  source: { url?: string | null; title?: string | null };
  /** Hand the whole list to the Prompt Drafter as one markdown document. */
  onSendToDrafter?: (markdown: string) => void;
  /** Hand the whole list to Claude Code as one plan prompt (via the repo
   *  confirm dialog — a localhost URL tells `guessProjectForPlan` nothing). */
  onSendToRedline?: (markdown: string) => void;
  /** Quote an item into the page-discussion composer and switch to it. That
   *  agent already grounds on the live page and can read the repo, so it is
   *  the right colleague for "why is this happening" — no new backend. */
  onDiscussItem?: (quoted: string) => void;
  /** The list row changed shape (created or cleared) — the panel's pill state
   *  and the localhost auto-offer both key on whether a list exists. */
  onListChanged?: (exists: boolean) => void;
  onClose: () => void;
}

/** A browser tab's working list.
 *
 *  Built for one situation: the user is watching their own dev server, clicking
 *  around, and finding things. Before this the list of what they found had
 *  nowhere to live — it stayed in their head, or got typed into a chat and
 *  scrolled away. Here it accumulates, and leaves in one piece. */
export default function BrowseList({
  browseId,
  source,
  onSendToDrafter,
  onSendToRedline,
  onDiscussItem,
  onListChanged,
  onClose,
}: BrowseListProps) {
  const [view, setView] = useState<BrowseListView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [draftKind, setDraftKind] = useState<ItemKind | null>(null);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const template = useMemo(
    () => templateFor(view?.list.template),
    [view?.list.template],
  );

  // Held in a ref, NOT read from the closure: the host passes an inline arrow,
  // so putting it in the deps below would make `load` a new function every
  // render and the load effect would refetch on each one — fetch, setState,
  // render, fetch. The load must key on the TAB and nothing else.
  const changedRef = useRef(onListChanged);
  changedRef.current = onListChanged;
  const report = useCallback((exists: boolean) => changedRef.current?.(exists), []);

  const load = useCallback(() => {
    let cancelled = false;
    void invoke<BrowseListView | null>("browse_list_get", { browseId })
      .then((v) => {
        if (cancelled) return;
        setView(v);
        setLoaded(true);
        report(!!v);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(String(e));
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [browseId, report]);
  useEffect(load, [load]);

  // Every mutation returns the authoritative row(s); nothing here guesses at
  // ids or sort indices and then reconciles.
  const items = view?.items ?? [];
  const setItems = (next: BrowseListItem[]) =>
    setView((v) => (v ? { ...v, items: next } : v));

  const start = (t: ListTemplate) => {
    setError(null);
    void invoke<BrowseListView>("browse_list_start", {
      browseId,
      template: t.id,
      title: source.title?.trim() || null,
    })
      .then((v) => {
        setView(v);
        setDraftKind(t.defaultKind);
        report(true);
      })
      .catch((e: unknown) => setError(String(e)));
  };

  const add = () => {
    const body = draft.trim();
    if (!body || !view) return;
    setError(null);
    void invoke<BrowseListItem>("browse_list_add", {
      browseId,
      kind: draftKind ?? template.defaultKind,
      body,
    })
      .then((it) => {
        setItems([...items, it]);
        setDraft("");
      })
      .catch((e: unknown) => setError(String(e)));
  };

  const patch = (
    id: string,
    p: { body?: string; kind?: string; done?: boolean },
  ) => {
    setError(null);
    void invoke<BrowseListItem>("browse_list_update", { id, ...p })
      .then((it) => setItems(items.map((x) => (x.id === it.id ? it : x))))
      .catch((e: unknown) => setError(String(e)));
  };

  const remove = (id: string) => {
    setError(null);
    void invoke("browse_list_remove", { id })
      .then(() => setItems(items.filter((x) => x.id !== id)))
      .catch((e: unknown) => setError(String(e)));
  };

  const clear = () => {
    setError(null);
    void invoke("browse_list_clear", { browseId })
      .then(() => {
        setView(null);
        report(false);
      })
      .catch((e: unknown) => setError(String(e)));
  };

  // A drag produces the order the user now sees, and that whole order is what
  // is sent — reconciling a from/to pair against concurrent adds is a race
  // this doesn't need to have.
  const dropOn = (targetId: string) => {
    const from = items.findIndex((x) => x.id === dragId);
    const to = items.findIndex((x) => x.id === targetId);
    setDragId(null);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setItems(next); // optimistic — the server echoes the settled order back
    void invoke<BrowseListItem[]>("browse_list_reorder", {
      browseId,
      ids: next.map((x) => x.id),
    })
      .then(setItems)
      .catch((e: unknown) => setError(String(e)));
  };

  const markdown = () =>
    view ? renderListMarkdown(view.list, view.items, source) : "";

  // ── The template chooser ─────────────────────────────────────────────────
  if (!loaded) return <Shell onClose={onClose} title="List" />;
  if (!view) {
    return (
      <Shell onClose={onClose} title="List" error={error}>
        <div className="px-3 py-3 flex flex-col gap-2">
          <p
            style={{
              fontSize: "12px",
              lineHeight: 1.5,
              color: "var(--color-ink-muted)",
            }}
          >
            Keep a running list of what needs to change while you click around
            this page — then hand the whole thing over in one piece.
          </p>
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => start(t)}
              className="text-left rounded px-3 py-2"
              style={{
                border: "1px solid var(--color-rule)",
                background: "var(--color-paper)",
                cursor: "pointer",
              }}
            >
              <div
                style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-ink)" }}
              >
                {t.label}
              </div>
              <div
                style={{
                  fontSize: "11px",
                  color: "var(--color-ink-muted)",
                  marginTop: "2px",
                }}
              >
                {t.blurb}
              </div>
            </button>
          ))}
        </div>
      </Shell>
    );
  }

  // ── The list ─────────────────────────────────────────────────────────────
  const sections = template.kinds
    .map((kind) => ({
      kind,
      rows: items.filter((i) => sectionFor(template, i.kind) === kind),
    }))
    .filter((s) => s.rows.length > 0);
  // The panel numbers per section, and so does `renderListMarkdown` — "item 3"
  // has to mean the same thing on screen, in the quote and in the handoff.
  const numberOf = new Map<string, number>();
  for (const s of sections) s.rows.forEach((r, i) => numberOf.set(r.id, i + 1));

  return (
    <Shell
      onClose={onClose}
      title={view.list.title?.trim() || template.label}
      error={error}
      onClear={clear}
    >
      <div className="flex-1 min-h-0 overflow-y-auto rl-thin-scroll-y px-3 py-2 flex flex-col gap-2">
        {items.length === 0 && (
          <div style={{ fontSize: "12px", color: "var(--color-ink-muted)", lineHeight: 1.5 }}>
            Nothing on it yet. Add the first thing you want changed.
          </div>
        )}
        {sections.map((section) => (
          <div key={section.kind} className="flex flex-col gap-1">
            {template.kinds.length > 1 && (
              <div
                style={{
                  fontSize: "9px",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.07em",
                  color: "var(--color-ink-muted)",
                  marginTop: "2px",
                }}
              >
                {KIND_LABEL[section.kind]}
              </div>
            )}
            {section.rows.map((item) => {
              const n = numberOf.get(item.id) ?? 0;
              return (
                <div
                  key={item.id}
                  className="group/item flex items-start gap-1.5 rounded px-1.5 py-1"
                  draggable={!editing}
                  onDragStart={() => setDragId(item.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => dropOn(item.id)}
                  style={{
                    border: "1px solid transparent",
                    borderColor: dragId === item.id ? "var(--color-info)" : "transparent",
                    background: "var(--color-paper)",
                  }}
                >
                  <GripVertical
                    size={12}
                    strokeWidth={2}
                    aria-hidden
                    style={{
                      color: "var(--color-ink-muted)",
                      opacity: 0.4,
                      marginTop: "3px",
                      cursor: "grab",
                      flexShrink: 0,
                    }}
                  />
                  <input
                    type="checkbox"
                    checked={item.done}
                    onChange={(e) => patch(item.id, { done: e.target.checked })}
                    aria-label={item.done ? "Mark not done" : "Mark done"}
                    style={{ marginTop: "3px", flexShrink: 0 }}
                  />
                  <span
                    aria-hidden
                    style={{
                      fontSize: "10px",
                      color: "var(--color-ink-muted)",
                      fontVariantNumeric: "tabular-nums",
                      marginTop: "2px",
                      flexShrink: 0,
                    }}
                  >
                    {n}.
                  </span>
                  {editing?.id === item.id ? (
                    <textarea
                      autoFocus
                      value={editing.body}
                      onChange={(e) => setEditing({ id: item.id, body: e.target.value })}
                      onBlur={() => {
                        if (editing.body.trim() && editing.body !== item.body) {
                          patch(item.id, { body: editing.body });
                        }
                        setEditing(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          e.currentTarget.blur();
                        }
                        if (e.key === "Escape") {
                          e.preventDefault();
                          setEditing(null);
                        }
                      }}
                      rows={2}
                      className="flex-1 rounded px-1 py-0.5"
                      style={{
                        fontSize: "12px",
                        border: "1px solid var(--color-rule)",
                        background: "var(--color-bg-elevated)",
                        color: "var(--color-ink)",
                        fontFamily: "inherit",
                        resize: "none",
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setEditing({ id: item.id, body: item.body })}
                      className="flex-1 text-left"
                      title="Edit"
                      style={{
                        fontSize: "12px",
                        lineHeight: 1.45,
                        color: item.done ? "var(--color-ink-muted)" : "var(--color-ink)",
                        textDecoration: item.done ? "line-through" : undefined,
                        background: "transparent",
                        border: "none",
                        padding: 0,
                        cursor: "text",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {item.body}
                    </button>
                  )}
                  <div className="flex items-center gap-0.5 opacity-0 group-hover/item:opacity-100 transition-opacity shrink-0">
                    {template.kinds.length > 1 && (
                      <button
                        type="button"
                        onClick={() => patch(item.id, { kind: nextKind(template, item.kind) })}
                        title={`${KIND_LABEL[sectionFor(template, item.kind)]} — click to change`}
                        style={chipStyle}
                      >
                        {KIND_LABEL[sectionFor(template, item.kind)]}
                      </button>
                    )}
                    {onDiscussItem && (
                      <button
                        type="button"
                        // Quoted with the number the panel shows, so the user
                        // and the agent point at the same line.
                        onClick={() => onDiscussItem(quoteItem(item, n))}
                        title="Ask the page agent about this item"
                        style={iconBtn}
                      >
                        <MessageSquare size={11} strokeWidth={2} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => remove(item.id)}
                      title="Remove"
                      style={iconBtn}
                    >
                      <X size={11} strokeWidth={2} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* One always-present composer: ⏎ appends, ⇧⏎ newline — the same idiom
          as the chat composer beside it. */}
      <div className="px-3 py-2 shrink-0" style={{ borderTop: "1px solid var(--color-rule)" }}>
        <div className="flex items-end gap-1.5">
          {template.kinds.length > 1 && (
            <button
              type="button"
              onClick={() =>
                setDraftKind(nextKind(template, draftKind ?? template.defaultKind))
              }
              title="What kind of item this is — click to change"
              style={{ ...chipStyle, marginBottom: "3px" }}
            >
              {KIND_LABEL[draftKind ?? template.defaultKind]}
            </button>
          )}
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                add();
              }
            }}
            placeholder="Add something you want changed…"
            rows={2}
            className="flex-1 rounded px-2 py-1"
            style={{
              fontSize: "12px",
              border: "1px solid var(--color-rule)",
              background: "var(--color-paper)",
              color: "var(--color-ink)",
              fontFamily: "inherit",
              resize: "none",
            }}
          />
          <button
            type="button"
            onClick={add}
            disabled={!draft.trim()}
            className="rounded px-2 py-1 font-medium"
            style={{
              background: "var(--color-info)",
              color: "var(--color-on-accent)",
              fontSize: "11px",
              opacity: draft.trim() ? 1 : 0.5,
            }}
          >
            Add
          </button>
        </div>
        {/* Neither handoff clears the list. It's a working list; the user
            decides when it's done. */}
        <div className="flex items-center gap-1.5 mt-1.5">
          {onSendToDrafter && (
            <button
              type="button"
              onClick={() => onSendToDrafter(markdown())}
              disabled={items.length === 0}
              title="Open the whole list in the Prompt Drafter to shape before sending"
              style={{ ...footerBtn, opacity: items.length ? 1 : 0.5 }}
            >
              <span className="inline-flex items-center gap-1">
                <PenLine size={10} strokeWidth={2} /> Open in Drafter
              </span>
            </button>
          )}
          {onSendToRedline && (
            <button
              type="button"
              onClick={() => onSendToRedline(markdown())}
              disabled={items.length === 0}
              title="Send the whole list to Claude Code — you'll confirm the target repo"
              style={{ ...footerBtn, opacity: items.length ? 1 : 0.5 }}
            >
              Send to Claude Code ▶
            </button>
          )}
        </div>
      </div>
    </Shell>
  );
}

const chipStyle: React.CSSProperties = {
  fontSize: "9px",
  fontWeight: 600,
  lineHeight: 1,
  padding: "3px 5px",
  border: "1px solid var(--color-rule)",
  borderRadius: "4px",
  background: "var(--color-bg-elevated)",
  color: "var(--color-ink-muted)",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const iconBtn: React.CSSProperties = {
  padding: "2px",
  lineHeight: 1,
  border: "none",
  background: "transparent",
  color: "var(--color-ink-muted)",
  cursor: "pointer",
};

const footerBtn: React.CSSProperties = {
  fontSize: "10px",
  lineHeight: 1,
  padding: "3px 7px",
  border: "1px solid var(--color-rule)",
  borderRadius: "5px",
  background: "var(--color-paper)",
  color: "var(--color-info)",
  cursor: "pointer",
};

/** The panel frame — header, an error line that is never swallowed, body. */
function Shell({
  title,
  error,
  onClear,
  onClose,
  children,
}: {
  title: string;
  error?: string | null;
  onClear?: () => void;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col h-full min-h-0" style={{ background: "var(--color-bg)" }}>
      <div
        className="flex items-center gap-2 px-3 py-1.5 shrink-0"
        style={{ borderBottom: "1px solid var(--color-rule)" }}
      >
        <span
          style={{
            fontSize: "10px",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "var(--color-info)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {title}
        </span>
        <div className="flex items-center gap-1 ml-auto">
          {onClear && (
            <button
              type="button"
              onClick={onClear}
              title="Clear this list"
              className="px-1 leading-none hover:opacity-100 opacity-60"
              style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title="Close the panel (the list is kept)"
            className="px-1 leading-none hover:opacity-100 opacity-60"
            style={{ color: "var(--color-ink-muted)" }}
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      </div>
      {error && (
        <div
          className="px-3 py-1 shrink-0"
          style={{ fontSize: "11px", color: "var(--color-warning)" }}
        >
          {error}
        </div>
      )}
      {children}
    </div>
  );
}
