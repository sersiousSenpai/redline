// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The door pane (W6): a plate the Front Door island lands on while the pane
// is on screen and focused. MonochatIsland reads the attribute (only one
// door plate at a time carries it), so the island is the one composer
// whichever door tab is showing. A door in a split that is not the focused
// pane is at rest (W5): it shows its box and recents (`restingDoor`), never
// an empty plate.

import { lazy, Suspense } from "react";

import type { DoorRecent } from "../../lib/doorRecents";
import type { PaneContext } from "../WorkbenchStage";

const RestingDoor = lazy(() => import("./restingDoor"));

export function DoorPane({ ctx, draftKey, recents = [], onWake, onOpenRecent }: {
  ctx: PaneContext;
  draftKey?: string;
  recents?: readonly DoorRecent[];
  /** Focus this pane: the island lands here. */
  onWake?: () => void;
  onOpenRecent?: (recent: DoorRecent) => void;
}) {
  // `active`, not the deferred `visible`: the island measures this plate on
  // the commit that makes its tab active (App's `landing` reads the same
  // undeferred view), so the attribute must be there on that commit.
  const landed = ctx.active && ctx.focused;
  return (
    <div className="rl-wb-door-plate" data-rl-door-plate={landed ? "" : undefined}>
      {ctx.active && !ctx.focused && draftKey && onWake && (
        <Suspense fallback={null}>
          <RestingDoor draftKey={draftKey} recents={recents} onWake={onWake} onOpenRecent={onOpenRecent} />
        </Suspense>
      )}
    </div>
  );
}
