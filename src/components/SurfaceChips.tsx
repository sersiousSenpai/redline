// SPDX-License-Identifier: Apache-2.0
import type { ContextChip } from "../lib/surfaceContext";

/** The surface's "this thing" chips in the Redline card. A pressed chip rides
 *  along with whatever the card sends; see lib/surfaceContext.ts. */
export function SurfaceChips({ chips, pressed, onToggle }: {
  chips: ContextChip[];
  pressed: (chip: ContextChip) => boolean;
  onToggle: (chip: ContextChip) => void;
}) {
  if (chips.length === 0) return null;
  return <div className="rl-context-chips" role="group" aria-label="Attach context">
    {chips.map(chip => <button key={chip.id} type="button" aria-pressed={pressed(chip)} title={chip.title} onClick={() => onToggle(chip)}>{chip.label}</button>)}
  </div>;
}
