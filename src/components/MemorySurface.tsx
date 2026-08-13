// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { usePersistedState } from "../theme/usePersistedState";
import { visibleRange } from "../lib/virtual";
import {
  describeVerdict,
  fmtTime,
  kindLabel,
  KIND_COLOR,
  type ChainVerdict,
} from "../lib/ledgerKinds";
import {
  dayBounds,
  dayLabel,
  fmtBytes,
  groupItems,
  GROUPINGS,
  GROUPING_LABEL,
  type ContextStats,
  type Grouping,
  type LedgerFilters,
  type TimelineFocus,
  type TimelineItem,
  type TimelineRow,
} from "../lib/timeline";
import { MemoryAsk } from "./MemoryAsk";
import { MemoryMapTab } from "./MemoryMap";
import { rootMasses, type MemoryMapData } from "../lib/memoryMap";
import { squarify } from "../lib/treemap";
import {
  buildTree,
  OP_LABEL,
  proposalSubject,
  sortObservations,
  supersedeLabel,
  type ClassNode,
  type ClassRun,
  type LinkView,
  type Observation,
  type ProposalView,
  type TreeNode,
} from "../lib/classTree";
import { noteOnEvent, standaloneNote, type NoteAct, type UserNote } from "../lib/notes";
import {
  actionHint,
  categoryLabel,
  categoryTone,
  coerceRun,
  LIBRARIAN_STORE_KEY,
  parseStoredRun,
  type LibrarianRun,
} from "../lib/librarian";
import { relativeTime, type MemoryStatus } from "./MemoryStatusPill";
import { ClassTreeRow, SettingsTab as PortabilitySections } from "./MemoryInspector";

// The Memory surface — the lake as a main-pane citizen (Memory-as-a-Second-
// Brain P1+P2+P4+P5+P6). Five tabs: Ask (one persisted conversation over the
// lake + catalog, whose citation chips drive the Timeline — see
// MemoryAsk.tsx), the Timeline (faceted, searchable, grouped — including the
// §1.5 trail view — over the whole hash-chained history via the cursor-paged
// `ledger_query`), the Catalog (the class tree with the full curation
// cockpit — the held-proposal review strip is the terminus of the keeper's
// escalation channel: merges, uncertain collapses and supersessions queue
// there instead of auto-applying), the Map (the record's shape under §3's
// four rules — node clicks land back on the Timeline; see MemoryMap.tsx),
// and Health (the status the pill compresses, rendered in full, the P6
// Librarian attention strip — on-demand, advisory only — the catalog mass
// treemap, plus the portability sections shared with the quick inspector).
//
// Styling follows the Agent Seats language (hero header with the corner glow,
// hairline gradient seam, glow-dot markers, pill chips, paper-on-elevated
// inset cards); the primitives are copied in the house tradition.

const PAGE = 500;
const ROW_H = 30;
const OVERSCAN = 12;

interface MemorySurfaceProps {
  activeSessionId?: string | null;
  activeSessionName?: string | null;
}

/** The viewer's glow-dot (Agent Seats' primitive, copied). */
function GlowDot({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        width: "8px",
        height: "8px",
        borderRadius: "2px",
        flexShrink: 0,
        background: on ? "var(--color-info)" : "transparent",
        border: on ? "none" : "1px solid var(--color-rule)",
        boxShadow: on
          ? "0 0 8px color-mix(in srgb, var(--color-info) 70%, transparent)"
          : "none",
      }}
    />
  );
}

/** Agent Seats' pill chip, copied — `chipStyle(true)` doubles as primary. */
function chipStyle(active: boolean): React.CSSProperties {
  return {
    fontSize: "10px",
    padding: "2px 7px",
    borderRadius: "999px",
    cursor: "pointer",
    whiteSpace: "nowrap",
    border: active
      ? "1px solid color-mix(in srgb, var(--color-info) 55%, var(--color-rule))"
      : "1px solid var(--color-rule)",
    background: active
      ? "color-mix(in srgb, var(--color-info) 14%, transparent)"
      : "transparent",
    color: "var(--color-ink)",
  };
}

const eyebrowStyle: React.CSSProperties = {
  fontSize: "10px",
  fontWeight: 700,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: "var(--color-ink-muted)",
};

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="font-sans" style={{ display: "flex", gap: 8, fontSize: 12 }}>
      <span style={{ color: "var(--color-ink-muted)", flex: "0 0 92px" }}>{label}</span>
      <span
        style={{
          flex: 1,
          wordBreak: "break-all",
          fontFamily: mono ? "var(--font-mono, monospace)" : undefined,
          fontSize: mono ? 11 : undefined,
        }}
      >
        {value}
      </span>
    </div>
  );
}

/** One facet section: eyebrow + value chips with counts; one active at most. */
function FacetSection({
  title,
  entries,
  active,
  onPick,
  render,
}: {
  title: string;
  entries: [string, number][];
  active: string | null;
  onPick: (v: string | null) => void;
  render?: (v: string) => React.ReactNode;
}) {
  if (!entries.length) return null;
  return (
    <div style={{ padding: "10px 12px 2px" }}>
      <div className="font-sans" style={{ ...eyebrowStyle, marginBottom: 6 }}>
        {title}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {entries.map(([v, count]) => (
          <button
            key={v}
            type="button"
            className="font-sans"
            onClick={() => onPick(active === v ? null : v)}
            title={`${v} — ${count}`}
            style={{ ...chipStyle(active === v), maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }}
          >
            {render ? render(v) : v} <span style={{ color: "var(--color-ink-muted)" }}>{count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// --- Timeline --------------------------------------------------------------

interface ThreadTreeView {
  node: { kind: string; id: string; label: string | null; messageCount: number };
  parent: { kind: string; id: string; label: string | null } | null;
  children: { kind: string; id: string; label: string | null; messageCount: number }[];
}

function TimelineTab({
  focus,
  onClearFocus,
}: {
  /** A citation-chip jump from the Ask tab — narrows the query to its
   *  evidence until dismissed. */
  focus: TimelineFocus | null;
  onClearFocus: () => void;
}) {
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [stats, setStats] = useState<ContextStats | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [grouping, setGrouping] = usePersistedState<Grouping>(
    "redline.memory.grouping",
    "day",
  );
  const [fKind, setFKind] = useState<string | null>(null);
  const [fAuthor, setFAuthor] = useState<string | null>(null);
  const [fSurface, setFSurface] = useState<string | null>(null);
  const [fProject, setFProject] = useState<string | null>(null);
  const [fDay, setFDay] = useState<string | null>(null);
  const [fStarred, setFStarred] = useState(false);
  const [fNoted, setFNoted] = useState(false);
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [selected, setSelected] = useState<TimelineItem | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [lineage, setLineage] = useState<ThreadTreeView | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerText, setComposerText] = useState("");

  useEffect(() => {
    const t = window.setTimeout(() => setQDebounced(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q]);

  const filters = useMemo<LedgerFilters>(
    () => ({
      ...(fKind ? { kind: fKind } : {}),
      ...(fAuthor ? { author: fAuthor } : {}),
      ...(fSurface ? { surface: fSurface } : {}),
      ...(fProject ? { project: fProject } : {}),
      ...(qDebounced ? { q: qDebounced } : {}),
      ...(fDay ? dayBounds(fDay) : {}),
      ...(fStarred ? { starred: true } : {}),
      ...(fNoted ? { noted: true } : {}),
      ...(focus?.seqs?.length ? { seqs: focus.seqs } : {}),
      ...(focus?.classNodeId ? { classNode: focus.classNodeId } : {}),
      ...(focus?.sessionId ? { sessionId: focus.sessionId } : {}),
      ...(focus?.threadId ? { threadId: focus.threadId } : {}),
      ...(focus?.browseId ? { browseId: focus.browseId } : {}),
      limit: PAGE,
    }),
    [fKind, fAuthor, fSurface, fProject, qDebounced, fDay, fStarred, fNoted, focus],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [page, s] = await Promise.all([
        invoke<TimelineItem[]>("ledger_query", { filters }),
        invoke<ContextStats>("context_stats"),
      ]);
      setItems(page);
      setStats(s);
      setHasMore(page.length === PAGE);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
    const un = listen("ledger-changed", () => void load());
    return () => void un.then((f) => f());
  }, [load]);

  const loadMore = useCallback(async () => {
    const last = items[items.length - 1];
    if (!last || loading) return;
    setLoading(true);
    try {
      const page = await invoke<TimelineItem[]>("ledger_query", {
        filters: { ...filters, beforeSeq: last.seq },
      });
      setItems((prev) => [...prev, ...page]);
      setHasMore(page.length === PAGE);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [items, filters, loading]);

  const openEvent = useCallback(async (it: TimelineItem) => {
    setSelected(it);
    setBody(null);
    setLineage(null);
    setNoteDraft(it.note ?? "");
    if (it.promptId != null) {
      try {
        setBody(await invoke<string | null>("ledger_prompt_body", { id: it.promptId }));
      } catch (e) {
        setBody(`(could not load body: ${e})`);
      }
    }
    if (it.sessionId) {
      try {
        setLineage(
          await invoke<ThreadTreeView>("context_thread_tree", {
            kind: "session",
            id: it.sessionId,
          }),
        );
      } catch {
        /* lineage is best-effort garnish */
      }
    }
  }, []);

  const forget = useCallback(
    async (promptId: number) => {
      if (
        !window.confirm(
          "Forget this prompt's words? The fact that it happened stays in the ledger; only the text is released.",
        )
      )
        return;
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

  // One note/star act on the selected event. The command emits
  // `ledger-changed`, so the list refreshes itself; the open rail is patched
  // in place so the editor never snaps back to stale text.
  const noteAct = useCallback(
    async (act: NoteAct) => {
      if (!selected) return;
      const seq = selected.seq;
      try {
        const n = await invoke<UserNote>("memory_note_write", {
          write: noteOnEvent(seq, act),
        });
        setSelected((prev) =>
          prev && prev.seq === seq
            ? { ...prev, starred: n.starred, note: n.text || null }
            : prev,
        );
        setError(null);
      } catch (e) {
        setError(String(e));
      }
    },
    [selected],
  );

  // A single-event citation opens its detail rail once the row arrives, so
  // the chip lands the user ON the evidence, not merely near it. Ref-guarded
  // per focus so reloads (ledger-changed) don't re-steal the rail.
  const focusOpenedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focus) {
      focusOpenedRef.current = null;
      return;
    }
    if (focus.seqs?.length !== 1) return;
    const key = `s:${focus.seqs[0]}`;
    if (focusOpenedRef.current === key) return;
    const it = items.find((i) => i.seq === focus.seqs![0]);
    if (it) {
      focusOpenedRef.current = key;
      void openEvent(it);
    }
  }, [focus, items, openEvent]);

  const saveStandalone = useCallback(async () => {
    const text = composerText.trim();
    if (!text) return;
    try {
      await invoke<UserNote>("memory_note_write", { write: standaloneNote(text) });
      setComposerText("");
      setComposerOpen(false);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [composerText]);

  const rows = useMemo<TimelineRow[]>(() => groupItems(items, grouping), [items, grouping]);

  // Windowed rows (the CodeView discipline: the component owns scrollTop /
  // viewport height; `visibleRange` is pure math).
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { start, end } = visibleRange(scrollTop, viewportH, rows.length, ROW_H, OVERSCAN);

  const projects = useMemo<[string, number][]>(() => {
    const counts = new Map<string, number>();
    for (const it of items) {
      if (it.projectPath) counts.set(it.projectPath, (counts.get(it.projectPath) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [items]);

  const ribbonDays = useMemo(() => (stats?.byDay ?? []).slice(-42), [stats]);
  const ribbonMax = useMemo(
    () => Math.max(1, ...ribbonDays.map(([, c]) => c)),
    [ribbonDays],
  );

  const projectName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      {/* Facet rail */}
      <div
        className="rl-thin-scroll-y"
        style={{
          width: 200,
          flexShrink: 0,
          overflowY: "auto",
          borderRight: "1px solid var(--color-rule)",
          paddingBottom: 12,
        }}
      >
        <FacetSection
          title="Kind"
          entries={stats?.byKind ?? []}
          active={fKind}
          onPick={setFKind}
          render={(v) => (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span
                aria-hidden
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 2,
                  background: KIND_COLOR[v] ?? "var(--color-ink-muted)",
                }}
              />
              {kindLabel(v)}
            </span>
          )}
        />
        {/* Your own marks — structural toggles, not value facets. */}
        <div style={{ padding: "10px 12px 2px" }}>
          <div className="font-sans" style={{ ...eyebrowStyle, marginBottom: 6 }}>
            Yours
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            <button
              type="button"
              className="font-sans"
              onClick={() => setFStarred((v) => !v)}
              aria-pressed={fStarred}
              title="Only starred events"
              style={chipStyle(fStarred)}
            >
              ★ Starred
            </button>
            <button
              type="button"
              className="font-sans"
              onClick={() => setFNoted((v) => !v)}
              aria-pressed={fNoted}
              title="Only events with your notes"
              style={chipStyle(fNoted)}
            >
              ✎ With notes
            </button>
          </div>
        </div>
        <FacetSection
          title="Actor"
          entries={stats?.byAuthor ?? []}
          active={fAuthor}
          onPick={setFAuthor}
        />
        <FacetSection
          title="Surface"
          entries={stats?.bySurface ?? []}
          active={fSurface}
          onPick={setFSurface}
        />
        <FacetSection
          title="Project"
          entries={projects}
          active={fProject}
          onPick={setFProject}
          render={projectName}
        />
      </div>

      {/* List column */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            borderBottom: "1px solid var(--color-rule)",
            flexShrink: 0,
          }}
        >
          <input
            className="font-sans"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search bodies…"
            style={{
              flex: 1,
              minWidth: 0,
              padding: "5px 9px",
              fontSize: 12,
              color: "var(--color-ink)",
              background: "var(--color-paper)",
              border: "1px solid var(--color-rule)",
              borderRadius: 6,
            }}
          />
          <div style={{ display: "flex", gap: 4 }}>
            {GROUPINGS.map((g) => (
              <button
                key={g}
                type="button"
                className="font-sans"
                onClick={() => setGrouping(g)}
                title={`Group by ${GROUPING_LABEL[g].toLowerCase()}`}
                style={{ ...chipStyle(grouping === g), fontSize: "11px" }}
              >
                {GROUPING_LABEL[g]}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="font-sans"
            onClick={() => setComposerOpen((v) => !v)}
            aria-expanded={composerOpen}
            title="Write a standalone note — a thought not attached to any event yet"
            style={{ ...chipStyle(composerOpen), fontSize: "11px" }}
          >
            ＋ Note
          </button>
        </div>

        {/* Citation focus from the Ask tab / node focus from the Map —
            dismissible, above every other filter so it's obvious why the
            list is narrow. */}
        {focus && (
          <div
            className="font-sans"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 12px",
              fontSize: 12,
              borderBottom: "1px solid color-mix(in srgb, var(--color-info) 45%, var(--color-rule))",
              background: "color-mix(in srgb, var(--color-info) 8%, transparent)",
              flexShrink: 0,
            }}
          >
            <span style={{ color: "var(--color-ink-muted)" }}>
              {focus.classNodeId
                ? "Filed under"
                : focus.sessionId || focus.threadId || focus.browseId
                  ? "From the map"
                  : "Evidence"}
            </span>
            <span style={{ fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {focus.label}
            </span>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              className="font-sans"
              onClick={onClearFocus}
              title="Back to the full Timeline"
              style={{ ...chipStyle(true), fontSize: "10px" }}
            >
              ✕ Clear
            </button>
          </div>
        )}

        {/* Standalone-note composer — what makes it a brain, not a margin. */}
        {composerOpen && (
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "flex-end",
              padding: "8px 12px",
              borderBottom: "1px solid var(--color-rule)",
              flexShrink: 0,
            }}
          >
            <textarea
              className="font-sans"
              value={composerText}
              onChange={(e) => setComposerText(e.target.value)}
              placeholder="A standalone thought — it joins the record as its own note…"
              rows={2}
              autoFocus
              style={{
                flex: 1,
                minWidth: 0,
                resize: "vertical",
                padding: "5px 9px",
                fontSize: 12,
                lineHeight: 1.5,
                color: "var(--color-ink)",
                background: "var(--color-paper)",
                border: "1px solid var(--color-rule)",
                borderRadius: 6,
              }}
            />
            <button
              type="button"
              className="font-sans"
              onClick={() => void saveStandalone()}
              disabled={!composerText.trim()}
              style={{
                ...chipStyle(true),
                fontSize: "11px",
                padding: "3px 12px",
                opacity: composerText.trim() ? 1 : 0.5,
              }}
            >
              Save note
            </button>
          </div>
        )}

        {/* Activity ribbon — doubles as the date filter. */}
        {ribbonDays.length > 1 && (
          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              gap: 2,
              height: 40,
              padding: "4px 12px 6px",
              borderBottom: "1px solid var(--color-rule)",
              flexShrink: 0,
            }}
          >
            {ribbonDays.map(([day, count]) => (
              <button
                key={day}
                type="button"
                onClick={() => setFDay((prev) => (prev === day ? null : day))}
                title={`${dayLabel(day)} — ${count} prompt${count === 1 ? "" : "s"}`}
                aria-pressed={fDay === day}
                style={{
                  flex: 1,
                  maxWidth: 14,
                  height: `${Math.max(12, (count / ribbonMax) * 100)}%`,
                  border: "none",
                  borderRadius: 2,
                  cursor: "pointer",
                  padding: 0,
                  background:
                    fDay === day
                      ? "var(--color-info)"
                      : "color-mix(in srgb, var(--color-info) 35%, transparent)",
                }}
              />
            ))}
            {fDay && (
              <button
                type="button"
                className="font-sans"
                onClick={() => setFDay(null)}
                style={{ ...chipStyle(true), fontSize: "10px", alignSelf: "center" }}
              >
                {dayLabel(fDay)} ✕
              </button>
            )}
          </div>
        )}

        {error && (
          <div
            className="font-sans"
            style={{ padding: "6px 12px", fontSize: 12, color: "var(--color-warning)" }}
          >
            {error}
          </div>
        )}

        {/* Windowed rows */}
        <div
          ref={scrollRef}
          className="rl-thin-scroll-y"
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          style={{ flex: 1, minHeight: 0, overflowY: "auto", position: "relative" }}
        >
          <div style={{ height: rows.length * ROW_H, position: "relative" }}>
            {rows.slice(start, end).map((row, i) => {
              const idx = start + i;
              const top = idx * ROW_H;
              if (row.type === "header") {
                return (
                  <div
                    key={row.key}
                    className="font-sans"
                    style={{
                      position: "absolute",
                      top,
                      left: 0,
                      right: 0,
                      height: ROW_H,
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "0 12px",
                      borderBottom: "1px solid var(--color-rule)",
                      background: "var(--color-bg-elevated)",
                      ...eyebrowStyle,
                    }}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {row.label}
                    </span>
                    <span style={{ fontWeight: 400 }}>{row.count}</span>
                    {row.meta && (
                      <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
                        {row.meta}
                      </span>
                    )}
                  </div>
                );
              }
              const it = row.item;
              const text =
                it.preview ?? it.title ?? it.url ?? [it.refKind, it.refId].filter(Boolean).join(" ");
              const isSel = selected?.seq === it.seq;
              return (
                <div
                  key={row.key}
                  className="font-sans"
                  onClick={() => void openEvent(it)}
                  style={{
                    position: "absolute",
                    top,
                    left: 0,
                    right: 0,
                    height: ROW_H,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "0 12px",
                    cursor: "pointer",
                    fontSize: 12,
                    borderBottom: "1px solid color-mix(in srgb, var(--color-rule) 45%, transparent)",
                    background: isSel
                      ? "color-mix(in srgb, var(--color-info) 10%, transparent)"
                      : "transparent",
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 2,
                      flexShrink: 0,
                      background: KIND_COLOR[it.kind] ?? "var(--color-ink-muted)",
                    }}
                  />
                  <span style={{ color: "var(--color-ink-muted)", flex: "0 0 76px" }}>
                    {fmtTime(it.ts)}
                  </span>
                  <span style={{ flex: "0 0 92px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {grouping === "trail" && it.action ? it.action : kindLabel(it.kind)}
                  </span>
                  <span
                    style={{
                      flex: "0 0 auto",
                      maxWidth: 90,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: "10.5px",
                      color: "var(--color-ink)",
                      background: "color-mix(in srgb, var(--color-info) 12%, transparent)",
                      border: "1px solid color-mix(in srgb, var(--color-info) 40%, var(--color-rule))",
                      borderRadius: 999,
                      padding: "0 7px",
                    }}
                  >
                    {it.author}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: text ? "var(--color-ink)" : "var(--color-ink-muted)",
                    }}
                  >
                    {text || "—"}
                  </span>
                  {it.starred && (
                    <span
                      aria-label="Starred"
                      style={{ fontSize: 11, color: "#e3b341", flexShrink: 0 }}
                    >
                      ★
                    </span>
                  )}
                  {it.note && (
                    <span
                      aria-label="Has your note"
                      title={it.note}
                      style={{ fontSize: 10, color: "var(--color-ink-muted)", flexShrink: 0 }}
                    >
                      ✎
                    </span>
                  )}
                  {it.compacted && (
                    <span style={{ fontSize: 10, color: "var(--color-ink-muted)", flexShrink: 0 }}>
                      gist
                    </span>
                  )}
                  {it.classTitle && (
                    <span
                      style={{
                        flexShrink: 0,
                        maxWidth: 110,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontSize: 10,
                        color: "var(--color-ink-muted)",
                        border: "1px solid var(--color-rule)",
                        borderRadius: 999,
                        padding: "0 6px",
                      }}
                    >
                      {it.classTitle}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {hasMore && (
            <div style={{ display: "flex", justifyContent: "center", padding: 10 }}>
              <button
                type="button"
                className="font-sans"
                onClick={() => void loadMore()}
                disabled={loading}
                style={{ ...chipStyle(false), fontSize: "11px", padding: "3px 12px" }}
              >
                {loading ? "Loading…" : "Load older events"}
              </button>
            </div>
          )}
          {!rows.length && !loading && (
            <div
              className="font-sans"
              style={{ padding: 24, fontSize: 12, color: "var(--color-ink-muted)" }}
            >
              {grouping === "trail"
                ? "No browsing trails match — trails appear once pages are captured under these filters."
                : "No events match these filters."}
            </div>
          )}
        </div>
      </div>

      {/* Detail rail */}
      {selected && (
        <div
          className="rl-thin-scroll-y"
          style={{
            width: 320,
            flexShrink: 0,
            overflowY: "auto",
            borderLeft: "1px solid var(--color-rule)",
            padding: "12px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              aria-hidden
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: KIND_COLOR[selected.kind] ?? "var(--color-ink-muted)",
              }}
            />
            <span className="font-sans" style={{ fontSize: 13, fontWeight: 600 }}>
              {kindLabel(selected.kind)} #{selected.seq}
            </span>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              className="font-sans"
              onClick={() => setSelected(null)}
              aria-label="Close detail"
              style={{
                border: "none",
                background: "transparent",
                color: "var(--color-ink-muted)",
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              ✕
            </button>
          </div>
          <Field label="When" value={fmtTime(selected.ts)} />
          <Field label="Author" value={selected.author} />
          {selected.surface && <Field label="Surface" value={selected.surface} />}
          {selected.projectPath && <Field label="Project" value={selected.projectPath} />}
          {selected.model && <Field label="Model" value={selected.model} />}
          {selected.sessionId && <Field label="Session" value={selected.sessionId} mono />}
          {selected.versionNumber != null && (
            <Field label="Version" value={`v${selected.versionNumber}`} />
          )}
          {selected.refKind && (
            <Field label="Reference" value={`${selected.refKind} ${selected.refId ?? ""}`} mono />
          )}
          {selected.url && <Field label="URL" value={selected.url} mono />}
          {selected.action && <Field label="Act" value={selected.action} />}
          {selected.classTitle && <Field label="Filed under" value={selected.classTitle} />}
          <Field label="Payload" value={selected.payloadHash} mono />
          <Field label="Entry" value={selected.entryHash} mono />
          <Field label="Prev" value={selected.prevHash} mono />

          {lineage && (lineage.parent || lineage.children.length > 0) && (
            <div style={{ marginTop: 4 }}>
              <div className="font-sans" style={{ ...eyebrowStyle, marginBottom: 6 }}>
                Lineage
              </div>
              <div
                className="font-sans"
                style={{
                  border: "1px solid var(--color-rule)",
                  borderRadius: 8,
                  background: "var(--color-paper)",
                  padding: "8px 10px",
                  fontSize: 12,
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                {lineage.parent && (
                  <div style={{ color: "var(--color-ink-muted)" }}>
                    ↑ {lineage.parent.label ?? `${lineage.parent.kind} ${lineage.parent.id.slice(0, 8)}`}
                  </div>
                )}
                <div>
                  {lineage.node.label ?? "This session"} ·{" "}
                  {lineage.node.messageCount} message{lineage.node.messageCount === 1 ? "" : "s"}
                </div>
                {lineage.children.map((c) => (
                  <div key={`${c.kind}:${c.id}`} style={{ color: "var(--color-ink-muted)" }}>
                    ↳ {c.label ?? c.kind} · {c.messageCount}
                  </div>
                ))}
              </div>
            </div>
          )}

          {(body != null || selected.preview != null) && (
            <div style={{ marginTop: 4 }}>
              <div className="font-sans" style={{ ...eyebrowStyle, marginBottom: 6 }}>
                {selected.compacted ? "Gist (body released)" : "Body"}
              </div>
              <pre
                className="font-sans"
                style={{
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontSize: 12,
                  lineHeight: 1.5,
                  border: "1px solid var(--color-rule)",
                  borderRadius: 8,
                  background: "var(--color-paper)",
                  padding: "8px 10px",
                  margin: 0,
                }}
              >
                {body ?? selected.preview}
              </pre>
            </div>
          )}

          {/* Your note — the margin over the record (P3). Star and words are
              the same row; each act appends its own `note` ledger event. */}
          <div style={{ marginTop: 4 }}>
            <div
              className="font-sans"
              style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}
            >
              <span style={eyebrowStyle}>Your note</span>
              <div style={{ flex: 1 }} />
              <button
                type="button"
                className="font-sans"
                onClick={() => void noteAct({ starred: !selected.starred })}
                aria-pressed={selected.starred}
                title={selected.starred ? "Unstar this event" : "Star this event"}
                style={{
                  ...chipStyle(selected.starred),
                  color: selected.starred ? "#e3b341" : "var(--color-ink)",
                }}
              >
                {selected.starred ? "★ Starred" : "☆ Star"}
              </button>
            </div>
            <textarea
              className="font-sans"
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="Write a margin note on this event…"
              rows={3}
              style={{
                width: "100%",
                boxSizing: "border-box",
                resize: "vertical",
                padding: "8px 10px",
                fontSize: 12,
                lineHeight: 1.5,
                color: "var(--color-ink)",
                background: "var(--color-paper)",
                border: "1px solid var(--color-rule)",
                borderRadius: 8,
              }}
            />
            {noteDraft !== (selected.note ?? "") && (
              <button
                type="button"
                className="font-sans"
                onClick={() => void noteAct({ text: noteDraft })}
                style={{
                  ...chipStyle(true),
                  fontSize: "11px",
                  padding: "3px 12px",
                  marginTop: 6,
                }}
              >
                Save note
              </button>
            )}
          </div>

          {selected.promptId != null && !selected.compacted && (
            <button
              type="button"
              className="font-sans"
              onClick={() => void forget(selected.promptId!)}
              style={{ ...chipStyle(false), fontSize: "11px", alignSelf: "flex-start" }}
            >
              Forget body…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// --- Catalog ---------------------------------------------------------------

/** The dead pane's mini action button, revived (small square, not a pill). */
function ActionBtn({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className="font-sans"
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
        flexShrink: 0,
      }}
    >
      {label}
    </button>
  );
}

const AMBER = "#e0913a";

type ActFn = (cmd: string, args: Record<string, unknown>) => void;

/** One held structural proposal: op badge, subject, rationale, digest preview
 *  + citations (collapse), the seq pair (supersede), and accept/reject. */
function ProposalCard({ p, now, onAct }: { p: ProposalView; now: number; onAct: ActFn }) {
  return (
    <div
      className="font-sans"
      style={{
        border: "1px solid color-mix(in srgb, #7c5cff 35%, var(--color-rule))",
        borderRadius: 8,
        background: "var(--color-paper)",
        padding: "8px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            padding: "1px 7px",
            borderRadius: 999,
            color: "#fff",
            background: "#7c5cff",
            flexShrink: 0,
          }}
        >
          {OP_LABEL[p.op] ?? p.op}
        </span>
        <span
          style={{
            fontWeight: 600,
            fontSize: 13,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {proposalSubject(p)}
        </span>
        <span style={{ fontSize: 11, color: "var(--color-ink-muted)", flexShrink: 0 }}>
          staged {relativeTime(p.createdAt, now)}
        </span>
        <div style={{ flex: 1 }} />
        <ActionBtn label="✓ Accept" title="Apply this reorganization" onClick={() => onAct("classmem_accept_proposal", { id: p.id })} />
        <ActionBtn label="✕ Reject" title="Drop this proposal (the rejection is recorded)" onClick={() => onAct("classmem_reject_proposal", { id: p.id })} />
      </div>
      {p.op === "supersede" && supersedeLabel(p.extraJson) && (
        <div style={{ fontSize: 12 }}>
          {supersedeLabel(p.extraJson)} — the newer decision replaces the older (never erased)
        </div>
      )}
      {p.rationale && (
        <div style={{ color: "var(--color-ink-muted)", fontSize: 12 }}>{p.rationale}</div>
      )}
      {p.op === "collapse" && (
        <>
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
            <div style={{ fontSize: 11, color: "var(--color-ink-muted)" }}>
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
        </>
      )}
    </div>
  );
}

interface NodeDetail {
  links: LinkView[];
  children: ClassNode[];
  observations: Observation[];
}

function CatalogTab() {
  const [nodes, setNodes] = useState<ClassNode[]>([]);
  const [proposals, setProposals] = useState<ProposalView[]>([]);
  const [run, setRun] = useState<ClassRun | null>(null);
  const [autoApply, setAutoApply] = useState(true);
  const [organizing, setOrganizing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());

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

  const openNode = useCallback(async (id: string) => {
    setSelected(id);
    setDetail(null);
    try {
      const d = await invoke<NodeDetail>("classmem_node", { id });
      setDetail({ links: d.links, children: d.children, observations: d.observations ?? [] });
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // Curation actions reload the open node themselves; the tree/proposal lists
  // refresh through the classmem-changed event every action emits.
  const act = useCallback<ActFn>(
    async (cmd, args) => {
      try {
        await invoke(cmd, args);
        if (selected) void openNode(selected);
      } catch (e) {
        setError(String(e));
      }
    },
    [selected, openNode],
  );

  useEffect(() => {
    void load();
    void invoke<boolean>("classmem_get_auto_apply").then(setAutoApply).catch(() => {});
    const un = listen("classmem-changed", () => void load());
    return () => void un.then((f) => f());
  }, [load]);

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

  const toggleAutoApply = useCallback(async () => {
    const next = !autoApply;
    setAutoApply(next);
    try {
      await invoke("classmem_set_auto_apply", { enabled: next });
    } catch {
      setAutoApply(!next); // revert on failure
    }
  }, [autoApply]);

  const rename = useCallback(
    (node: TreeNode | ClassNode) => {
      const title = window.prompt("Rename class", node.title);
      if (title && title.trim()) act("classmem_rename_node", { id: node.id, title: title.trim() });
    },
    [act],
  );

  const tree = useMemo(() => buildTree(nodes), [nodes]);
  const selectedNode = selected ? nodes.find((n) => n.id === selected) : undefined;

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

  // The per-row trailing cluster injected into the shared tree rows: proposed
  // classes get their verdict buttons; accepted ones get pin + rename.
  const rowActions = useCallback(
    (n: TreeNode) => (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
        {n.status === "proposed" ? (
          <>
            <span
              style={{
                fontSize: 10,
                padding: "0 6px",
                borderRadius: 999,
                color: "#fff",
                background: AMBER,
              }}
            >
              proposed
            </span>
            <ActionBtn label="✓" title="Accept class" onClick={() => act("classmem_accept_node", { id: n.id })} />
            <ActionBtn label="✕" title="Reject class" onClick={() => act("classmem_reject_node", { id: n.id })} />
          </>
        ) : (
          <>
            <ActionBtn
              label={n.pinned ? "📌" : "📍"}
              title={n.pinned ? "Unpin" : "Pin (anti-decay)"}
              onClick={() => act("classmem_pin_node", { id: n.id, pinned: !n.pinned })}
            />
            <ActionBtn label="✎" title="Rename class" onClick={() => rename(n)} />
          </>
        )}
      </span>
    ),
    [act, rename],
  );

  const now = Date.now();
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
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {/* Toolbar: Organize + auto-apply, over the whole catalog. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 16px",
          borderBottom: "1px solid var(--color-rule)",
          flexShrink: 0,
        }}
      >
        <span className="font-sans" style={{ fontSize: 12, color: "var(--color-ink-muted)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {nodes.length} class{nodes.length === 1 ? "" : "es"}
          {run?.summary ? ` · last run: ${run.summary}` : ""}
        </span>
        <label
          className="font-sans"
          style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer", flexShrink: 0 }}
          title="On: Organize files new lake items directly (destructive reorgs still wait below). Off: everything stages for review."
        >
          <input
            type="checkbox"
            checked={autoApply}
            onChange={() => void toggleAutoApply()}
            style={{ accentColor: "var(--color-info)" }}
          />
          Auto-organize
        </label>
        <button
          type="button"
          className="font-sans"
          onClick={() => void organize()}
          disabled={organizing}
          style={{ ...chipStyle(true), fontSize: "11px", padding: "3px 12px", cursor: organizing ? "wait" : "pointer" }}
        >
          {organizing ? "Organizing…" : "Organize now"}
        </button>
      </div>

      {notice && (
        <div
          className="font-sans"
          style={{
            padding: "6px 16px",
            fontSize: 12,
            background: "color-mix(in srgb, var(--color-info) 10%, transparent)",
            borderBottom: "1px solid var(--color-rule)",
            flexShrink: 0,
          }}
        >
          {notice}
        </div>
      )}
      {error && (
        <div className="font-sans" style={{ padding: "6px 16px", fontSize: 12, color: "var(--color-warning)", flexShrink: 0 }}>
          {error}
        </div>
      )}

      {/* The held-proposal review strip — the escalation channel's terminus.
          Prominent when anything is queued; a quiet promise when nothing is. */}
      {proposals.length > 0 ? (
        <div
          className="rl-thin-scroll-y"
          style={{
            flexShrink: 0,
            maxHeight: "42%",
            overflowY: "auto",
            padding: "10px 16px 12px",
            borderBottom: `2px solid color-mix(in srgb, ${AMBER} 55%, var(--color-rule))`,
            background: `color-mix(in srgb, ${AMBER} 6%, transparent)`,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div className="font-sans" style={{ ...eyebrowStyle, color: AMBER }}>
            Held for review · {proposals.length}
          </div>
          <div className="font-sans" style={{ fontSize: 12, color: "var(--color-ink-muted)" }}>
            The keeper never applies these on its own — each one reshapes or retires part of
            the catalog, so it waits for your verdict.
          </div>
          {proposals.map((p) => (
            <ProposalCard key={p.id} p={p} now={now} onAct={act} />
          ))}
        </div>
      ) : (
        <div
          className="font-sans"
          style={{
            flexShrink: 0,
            padding: "6px 16px",
            fontSize: 11,
            color: "var(--color-ink-muted)",
            borderBottom: "1px solid var(--color-rule)",
          }}
        >
          Nothing held for review — merges, uncertain collapses and supersessions queue here
          instead of auto-applying.
        </div>
      )}

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Tree column (the toolbar stays outside the scroll container). */}
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
              flexShrink: 0,
            }}
          >
            <span className="font-sans" style={{ flex: 1, minWidth: 0 }}>
              Every change is recorded in the ledger · reversible
            </span>
            <button className="font-sans" style={treeCtlBtn} onClick={() => setCollapsedIds(new Set())} title="Expand every branch">
              Expand all
            </button>
            <button className="font-sans" style={treeCtlBtn} onClick={collapseAll} title="Collapse to the root classes">
              Collapse all
            </button>
          </div>
          <div className="rl-thin-scroll-y" style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
            {tree.length === 0 ? (
              <div className="font-sans" style={{ padding: 16, color: "var(--color-ink-muted)", fontSize: 13 }}>
                No classes yet. Click <b>Organize now</b> to seed one class per repo and let
                the keeper build a tree over your captured prompts
                {autoApply ? " — it organizes on its own; curate here only if you want." : " for you to review."}
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
                  actions={rowActions}
                />
              ))
            )}
          </div>
        </div>

        {/* Detail rail: the selected class's pointers into the lake. */}
        <div className="rl-thin-scroll-y" style={{ flex: "1 1 48%", overflowY: "auto", padding: 12, fontSize: 13, minWidth: 0 }}>
          {!selected || !selectedNode ? (
            <div className="font-sans" style={{ color: "var(--color-ink-muted)" }}>
              Select a class to see what it points at in the lake.
            </div>
          ) : (
            <div className="font-sans" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {selectedNode.title}
                </span>
                {selectedNode.pinned && <span title="Pinned (anti-decay)">📌</span>}
                <div style={{ flex: 1 }} />
                {selectedNode.status !== "proposed" && (
                  <>
                    <ActionBtn
                      label={selectedNode.pinned ? "📌 Unpin" : "📍 Pin"}
                      title={selectedNode.pinned ? "Unpin" : "Pin (anti-decay)"}
                      onClick={() => act("classmem_pin_node", { id: selectedNode.id, pinned: !selectedNode.pinned })}
                    />
                    <ActionBtn label="✎ Rename" title="Rename class" onClick={() => rename(selectedNode)} />
                  </>
                )}
              </div>
              {selectedNode.summary && (
                <div style={{ fontSize: 12, color: "var(--color-ink-muted)" }}>{selectedNode.summary}</div>
              )}
              {detail == null ? (
                <div style={{ color: "var(--color-ink-muted)" }}>Loading…</div>
              ) : (
                <>
                  {detail.children.length > 0 && (
                    <div style={{ color: "var(--color-ink-muted)", fontSize: 12 }}>
                      {detail.children.length} sub-class{detail.children.length === 1 ? "" : "es"}
                    </div>
                  )}
                  {detail.links.length === 0 &&
                    detail.children.length === 0 &&
                    detail.observations.length === 0 && (
                      <div style={{ color: "var(--color-ink-muted)" }}>No links yet — a container class.</div>
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
                        background: l.status === "proposed" ? `color-mix(in srgb, ${AMBER} 8%, transparent)` : "transparent",
                      }}
                    >
                      <span style={{ flex: "0 0 auto", fontSize: 10, textTransform: "uppercase", color: "var(--color-ink-muted)" }}>
                        {l.targetKind}
                      </span>
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          // Superseded decisions are history, not the answer — mute them.
                          color: l.supersededBy != null ? "var(--color-ink-muted)" : undefined,
                        }}
                      >
                        {l.label ?? `#${l.targetId}`}
                      </span>
                      {l.supersededBy != null && (
                        <span
                          title={`This decision was superseded by ledger event #${l.supersededBy}. It stays in the lake as history.`}
                          style={{ flex: "0 0 auto", fontSize: 10, padding: "0 6px", borderRadius: 999, color: "#fff", background: "#8a8f98" }}
                        >
                          superseded → #{l.supersededBy}
                        </span>
                      )}
                      {l.supersededBy != null && selectedNode.pinned && (
                        <span
                          title="You pinned this class, and one of its decisions is now marked superseded — worth a look."
                          style={{ flex: "0 0 auto", fontSize: 10, padding: "0 6px", borderRadius: 999, color: "#fff", background: AMBER }}
                        >
                          pinned · superseded
                        </span>
                      )}
                      {l.status === "proposed" ? (
                        <>
                          <ActionBtn label="✓" title="Accept link" onClick={() => act("classmem_accept_link", { linkId: l.id })} />
                          <ActionBtn label="✕" title="Reject link" onClick={() => act("classmem_reject_link", { linkId: l.id })} />
                        </>
                      ) : (
                        <ActionBtn
                          label="Unfile"
                          title="Unfile this link (rolls back the gardener; keeps the ledger intact)"
                          onClick={() => act("memory_revert_link", { linkId: l.id })}
                        />
                      )}
                    </div>
                  ))}
                  {detail.observations.length > 0 && (
                    <>
                      <div style={{ color: "var(--color-ink-muted)", marginTop: 8, marginBottom: 2, fontSize: 12 }}>
                        Patterns (agent-derived — hypotheses, not facts)
                      </div>
                      {sortObservations(detail.observations).map((o) => (
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
                          <ActionBtn
                            label={o.pinned ? "📌" : "📍"}
                            title={o.pinned ? "Unpin pattern" : "Pin pattern (promote into this class's permanent context)"}
                            onClick={() => act("classmem_pin_observation", { id: o.id, pinned: !o.pinned })}
                          />
                          <ActionBtn
                            label="✕"
                            title="Dismiss pattern (never resurfaces)"
                            onClick={() => act("classmem_dismiss_observation", { id: o.id })}
                          />
                        </div>
                      ))}
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Health ----------------------------------------------------------------

/** The survey in flight, held at module scope: the Health tab unmounts on
 *  every tab switch, and a Librarian run is a minute-long billed agent spawn
 *  whose result lands nowhere else — dropping it with the component would
 *  silently discard the run. The resolved run also lands in localStorage
 *  (stamped with when it ran) so the last survey stays readable across
 *  restarts. Never rejects: failures resolve as `{ error }`, so a survey that
 *  settles while the strip is unmounted can't become an unhandled rejection —
 *  the error is parked in `lastSurveyError` for the next mount instead. */
type SurveyOutcome = { run: LibrarianRun | null; error: string | null };
let surveyInFlight: Promise<SurveyOutcome> | null = null;
let lastSurveyError: string | null = null;

function startSurvey(): Promise<SurveyOutcome> {
  if (!surveyInFlight) {
    surveyInFlight = invoke<unknown>("librarian_agent")
      .then((reply): SurveyOutcome => {
        const run = coerceRun(reply, Date.now());
        // Rust's parse_checklist returns an empty default when the agent's
        // reply carried no JSON at all — indistinguishable from a real
        // all-clear only by the missing summary. Surface it, don't store it.
        if (!run || (!run.summary && run.checklist.length === 0)) {
          return { run: null, error: "the Librarian's reply carried no readable checklist" };
        }
        try {
          localStorage.setItem(LIBRARIAN_STORE_KEY, JSON.stringify(run));
        } catch {
          /* persistence is a convenience; the in-memory run still renders */
        }
        return { run, error: null };
      })
      .catch((e): SurveyOutcome => ({ run: null, error: String(e) }))
      .then((outcome) => {
        lastSurveyError = outcome.error;
        return outcome;
      })
      .finally(() => {
        surveyInFlight = null;
      });
  }
  return surveyInFlight;
}

/** The Librarian attention strip — P6's UI over `librarian_agent`. On-demand
 *  only: one click, one read-only headless run over the ground-truth friction
 *  digest, a ranked checklist back. Advisory only is the module's hard
 *  constraint (librarian.rs records why the Loop Orchestrator was pulled):
 *  the strip states what is unreconciled and can walk the user to the
 *  Catalog, but nothing here dispatches work. */
function LibrarianStrip({ onOpenCatalog }: { onOpenCatalog: () => void }) {
  const [run, setRun] = useState<LibrarianRun | null>(() =>
    parseStoredRun(localStorage.getItem(LIBRARIAN_STORE_KEY)),
  );
  const [running, setRunning] = useState(() => surveyInFlight != null);
  const [error, setError] = useState<string | null>(() => lastSurveyError);

  // Re-attach to a survey started before the last tab switch.
  useEffect(() => {
    if (!surveyInFlight) return;
    let alive = true;
    void surveyInFlight.then((outcome) => {
      if (!alive) return;
      setRunning(false);
      if (outcome.run) setRun(outcome.run);
      setError(outcome.error);
    });
    return () => {
      alive = false;
    };
  }, []);

  const survey = () => {
    setRunning(true);
    setError(null);
    void startSurvey().then((outcome) => {
      setRunning(false);
      if (outcome.run) setRun(outcome.run);
      setError(outcome.error);
    });
  };

  const now = Date.now();
  return (
    <div style={{ padding: "0 16px 4px", flexShrink: 0 }}>
      <div
        style={{
          border: "1px solid var(--color-rule)",
          borderRadius: 8,
          background: "var(--color-paper)",
          padding: "10px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div className="font-sans" style={eyebrowStyle}>
            Needs attention
          </div>
          {run && (
            <span
              className="font-sans"
              style={{ fontSize: 11, color: "var(--color-ink-muted)" }}
            >
              surveyed {relativeTime(run.ranAtMs, now)}
            </span>
          )}
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="font-sans"
            onClick={survey}
            disabled={running}
            style={{ ...chipStyle(!running), fontSize: "11px", padding: "3px 12px" }}
          >
            {running ? "Surveying…" : run ? "Survey again" : "Survey now"}
          </button>
        </div>
        {error && (
          <div className="font-sans" style={{ fontSize: 12, color: "var(--color-warning)" }}>
            {error}
          </div>
        )}
        {running ? (
          <div className="font-sans" style={{ fontSize: 12, color: "var(--color-ink-muted)" }}>
            The Librarian is reading the friction digest and ranking what's
            unreconciled — usually under a minute.
          </div>
        ) : run ? (
          <>
            {run.summary && (
              <div className="font-sans" style={{ fontSize: 12, lineHeight: 1.45 }}>
                {run.summary}
              </div>
            )}
            {run.checklist.length === 0 ? (
              <div className="font-sans" style={{ fontSize: 12, color: "var(--color-ink-muted)" }}>
                Nothing needs attention.
              </div>
            ) : (
              <ol
                style={{
                  listStyle: "none",
                  margin: 0,
                  padding: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                {run.checklist.map((item) => {
                  const tone = categoryTone(item.category);
                  const hint = actionHint(item.action);
                  return (
                    <li
                      key={item.priority}
                      style={{ display: "flex", alignItems: "baseline", gap: 8 }}
                    >
                      <span
                        className="font-sans"
                        style={{
                          flexShrink: 0,
                          width: 16,
                          textAlign: "right",
                          fontSize: 11,
                          color: "var(--color-ink-muted)",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {item.priority}
                      </span>
                      <span
                        className="font-sans"
                        style={{
                          flexShrink: 0,
                          fontSize: 10,
                          fontWeight: 600,
                          padding: "1px 7px",
                          borderRadius: 999,
                          whiteSpace: "nowrap",
                          color: tone,
                          border: `1px solid color-mix(in srgb, ${tone} 45%, var(--color-rule))`,
                          background: `color-mix(in srgb, ${tone} 10%, transparent)`,
                        }}
                      >
                        {categoryLabel(item.category)}
                      </span>
                      <span className="font-sans" style={{ flex: 1, fontSize: 12, lineHeight: 1.45 }}>
                        <span style={{ fontWeight: 600 }}>{item.title}</span>
                        {item.detail && (
                          <span style={{ color: "var(--color-ink-muted)" }}> — {item.detail}</span>
                        )}
                      </span>
                      {hint && (
                        <button
                          type="button"
                          className="font-sans"
                          onClick={onOpenCatalog}
                          style={{ ...chipStyle(false), fontSize: "10px", flexShrink: 0 }}
                        >
                          {hint.label} →
                        </button>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </>
        ) : (
          <div
            className="font-sans"
            style={{ fontSize: 12, lineHeight: 1.45, color: "var(--color-ink-muted)" }}
          >
            On demand, the Librarian surveys the workspace — held proposals,
            stalled reviews, the unorganized backlog, aging sessions, missions —
            and ranks what needs attention. Advisory only: it states what is
            unreconciled; it never dispatches work.
          </div>
        )}
      </div>
    </div>
  );
}

/** "Where does my memory live" — the catalog's root classes as a squarified
 *  treemap, area ∝ subtree mass (own + descendant filings). One of §3's two
 *  cheaper visuals; it reads the same `memory_map` payload the Map tab draws.
 *  A tile click filters the Timeline to that class (the Map's rule 4, applied
 *  here too). Dumb absolutely-positioned divs over the pure `squarify`. */
function TreemapCard({
  data,
  onCite,
}: {
  data: MemoryMapData | null;
  onCite: (f: TimelineFocus) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const HEIGHT = 180;
  const tiles = useMemo(
    () => (data && width > 0 ? squarify(rootMasses(data.nodes), width, HEIGHT) : []),
    [data, width],
  );
  const maxValue = tiles.length ? tiles[0].value : 1;

  return (
    <div style={{ padding: "0 16px 4px", flexShrink: 0 }}>
      <div
        style={{
          border: "1px solid var(--color-rule)",
          borderRadius: 8,
          background: "var(--color-paper)",
          padding: "10px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div className="font-sans" style={eyebrowStyle}>
          Where your memory lives
        </div>
        <div ref={ref} style={{ position: "relative", height: HEIGHT }}>
          {tiles.length === 0 ? (
            <div
              className="font-sans"
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                color: "var(--color-ink-muted)",
              }}
            >
              No accepted classes with filings yet — the treemap draws the
              catalog's mass.
            </div>
          ) : (
            tiles.map((t) => (
              <button
                key={t.id}
                type="button"
                className="font-sans"
                onClick={() => onCite({ classNodeId: t.id, label: t.label })}
                title={`${t.label} — ${t.value} filed · click to filter the Timeline`}
                style={{
                  position: "absolute",
                  left: t.x,
                  top: t.y,
                  width: Math.max(0, t.w - 2),
                  height: Math.max(0, t.h - 2),
                  border: "1px solid var(--color-rule)",
                  borderRadius: 4,
                  cursor: "pointer",
                  overflow: "hidden",
                  textAlign: "left",
                  padding: "3px 5px",
                  fontSize: 10,
                  lineHeight: 1.3,
                  color: "var(--color-ink)",
                  background: `color-mix(in srgb, var(--color-info) ${
                    6 + Math.round(26 * (t.value / maxValue))
                  }%, transparent)`,
                }}
              >
                {t.w > 52 && t.h > 24 && (
                  <>
                    <span
                      style={{
                        display: "block",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontWeight: 600,
                      }}
                    >
                      {t.label}
                    </span>
                    <span style={{ color: "var(--color-ink-muted)" }}>{t.value}</span>
                  </>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function HealthTab({
  status,
  activeSessionId,
  activeSessionName,
  onCite,
  onOpenCatalog,
}: {
  status: MemoryStatus | null;
  activeSessionId?: string | null;
  activeSessionName?: string | null;
  /** A treemap tile click lands on the Timeline filtered to that class. */
  onCite: (f: TimelineFocus) => void;
  /** The Librarian strip's action hints navigate here — never dispatch. */
  onOpenCatalog: () => void;
}) {
  const [verdict, setVerdict] = useState<ChainVerdict | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [captureExternal, setCaptureExternal] = useState<boolean | null>(null);
  const [mapData, setMapData] = useState<MemoryMapData | null>(null);
  const now = Date.now();

  useEffect(() => {
    void invoke<boolean>("ledger_get_capture_external")
      .then(setCaptureExternal)
      .catch(() => {});
  }, []);

  // The catalog mass rollup behind "where does my memory live" — the same
  // `memory_map` payload the Map tab draws, reduced to root masses here.
  useEffect(() => {
    const load = () =>
      void invoke<MemoryMapData>("memory_map").then(setMapData).catch(() => {});
    load();
    const un = listen("classmem-changed", load);
    return () => void un.then((f) => f());
  }, []);

  const verify = async () => {
    setVerifying(true);
    try {
      setVerdict(await invoke<ChainVerdict>("ledger_verify"));
    } finally {
      setVerifying(false);
    }
  };

  const toggleCapture = async (enabled: boolean) => {
    setCaptureExternal(enabled);
    try {
      await invoke("ledger_set_capture_external", { enabled });
    } catch {
      setCaptureExternal(!enabled);
    }
  };

  const card: React.CSSProperties = {
    border: "1px solid var(--color-rule)",
    borderRadius: 8,
    background: "var(--color-paper)",
    padding: "10px 12px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    flex: "1 1 260px",
    minWidth: 240,
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, padding: "12px 16px 4px", flexShrink: 0 }}>
        <div style={card}>
          <div className="font-sans" style={eyebrowStyle}>
            The lake
          </div>
          <Field label="Events" value={String(status?.itemCount ?? "—")} />
          <Field label="Backlog" value={`${status?.backlog ?? "—"} unorganized`} />
          <Field
            label="Organized"
            value={
              status?.lastOrganizedTs
                ? relativeTime(status.lastOrganizedTs, now)
                : "never"
            }
          />
          {status?.lastOrganizedSummary && (
            <div
              className="font-sans"
              style={{ fontSize: 12, lineHeight: 1.45, color: "var(--color-ink-muted)" }}
            >
              {status.lastOrganizedSummary}
            </div>
          )}
          <Field
            label="Compaction"
            value={
              status
                ? `${status.compactedCount} released · ${fmtBytes(status.reclaimedBytes)}${
                    status.lastCompactionTs
                      ? ` · ${relativeTime(status.lastCompactionTs, now)}`
                      : ""
                  }`
                : "—"
            }
          />
          <label
            className="font-sans"
            style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}
          >
            <input
              type="checkbox"
              checked={captureExternal ?? true}
              onChange={(e) => void toggleCapture(e.target.checked)}
              style={{ accentColor: "var(--color-info)" }}
            />
            Capture external claude sessions
          </label>
        </div>

        <div style={card}>
          <div className="font-sans" style={eyebrowStyle}>
            Chain integrity
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <GlowDot on={status?.chainOk ?? false} />
            <span className="font-sans" style={{ fontSize: 12 }}>
              {status ? (status.chainOk ? "Chain verifies" : "Chain BROKEN") : "—"}
            </span>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              className="font-sans"
              onClick={() => void verify()}
              disabled={verifying}
              style={{ ...chipStyle(true), fontSize: "11px", padding: "3px 12px" }}
            >
              {verifying ? "Verifying…" : "Verify now"}
            </button>
          </div>
          {verdict && (
            <>
              <div className="font-sans" style={{ fontSize: 12 }}>
                {describeVerdict(verdict)}
              </div>
              <Field label="Checked" value={String(verdict.checked)} />
              {verdict.headHash && <Field label="Head" value={verdict.headHash} mono />}
              {verdict.firstBadSeq != null && (
                <Field label="First bad" value={`seq ${verdict.firstBadSeq}`} />
              )}
            </>
          )}
        </div>
      </div>

      {/* The Librarian attention strip (P6) — on-demand, advisory only. */}
      <LibrarianStrip onOpenCatalog={onOpenCatalog} />

      {/* The catalog's mass, spatially (§3's cheap visual). */}
      <TreemapCard data={mapData} onCite={onCite} />

      {/* Portability — the same sections the quick inspector shows. */}
      <PortabilitySections
        activeSessionId={activeSessionId}
        activeSessionName={activeSessionName}
      />
    </div>
  );
}

// --- The surface -----------------------------------------------------------

type SurfaceTab = "ask" | "timeline" | "catalog" | "map" | "health";

export function MemorySurface({ activeSessionId, activeSessionName }: MemorySurfaceProps) {
  const [tab, setTab] = usePersistedState<SurfaceTab>(
    "redline.memory.surfaceTab",
    "timeline",
  );
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  // The Ask tab's citation-chip jump: set the focus, land on the Timeline.
  const [focus, setFocus] = useState<TimelineFocus | null>(null);
  const cite = useCallback(
    (f: TimelineFocus) => {
      setFocus(f);
      setTab("timeline");
    },
    [setTab],
  );

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await invoke<MemoryStatus>("memory_status"));
    } catch {
      /* the hero degrades to em-dashes */
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    // Debounced for the same reason as the pill's: a browse capture burst
    // emits one `memory-changed` per page, and the hero only needs the
    // settled number.
    let coalesce: number | undefined;
    const reload = () => {
      window.clearTimeout(coalesce);
      coalesce = window.setTimeout(() => void loadStatus(), 1_000);
    };
    const un = listen("memory-changed", reload);
    // Proposal verdicts emit only classmem-changed; the hero's held-for-review
    // count and the catalog chip badge must follow them too.
    const unClass = listen("classmem-changed", reload);
    return () => {
      window.clearTimeout(coalesce);
      void un.then((f) => f());
      void unClass.then((f) => f());
    };
  }, [loadStatus]);

  const now = Date.now();
  const held = status?.pendingProposals ?? 0;
  const sentence = status
    ? `${status.itemCount.toLocaleString()} event${status.itemCount === 1 ? "" : "s"} · chain ${
        status.chainOk ? "OK" : "BROKEN"
      } · organized ${status.lastOrganizedTs ? relativeTime(status.lastOrganizedTs, now) : "never"}${
        held > 0 ? ` · ${held} held for review` : ""
      }`
    : "Reading the lake…";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: "var(--color-bg-elevated)",
      }}
    >
      {/* Hero header — the Agent Seats corner glow + gradient wash. */}
      <header
        style={{
          position: "relative",
          flexShrink: 0,
          padding: "14px 20px 12px",
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
              boxShadow: "0 0 10px color-mix(in srgb, var(--color-info) 70%, transparent)",
            }}
          />
          Memory
        </div>
        <div
          className="font-sans"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            fontSize: "12px",
            color: "var(--color-ink-muted)",
            marginTop: "8px",
          }}
        >
          <span style={{ flex: 1 }}>{sentence}</span>
          <div style={{ display: "flex", gap: 4 }}>
            {(["ask", "timeline", "catalog", "map", "health"] as SurfaceTab[]).map((t) => (
              <button
                key={t}
                type="button"
                className="font-sans"
                onClick={() => setTab(t)}
                style={{ ...chipStyle(tab === t), fontSize: "11px", textTransform: "capitalize" }}
              >
                {t}
                {t === "catalog" && held > 0 && (
                  <span
                    title={`${held} proposal${held === 1 ? "" : "s"} held for review`}
                    style={{
                      marginLeft: 5,
                      padding: "0 5px",
                      borderRadius: 999,
                      fontSize: "10px",
                      color: "#fff",
                      background: "#e0913a",
                    }}
                  >
                    {held}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </header>
      {/* Hairline accent seam under the hero. */}
      <div
        aria-hidden
        style={{
          flexShrink: 0,
          height: "2px",
          opacity: 0.65,
          background:
            "linear-gradient(90deg, var(--color-info), color-mix(in srgb, var(--color-info) 20%, transparent))",
        }}
      />
      {tab === "ask" ? (
        <MemoryAsk onCite={cite} />
      ) : tab === "timeline" ? (
        <TimelineTab focus={focus} onClearFocus={() => setFocus(null)} />
      ) : tab === "catalog" ? (
        <CatalogTab />
      ) : tab === "map" ? (
        <MemoryMapTab onFocus={cite} />
      ) : (
        <HealthTab
          status={status}
          activeSessionId={activeSessionId}
          activeSessionName={activeSessionName}
          onCite={cite}
          onOpenCatalog={() => setTab("catalog")}
        />
      )}
    </div>
  );
}
