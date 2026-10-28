// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The terminals pane (W3, W6): an empty box the one terminal layer is pinned
// over (`workbench/TerminalLayer`), so xterm never moves between walls. The
// slot rides the layer's chunk.

import { lazy, Suspense } from "react";

import type { PaneContext } from "../WorkbenchStage";

const TerminalWallSlot = lazy(() => import("../TerminalLayer").then((m) => ({ default: m.TerminalWallSlot })));

export function TerminalsPane({ paneId, ctx }: { paneId: string; ctx: PaneContext }) {
  return (
    <Suspense fallback={null}>
      <TerminalWallSlot paneId={paneId} active={ctx.active} />
    </Suspense>
  );
}
