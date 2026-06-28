// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The scrape *contract* — a versioned, serializable schema that describes WHAT
//! to extract from a page, kept deliberately separate from the executor that
//! runs it. The metaphor: this is the malleable shell (the electrons) that
//! orbits the static kernel in `scrapeKernel.ts`. A schema is plain data — never
//! code — so it can be authored by a preset, hand-edited as JSON, or (future)
//! emitted by a forked Claude Code instance, and all three pass through the one
//! `validateSchema` door before the kernel will execute them.

/** Bumped when the schema shape changes. `migrateSchema` upgrades older payloads
 *  to this version, so a schema authored against v1 keeps loading after the
 *  kernel grows. Mirrors `skill.rs`'s `SKILL_VERSION` precedent. */
export const SCRAPE_SCHEMA_VERSION = 1;

export type ScrapeFieldType = "text" | "html" | "attr" | "list";

export interface ScrapeField {
  /** Output key for this field in the result's `data` object. */
  name: string;
  /** CSS selector, resolved within the current context (the root, or — for a
   *  `list` item — that item element). An empty selector means "this context
   *  element itself" (used by list `itemFields`). */
  selector: string;
  type: ScrapeFieldType;
  /** For `type: "attr"` — which attribute to read (e.g. "href", "content"). */
  attribute?: string;
  /** For `type: "list"` — selector for each item, relative to the context.
   *  Falls back to `selector` when omitted. */
  itemSelector?: string;
  /** For `type: "list"` — optional sub-fields; with these each item becomes a
   *  structured record (sub-selectors resolve within the item) instead of a
   *  bare string. */
  itemFields?: ScrapeField[];
  /** Cap captured characters for `text`/`html` (truncated, flagged in warnings). */
  maxChars?: number;
}

export interface ScrapeSchema {
  /** Equals `SCRAPE_SCHEMA_VERSION` at author time; the gate for `migrateSchema`. */
  version: number;
  /** Human label, e.g. "Article". */
  name: string;
  /** Optional root selector; all field selectors resolve within it. Absent →
   *  the whole document. */
  root?: string;
  fields: ScrapeField[];
}

export interface ScrapeResult {
  ok: boolean;
  version: number;
  schemaName: string;
  url: string;
  title: string;
  /** field.name → extracted value (string | string[] | record[] | null). */
  data: Record<string, unknown>;
  /** Non-fatal per-field problems (no match, truncation, unknown type). */
  warnings: string[];
  /** Set only when `ok === false` (the scrape blew up entirely). */
  error?: string;
}

const FIELD_TYPES: ScrapeFieldType[] = ["text", "html", "attr", "list"];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate one field (recursively, for list `itemFields`). `path` is only used
 *  to make error messages locate the offending field. */
function validateField(value: unknown, path: string): ScrapeField {
  if (!isObject(value)) throw new Error(`${path}: field must be an object`);
  const { name, selector, type, attribute, itemSelector, itemFields, maxChars } =
    value;
  if (typeof name !== "string" || !name.trim()) {
    throw new Error(`${path}: field "name" must be a non-empty string`);
  }
  if (typeof selector !== "string") {
    throw new Error(`${path}.${name}: "selector" must be a string`);
  }
  if (typeof type !== "string" || !FIELD_TYPES.includes(type as ScrapeFieldType)) {
    throw new Error(
      `${path}.${name}: "type" must be one of ${FIELD_TYPES.join(", ")}`,
    );
  }
  const field: ScrapeField = { name, selector, type: type as ScrapeFieldType };
  if (attribute !== undefined) {
    if (typeof attribute !== "string") {
      throw new Error(`${path}.${name}: "attribute" must be a string`);
    }
    field.attribute = attribute;
  }
  if (itemSelector !== undefined) {
    if (typeof itemSelector !== "string") {
      throw new Error(`${path}.${name}: "itemSelector" must be a string`);
    }
    field.itemSelector = itemSelector;
  }
  if (itemFields !== undefined) {
    if (!Array.isArray(itemFields)) {
      throw new Error(`${path}.${name}: "itemFields" must be an array`);
    }
    field.itemFields = itemFields.map((f, i) =>
      validateField(f, `${path}.${name}.itemFields[${i}]`),
    );
  }
  if (maxChars !== undefined) {
    if (typeof maxChars !== "number" || !Number.isFinite(maxChars) || maxChars < 0) {
      throw new Error(`${path}.${name}: "maxChars" must be a non-negative number`);
    }
    field.maxChars = maxChars;
  }
  return field;
}

/** The single door into the executor: turn untrusted input (a preset, the JSON
 *  editor, or a future fork's payload) into a structurally valid `ScrapeSchema`,
 *  throwing a human-readable error on any violation. Authoring is untrusted and
 *  mutable; execution is trusted and fixed — this is the boundary between them. */
export function validateSchema(value: unknown): ScrapeSchema {
  if (!isObject(value)) throw new Error("schema must be an object");
  const { version, name, root, fields } = value;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new Error('schema "version" must be a positive integer');
  }
  if (typeof name !== "string" || !name.trim()) {
    throw new Error('schema "name" must be a non-empty string');
  }
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error('schema "fields" must be a non-empty array');
  }
  const out: ScrapeSchema = {
    version,
    name,
    fields: fields.map((f, i) => validateField(f, `fields[${i}]`)),
  };
  if (root !== undefined) {
    if (typeof root !== "string") throw new Error('schema "root" must be a string');
    out.root = root;
  }
  return out;
}

/** Upgrade an older-versioned schema to the current shape, then validate it.
 *  v1 is the identity transform; the switch exists now so the seam is real when
 *  the kernel evolves and a fork-authored v1 schema must still load. */
export function migrateSchema(raw: unknown): ScrapeSchema {
  const schema = validateSchema(raw);
  switch (schema.version) {
    case SCRAPE_SCHEMA_VERSION:
      return schema;
    default:
      // Newer-than-known or any unmapped version: clamp to the current version
      // and let validation have already guaranteed the shape is compatible.
      return { ...schema, version: SCRAPE_SCHEMA_VERSION };
  }
}
