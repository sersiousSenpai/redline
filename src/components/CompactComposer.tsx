// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The compact composer's frame (D27): the box a conversation types in,
// centred under its transcript and pinned to the pane's bottom. The chat
// room hands it its FrontDoor; the session conversation's composer wears
// the same class itself (`SessionComposer`, stage layout). The look is
// CompactComposer.css's, and it rides each host's lazy chunk.

import type { ReactNode } from "react";

import "./CompactComposer.css";

export function CompactComposer({ pose = "full", children }: {
  /** A narrow host (the dock's column): the gutters give way first. */
  pose?: "full" | "compact";
  children: ReactNode;
}) {
  return (
    <div className="rl-compact-dock" data-pose={pose}>
      <div className="rl-compact-composer rl-glass rl-glass-sheet" data-compact-composer>
        {children}
      </div>
    </div>
  );
}
