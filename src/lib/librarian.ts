// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
// The Librarian attention strip's pure layer (Memory-as-a-Second-Brain P6).
// `librarian_agent` (librarian.rs) runs the on-demand, advisory-only Librarian
// and returns its machine-parsed checklist; this module owns the FE types, the
// category vocabulary, and the one validator both entry points share — the
// wire reply (stamped with a fresh ranAtMs) and the localStorage copy that
// keeps the last survey readable across tab switches and restarts. The
// advisory-only constraint is load-bearing (librarian.rs records why): the
// strip may walk the user somewhere, it must never dispatch work — so
// `actionHint` maps action hints to in-surface destinations, never to spawns.

/** Mirrors `librarian::ChecklistItem` (librarian.rs). */
export type ChecklistItem = {
  /** 1-based rank; re-normalized to list order wherever the data enters. */
  priority: number;
  category: string;
  title: string;
  detail: string;
  action?: string;
  count?: number;
};

/** One finished survey: the Rust reply plus when it ran. */
export type LibrarianRun = {
  summary: string;
  checklist: ChecklistItem[];
  ranAtMs: number;
};

export const LIBRARIAN_STORE_KEY = "redline.memory.librarianRun";

const CATEGORY_LABEL: Record<string, string> = {
  held_proposal: "Held proposal",
  stalled_review: "Stalled review",
  unstructured_backlog: "Backlog",
  bulging_branch: "Bulging branch",
  aging_session: "Aging session",
  un_exported: "Un-exported",
  mission: "Mission",
  source_trust: "Source trust",
};

/** Human label for a friction category. The category field is free-form on
 *  the Rust side, so unknown values prettify instead of leaking snake_case. */
export function categoryLabel(category: string): string {
  const known = CATEGORY_LABEL[category];
  if (known) return known;
  const words = category.replace(/_/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Item";
}

/** Held destructive ops share the catalog badge's amber; stalled work warns;
 *  stewardship signals read informational; anything else stays muted. */
export function categoryTone(category: string): string {
  switch (category) {
    case "held_proposal":
      return "#e0913a"; // the held-for-review amber the catalog badge uses
    case "stalled_review":
    case "aging_session":
    case "bulging_branch":
      return "var(--color-warning)";
    case "unstructured_backlog":
    case "un_exported":
    case "mission":
      return "var(--color-info)";
    default:
      return "var(--color-ink-muted)";
  }
}

/** Where an action hint can take the user *inside the Memory surface*.
 *  Navigation only — `organize` opens the Catalog where the Organize button
 *  lives, it does not run the classifier. `open_session` carries no session
 *  id in the schema and `export_bundle`'s portability sections already sit on
 *  the same Health screen, so neither earns a chip. */
export function actionHint(
  action?: string,
): { label: string; target: "catalog" } | null {
  switch (action) {
    case "organize":
      return { label: "Organize in the Catalog", target: "catalog" };
    case "review_proposals":
      return { label: "Review in the Catalog", target: "catalog" };
    default:
      return null;
  }
}

/** Validate an untrusted run-shaped value — the wire reply or the stored
 *  copy. Mirrors `librarian::parse_checklist`'s tolerances: titleless items
 *  drop, categories default, `action: "none"` normalizes away, priorities
 *  re-rank to a clean 1..N in list order. A value with no usable timestamp
 *  (and no fallback) is rejected — a survey can't be described honestly
 *  without knowing when it ran. */
export function coerceRun(v: unknown, fallbackRanAtMs?: number): LibrarianRun | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const ranAtMs =
    typeof o.ranAtMs === "number" && Number.isFinite(o.ranAtMs)
      ? o.ranAtMs
      : fallbackRanAtMs;
  if (ranAtMs === undefined) return null;
  const summary = typeof o.summary === "string" ? o.summary.trim() : "";
  const checklist: ChecklistItem[] = [];
  if (Array.isArray(o.checklist)) {
    for (const item of o.checklist) {
      const c = coerceItem(item);
      if (c) checklist.push(c);
    }
  }
  checklist.forEach((c, i) => {
    c.priority = i + 1;
  });
  return { summary, checklist, ranAtMs };
}

function coerceItem(v: unknown): ChecklistItem | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const title = typeof o.title === "string" ? o.title.trim() : "";
  if (!title) return null; // an item with no headline is noise (librarian.rs)
  const category =
    typeof o.category === "string" && o.category.trim()
      ? o.category.trim()
      : "unstructured_backlog";
  const detail = typeof o.detail === "string" ? o.detail.trim() : "";
  const rawAction = typeof o.action === "string" ? o.action.trim() : "";
  const action = rawAction && rawAction !== "none" ? rawAction : undefined;
  const count =
    typeof o.count === "number" && Number.isFinite(o.count)
      ? Math.trunc(o.count)
      : undefined;
  return { priority: 0, category, title, detail, action, count };
}

/** The stored last run, or null when absent or garbled — stale storage must
 *  never throw its way into the strip. */
export function parseStoredRun(raw: string | null): LibrarianRun | null {
  if (!raw) return null;
  try {
    return coerceRun(JSON.parse(raw));
  } catch {
    return null;
  }
}
