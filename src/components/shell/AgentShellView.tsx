// SPDX-License-Identifier: Apache-2.0
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { MarkdownView } from "../MarkdownView";
import StreamingBubble from "../StreamingBubble";
import TurnFooter from "../TurnFooter";
import type { TurnMeter } from "../../lib/turnMeter";
import { transformEvents, textOf, shellLinks } from "../../lib/shell/transform";
import type { AgentShellLaunch, ShellBatch, ShellBlock, ShellEvent, ShellInfo } from "../../lib/shell/types";
import type { DiffFile } from "../../types";
import "./Shell.css";
import ShellContextPicker, { type ShellContextChip } from "./ShellContextPicker";
import { CommandCard } from "./CommandCard";
import { loadShellDraft, saveShellDraft, type ShellDraft, type QueuedShellPrompt } from "../../lib/shell/drafts";
export { CommandCard } from "./CommandCard";
const DiffView = lazy(() => import("../DiffView"));
const noop = () => {};
function ShellDiff({ block, onFile }: { block: ShellBlock; onFile:(path:string)=>void }) {
  const input = block.input ?? {}, path = String(input.file_path ?? input.notebook_path ?? "Changed file");
  const before = String(input.old_string ?? ""), after = String(input.new_string ?? input.content ?? input.new_source ?? "");
  const [open, setOpen] = useState(false);
  const file: DiffFile = { oldPath:path,newPath:path,status:block.tool === "Write" ? "added" : "modified",binary:false,hunks:[{oldStart:1,newStart:1,oldLines:before ? before.split("\n").length : 0,newLines:after ? after.split("\n").length : 0,header:"Proposed tool edit",lines:[...(before ? before.split("\n").map((text,index)=>({kind:"del" as const,oldLine:index+1,newLine:null,text})) : []),...(after ? after.split("\n").map((text,index)=>({kind:"add" as const,oldLine:null,newLine:index+1,text})) : [])]}] };
  return <div className="rl-shell-card"><button type="button" onClick={() => setOpen(!open)}>{block.done ? "Changed" : "Editing"} · {path} {open ? "▴" : "▾"}</button><button type="button" onClick={()=>onFile(path)}>Open file ↗</button>{open && <div style={{height:240}}><Suspense fallback={<pre>{after}</pre>}><DiffView files={[file]} diffKey={block.id} mode="unified" viewed={new Set()} onToggleViewed={noop} reviewId={null} round={0} annotations={[]} onAddAnnotation={noop} onUpdateAnnotation={noop} onDeleteAnnotation={noop}/></Suspense></div>}</div>;
}
function PermissionCard({ id, block, onError }: { id: string; block: ShellBlock; onError: (error:string)=>void }) {
  const [note,setNote]=useState(""), [answers,setAnswers]=useState<Record<string,string>>({}), [pending,setPending]=useState(false);
  const questions=Array.isArray(block.input?.questions) ? block.input.questions as {question:string;header?:string;multiSelect?:boolean;options:{label:string;description?:string}[]}[] : [];
  const respond=async(decision:string)=>{setPending(true);try{await invoke("agent_shell_permission_respond",{id,requestId:block.requestId,decision,note:note || null,answers:questions.length ? answers : null});}catch(error){onError(String(error));}finally{setPending(false);}};
  if(block.resolved)return <div className="rl-shell-receipt">{block.tool} · {block.text}</div>;
  return <div className="rl-shell-permission" role="group" aria-label={questions.length ? "Agent question" : "Permission request"}>
    <strong>{questions.length ? "A question for you" : `${block.tool} needs your permission`}</strong>
    {questions.length ? questions.map(question=><fieldset key={question.question}><legend>{question.question}</legend>{(question.options ?? []).map(option=><label key={option.label}><input type={question.multiSelect ? "checkbox" : "radio"} name={`${block.id}-${question.question}`} checked={(answers[question.question] ?? "").split(", ").includes(option.label)} onChange={event=>setAnswers(previous=>({...previous,[question.question]:question.multiSelect ? [...new Set([...(previous[question.question] ?? "").split(", ").filter(Boolean).filter(label=>label!==option.label),...(event.target.checked ? [option.label] : [])])].join(", ") : option.label}))}/>{option.label}{option.description && <small> · {option.description}</small>}</label>)}<input aria-label={`Other answer: ${question.question}`} placeholder="Or write an answer" onChange={event=>setAnswers(previous=>({...previous,[question.question]:event.target.value}))}/></fieldset>) : <pre>{textOf(block.input)}</pre>}
    <input aria-label="Permission note" value={note} onChange={event=>setNote(event.target.value)} placeholder="Optional note"/>
    <div><button type="button" disabled={pending || questions.some(question=>!answers[question.question])} onClick={()=>void respond("allow")}>{questions.length ? "Send answer" : "Allow once"}</button>{!!block.suggestions?.length && <button type="button" disabled={pending} onClick={()=>void respond("always")}>Always allow</button>}<button type="button" disabled={pending} onClick={()=>void respond("deny")}>Deny</button></div>
  </div>;
}
export default function AgentShellView({id,cwd,sessionId,launch,visible,onActivity,onExit,onTitle,onPaneFocus,onRaw,onInfo}:{
  id:string;cwd:string|null;sessionId?:string;launch?:AgentShellLaunch;visible:boolean;
  onActivity?:(id:string)=>void;onExit?:(id:string)=>void;onTitle?:(id:string,title:string)=>void;onPaneFocus?:(id:string)=>void;onRaw:()=>void;onInfo?:(info:ShellInfo)=>void;
}) {
  const initialDraft=useRef(loadShellDraft(id,launch?.permissionMode ?? "default"));
  const [events,setEvents]=useState<ShellEvent[]>([]),[history,setHistory]=useState<ShellEvent[]>([]),[info,setInfo]=useState<ShellInfo|null>(null),[error,setError]=useState<string|null>(null),[text,setText]=useState(initialDraft.current.text),[queue,setQueue]=useState<QueuedShellPrompt[]>(initialDraft.current.queue),[memory,setMemory]=useState(initialDraft.current.memory),[rawEvents,setRawEvents]=useState(false),[fold,setFold]=useState(true),[noise,setNoise]=useState(true),[tools,setTools]=useState(true),[mode,setMode]=useState(initialDraft.current.mode);
  const [chips,setChips]=useState<ShellContextChip[]>(initialDraft.current.chips);
  const [draftWarning,setDraftWarning]=useState<string|null>(null);
  const draft=useRef<ShellDraft>({text,chips,queue,memory,mode});draft.current={text,chips,queue,memory,mode};
  useEffect(()=>{const result=saveShellDraft(id,draft.current);setDraftWarning(result.reloadSafe ? null : "Your draft is kept in this window. Browser storage is unavailable, so reload could discard it.");},[id,text,chips,queue,memory,mode]);
  useEffect(()=>()=>{saveShellDraft(id,draft.current);},[id]);
  const requestRaw=(clearCommand=false)=>{
    const next={...draft.current,text:clearCommand ? "" : draft.current.text};
    if(!saveShellDraft(id,next).retained){setError("There is no room to preserve this draft. Send it or copy it before changing views.");return;}
    draft.current=next;if(clearCommand)setText("");onRaw();
  };
  const [attachmentRev,setAttachmentRev]=useState(0);const attached=useRef(false),onInfoRef=useRef(onInfo),onActivityRef=useRef(onActivity),onExitRef=useRef(onExit);onInfoRef.current=onInfo;onActivityRef.current=onActivity;onExitRef.current=onExit;
  const provider=launch?.backend === "codex" ? "Codex" : "Claude";
  const currentSid=info?.sessionId ?? sessionId ?? "";
  useEffect(()=>{
    let alive=true;const attachmentId=crypto.randomUUID();const output=new Channel<ShellBatch>();
    output.onmessage=batch=>{if(!alive)return;setEvents(previous=>{const seq=previous[previous.length - 1]?.seq ?? 0;return [...previous,...batch.events.filter(event=>event.seq>seq)].slice(-4096);});setInfo(previous=>previous ? {...previous,alive:batch.alive,busy:batch.busy,sessionId:String([...batch.events].reverse().find(event=>event.kind==="init")?.data.sessionId ?? previous.sessionId)} : previous);onActivityRef.current?.(id);void invoke("agent_shell_ack",{id,attachmentId,seq:batch.events[batch.events.length - 1]?.seq ?? 0});if(batch.events.some(event=>event.kind==="exit"))onExitRef.current?.(id);};
    void invoke<ShellInfo>("agent_shell_attach",{id,attachmentId,onOutput:output}).then(value=>{if(alive){attached.current=true;setInfo(value);onInfoRef.current?.(value);}}).catch(async()=>{if(sessionId){try{const rows=await invoke<ShellEvent[]>("agent_shell_history",{sessionId,backend:launch?.backend});if(alive)setHistory(rows);}catch{/* An empty transcript is an honest empty session. */}}if(alive)setInfo({id,sessionId:sessionId ?? "",cwd:cwd ?? "",alive:false,busy:false,raw:false});});
    return()=>{alive=false;attached.current=false;void invoke("agent_shell_detach",{id,attachmentId}).catch(()=>{});};
  },[id,sessionId,attachmentRev]);
  useEffect(()=>{if(info){onInfoRef.current?.(info);onTitle?.(id,info.busy ? `${provider} · working` : provider);}},[info?.alive,info?.busy]);
  const blocks=useMemo(()=>[...transformEvents(history),...transformEvents(events,{fold,noise,tools})],[events,history,fold,noise,tools]);
  const meter=[...events].reverse().find(event=>event.kind==="meter")?.data.meter as TurnMeter|undefined;
  const navigate=(kind:string,value:string)=>window.dispatchEvent(new CustomEvent("redline-shell-open",{detail:{kind,value,sessionId:currentSid,cwd:info?.cwd ?? cwd}}));
  const send=async(message:string,capturedChips:ShellContextChip[]=chips,useMemory=memory)=>{
    if(message.trim()==="/raw"){requestRaw(true);return;}if(message.trim()==="/review"){navigate("review",currentSid);return;}if(message.trim()==="/restore"){navigate("restore",currentSid);return;}
    if(/^\/(login|logout|terminal-setup|keybindings|theme)(\s|$)/.test(message)){setError("This command needs raw view. Open raw view to continue.");return;}
    setError(null);setInfo(previous=>previous ? {...previous,busy:true} : previous);
    try{await invoke("agent_shell_send",{id,text:message,memory:useMemory,chips:capturedChips.map(chip=>chip.request)});}catch(error){setError(String(error));setChips(previous=>[...previous,...capturedChips.filter(chip=>!previous.some(existing=>JSON.stringify(existing.request)===JSON.stringify(chip.request)))]);setText(previous=>previous.trim()?`${message}\n\n${previous}`:message);setInfo(previous=>previous?{...previous,busy:false}:previous);}
  };
  useEffect(()=>{if(info?.alive&&!info.busy&&queue.length){const next=queue[0];setQueue(previous=>previous.slice(1));void send(next.text,next.chips,next.memory);}},[info?.busy,info?.alive,queue.length]);
  const submit=()=>{if(!text.trim())return;if(text.trim()==="/raw"){requestRaw(true);return;}if(info?.busy){if(queue.length>=5){setError("The queue is full. Wait for this reply.");return;}setQueue(previous=>[...previous,{text,chips,memory}]);}else void send(text,chips,memory);setText("");setChips([]);};
  const resume=async()=>{try{setError(null);const value=await invoke<ShellInfo>("agent_shell_start",{id,request:{...(launch ?? {cwd,permissionMode:mode}),prompt:"",sessionId:currentSid || undefined}});setEvents([]);setInfo(value);setAttachmentRev(value=>value+1);}catch(error){setError(String(error));}};
  const renderBlock=(block:ShellBlock):React.ReactNode=>{
    if(block.kind==="permission")return <PermissionCard key={block.id} id={id} block={block} onError={setError}/>;
    if(block.kind==="diff")return <ShellDiff key={block.id} block={block} onFile={path=>navigate("file",path)}/>;
    if(block.kind==="command")return <CommandCard key={block.id} command={String(block.input?.command ?? block.tool ?? "Command")} output={textOf(block.output)} running={!block.done}/>;
    if(block.kind==="explore")return <details key={block.id} className="rl-shell-card"><summary>Explored · {[block,...(block.children ?? [])].filter(child=>["Read","Glob","LS"].includes(child.tool ?? "")).length} files, {[block,...(block.children ?? [])].filter(child=>["Grep","WebSearch","WebFetch"].includes(child.tool ?? "")).length} searches</summary>{[block,...(block.children ?? [])].map(child=><div key={child.id}><strong>{child.tool}</strong><pre>{textOf(child.input)}</pre>{child.output!=null&&<pre>{textOf(child.output)}</pre>}</div>)}</details>;
    if(block.kind==="todo")return <div key={block.id} className="rl-shell-checklist">{(Array.isArray(block.input?.todos)?block.input.todos:[]).map((item,index)=><label key={index}><input type="checkbox" checked={(item as {status:string}).status==="completed"} readOnly/>{String((item as {content:string}).content)}</label>)}</div>;
    if(block.kind==="agent")return <details key={block.id} className="rl-shell-card"><summary>{String(block.input?.description ?? block.input?.name ?? block.tool)}{block.done?" · done":" · working"}</summary>{block.children?.map(renderBlock)}{block.output!=null&&<pre>{textOf(block.output)}</pre>}</details>;
    if(block.kind==="plan")return <div key={block.id} className="rl-shell-plan"><strong>{block.text ?? "Plan ready"}</strong><button type="button" onClick={()=>navigate("review",currentSid)}>Review →</button></div>;
    if(block.kind==="context")return <details key={block.id} className="rl-shell-card"><summary>Context · {(block.event?.data.items as unknown[]|undefined)?.length ?? 0}</summary>{(block.event?.data.items as {label:string;origin:string;body:string}[]|undefined)?.map((item,index)=><details key={index}><summary>{item.label} · {item.origin}</summary><pre>{item.body}</pre></details>)}</details>;
    if(block.kind==="text"&&!block.done&&info?.busy&&block===blocks[blocks.length - 1])return <StreamingBubble key={block.id} text={block.text ?? ""} agent={provider}/>;
    return <div key={block.id} className={`rl-shell-${block.kind}`}>{block.kind==="user"&&<small>You</small>}<MarkdownView body={block.text ?? ""} compact onLinkClick={url=>navigate("url",url)}/>{shellLinks(block.text ?? "").filter(link=>link.kind!=="url").map(link=><button key={link.value} type="button" className="rl-shell-link" onClick={()=>navigate(link.kind,link.value)}>{link.value}</button>)}</div>;
  };
  return <div className="rl-agent-shell" style={{display:visible?"flex":"none"}} onPointerDown={()=>onPaneFocus?.(id)} onKeyDown={event=>{if(event.key==="Escape"&&info?.busy){event.preventDefault();void invoke("agent_shell_interrupt",{id}).catch(error=>setError(String(error)));}}}>
    <div className="rl-shell-toolbar"><span>{info?.alive?(info.busy?"Working":"Ready"):"Saved session"}</span><button type="button" disabled={!!info?.busy || !!text.trim() || !!queue.length || !!chips.length} title={text.trim() || queue.length || chips.length ? "Send or clear your draft and queued prompts first. Use /raw to preserve them while changing views." : undefined} onClick={()=>requestRaw()}>Raw view</button><button type="button" onClick={()=>setRawEvents(!rawEvents)}>{rawEvents?"Show blocks":"Raw events"}</button>{import.meta.env.DEV&&<><label><input type="checkbox" checked={fold} onChange={event=>setFold(event.target.checked)}/>Fold exploration</label><label><input type="checkbox" checked={noise} onChange={event=>setNoise(event.target.checked)}/>Filter reminders</label><label><input type="checkbox" checked={tools} onChange={event=>setTools(event.target.checked)}/>Tool cards</label></>}</div>
    <div className="rl-shell-blocks">{rawEvents?<pre>{events.slice(-500).map(event=>JSON.stringify(event)).join("\n")}</pre>:blocks.slice(-300).map(renderBlock)}<TurnFooter meter={meter}/></div>
    {error&&<div className="rl-shell-error" role="alert">{error}</div>}{draftWarning&&<div className="rl-shell-error" role="status">{draftWarning}</div>}
    {!!queue.length&&<div className="rl-shell-queue" aria-label="Queued prompts">{queue.map((prompt,index)=><div key={index}><span>{prompt.text}{prompt.chips.length ? ` · ${prompt.chips.length} context items` : ""}</span><button type="button" aria-label="Edit queued prompt" disabled={!!text.trim() || !!chips.length} title={text.trim() || chips.length ? "Send or clear your current draft before editing a queued prompt" : undefined} onClick={()=>{setText(prompt.text);setChips(prompt.chips);setMemory(prompt.memory);setQueue(previous=>previous.filter((_,i)=>i!==index));}}>Edit</button><button type="button" aria-label="Delete queued prompt" onClick={()=>setQueue(previous=>previous.filter((_,i)=>i!==index))}>×</button></div>)}</div>}
    {!info?.alive?<button type="button" onClick={()=>void resume()}>Resume hosted session</button>:<div className="rl-shell-composer"><textarea aria-label="Message agent" maxLength={1024*1024} value={text} onChange={event=>setText(event.target.value)} onKeyDown={event=>{if(event.key==="Enter"&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();submit();}}} placeholder="Message the agent · @plan §2 · /review · /raw"/><ShellContextPicker cwd={cwd ?? info.cwd} sessionId={currentSid} chips={chips} onChange={setChips}/><div><select aria-label="Permission mode" value={mode} onChange={event=>{const next=event.target.value as typeof mode;setMode(next);void invoke("agent_shell_control",{id,subtype:"set_permission_mode",value:next}).catch(error=>setError(String(error)));}}><option value="plan">Plan</option><option value="default">Ask before writes</option><option value="acceptEdits">Accept edits</option><option value="auto">Auto</option></select><label><input type="checkbox" checked={memory} onChange={event=>setMemory(event.target.checked)}/>Memory</label>{info.busy&&<button type="button" onClick={()=>void invoke("agent_shell_interrupt",{id}).catch(error=>setError(String(error)))}>Stop</button>}<button type="button" disabled={!text.trim()} onClick={submit}>{info.busy?"Queue":"Send"}</button></div></div>}
  </div>;
}
