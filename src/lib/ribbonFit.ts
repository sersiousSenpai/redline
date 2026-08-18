// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Which ribbon groups survive a narrow pane, and in what order they leave.
//
// The give-up order is ONE law, stated once:
//
//   aids before semantics, semantics before authorship;
//   anything with a keystroke goes before anything without one.
//
// "Aids" are presentation that doesn't survive the launch anyway (colour,
// alignment, font). "Semantics" are structure that does (lists, marks,
// headings). "Authorship" is whether your keystrokes are being tracked and who
// is writing — which is not a formatting preference at all.
//
// Three groups are NEVER hidden at any width: Editing/Suggesting, ✦ Generate,
// and Comments. They are the only controls with no keyboard equivalent and no
// other entry point, and two of them govern whether your typing is being
// recorded as a tracked change. A ribbon that hides those to make room for a
// font picker has its priorities exactly backwards.

export interface RibbonGroup {
  id: string;
  /** Measured width in px, including its gap. Cached by the caller. */
  width: number;
}

/** The give-up order: index 0 leaves first. Groups not listed here can never
 *  be hidden — see `NEVER_HIDDEN`. */
export const GIVE_UP_ORDER = [
  "clear", // an aid with a keyboard path (⌘\ / retype)
  "color", // pure presentation, dropped at launch
  "align", // pure presentation, dropped at launch
  "type", // font family + size — presentation, dropped at launch
  "insert", // structure, but every item has a menu path
  "lists", // semantics, keyboard-reachable via markdown input rules
  "marks", // semantics, and every one has a ⌘ shortcut
  "style", // paragraph semantics — the last thing to go
  "history", // ⌘Z / ⌘⇧Z; the shortcut IS the feature
] as const;

/** Never hidden at any width. The only controls with no keyboard equivalent
 *  and no other entry point. */
export const NEVER_HIDDEN = ["mode", "generate", "comments"] as const;

/** Hysteresis: a group must have this much MORE room than it needs before it
 *  comes back. Without it a divider drag sits exactly on the boundary and the
 *  group flickers in and out on every frame — the lesson already written down
 *  in useTextClearance. */
export const REVEAL_HYSTERESIS = 24;

export interface FitResult {
  /** Group ids to render inline, in their natural order. */
  visible: string[];
  /** Group ids that moved into the `⋯` overflow menu, give-up order. */
  overflow: string[];
}

/** Decide what fits.
 *
 *  `groups` is every group in its NATURAL (rendered) order with its measured
 *  width. `available` is the ribbon's inner width. `previouslyHidden` is what
 *  was in the overflow last time, so a group that is only just wide enough
 *  again has to clear the hysteresis margin before it returns. */
export function fitRibbon(
  groups: RibbonGroup[],
  available: number,
  previouslyHidden: readonly string[] = [],
  overflowButtonWidth = 34,
): FitResult {
  const byId = new Map(groups.map((g) => [g.id, g]));
  // The PREVIOUS state is the starting point, not an empty set. Recomputing
  // from scratch and only then applying a margin means a group sitting exactly
  // on the boundary is re-shown every frame — which is the flip-flop the
  // margin exists to prevent.
  const hidden = new Set(previouslyHidden.filter((id) => byId.has(id)));

  const total = () => {
    let sum = 0;
    for (const g of groups) if (!hidden.has(g.id)) sum += g.width;
    return sum + (hidden.size > 0 ? overflowButtonWidth : 0);
  };

  // Give up, in order, until it fits.
  for (const id of GIVE_UP_ORDER) {
    if (total() <= available) break;
    if (!byId.has(id) || hidden.has(id)) continue;
    hidden.add(id);
  }

  // Come back, in reverse: the last thing given up is the first thing to
  // return, and it must clear the hysteresis margin to do so.
  for (const id of [...GIVE_UP_ORDER].reverse()) {
    if (!hidden.has(id)) continue;
    hidden.delete(id);
    if (total() + REVEAL_HYSTERESIS > available) {
      hidden.add(id);
      break; // nothing narrower will fit either
    }
  }

  return {
    visible: groups.filter((g) => !hidden.has(g.id)).map((g) => g.id),
    overflow: GIVE_UP_ORDER.filter((id) => hidden.has(id)),
  };
}
