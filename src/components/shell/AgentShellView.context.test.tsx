// SPDX-License-Identifier: Apache-2.0
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fixture=vi.hoisted(()=>({channel:null as null|{onmessage:(batch:unknown)=>void},invoke:vi.fn(),request:{kind:"plan",sessionId:"plan-1",section:"2"}}));
vi.mock("@tauri-apps/api/core",()=>({invoke:fixture.invoke,Channel:class { onmessage=(_:unknown)=>{};constructor(){fixture.channel=this;} }}));
vi.mock("@tauri-apps/plugin-dialog",()=>({open:vi.fn(async()=>null)}));
vi.mock("../BrowserSurfaces",()=>({BrowserPopover:({children}:{children:React.ReactNode})=><div role="dialog">{children}</div>}));
vi.mock("../MarkdownView",()=>({MarkdownView:({body}:{body:string})=><p>{body}</p>}));
vi.mock("../StreamingBubble",()=>({default:()=>null}));
vi.mock("../TurnFooter",()=>({default:()=>null}));
vi.mock("./CommandCard",()=>({CommandCard:()=>null}));
import AgentShellView from "./AgentShellView";
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLDivElement,root:Root;
beforeEach(()=>{fixture.invoke.mockReset();fixture.invoke.mockImplementation(async(command:string)=>command==="agent_shell_attach"?{id:"shell",sessionId:"plan-1",cwd:"/repo",alive:true,busy:false,raw:false}:command==="shell_context_options"?[{label:"@plan §2 · Implementation",detail:"v3",request:fixture.request}]:command==="shell_context_preview"?[{kind:"plan",label:"@plan §2",origin:"plan:plan-1 v3",body:"Trusted plan section"}]:null);host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();});
async function mount(){await act(async()=>root.render(<AgentShellView id="shell" cwd="/repo" sessionId="plan-1" visible onRaw={()=>{}}/>));}
async function click(text:string){const button=[...host.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent===text || button.textContent?.startsWith(text));expect(button).toBeDefined();await act(async()=>button!.click());}
async function type(text:string){await act(async()=>{const field=host.querySelector<HTMLTextAreaElement>('[aria-label="Message agent"]')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(field,text);field.dispatchEvent(new Event("input",{bubbles:true}));});}
async function attach(){await click("Attach context");await click("@plan §2 · Implementation");}
it("sends the exact visible sentence and trusted descriptors separately, with inspectable context",async()=>{
  await mount();await attach();expect(host.textContent).toContain("Trusted plan section");expect(host.textContent).toContain("plan:plan-1 v3");
  const message="Please apply @plan §2.\nKeep this whitespace.  ";await type(message);await click("Send");
  expect(fixture.invoke).toHaveBeenCalledWith("agent_shell_send",{id:"shell",text:message,memory:false,chips:[fixture.request]});
  expect(host.querySelector('[aria-label="Attached context"]')).toBeNull();
});
it("queues each prompt with its own context and memory selection",async()=>{
  await mount();await act(async()=>fixture.channel!.onmessage({events:[],alive:true,busy:true}));await attach();await type("Queued wording");
  const memory=host.querySelector<HTMLInputElement>('.rl-shell-composer input[type="checkbox"]')!;await act(async()=>memory.click());await click("Queue");await act(async()=>memory.click());
  expect(fixture.invoke.mock.calls.some(([command])=>command==="agent_shell_send")).toBe(false);
  await act(async()=>fixture.channel!.onmessage({events:[],alive:true,busy:false}));
  expect(fixture.invoke).toHaveBeenCalledWith("agent_shell_send",{id:"shell",text:"Queued wording",memory:true,chips:[fixture.request]});
});
