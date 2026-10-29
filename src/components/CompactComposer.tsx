// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The compact composer's frame (D27): where a conversation types, centred
// under its transcript and pinned to the pane's bottom. The chat room hands
// it its FrontDoor, which draws the Home door's box itself (ComposerLook.css:
// one look for every composer); the session conversation's composer wears
// that look on the stage (`SessionComposer`). This frame is the place and
// the measure only, and it rides each host's lazy chunk.

import type { ReactNode } from "react";

import "./CompactComposer.css";

export function CompactComposer({ pose = "full", children }: {
  /** A narrow host (the dock's column): the gutters give way first. */
  pose?: "full" | "compact";
  children: ReactNode;
}) {
  return (
    <div className="rl-compact-dock" data-pose={pose}>
      <div className="rl-compact-measure" data-compact-composer>
        {children}
      </div>
    </div>
  );
}
