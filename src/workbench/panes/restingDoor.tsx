// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// A door pane at rest (W5): a door in a split that is not the focused pane.
// The Front Door island is one composer and lands on the focused door only
// (`data-rl-door-plate`), so a second door showed an empty plate — a dead
// end. At rest the pane shows what the door is: its box, holding the
// sentence it keeps (or the prompt), and the way back to recent plans,
// chats and pages. A press in the box focuses the pane and the island lands
// there with the caret; a recent opens as the island's own does. Lazy: only
// a split ever shows one.

import type { DoorRecent } from "../../lib/doorRecents";
import { readSharedDraft } from "../../hooks/useSharedDraft";
import "./restingDoor.css";

const SECTIONS: { kind: DoorRecent["kind"]; label: string }[] = [
  { kind: "plan", label: "Plans" },
  { kind: "chat", label: "Chats" },
  { kind: "browse", label: "Pages" },
];

/** How many recents a resting door lists per section. */
const PER_SECTION = 4;

export default function RestingDoor({ draftKey, recents, onWake, onOpenRecent }: {
  draftKey: string;
  recents: readonly DoorRecent[];
  onWake: () => void;
  onOpenRecent?: (recent: DoorRecent) => void;
}) {
  const draft = readSharedDraft(draftKey).trim();
  return (
    <div className="rl-door-rest" data-door-rest="">
      <button type="button" className="rl-door-rest-box" data-drafted={draft ? "" : undefined} onClick={onWake} aria-label={draft ? `Continue: ${draft}` : "Start here: what are we working on?"}>
        <span className="rl-door-rest-text">{draft || "What are we working on?"}</span>
      </button>
      {onOpenRecent && recents.length > 0 && (
        <div className="rl-door-rest-recents" role="group" aria-label="Jump back in">
          {SECTIONS.map(({ kind, label }) => {
            const items = recents.filter((r) => r.kind === kind).slice(0, PER_SECTION);
            if (!items.length) return null;
            return (
              <div key={kind} className="rl-door-rest-row" data-kind={kind}>
                <span className="rl-door-rest-head">{label}</span>
                <div className="rl-door-rest-items">
                  {items.map((r) => (
                    <button key={`${r.kind}:${r.id}`} type="button" className="rl-door-rest-chip" title={r.detail} onClick={() => onOpenRecent(r)}>
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
