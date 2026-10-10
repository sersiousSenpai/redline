// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The browser chat's place in the app: which panels share the dock column,
// what the Redline pill's compact composer may launch from the browser, and
// what the page agent is allowed to do. Data, so a test, the UI and the prompt
// all read the same answer.
//
// Rule ids (BC-n) are catalogued in invariants.ts.

import type { ChatPill } from "../browseChatState";
import type { LaunchDestination } from "../frontDoor";
import type { MainSurface } from "../mainSurface";
import contract from "./contract.json";

/** What the HOVER composer (the pill's compact card) may launch here. On the
 *  browser that is Plan and Run only: the browser's conversation is the page
 *  chat in the dock, and a second chat in the pill would compete with it
 *  (BC-37). A CLICK opens the full Front Door, which is unrestricted.
 *  `undefined` means this layer puts no limit on the surface. */
export function pillComposerDestinations(surface: MainSurface): readonly LaunchDestination[] | undefined {
  return (contract.pillComposerDestinations as Partial<Record<MainSurface, LaunchDestination[]>>)[surface];
}

/** The three panels that share the browser's dock column (BC-10, BC-16). */
export const BROWSER_PANELS: readonly { pill: ChatPill; conversation: boolean; label: string }[] = [
  { pill: "page", conversation: true, label: "This page" },
  { pill: "cart", conversation: false, label: "Task list" },
  { pill: "mission", conversation: true, label: "Mission" },
];

/** The page agent's reach on each provider. The prompt and the skill teach
 *  exactly this, and wiring.test.ts checks the routes exist and are taught.
 *  A Codex chat drives the page only once the daemon token reaches it. */
export function agentCapabilities(provider: "claude-code" | "codex", tokenDelivered: boolean) {
  const drive = provider === "claude-code" || tokenDelivered;
  return {
    read: [...contract.readRoutes, ...contract.codeRoutes],
    mutate: drive ? [contract.actionRoute, ...contract.tabRoutes] : [],
    write: drive ? [contract.writeRoute] : [],
    web: ["WebSearch", "WebFetch"],
    files: "read-only" as const,
    git: "read-only" as const,
    /** Curation is the user's: no pins, no Task-list items, no launches (BC-24). */
    curate: false as const,
  };
}
