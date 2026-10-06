// SPDX-License-Identifier: Apache-2.0
import type { ShellBlock, ShellEvent } from "../types";
const exploration = new Set(["Read", "Grep", "Glob", "LS", "WebSearch", "WebFetch"]);
const edits = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
export interface TransformOptions { fold?: boolean; noise?: boolean; tools?: boolean }
export const textOf = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value) ? value.map(part => typeof part === "object" && part ? String((part as {text?: string}).text ?? "") : String(part)).join("\n") : value == null ? "" : JSON.stringify(value, null, 2);
export function filterNoise(text: string): string { return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim(); }
export function toolKind(name: string): ShellBlock["kind"] { return exploration.has(name) ? "explore" : edits.has(name) ? "diff" : name === "Bash" ? "command" : name === "TodoWrite" ? "todo" : name === "Agent" || name === "Task" || name === "Workflow" ? "agent" : name === "ExitPlanMode" ? "plan" : "command"; }
/** Ordered, pure transformation: normalize → noise → tools → fold. Replay
 * gives the same blocks as live delivery; provider UUIDs own tool identity. */
export function transformEvents(events: readonly ShellEvent[], options: TransformOptions = {}): ShellBlock[] {
  const blocks: ShellBlock[] = []; const tools = new Map<string, ShellBlock>(); let live: ShellBlock | undefined;
  for (const event of events) {
    const data = event.data;
    const clean = (value: unknown) => options.noise === false ? textOf(value) : filterNoise(textOf(value));
    if (event.kind === "user") { live = undefined; blocks.push({id:`event-${event.seq}`,kind:"user",text:textOf(data.text)}); }
    else if (event.kind === "delta") { if (!live) { live = {id:`event-${event.seq}`,kind:"text",text:""}; blocks.push(live); } live.text += textOf(data.text); }
    else if (event.kind === "text") { blocks.push({id:`event-${event.seq}`,kind:"text",text:clean(data.text)}); }
    else if (options.tools === false && (event.kind === "tool" || event.kind === "tool-result")) {live=undefined;blocks.push({id:`event-${event.seq}`,kind:"text",text:"```json\n"+JSON.stringify(data,null,2)+"\n```"});}
    else if (event.kind === "tool") {
      live = undefined; const name = String(data.name ?? "Tool"), id = String(data.id ?? event.seq);
      if (tools.has(id)) continue;
      const block: ShellBlock = {id,kind:toolKind(name),tool:name,input:(data.input ?? {}) as Record<string, unknown>,done:false}; tools.set(id,block);
      const parent = data.parentId ? tools.get(String(data.parentId)) : undefined;
      if (parent) (parent.children ??= []).push(block); else blocks.push(block);
    } else if (event.kind === "tool-result") { const block = tools.get(String(data.id)); if (block) { block.done = true; block.output = data.content; if (block.kind === "plan" && data.error) block.text = "Feedback sent — the agent is revising"; } }
    else if (event.kind === "permission") { if (blocks.some(block => block.requestId === data.requestId)) continue; blocks.push({id:`permission-${data.requestId}`,kind:"permission",requestId:String(data.requestId),tool:String(data.name),input:(data.input ?? {}) as Record<string, unknown>,suggestions:Array.isArray(data.suggestions) ? data.suggestions : undefined,event}); }
    else if (event.kind === "permission-resolved") { const block = blocks.find(block => block.requestId === data.requestId); if (block) { block.resolved = true; block.text = data.decision === "deny" ? "Denied" : data.decision === "cancelled" ? "Cancelled" : "Allowed"; } }
    else if (event.kind === "context") blocks.push({id:`context-${event.seq}`,kind:"context",event});
    else if (event.kind === "complete") { if (data.error) blocks.push({id:`error-${event.seq}`,kind:"error",text:clean(data.errors ?? data.text) || "The turn ended with an error"}); else if (!live && clean(data.text)) blocks.push({id:`complete-${event.seq}`,kind:"text",text:clean(data.text)}); else if (live) {live.text=clean(data.text) || clean(live.text);live.done=true;} live=undefined; }
    else if (event.kind === "error" || event.kind === "exit") blocks.push({id:`event-${event.seq}`,kind:event.kind === "error" ? "error" : "status",text:clean(data.text)});
  }
  if (options.fold === false) return blocks;
  const folded: ShellBlock[] = [];
  for (const block of blocks) {
    const previous = folded[folded.length - 1];
    if (block.kind === "explore" && previous?.kind === "explore") { (previous.children ??= []).push(block); }
    else if (block.kind === "explore") folded.push({...block,children:[]});
    else folded.push(block);
  }
  return folded;
}
export function shellLinks(text: string): {kind:"url"|"file"|"block";value:string}[] {
  const links: {kind:"url"|"file"|"block";value:string}[] = [], seen = new Set<string>();
  for (const token of text.matchAll(/`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'|([^\s<>"'`]+)/g)) {
    const quoted = token[1] ?? token[2] ?? token[3];
    const value = (quoted ?? token[4]).replace(/^[([]+/, "").replace(/[\]),.;!?]+$/, "");
    let kind: "url"|"file"|"block";
    if (/^https?:\/\//.test(value)) { try { new URL(value); } catch { continue; } kind = "url"; }
    else if (/^rl:blk-[\w-]+$/.test(value)) kind = "block";
    else if (!["/raw", "/review", "/restore"].includes(value) && (
      /^(?:\.{1,2}\/|\/)[\w.@/ -]+(?::\d+(?::\d+)?)?$/.test(value) ||
      /^[\w.@-]+(?:\/[\w.@-]+)*\.[a-z\d]{1,12}(?::\d+(?::\d+)?)?$/i.test(value)
    ) && (quoted !== undefined || !value.includes(" "))) kind = "file";
    else continue;
    const key = `${kind}:${value}`; if (seen.has(key)) continue; seen.add(key); links.push({kind,value});
  }
  return links;
}
