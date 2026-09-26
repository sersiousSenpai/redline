// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useId, useRef, useState } from "react";
import { Minus, Pencil, Plus, X } from "lucide-react";
import { BrowserDialog } from "./BrowserSurfaces";
import { MAX_GRID_SIDE, MAX_MOSAIC_TILES, type BrowserGrid } from "../lib/browserLayout";
import { buildMosaic, type Mosaic, type MosaicEntry, type MosaicSummary } from "../lib/browserMosaics";

// Both dialogs sit over the browser, so both go through BrowserDialog: a native
// page paints above React DOM and would hide anything that bypasses the kit.

function usedAgo(at: number, now = Date.now()): string {
  if (!at) return "Not opened yet";
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "Used just now";
  if (minutes < 60) return `Used ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Used ${hours} h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `Used ${days} d ago` : `Used ${new Date(at).toLocaleDateString()}`;
}
export const gridLabel = (grid: BrowserGrid) => `${grid.rows} × ${grid.cols}`;

export function MosaicManagerDialog({ mosaics, error, activeId, activeName, startupId, canSaveCurrent, onOpen, onEdit, onNew, onSaveCurrent, onDelete, onStartup, onLeave, onClose }: {
  mosaics: MosaicSummary[] | null; error: string | null; activeId: string | null; activeName: string | null; startupId: string | null; canSaveCurrent: boolean;
  onOpen: (id: string) => void; onEdit: (id: string) => void; onNew: () => void; onSaveCurrent: () => void;
  onDelete: (id: string) => void; onStartup: (id: string | null) => void; onLeave: () => void; onClose: () => void;
}) {
  const [deleting, setDeleting] = useState<MosaicSummary | null>(null);
  const startupName = useId();
  return <BrowserDialog title="Mosaics" subtitle="Save a set of pages as a grid and open all of them together." width={520} onClose={onClose}>
    {deleting ? <div>
      <h3 className="text-base font-medium">Delete “{deleting.name}”?</h3>
      <p className="rb-help">This removes the saved grid and its pages. Conversations about those pages stay in your history.</p>
      <div className="flex gap-2 mt-4"><button type="button" className="rb-button" onClick={() => setDeleting(null)}>Keep mosaic</button><button type="button" className="rb-button" style={{ color: "var(--color-danger)" }} onClick={() => { onDelete(deleting.id); setDeleting(null); }}>Delete mosaic</button></div>
    </div> : <>
      <div className="flex flex-wrap gap-2 mb-3">
        <button type="button" className="rb-button rb-button-primary" onClick={onNew}><Plus size={14} aria-hidden/>New mosaic</button>
        {!activeId && <button type="button" className="rb-button" onClick={onSaveCurrent} disabled={!canSaveCurrent}>Save these pages as a mosaic</button>}
        {activeId && <button type="button" className="rb-button" onClick={onLeave}>Close {activeName ? `“${activeName}”` : "this mosaic"}</button>}
      </div>
      {error && <p role="alert" className="rb-help" style={{ color: "var(--color-danger)" }}>{error}</p>}
      {mosaics === null ? <p className="rb-help" role="status">Loading saved mosaics…</p> : <div aria-label="Saved mosaics">
        {mosaics.map((item) => <div key={item.id} className="rb-setting" style={{ gap: 8 }}>
          <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpen(item.id)} style={{ background: "none", border: 0, color: "inherit", cursor: "pointer" }}>
            <span className="truncate">{item.name}</span>
            <small>{gridLabel(item.grid)} · {item.tabCount} {item.tabCount === 1 ? "page" : "pages"} · {item.id === activeId ? "Open now" : usedAgo(item.updatedAt)}</small>
          </button>
          <button type="button" className="rb-icon-button" aria-label={`Edit ${item.name}`} title="Edit" onClick={() => onEdit(item.id)}><Pencil size={14}/></button>
          <button type="button" className="rb-icon-button" aria-label={`Delete ${item.name}`} title="Delete" onClick={() => setDeleting(item)}><X size={14}/></button>
        </div>)}
        {!mosaics.length && <p className="rb-help">A mosaic keeps pages you check together, like a morning set of news sites, and opens them side by side in one click.</p>}
      </div>}
      {!!mosaics?.length && <fieldset className="rb-mosaic-startup">
        <legend>Open at startup</legend>
        <label><input type="radio" name={startupName} checked={!startupId} onChange={() => onStartup(null)}/>Regular browsing</label>
        {mosaics.map((item) => <label key={item.id}><input type="radio" name={startupName} checked={startupId === item.id} onChange={() => onStartup(item.id)}/><span className="truncate">{item.name}</span></label>)}
        <p className="rb-help" style={{ marginTop: 6 }}>Opens the first time you use the browser after Redline starts.</p>
      </fieldset>}
    </>}
  </BrowserDialog>;
}

function Stepper({ label, value, onChange }: { label: "rows" | "columns"; value: number; onChange: (value: number) => void }) {
  return <div className="rb-stepper" role="group" aria-label={label === "rows" ? "Rows" : "Columns"}>
    <span>{label === "rows" ? "Rows" : "Columns"}</span>
    <button type="button" className="rb-icon-button" aria-label={`Fewer ${label}`} disabled={value <= 1} onClick={() => onChange(value - 1)}><Minus size={14}/></button>
    <output aria-live="polite">{value}</output>
    <button type="button" className="rb-icon-button" aria-label={`More ${label}`} disabled={value >= MAX_GRID_SIDE} onClick={() => onChange(value + 1)}><Plus size={14}/></button>
  </div>;
}

export interface MosaicDraft { id: string; name: string; grid: BrowserGrid; entries: MosaicEntry[] }

export function MosaicEditDialog({ draft, previous, onSave, onCancel, createId }: {
  draft: MosaicDraft; previous: Mosaic | null; onSave: (mosaic: Mosaic) => Promise<void>; onCancel: () => void; createId: () => string;
}) {
  const [name, setName] = useState(draft.name);
  const [grid, setGrid] = useState(draft.grid);
  // Every slot keeps its text while the grid shrinks, so growing it back restores them.
  const [entries, setEntries] = useState<MosaicEntry[]>(() => Array.from({ length: MAX_MOSAIC_TILES }, (_, i) => draft.entries[i] ?? { url: "", label: "" }));
  const [error, setError] = useState<{ message: string; index?: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const fieldId = useId();
  const count = grid.rows * grid.cols;
  const filled = entries.slice(0, count).map((entry) => !!entry.url.trim());
  useEffect(() => { nameRef.current?.focus(); }, []);
  const save = async () => {
    if (saving) return;
    const result = buildMosaic({ id: draft.id, name, grid, entries, previous, createId });
    if ("error" in result) {
      setError({ message: result.error, index: result.index });
      document.getElementById(result.index === undefined ? `${fieldId}-name` : `${fieldId}-url-${result.index}`)?.focus();
      return;
    }
    setSaving(true); setError(null);
    try { await onSave(result.mosaic); }
    catch (reason) { setError({ message: `The mosaic could not be saved. ${String(reason)}` }); setSaving(false); }
  };
  const patch = (index: number, value: Partial<MosaicEntry>) => setEntries((prev) => prev.map((entry, i) => i === index ? { ...entry, ...value } : entry));
  return <BrowserDialog title={previous ? "Edit mosaic" : "New mosaic"} subtitle="Every page stays live. Opening the mosaic loads each one fresh from its address." width={600} onClose={onCancel} closeLabel="Cancel"
    footer={<button type="button" className="rb-button rb-button-primary" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save mosaic"}</button>}>
    <div className="flex min-w-0 flex-col gap-3" onKeyDown={(event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void save(); }
    }}>
      <label htmlFor={`${fieldId}-name`}>Name</label>
      <input ref={nameRef} id={`${fieldId}-name`} className="rb-field" value={name} maxLength={200} onChange={(event) => setName(event.target.value)} placeholder="e.g. Stock News"
        aria-invalid={error && error.index === undefined && !name.trim() ? true : undefined}/>
      <div className="rb-mosaic-shape">
        <div className="flex flex-col gap-2">
          <Stepper label="rows" value={grid.rows} onChange={(rows) => setGrid((prev) => ({ ...prev, rows }))}/>
          <Stepper label="columns" value={grid.cols} onChange={(cols) => setGrid((prev) => ({ ...prev, cols }))}/>
        </div>
        <span className="rb-layout-preview rb-mosaic-preview" aria-label={`${gridLabel(grid)} grid, ${filled.filter(Boolean).length} of ${count} filled`} role="img"
          style={{ gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${grid.rows}, minmax(0, 1fr))` }}>
          {filled.map((on, i) => <span key={i} data-empty={on ? undefined : true}/>)}
        </span>
      </div>
      <ol className="rb-mosaic-pages" aria-label="Pages">
        {entries.slice(0, count).map((entry, i) => <li key={i}>
          <span className="rb-mosaic-slot" aria-hidden>{i + 1}</span>
          <input id={`${fieldId}-url-${i}`} className="rb-field" value={entry.url} onChange={(event) => patch(i, { url: event.target.value })}
            aria-label={`Page ${i + 1} address (row ${Math.floor(i / grid.cols) + 1}, column ${(i % grid.cols) + 1})`} placeholder="Address, like wsj.com"
            spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-invalid={error?.index === i ? true : undefined}/>
          <input className="rb-field" value={entry.label} maxLength={80} onChange={(event) => patch(i, { label: event.target.value })}
            aria-label={`Page ${i + 1} label (optional)`} placeholder="Label (optional)"/>
        </li>)}
      </ol>
      {error && <p role="alert" className="rb-help" style={{ margin: 0, color: "var(--color-danger)" }}>{error.message}</p>}
      <p className="rb-help" style={{ margin: 0 }}>Leave a space empty to fill it later. ⌘ Enter or Ctrl Enter to save.</p>
    </div>
  </BrowserDialog>;
}
