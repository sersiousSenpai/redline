// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Test-only: the conversation fixtures, hand-made here and golden from the
//! engine (`src-tauri/tests/fixtures/convo/*.events.json`, written by the
//! Rust mirror's own tests), read into deliveries the reducer can replay.
//!
//! A fixture file is any of:
//! - `ConvoEvent[]`: one delivery;
//! - `ConvoBatch[]`: deliveries in order;
//! - `{ events, hasOlder?, reset? }`: one delivery;
//! - `{ snapshot?, batches?, pages? }`: a subscription as it happened.
//!
//! Anything else in the object (an engine golden's `expected` summary, its
//! source transcript's name) is ignored here, so a golden written for the
//! Rust side plugs in as it is.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ConvoBatch, ConvoEvent, ConvoEventKind, ConvoPage, ConvoSnapshot } from "../types";
import { convoReducer, initialConvoState, type ConvoAction, type ConvoState } from "../reducer";

export const FIXTURE_DIRS = [
  join(process.cwd(), "src/components/agent/convo/__fixtures__"),
  join(process.cwd(), "src-tauri/tests/fixtures/convo"),
];

export interface ConvoFixture {
  name: string;
  /** "hand" for this folder's, "golden" for the engine's. */
  source: "hand" | "golden";
  actions: ConvoAction[];
  /** Every event the fixture carries, in file order. */
  events: ConvoEvent[];
}

/** Every kind `types.ts` declares, so a fixture with a stray kind fails. */
export const EVENT_KINDS: readonly ConvoEventKind[] = [
  "bound",
  "epoch",
  "user_text",
  "assistant_text",
  "thinking",
  "tool_use",
  "tool_result",
  "interrupted",
  "mode_change",
  "model_seen",
  "compact",
  "turn_end",
  "queued",
  "plan_proposed",
  "plan_outcome",
  "ask_opened",
  "ask_closed",
  "delivered",
  "undelivered",
  "readiness",
];

/** The base every event carries, and a declared kind. The per-kind fields
 *  are TypeScript's job at the boundary; this catches a fixture that would
 *  not even reach it. */
export function isConvoEvent(value: unknown): value is ConvoEvent {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    v.id.length > 0 &&
    Number.isFinite(v.epoch) &&
    Number.isFinite(v.offset) &&
    Number.isFinite(v.ts) &&
    EVENT_KINDS.includes(v.kind as ConvoEventKind)
  );
}

const isBatch = (value: unknown): value is ConvoBatch =>
  !!value && typeof value === "object" && Array.isArray((value as ConvoBatch).events);

/** A parsed fixture as reducer actions. Throws on a shape it can't read. */
export function fixtureActions(json: unknown): ConvoAction[] {
  if (Array.isArray(json)) {
    if (json.every(isConvoEvent)) return [{ type: "batch", batch: { events: json } }];
    if (json.every(isBatch)) return json.map((batch) => ({ type: "batch", batch }));
    throw new Error("an array fixture holds events or batches, not a mix");
  }
  if (json && typeof json === "object") {
    const v = json as { snapshot?: Partial<ConvoSnapshot> & { events: ConvoEvent[] }; batches?: ConvoBatch[]; pages?: ConvoPage[] };
    if (isBatch(json) && !v.snapshot && !v.batches) return [{ type: "batch", batch: json }];
    const actions: ConvoAction[] = [];
    if (v.snapshot)
      actions.push({
        type: "snapshot",
        snapshot: { subscriptionId: v.snapshot.subscriptionId ?? "fixture", hasOlder: v.snapshot.hasOlder ?? false, events: v.snapshot.events },
      });
    for (const batch of v.batches ?? []) actions.push({ type: "batch", batch });
    for (const page of v.pages ?? []) actions.push({ type: "page", page });
    if (actions.length) return actions;
  }
  throw new Error("not a conversation fixture");
}

export function actionEvents(actions: readonly ConvoAction[]): ConvoEvent[] {
  return actions.flatMap((action) =>
    action.type === "batch"
      ? action.batch.events
      : action.type === "snapshot"
        ? action.snapshot.events
        : action.type === "page"
          ? action.page.events
          : [],
  );
}

export function loadConvoFixtures(): ConvoFixture[] {
  const out: ConvoFixture[] = [];
  for (const [i, dir] of FIXTURE_DIRS.entries()) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".events.json")).sort()) {
      const actions = fixtureActions(JSON.parse(readFileSync(join(dir, file), "utf8")));
      out.push({ name: file.replace(/\.events\.json$/, ""), source: i === 0 ? "hand" : "golden", actions, events: actionEvents(actions) });
    }
  }
  return out;
}

export function loadConvoFixture(name: string): ConvoFixture {
  const found = loadConvoFixtures().find((fixture) => fixture.name === name);
  if (!found) throw new Error(`no conversation fixture "${name}"`);
  return found;
}

export function replay(actions: readonly ConvoAction[], from: ConvoState = initialConvoState()): ConvoState {
  return actions.reduce(convoReducer, from);
}
