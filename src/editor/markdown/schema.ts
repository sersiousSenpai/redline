// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { getSchema } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";

import { planExtensions } from "../extensions/planExtensions";

/** Headless ProseMirror schema for the plan editor — identical to the live
 *  editor's schema (same extension list), so parse/serialize and on-screen
 *  rendering share one node/mark model. Built once. */
let cached: Schema | null = null;

export function planSchema(): Schema {
  if (!cached) cached = getSchema(planExtensions());
  return cached;
}
