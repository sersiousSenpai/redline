// SPDX-License-Identifier: Apache-2.0
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke:mocks.invoke,Channel:class {onmessage=()=>{};}}));
vi.mock("../MarkdownView",()=>({MarkdownView:({body}:{body:string})=><div>{body}</div>}));
vi.mock("../StreamingBubble",()=>({default:()=>null}));
vi.mock("../TurnFooter",()=>({default:()=>null}));
vi.mock("./ShellContextPicker",()=>({default:()=>null}));
import AgentShellView from "./AgentShellView";
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLDivElement,root:Root;
beforeEach(()=>{
  mocks.invoke.mockImplementation((name:string)=>name==="agent_shell_attach"?Promise.resolve({id:"test",sessionId:"session",cwd:"/tmp",alive:true,busy:true,raw:false}):Promise.resolve());
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
const button=(text:string)=>[...host.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent===text)!;
const input=()=>host.querySelector<HTMLTextAreaElement>('[aria-label="Message agent"]')!;
async function type(text:string){await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input(),text);input().dispatchEvent(new Event("input",{bubbles:true}));});}
describe("hosted shell draft lifecycle",()=>{
  it("keeps the draft and queue across remount and explicit raw handoff",async()=>{
    const id=crypto.randomUUID(),onRaw=vi.fn();
    const props={id,cwd:"/tmp",sessionId:"session",visible:true,onRaw};
    await act(async()=>root.render(<AgentShellView {...props}/>));
    await type("Queued instruction");await act(async()=>button("Queue").click());
    await type("Unsent question");
    expect(button("Raw view").disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Edit queued prompt"]')!.disabled).toBe(true);
    await act(async()=>root.unmount());root=createRoot(host);
    await act(async()=>root.render(<AgentShellView {...props}/>));
    expect(input().value).toBe("Unsent question");expect(host.textContent).toContain("Queued instruction");
    await type("/raw");await act(async()=>button("Queue").click());
    expect(onRaw).toHaveBeenCalledTimes(1);
    await act(async()=>root.unmount());root=createRoot(host);
    await act(async()=>root.render(<AgentShellView {...props}/>));
    expect(host.textContent).toContain("Queued instruction");expect(input().value).toBe("");
  });
});
