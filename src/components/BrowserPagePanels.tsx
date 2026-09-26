// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useState } from "react";
import { Pencil, Star, X } from "lucide-react";
import { BrowserDialog } from "./BrowserSurfaces";
import { arrangementTiles, type BrowserLayout, type BrowserPreset } from "../lib/browserLayout";

const arrangements: { preset: BrowserPreset; count: number; label: string }[] = [
  { preset: "browse", count: 1, label: "One page" },
  { preset: "compare", count: 2, label: "Two pages" },
  { preset: "research", count: 3, label: "Three pages" },
  { preset: "grid", count: 4, label: "Four pages" },
];
export function BrowserLayoutDialog({ layout, available, tabs = [], activeBrowseId = "", onChoose, onSaveDefault, onClose }: {
  layout: BrowserLayout; available: number; tabs?: { browseId: string; title: string }[]; activeBrowseId?: string; onChoose: (preset: BrowserPreset, count: number) => void; onSaveDefault: () => void; onClose: () => void;
}) {
  const [saved, setSaved] = useState(false);
  return <BrowserDialog title="Arrange pages" subtitle="Choose how many pages to see together. Chat stays where you left it." onClose={onClose}
    footer={<button type="button" className="rb-button" onClick={() => { onSaveDefault(); setSaved(true); }}>{saved ? "Default saved" : "Use as default"}</button>}>
    <div className="rb-layout-choices">{arrangements.map(({ preset, count, label }) => <button key={preset} type="button" className="rb-layout-choice" aria-pressed={(layout.preset === "discuss" ? "browse" : layout.preset) === preset} onClick={() => { setSaved(false); onChoose(preset, count); }}>
      <span className="rb-layout-preview" data-count={count} >{Array.from({ length: count }, (_, i) => { const id = arrangementTiles(layout, tabs.map(tab => tab.browseId), activeBrowseId, count)[i]; return <span key={i}>{tabs.find(tab => tab.browseId === id)?.title || "Empty"}</span>; })}</span><span>{label}</span>
    </button>)}</div>
    <p className="rb-help">Use the page titles to choose tabs, and drag the dividers to resize. {available < 4 ? "Open more tabs to fill additional spaces. " : ""}Smaller windows show fewer pages and restore your arrangement when expanded.</p>
  </BrowserDialog>;
}

export function BrowserPreferencesDialog({ selectionActions, onSelectionActions, onClose }: {
  selectionActions: boolean; onSelectionActions: (value: boolean) => void; onClose: () => void;
}) {
  return <BrowserDialog title="Browsing preferences" onClose={onClose}>
    <label className="rb-setting"><span>Actions on selected text<small>Show shortcuts to discuss, explain or save text when you select it on a page.</small></span><input type="checkbox" checked={selectionActions} onChange={(e) => onSelectionActions(e.target.checked)}/></label>
  </BrowserDialog>;
}

export function BrowserBookmarksDialog({ bookmarks, title, url, onSave, onRemove, onOpen, onClose }: {
  bookmarks: { title: string; url: string }[]; title: string; url: string; onSave: (url: string, title: string) => void; onRemove: (url: string) => void; onOpen: (url: string) => void; onClose: () => void;
}) {
  const [name, setName] = useState(title), [search, setSearch] = useState("");
  const [editing, setEditing] = useState<string | null>(null), [editName, setEditName] = useState("");
  const saved = bookmarks.some((item) => item.url === url);
  const filtered = bookmarks.filter((item) => `${item.title} ${item.url}`.toLowerCase().includes(search.toLowerCase()));
  return <BrowserDialog title="Bookmarks" onClose={onClose}>
    <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSave(url, name.trim()); }} className="mb-5">
      <label className="block mb-2 text-xs" htmlFor="rb-bookmark-name">{saved ? "Saved page name" : "Save the current page"}</label>
      <div className="flex gap-2"><input id="rb-bookmark-name" className="rb-field" value={name} onChange={(e) => setName(e.target.value)}/><button type="submit" className="rb-button" disabled={!name.trim()}><Star size={14}/>{saved ? "Update" : "Save"}</button></div>
      <p className="rb-help" style={{ marginTop: 6, overflowWrap: "anywhere" }}>{url}</p>
    </form>
    {bookmarks.length > 5 && <input className="rb-field mb-2" aria-label="Find a bookmark" placeholder="Find a bookmark" value={search} onChange={(e) => setSearch(e.target.value)}/>}
    <div aria-label="Saved pages">{filtered.map((bookmark) => <div key={bookmark.url} className="rb-setting" style={{ gap: 8 }}>
      {editing === bookmark.url ? <form className="flex flex-1 gap-2 min-w-0" onSubmit={(e) => { e.preventDefault(); if (editName.trim()) { onSave(bookmark.url, editName.trim()); setEditing(null); } }}><input className="rb-field" aria-label="Bookmark name" autoFocus value={editName} onChange={(e) => setEditName(e.target.value)}/><button className="rb-button" type="submit">Save</button></form>
        : <button type="button" className="min-w-0 flex-1 text-left" style={{ background: "none", border: 0, color: "inherit", cursor: "pointer" }} onClick={() => { onClose(); onOpen(bookmark.url); }}><span className="truncate">{bookmark.title}</span><small className="truncate">{bookmark.url}</small></button>}
      <button type="button" className="rb-icon-button" aria-label={`Rename ${bookmark.title}`} onClick={() => { setEditing(bookmark.url); setEditName(bookmark.title); }}><Pencil size={14}/></button>
      <button type="button" className="rb-icon-button" aria-label={`Remove ${bookmark.title}`} onClick={() => onRemove(bookmark.url)}><X size={14}/></button>
    </div>)}</div>
    {!filtered.length && <p className="rb-help">{bookmarks.length ? "No bookmarks match your search." : "Saved pages will appear here."}</p>}
  </BrowserDialog>;
}
