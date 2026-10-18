import { useRef } from "react";
import { Panel, useClickPopover } from "./popover";
import { isLiveRunState } from "../lib/orchestration";
import { NESTED_CONTROL_STYLE, nestedControl } from "./ui/nestedControl";

export type ManualPlanState = "in_review" | "approved" | "completed";
export interface PlanStateTarget { status: string; runState?: string | null; held?: boolean }
export function PlanStateMenu({ session, onState, onMove, children, nested }: {
  session: PlanStateTarget; onState: (state: ManualPlanState) => void; onMove?: () => void; children?: React.ReactNode;
  /** Rendered inside another button (the classic session row's), where its
   *  trigger can't be a <button> of its own. */
  nested?: boolean;
}) {
  const trigger = useRef<HTMLElement>(null);
  const menu = useClickPopover(trigger, "left");
  const current = session.status === "approved" ? session.runState === "landed" ? "completed" : "approved" : "in_review";
  const reason = session.held ? "Claude is waiting on this plan — use Approve in the footer"
    : isLiveRunState(session.runState ?? null) ? "Stand the live run down before changing its state" : undefined;
  const pick = (action: () => void) => { action(); menu.close(); trigger.current?.focus(); };
  return <span onClick={event => event.stopPropagation()}>
    {nested
      ? <span ref={trigger} aria-label="Change plan state" aria-haspopup="menu" aria-expanded={menu.open} {...nestedControl(menu.toggle)} style={NESTED_CONTROL_STYLE}>
          {children ?? "Mark as…"}
        </span>
      : <button ref={trigger as React.RefObject<HTMLButtonElement>} type="button" aria-label="Change plan state" aria-haspopup="menu" aria-expanded={menu.open} onClick={menu.toggle}>
          {children ?? "Mark as…"}
        </button>}
    {menu.open && <Panel label="Plan state" {...menu.panelProps}>
      {([["in_review", "In review"], ["approved", "Approved · not built"], ["completed", "Completed"]] as const).map(([state, label]) =>
        <button key={state} type="button" role="menuitemradio" aria-checked={current === state} disabled={!!reason} title={reason}
          className="rl-menu-item w-full px-3 py-2 text-left text-xs disabled:opacity-40" onClick={() => pick(() => onState(state))}>
          <span aria-hidden>{current === state ? "✓ " : "　 "}</span>{label}
        </button>)}
      {onMove && <button type="button" role="menuitem" className="rl-menu-item w-full border-t px-3 py-2 text-left text-xs"
        style={{ borderColor:"var(--color-rule)" }} onClick={() => pick(onMove)}>Move to repo…</button>}
    </Panel>}
  </span>;
}
