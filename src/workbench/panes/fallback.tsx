// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The standard per-surface crash-containment fallback (T2.1).
//
// 14 of the 21 recorded runtime failures were WKWebView render errors and 12
// took the whole app down, because the only boundaries in the tree were the
// header, the content area and the root — so a cold or stale lazy chunk in
// ONE surface blanked every surface. A boundary sitting directly above each
// lazily-loaded body settles that failure at body granularity instead, and
// names it in the `render_crash` friction row it writes
// (`ErrorBoundary.componentDidCatch` -> `record_render_crash`).
//
// Deliberately a fallback factory rather than a wrapper component: the
// literal `<ErrorBoundary region="…">` stays at each call site in the pane
// modules, which is what `src/lib/surfaceBoundaries.test.ts` reads. Every pane
// is ALSO inside its kind-named boundary in WorkbenchStage, so a crash the
// inner one misses still stops at the pane.

import { BoundaryFallback } from "../../components/ErrorBoundary";

export const surfaceFallback =
  (region: string) => (err: Error, reset: () => void) => (
    <div className="flex-1 overflow-hidden flex items-center justify-center">
      <BoundaryFallback region={region} error={err} reset={reset} />
    </div>
  );
