// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The singleton bodies' slots (the plan, the browser, the companion chat):
// the body mounts once, in its portal host, and a pane shows only a slot
// that takes the host while the pane is visible. Static and small, so the
// pane modules (`./panes/*`) render a slot on the boot path without waiting
// on the stage's chunk.

import type { AnyPane } from "./model";
import { PersistentPortalSlot } from "../components/PersistentPortalSlot";
import type { PaneContext } from "./WorkbenchStage";

/** A singleton's slot: `PersistentPortalSlot`, taking the host only while
 *  the pane is visible, so a slot in a hidden kept tab cannot steal it. The
 *  second visible slot (W5's splits) shows where the body went. */
export function SingletonSlot({ host, name, active }: { host: HTMLElement; name: string; active: boolean }) {
  return <PersistentPortalSlot host={host} name={name} active={active} />;
}

/** What a second pane of a singleton shows while another pane holds the
 *  body: where it is, and a way to bring it here. */
export function SingletonElsewhere({ what, onBringHere }: { what: string; onBringHere: () => void }) {
  return (
    <div className="rl-wb-elsewhere" role="status">
      <p>Showing {what} in the other pane</p>
      <button type="button" onClick={onBringHere}>Bring here</button>
    </div>
  );
}

/** A singleton's pane (the plan, the browser), named by its kind: the
 *  holder (`singletonHolder`) shows the slot; another visible pane shows
 *  where the body went, and "Bring here" makes it the holder. */
export function Singleton({ host, pane, ctx, holder, bring }: { host: HTMLElement; pane: AnyPane; ctx: PaneContext; holder: string | undefined; bring: (paneId: string) => void }) {
  return ctx.visible && holder !== pane.id
    ? <SingletonElsewhere what={`the ${pane.kind}`} onBringHere={() => bring(pane.id)} />
    : <SingletonSlot host={host} name={pane.kind} active={ctx.visible} />;
}
