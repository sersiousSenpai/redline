// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The door pane (W6): an empty plate the Front Door island lands on while
// the pane is on screen and focused. MonochatIsland reads the attribute
// (only one door plate at a time carries it), so the island is the one
// composer whichever door tab is showing.

import type { PaneContext } from "../WorkbenchStage";

export function DoorPane({ ctx }: { ctx: PaneContext }) {
  // `active`, not the deferred `visible`: the island measures this plate on
  // the commit that makes its tab active (App's `landing` reads the same
  // undeferred view), so the attribute must be there on that commit.
  return <div className="rl-wb-door-plate" data-rl-door-plate={ctx.active && ctx.focused ? "" : undefined} />;
}
