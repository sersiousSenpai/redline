// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GripVertical, MapPin, PenLine, MessageSquare, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { BrowseListItem, BrowseListView } from "../types";
import {
  groupByPage,
  KIND_LABEL,
  nextKind,
  pageKeyOf,
  quoteItem,
  renderListMarkdown,
  sectionFor,
  templateFor,
  TEMPLATES,
  type ItemKind,
  type ListTemplate,
} from "../lib/browseList";
import {
  fallbackLocator,
  normalizeLocator,
  type PageContext,
  type RawLocator,
} from "../lib/pageLocator";

/** How often the panel asks the page what is highlighted.
 *
 *  Only while the List pill is the visible one, and the result is dropped
 *  unless the phrase actually changed — so a still page costs one cheap eval
 *  and zero renders. It is a poll rather than an event because the selection
 *  lives in an OS-composited child webview that emits nothing to the host. */
const SELECTION_POLL_MS = 800;

interface BrowseListProps {
  /** Stable per-tab id — the same durable key as the tab's discussion, so the
   *  list reattaches to its tab the way the conversation does. */
  browseId: string;
  /** The tab the list is being built against, for the provenance line on the
   *  handoff document. NOT where an item goes: items are filed under the page
   *  they were written on, which after two clicks is a different page. */
  source: { url?: string | null; title?: string | null };
  /** Read the live page: its real URL and title, and whatever the user has
   *  highlighted on it. Absent in tests and anywhere without a webview, in
   *  which case items are written unplaced — the pre-existing behaviour. */
  capturePage?: () => Promise<PageContext | null>;
  /** Hand a written item to the background naming agent, which may replace its
   *  pointer with a better phrase. Fire-and-forget; reports back over the
   *  `browse-list-located` event this component listens for. */
  onLocate?: (itemId: string, selection: string, locator: RawLocator | null) => void;
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
 *  scrolled away. Here it accumulates, and leaves in one piece.
 *
 *  Two things a walkthrough always needs and a flat list never carried. WHICH
 *  SCREEN: items are grouped by the page they were written on, because by item
 *  four the user is three clicks from where the list was started. And WHICH
 *  THING on it: highlight a component before writing the note and the item
 *  keeps a pointer to it — "Search bar — line spacing is off" — so the note
 *  stays actionable to someone who never saw the screen. */
export default function BrowseList({
  browseId,
  source,
  capturePage,
  onLocate,
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
  const [editing, setEditing] = useState<{
    id: string;
    body: string;
    locator: string;
  } | null>(null);
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
  const captureRef = useRef(capturePage);
  captureRef.current = capturePage;
  const locateRef = useRef(onLocate);
  locateRef.current = onLocate;

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

  // ── What the next item will be anchored to ───────────────────────────────
  // Shown BEFORE the add, because a pointer that appears only after the fact is
  // indistinguishable from the app guessing. Seeing "Search bar" sitting over
  // the composer is what tells the user their highlight was understood — and
  // gives them somewhere to take it back.
  const [pending, setPending] = useState<{
    /** `pageLocator`'s deterministic phrase — what would be stored. */
    phrase: string;
    /** The highlighted passage, handed to the naming agent as evidence. */
    text: string;
    locator: RawLocator | null;
    ts: number;
  } | null>(null);
  // Selections the user detached. Keyed by the page's own timestamp for the
  // selection, so dismissing one highlight doesn't suppress the next.
  const dismissedRef = useRef<number>(0);
  useEffect(() => {
    if (!capturePage) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled || document.hidden) return;
      const page = await capturePage().catch(() => null);
      if (cancelled) return;
      const sel = page?.selection ?? null;
      if (!sel || sel.ts === dismissedRef.current) {
        setPending((p) => (p === null ? p : null));
        return;
      }
      const phrase = fallbackLocator(sel.locator);
      setPending((p) =>
        p && p.ts === sel.ts && p.phrase === phrase
          ? p // identical — returning `p` is what keeps this from re-rendering
          : { phrase, text: sel.text, locator: sel.locator, ts: sel.ts },
      );
    };
    void tick();
    const interval = window.setInterval(() => void tick(), SELECTION_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [capturePage, browseId]);

  // The naming agent finished on some item. It may not be one of ours (every
  // tab's panel hears every event), and the item may have been deleted since.
  useEffect(() => {
    const un = listen<{ browseId: string; itemId: string; locator: string }>(
      "browse-list-located",
      (e) => {
        if (e.payload.browseId !== browseId) return;
        setView((v) =>
          v
            ? {
                ...v,
                items: v.items.map((x) =>
                  x.id === e.payload.itemId ? { ...x, locator: e.payload.locator } : x,
                ),
              }
            : v,
        );
      },
    );
    return () => {
      void un.then((f) => f());
    };
  }, [browseId]);

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

  /** Write one item, placed and pointed.
   *
   *  The page is captured HERE rather than read from `source`, because that
   *  prop is the tab's polled URL (a second stale, and its title is only ever
   *  the hostname) and because the highlight is not reachable any other way.
   *  A capture that fails writes the item anyway: unplaced beats unwritten. */
  const add = async () => {
    const body = draft.trim();
    if (!body || !view) return;
    setError(null);
    setDraft(""); // optimistic: the capture is a round-trip, and ⏎ must feel done
    const page = await captureRef.current?.().catch(() => null);
    const sel =
      page?.selection && page.selection.ts !== dismissedRef.current
        ? page.selection
        : null;
    // Prefer the phrase already on screen when it describes this same
    // selection: the user agreed to that one by not detaching it.
    const phrase =
      pending && sel && pending.ts === sel.ts
        ? pending.phrase
        : fallbackLocator(sel?.locator);
    try {
      const it = await invoke<BrowseListItem>("browse_list_add", {
        browseId,
        kind: draftKind ?? template.defaultKind,
        body,
        pageUrl: page?.url ?? source.url ?? null,
        pageTitle: page?.title ?? null,
        locator: phrase || null,
      });
      setItems([...items, it]);
      if (sel) {
        locateRef.current?.(it.id, sel.text, sel.locator);
        // One highlight, one item. Leaving it armed would quietly anchor the
        // NEXT note — about something else entirely — to the same component.
        dismissedRef.current = sel.ts;
        setPending(null);
      }
    } catch (e: unknown) {
      setError(String(e));
      setDraft(body); // put their words back; nothing was written
    }
  };

  const patch = (
    id: string,
    p: { body?: string; kind?: string; done?: boolean; locator?: string },
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

  /** Commit an open edit. Body and pointer are saved together because they are
   *  one thought — "no, it's the *filter* dropdown, and the spacing is fine". */
  const commitEdit = (item: BrowseListItem) => {
    if (!editing || editing.id !== item.id) return;
    const body = editing.body.trim();
    const locator = normalizeLocator(editing.locator);
    const p: { body?: string; locator?: string } = {};
    if (body && body !== item.body) p.body = editing.body;
    // "" is a real value here: a wrong pointer aims the reader at the wrong
    // component, so detaching it has to be possible. `browse_list_update`
    // treats a blank locator as a clear, unlike a blank body.
    if (locator !== normalizeLocator(item.locator)) p.locator = locator;
    if (p.body !== undefined || p.locator !== undefined) patch(item.id, p);
    setEditing(null);
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
            Keep a running list of what needs to change while you click around —
            each item filed under the page you were on, and pointed at whatever
            you had highlighted. Then hand the whole thing over in one piece.
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
  // Sections are PAGES, in the order the user walked them. Coming back to a
  // page appends to the section it already has rather than opening a second
  // one, which is what makes this a map of the walkthrough and not a log of it.
  const sections = groupByPage(items);
  const hereKey = pageKeyOf(source.url);
  // The panel numbers within a section, and so does `renderListMarkdown` —
  // "item 3" has to mean the same thing on screen, in the quote and in the
  // handoff.
  const numberOf = new Map<string, number>();
  for (const s of sections) s.items.forEach((r, i) => numberOf.set(r.id, i + 1));

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
            Nothing on it yet. Add the first thing you want changed — it'll be
            filed under this page.
          </div>
        )}
        {sections.map((section) => (
          <div key={section.key} className="flex flex-col gap-1">
            <div
              className="flex items-baseline gap-1.5"
              title={section.url ?? "This item was written before Redline recorded the page"}
              style={{ marginTop: "2px", minWidth: 0 }}
            >
              <span
                style={{
                  fontSize: "9px",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.07em",
                  color: "var(--color-ink-muted)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {section.label}
              </span>
              {section.key !== "" && section.key === hereKey && (
                <span
                  style={{
                    fontSize: "9px",
                    fontWeight: 600,
                    color: "var(--color-info)",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  · here
                </span>
              )}
            </div>
            {section.items.map((item) => {
              const n = numberOf.get(item.id) ?? 0;
              const locator = normalizeLocator(item.locator);
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
                  {/* Always visible, not a hover reveal: with pages as the
                      sections, the kind is the only thing left saying what sort
                      of item this is. */}
                  {template.kinds.length > 1 && (
                    <button
                      type="button"
                      onClick={() => patch(item.id, { kind: nextKind(template, item.kind) })}
                      title={`${KIND_LABEL[sectionFor(template, item.kind)]} — click to change`}
                      style={{ ...chipStyle, marginTop: "1px", flexShrink: 0 }}
                    >
                      {KIND_LABEL[sectionFor(template, item.kind)]}
                    </button>
                  )}
                  {editing?.id === item.id ? (
                    <div className="flex-1 flex flex-col gap-1 min-w-0">
                      <input
                        value={editing.locator}
                        onChange={(e) =>
                          setEditing({ ...editing, locator: e.target.value })
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commitEdit(item);
                          }
                          if (e.key === "Escape") {
                            e.preventDefault();
                            setEditing(null);
                          }
                        }}
                        placeholder="Where on the page (optional)"
                        aria-label="Location pointer"
                        className="rounded px-1 py-0.5"
                        style={{
                          fontSize: "11px",
                          border: "1px solid var(--color-rule)",
                          background: "var(--color-bg-elevated)",
                          color: "var(--color-info)",
                          fontFamily: "inherit",
                        }}
                      />
                      <textarea
                        autoFocus
                        value={editing.body}
                        onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                        onBlur={(e) => {
                          // Moving between the two fields of one edit is not
                          // leaving the edit.
                          if (e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) {
                            return;
                          }
                          commitEdit(item);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            commitEdit(item);
                          }
                          if (e.key === "Escape") {
                            e.preventDefault();
                            setEditing(null);
                          }
                        }}
                        rows={2}
                        className="rounded px-1 py-0.5"
                        style={{
                          fontSize: "12px",
                          border: "1px solid var(--color-rule)",
                          background: "var(--color-bg-elevated)",
                          color: "var(--color-ink)",
                          fontFamily: "inherit",
                          resize: "none",
                        }}
                      />
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        setEditing({ id: item.id, body: item.body, locator })
                      }
                      className="flex-1 text-left min-w-0"
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
                      {locator && (
                        <>
                          <span
                            style={{
                              fontWeight: 600,
                              color: item.done
                                ? "var(--color-ink-muted)"
                                : "var(--color-info)",
                            }}
                          >
                            {locator}
                          </span>
                          <span style={{ color: "var(--color-ink-muted)" }}> — </span>
                        </>
                      )}
                      {item.body}
                    </button>
                  )}
                  <div className="flex items-center gap-0.5 opacity-0 group-hover/item:opacity-100 transition-opacity shrink-0">
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
        {pending && (
          <div
            className="flex items-center gap-1 mb-1.5"
            title={`Highlighted on the page: “${pending.text.slice(0, 120)}”`}
            style={{ minWidth: 0 }}
          >
            <MapPin
              size={10}
              strokeWidth={2}
              aria-hidden
              style={{ color: "var(--color-info)", flexShrink: 0 }}
            />
            <span
              style={{
                fontSize: "10px",
                color: "var(--color-info)",
                fontWeight: 600,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {pending.phrase || "the part you highlighted"}
            </span>
            <button
              type="button"
              onClick={() => {
                dismissedRef.current = pending.ts;
                setPending(null);
              }}
              title="Don't attach this location"
              style={{ ...iconBtn, flexShrink: 0 }}
            >
              <X size={10} strokeWidth={2} />
            </button>
          </div>
        )}
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
                void add();
              }
            }}
            placeholder={
              pending
                ? "What's wrong with it?"
                : "Add something you want changed…"
            }
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
            onClick={() => void add()}
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
