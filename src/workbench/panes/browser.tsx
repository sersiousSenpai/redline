// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The browser pane (W1, W6). The browser is a singleton: one BrowserPane,
// its native webviews and its tab strip, mounted once in the browser host;
// a browser pane shows its slot, and the visible, focused one holds it
// (`singletonHolder`, spike 2). The pane is the largest unclaimed lever on
// the boot path (109 kB of source), so it is a lazy chunk.

import { lazy, Suspense, type ComponentProps } from "react";

import { ErrorBoundary } from "../../components/ErrorBoundary";
import type { AnyPane } from "../model";
import { Singleton } from "../singleton";
import type { PaneContext } from "../WorkbenchStage";
import { surfaceFallback } from "./fallback";

export const loadBrowserPane = () => import("../../components/BrowserPane");
const BrowserPane = lazy(() => loadBrowserPane().then((m) => ({ default: m.BrowserPane })));

export type BrowserBodyProps = ComponentProps<typeof BrowserPane>;

/** The one BrowserPane, rendered into the browser host. */
export function BrowserBody(props: BrowserBodyProps) {
  return (
    <Suspense fallback={null}>
      <ErrorBoundary region="browser" fallback={surfaceFallback("browser")}>
        <BrowserPane {...props} />
      </ErrorBoundary>
    </Suspense>
  );
}

/** A browser pane: the holder shows the slot, another visible browser pane
 *  says where the page is and can bring it here. */
export function BrowserPaneView({ host, pane, ctx, holder, bring }: { host: HTMLElement; pane: AnyPane; ctx: PaneContext; holder: string | undefined; bring: (paneId: string) => void }) {
  return <Singleton host={host} pane={pane} ctx={ctx} holder={holder} bring={bring} />;
}
