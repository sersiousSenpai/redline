// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The page chat's pieces around its replies: the work rows under a reply's
//! text, the context a message carries, the status rail above the composer,
//! and the empty state. What each one shows comes from the structure layer
//! (`lib/browserChat/transcript.ts`); these only draw it.

import { useEffect, useState, type ReactNode } from "react";
import { ArrowDown, ChevronDown, ChevronRight, Image as ImageIcon, ListTodo, MousePointerClick, Quote, Target, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { cartKey } from "../lib/browseList";
import type { TurnChip, WorkRow, WorkStep } from "../lib/browserChat/transcript";
import type { BrowseListItem, BrowseListView } from "../types";
import { QueuePill, QueueRows, type QueueItem } from "./QueueTray";

// --- work rows ---------------------------------------------------------------

function Step({ step }: { step: WorkStep }) {
  return (
    <>
      <span className="rb-work-verb">{step.verb}</span>
      {step.object && <span className="rb-work-object"> {step.object}</span>}
    </>
  );
}

/** A reply's steps, under its text: one quiet line each, verb then object.
 *  Keyed by position, so a row that turns from one look into "Explored 2
 *  pages", or from a call into its outcome, changes in place. */
export function WorkRows({ rows }: { rows: readonly WorkRow[] }) {
  if (!rows.length) return null;
  return (
    <ul className="rb-work" data-work-rows>
      {rows.map((row, i) => (row.kind === "explored" ? <ExploredRow key={i} row={row} /> : (
        <li key={i} className="rb-work-row" data-failed={row.step.failed || undefined} title={`${row.step.verb} ${row.step.object}`.trim()}>
          <Step step={row.step} />
        </li>
      )))}
    </ul>
  );
}

/** "Explored 3 pages, 2 searches", which opens to the looks it folds. The one
 *  row that changes height, and only when the reader opens it. */
function ExploredRow({ row }: { row: Extract<WorkRow, { kind: "explored" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rb-work-row" data-explored>
      <button type="button" className="rb-work-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
        <span className="rb-work-verb">Explored</span>
        <span className="rb-work-object"> {row.object}</span>
      </button>
      {open && (
        <ul className="rb-work-folded">
          {row.steps.map((step, i) => (
            <li key={i} className="rb-work-row"><Step step={step} /></li>
          ))}
        </ul>
      )}
    </li>
  );
}

// --- the context a message carries -------------------------------------------

/** Data URLs for attachment files, read once per path: a card that remounts
 *  (a tab switch, a reload of the thread) draws its picture from memory. The
 *  newest few are kept; an older one is read again if it scrolls back. */
const pictures = new Map<string, Promise<string | null>>();
const PICTURES_KEEP = 24;
/** A picture file's bytes as a URL an <img> can draw. */
export function pictureUrl(path: string, base64: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return `data:image/${{ jpg: "jpeg", jpeg: "jpeg", gif: "gif", webp: "webp" }[ext] ?? "png"};base64,${base64}`;
}
function picture(path: string): Promise<string | null> {
  let read = pictures.get(path);
  if (!read) {
    read = invoke<{ data: string | null }>("read_file_base64", { path }).then(
      (file) => (file.data ? pictureUrl(path, file.data) : null),
      () => null,
    );
    if (pictures.size >= PICTURES_KEEP) pictures.delete(pictures.keys().next().value!);
    pictures.set(path, read);
  }
  return read;
}

/** A screenshot or an image in a box of its final size before the picture
 *  paints, so its arrival never moves the thread (BC-40). */
function Picture({ chip }: { chip: Extract<TurnChip, { path: string }> }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void picture(chip.path).then((url) => { if (current) setSrc(url); });
    return () => { current = false; };
  }, [chip.path]);
  return (
    <figure className="rb-picture" style={{ aspectRatio: `${chip.width} / ${chip.height}` }} title={`${chip.kind === "screenshot" ? "Screenshot" : "Image"} · ${chip.label}`}>
      {src ? <img src={src} alt={chip.label} /> : <figcaption>{chip.label}</figcaption>}
    </figure>
  );
}

const CHIP_ICONS: Record<TurnChip["kind"], ReactNode> = {
  quote: <Quote size={11} aria-hidden />,
  element: <MousePointerClick size={11} aria-hidden />,
  screenshot: <ImageIcon size={11} aria-hidden />,
  image: <ImageIcon size={11} aria-hidden />,
};

/** The chips a message carries, in the composer (removable) or in the
 *  user's card once sent. Pictures show as pictures in the card. */
export function TurnContext({ chips, onRemove, pictures = false }: { chips: readonly TurnChip[]; onRemove?: (chip: TurnChip) => void; pictures?: boolean }) {
  if (!chips.length) return null;
  const shown = pictures ? chips.filter((c) => !("path" in c)) : chips;
  return (
    <div className="rb-context">
      {pictures && chips.map((chip, i) => ("path" in chip ? <Picture key={`p${i}`} chip={chip} /> : null))}
      {shown.length > 0 && (
        <div className="rb-chips">
          {shown.map((chip, i) => (
            <span key={i} className="rb-chip" data-kind={chip.kind} title={chip.kind === "quote" ? chip.body.replace(/^> ?/gm, "") : chip.label}>
              {CHIP_ICONS[chip.kind]}
              <span className="rb-chip-label">{chip.label}</span>
              {onRemove && (
                <button type="button" className="rb-chip-x" aria-label={`Remove ${chip.label}`} onClick={() => onRemove(chip)}>
                  <X size={11} aria-hidden />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// --- the status rail -----------------------------------------------------------

/** The workspace's open Task-list items, read for the rail's count. `nonce`
 *  re-reads it after the pane wrote to the list. Reads only: an absent list
 *  stays absent until the Task list itself starts one. */
export function useTaskListPeek(workspace: string, nonce: number): BrowseListItem[] {
  const [items, setItems] = useState<BrowseListItem[]>([]);
  useEffect(() => {
    let current = true;
    void invoke<BrowseListView | null>("browse_list_get", { browseId: cartKey(workspace) }).then(
      (view) => { if (current) setItems(Array.isArray(view?.items) ? view.items.filter((item) => !item.done) : []); },
      () => {},
    );
    return () => { current = false; };
  }, [workspace, nonce]);
  return items;
}

export type RailTray = "queue" | "tasks" | "mission";

export interface RailMission {
  title: string;
  goal: string;
  findings: number;
  onOpen: () => void;
  onSynthesize: () => void;
}

/** Live state above the composer (BC-39): ↓ to the newest line, the queue,
 *  the Task list's count and the mission's goal. A zero-height anchor, so the
 *  rail and the tray it opens lie over the thread's bottom edge (which the
 *  thread keeps clear) instead of taking height from it. One tray at a time,
 *  opening upward; Esc closes it (the chat's key handler). */
export function StatusRail({
  following,
  newCount,
  onJump,
  queue,
  onUnqueue,
  tasks,
  onOpenTasks,
  mission,
  tray,
  onTray,
}: {
  following: boolean;
  newCount: number;
  onJump: () => void;
  queue: QueueItem[];
  onUnqueue: (id: string) => void;
  tasks: BrowseListItem[];
  onOpenTasks?: () => void;
  mission: RailMission | null;
  tray: RailTray | null;
  onTray: (tray: RailTray | null) => void;
}) {
  const toggle = (next: RailTray) => onTray(tray === next ? null : next);
  const open = tray === "queue" && queue.length ? "queue" : tray === "tasks" && tasks.length ? "tasks" : tray === "mission" && mission ? "mission" : null;
  if (following && !queue.length && !tasks.length && !mission) return null;
  return (
    <div className="rl-queue-anchor rb-rail-anchor" data-browser-chat-rail>
      <div className="rb-rail">
        {open && (
          <div className="rb-tray" key={open} data-tray={open}>
            {open === "queue" && <QueueRows rows={queue} onRemove={onUnqueue} />}
            {open === "tasks" && <TaskTray items={tasks} onOpen={onOpenTasks} />}
            {open === "mission" && mission && <GoalCard mission={mission} />}
          </div>
        )}
        <div className="rb-rail-row">
          {!following && (
            <button type="button" className="rb-rail-pill" data-jump aria-label={newCount ? `Jump to the newest message, ${newCount} new` : "Jump to the newest message"} title="Jump to the newest message (End)" onClick={onJump}>
              <ArrowDown size={12} aria-hidden />
              {newCount > 0 && <span>{newCount} new</span>}
            </button>
          )}
          {queue.length > 0 && (
            <div role="group" aria-label="Queued messages" className="rb-rail-group">
              <QueuePill rows={queue} open={open === "queue"} onToggle={() => toggle("queue")} compact={tasks.length > 0 || !!mission} />
            </div>
          )}
          {tasks.length > 0 && (
            <button type="button" className="rb-rail-pill" aria-expanded={open === "tasks"} onClick={() => toggle("tasks")}>
              <ListTodo size={12} aria-hidden />
              <span>Task list · {tasks.length}</span>
            </button>
          )}
          {mission && (
            <button type="button" className="rb-rail-pill" data-mission aria-expanded={open === "mission"} title={mission.goal || mission.title} onClick={() => toggle("mission")}>
              <Target size={12} aria-hidden />
              <span className="rb-rail-pill-text">{mission.title}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The Task list's open items by the page they were written on, and the way
 *  to the list itself. */
function TaskTray({ items, onOpen }: { items: BrowseListItem[]; onOpen?: () => void }) {
  const pages = new Map<string, BrowseListItem[]>();
  for (const item of items.slice(0, 8)) {
    const page = item.pageTitle || item.pageUrl || "No page";
    pages.set(page, [...(pages.get(page) ?? []), item]);
  }
  return (
    <div className="rb-tray-body" aria-label="Task list">
      {[...pages].map(([page, rows]) => (
        <section key={page}>
          <h3 className="rb-tray-heading">{page}</h3>
          <ul>{rows.map((item) => <li key={item.id}>{item.body.split("\n")[0]}</li>)}</ul>
        </section>
      ))}
      {items.length > 8 && <p className="rb-tray-more">and {items.length - 8} more</p>}
      {onOpen && <button type="button" className="rb-button" onClick={onOpen}>Open the Task list</button>}
    </div>
  );
}

/** The mission's goal, minimized to its pill until asked for, with
 *  Synthesize as the card's one primary action. */
function GoalCard({ mission }: { mission: RailMission }) {
  return (
    <div className="rb-tray-body" aria-label="Mission goal">
      <h3 className="rb-tray-title">{mission.title}</h3>
      {mission.goal && <p className="rb-tray-goal">{mission.goal}</p>}
      <div className="rb-tray-actions">
        <span className="rb-tray-more">{mission.findings === 1 ? "1 finding" : `${mission.findings} findings`}</span>
        <button type="button" className="rb-button" onClick={mission.onOpen}>Open mission</button>
        <button type="button" className="rb-button rb-button-primary" onClick={mission.onSynthesize}>Synthesize</button>
      </div>
    </div>
  );
}

// --- the empty state -----------------------------------------------------------

/** A new chat: the composer is the empty state. Above it, two or three things
 *  to start with and one muted tip. */
export function EmptyChat({ onSend, onMission }: { onSend: (text: string) => void; onMission?: () => void }) {
  return (
    <div className="rb-empty" data-browser-chat-empty>
      <div className="rb-suggestions" role="group" aria-label="Suggestions">
        <button type="button" className="rb-suggestion" onClick={() => onSend("Summarize this page.")}>Summarize this page</button>
        <button type="button" className="rb-suggestion" onClick={() => onSend("Extract the main table on this page as a markdown table.")}>Extract a table</button>
        {onMission && <button type="button" className="rb-suggestion" onClick={onMission}>Start a mission</button>}
      </div>
      <p className="rb-tip">Highlight text on the page and choose Ask to quote it here.</p>
    </div>
  );
}
