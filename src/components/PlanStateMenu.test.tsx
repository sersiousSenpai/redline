import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlanStateMenu, type PlanStateTarget } from "./PlanStateMenu";
import { MoveToRepoDialog } from "./MoveToRepoDialog";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
function menu(session: PlanStateTarget) {
  const onState = vi.fn(), onMove = vi.fn();
  act(() => root.render(<PlanStateMenu session={session} onState={onState} onMove={onMove}/>));
  act(() => host.querySelector<HTMLButtonElement>('button')!.click());
  return { onState, onMove };
}
it("represents approved without a run as not built, and permits completion", () => {
  const actions = menu({status:"approved",runState:null});
  const choices = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
  expect(choices.find(c => c.getAttribute('aria-checked') === 'true')?.textContent).toContain('Approved · not built');
  act(() => choices[2].click()); expect(actions.onState).toHaveBeenCalledWith('completed');
  expect(document.activeElement).toBe(host.querySelector('button'));
});
it.each([{status:'in_review',held:true}, {status:'approved',runState:'running'}])("blocks manual state changes for live work", session => {
  const actions = menu(session);
  const choices = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
  expect(choices.every(c => c.disabled && c.title)).toBe(true);
  act(() => choices[2].click()); expect(actions.onState).not.toHaveBeenCalled();
});
it("offers repo movement independently", () => {
  const actions = menu({status:'in_review'});
  act(() => document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
  expect(actions.onMove).toHaveBeenCalledOnce(); expect(actions.onState).not.toHaveBeenCalled();
});
it("preselects the plan's likely repo and retains an actionable error", async () => {
  const onConfirm = vi.fn(() => Promise.reject(new Error('Directory no longer exists'))), onCancel = vi.fn();
  act(() => root.render(<MoveToRepoDialog markdown="# Build beta\n\nUpdate /code/beta/src/main.ts" currentProject="/code/alpha" options={[{path:'/code/alpha',name:'alpha',source:'folder'}, {path:'/code/beta',name:'beta',source:'folder'}]} onConfirm={onConfirm} onCancel={onCancel}/>));
  expect(host.textContent).toContain('beta');
  await act(async () => [...host.querySelectorAll('button')].find(b=>b.textContent==='Move plan')!.click());
  expect(onConfirm).toHaveBeenCalledWith('/code/beta'); expect(onCancel).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Directory no longer exists');
});
