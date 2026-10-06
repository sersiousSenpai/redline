// Synthetic service boundary only. Production UI components are imported intact.
const noop = () => {};
export const messages = [{id:"seed",role:"user",body:"How should we scope this?",status:"complete",createdAt:1}, {id:"reply",role:"assistant",status:"complete",createdAt:2,body:"**One bucket per seat, with the key’s bucket as a ceiling** — share capacity without losing individual accountability.\n\n```mermaid\nflowchart LR\n  request[request] --> seats{seats?}\n  seats -->|yes| bucket[seat bucket]\n  seats -->|no| ceiling[key ceiling]\n  bucket --> ceiling\n  class ceiling rl-emph\n```\n\n| | seat | key |\n|---|---|---|\n| limit | per person | shared cap |\n| reset | hourly | daily |\n\n*Grounded in src/limits.rs and v1 of your plan.*"}];
export function useAgentTurn() { return { messages, liveText:"", status:"idle", loaded:true, send:(text,options)=>{window.__qaSend={text,options};}, cancel:noop, clear:noop, meters:{}, activity:[] }; }
export function getCurrentWebview() { return {onDragDropEvent:async()=>noop}; }
export function useReadAloud() { return { speaking: false, stop: noop, speak: noop }; }
export function useDictation() { return { listening: false, partial: "", toggle: noop }; }
export async function invoke(command: string) {
  if (command === "fork_thread_model") return [null,null];
  if (command === "get_agent_seats") return { seats: { fork_plan: { model:"opus",effort:"xhigh" } } };
  if (command === "model_catalog_snapshot") return {models:[],checkedAt:1,source:"harness",warning:null};
  if (command === "companion_list") return [{ companionId: "qa-carried", title: "Research carried into the browser", createdAt: 1_789_286_000_000 }];
  if (command === "browse_feedback_list") return {};
  if (/prefs|settings/.test(command)) return null;
  return [];
}
export async function listen() { return noop; }
export async function emit() {}
export async function emitTo() {}
export async function once() { return noop; }
export async function open() { return null; }
export async function openUrl() {}
export function convertFileSrc(path: string) { return path; }
export function isTauri() { return false; }
export class Channel { onmessage = noop; }
