// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The Memory pane (W6): the memory surface (lake, catalog, map). Off the
// boot path — `MemorySurface` is 85 kB and its map's scene a chunk of its
// own beyond that.

import { lazy, Suspense, type ComponentProps } from "react";

import { ErrorBoundary } from "../../components/ErrorBoundary";
import { surfaceFallback } from "./fallback";

export const loadMemorySurface = () => import("../../components/MemorySurface");
const MemorySurface = lazy(() => loadMemorySurface().then((m) => ({ default: m.MemorySurface })));

export type MemoryPaneProps = ComponentProps<typeof MemorySurface>;

export function MemoryPane(props: MemoryPaneProps) {
  return (
    // fallback={null}: the surface arrives a beat after its plate, which
    // reads as a settle — a spinner would read as a glitch. (Also the
    // boundary itself: `lazy` with no Suspense above it throws to the
    // content-area ErrorBoundary on a cold chunk.)
    <Suspense fallback={null}>
      <ErrorBoundary region="memory" fallback={surfaceFallback("memory")}>
        <MemorySurface {...props} />
      </ErrorBoundary>
    </Suspense>
  );
}
