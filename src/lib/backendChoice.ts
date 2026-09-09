// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Which CLI harness a plan session runs on, and at what model/effort.
//
// **`backend` is the identifier; "harness" is UI copy only.** The word
// *harness* is already taken three times in this repo — the white-label
// workspace manifest (`lib/harness.ts`), user-authored shelf agents
// (`src-tauri/src/harness.rs`), and a seat name in `KNOWN_SEATS`. The existing
// word for the CLI-vendor axis is `backend` (`SeatConfig.backend`,
// `backend_for()`), so every identifier here uses it.
//
// Pure by construction — no `invoke`, same discipline as `lib/launch.ts`. The
// live Codex catalog is fetched by the caller and passed in, so every rule in
// this file is testable without a binary.

import { EFFORT_OPTIONS } from "./seatAssign";

export type Backend = "claude-code" | "codex" | "cursor" | "antigravity";

/** Planning providers are distinct from the model running inside their CLI. */
export interface PlanBackend {
  id: Backend;
  label: string;
  binary: string;
  preview?: boolean;
  effort: "global" | "model" | "none";
  discussion: "fork" | "sidecar" | "claude-sidecar";
}

export const PLAN_BACKENDS: Record<Backend, PlanBackend> = {
  "claude-code": { id: "claude-code", label: "Claude", binary: "claude", effort: "global", discussion: "fork" },
  codex: { id: "codex", label: "Codex", binary: "codex", effort: "model", discussion: "fork" },
  cursor: { id: "cursor", label: "Cursor", binary: "agent", effort: "none", discussion: "claude-sidecar" },
  antigravity: { id: "antigravity", label: "Antigravity", binary: "agy", preview: true, effort: "model", discussion: "claude-sidecar" },
};

export function parseBackend(value: unknown): Backend {
  const name = typeof value === "string" ? value.trim().toLowerCase() : "";
  return Object.prototype.hasOwnProperty.call(PLAN_BACKENDS, name) ? name as Backend : "claude-code";
}

export interface BackendChoice {
  backend: Backend;
  /** `null` = the backend's own default (no `--model` / `-m` flag). */
  model: string | null;
  /** `null` = the backend's own default (no `--effort` / `model_reasoning_effort`). */
  effort: string | null;
}

/** One row of `codex debug models`, as `codex_model_catalog` projects it.
 *  Mirrors Rust's `codex_app_server::CodexModel`. */
export interface CodexModel {
  slug: string;
  displayName: string;
  description: string;
  defaultEffort: string | null;
  /** Per-model, and a different set from Claude's — `ultra` exists on the
   *  frontier models only, which is why an effort can't be validated against
   *  one global list. */
  efforts: string[];
}

export type ProviderModel = CodexModel;
export type ModelCatalogs = Partial<Record<Backend, readonly ProviderModel[]>>;
/** Array input retained for callers predating provider-keyed catalogs. */
type CatalogInput = ModelCatalogs | readonly CodexModel[];
function catalogFor(backend: Backend, input: CatalogInput): readonly ProviderModel[] {
  if (Array.isArray(input)) return backend === "codex" ? input : [];
  return (input as ModelCatalogs)[backend] ?? [];
}

export const BACKENDS = Object.values(PLAN_BACKENDS);

export function backendLabel(backend: Backend): string {
  return BACKENDS.find((b) => b.id === backend)?.label ?? "Claude";
}

/** The agent's display name for a *stored* backend value — `sessions.backend`,
 *  which is `null` on every row written before plan sessions could run on
 *  anything but Claude. Tolerant on purpose: this feeds UI copy in a discussion
 *  thread, where an unrecognised value must read as "Claude", never as blank or
 *  as the raw identifier. */
export function agentLabelFor(backend: string | null | undefined): string {
  // Trimmed + case-folded to match `ForkBackend::from_stored` on the Rust
  // side, which is what actually picks the binary. If the two disagreed, a
  // thread could run on Codex while every label in it said Claude.
  const stored = (backend ?? "").trim().toLowerCase();
  return backendLabel(parseBackend(stored));
}

/** What the door starts on and falls back to: today's behaviour exactly —
 *  Claude Code with no flags, which is the byte-identical legacy command. */
export function defaultChoice(): BackendChoice {
  return { backend: "claude-code", model: null, effort: null };
}

/** The models offered for a backend. Claude's come from `seatAssign` (that
 *  file's header states it is the frontend source of truth, and `ChatRoom`
 *  already reuses it for the same reason) — never a second copy. Codex's are
 *  live, so a catalog that failed to load offers only "Default" rather than a
 *  hardcoded list that quietly goes stale. */
export function modelsFor(
  backend: Backend,
  codexModels: CatalogInput,
): { value: string; label: string; hint?: string }[] {
  const catalog = catalogFor(backend, codexModels);
  if (backend === "claude-code" && catalog.length === 0) {
    return ["opus", "sonnet", "haiku"].map((m) => ({ value: m, label: m }));
  }
  return catalog.map((m) => ({
    value: m.slug,
    label: m.displayName,
    hint: m.description,
  }));
}

/** The efforts offered for a backend+model. Claude's are global; Codex's are
 *  per-model and include levels Claude has never had (`ultra`). */
export function effortsFor(
  backend: Backend,
  model: string | null,
  codexModels: CatalogInput,
): string[] {
  if (PLAN_BACKENDS[backend].effort === "none") return [];
  if (backend === "claude-code") return [...EFFORT_OPTIONS];
  if (!model) return [];
  return catalogFor(backend, codexModels).find((m) => m.slug === model)?.efforts ?? [];
}

/** Fold a choice back onto what the backend can actually accept.
 *
 *  The case this exists for: pick Codex · GPT-5.6-Sol · ultra, then switch the
 *  model to GPT-5.5, which stops at `xhigh`. Sending `ultra` there is a launch
 *  that fails at the first token, so the effort is dropped to the backend
 *  default instead. Switching backend drops both — a Claude alias is not a
 *  Codex slug, and vice versa. */
export function normalizeChoice(
  choice: BackendChoice,
  codexModels: CatalogInput,
): BackendChoice {
  const backend = parseBackend(choice.backend);
  // The one escape hatch: Codex's catalog is live, so an empty list means the
  // probe hasn't answered yet (or failed) — not that nothing is valid. Silently
  // clearing the user's stored pick on every cold boot would make the sticky
  // preference un-sticky exactly when they'd notice. Claude's lists are static,
  // so they always validate.
  const catalogUnknown = (backend !== "claude-code" || !Array.isArray(codexModels)) && catalogFor(backend, codexModels).length === 0;
  const models = modelsFor(backend, codexModels);
  const model =
    choice.model && (catalogUnknown || models.some((m) => m.value === choice.model))
      ? choice.model
      : null;
  const efforts = effortsFor(backend, model, codexModels);
  const effort =
    PLAN_BACKENDS[backend].effort !== "none" && choice.effort && (catalogUnknown || efforts.includes(choice.effort))
      ? choice.effort
      : null;
  return { backend, model, effort };
}

/** Tolerant read of the persisted blob — anything unrecognised degrades to the
 *  default rather than launching on a backend nobody chose. */
export function parseChoice(raw: unknown): BackendChoice {
  if (!raw || typeof raw !== "object") return defaultChoice();
  const v = raw as Partial<BackendChoice>;
  const str = (x: unknown) =>
    typeof x === "string" && x.trim() ? x.trim() : null;
  return {
    backend: parseBackend(v.backend),
    model: str(v.model),
    effort: str(v.effort),
  };
}

/** The chip's text: `Claude`, `Claude · opus`, `Codex · GPT-5.6-Sol · xhigh`.
 *  Display names come from the catalog so the chip reads the way the CLI's own
 *  picker does, falling back to the slug when the catalog hasn't loaded. */
export function choiceLabel(
  choice: BackendChoice,
  codexModels: CatalogInput,
): string {
  const parts = [backendLabel(choice.backend)];
  if (choice.model) {
    const display =
      catalogFor(choice.backend, codexModels).find((m) => m.slug === choice.model)?.displayName ?? choice.model;
    parts.push(display);
  }
  if (choice.effort) parts.push(choice.effort);
  return parts.join(" · ");
}

/** Is this choice the untouched default? Drives whether the chip renders as a
 *  quiet "Claude" or an armed pick. */
export function isDefaultChoice(choice: BackendChoice): boolean {
  return (
    choice.backend === "claude-code" && !choice.model && !choice.effort
  );
}
