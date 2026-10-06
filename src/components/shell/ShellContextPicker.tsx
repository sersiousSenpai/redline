// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { BrowserPopover } from "../BrowserSurfaces";
export interface ShellContextRequest { kind: "plan"|"comment"|"file"|"tab"|"selection"; sessionId?: string; section?: string; commentId?: string; path?: string; label?: string }
export interface ShellContextItem { kind: string; label: string; origin: string; body: string }
export interface ShellContextChip { label: string; request: ShellContextRequest; preview: ShellContextItem[] }
interface ContextOption { label: string; detail: string; request: ShellContextRequest }
export default function ShellContextPicker({cwd,sessionId,chips,onChange}:{cwd:string;sessionId:string;chips:ShellContextChip[];onChange:(chips:ShellContextChip[])=>void}) {
  const trigger=useRef<HTMLButtonElement>(null),generation=useRef(0);
  const [open,setOpen]=useState(false),[options,setOptions]=useState<ContextOption[]>([]),[query,setQuery]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const current=useRef({chips,onChange});current.current={chips,onChange};
  useEffect(()=>()=>{generation.current++;},[]);
  useEffect(()=>{if(!open)return;let alive=true;setError("");void invoke<ContextOption[]>("shell_context_options",{cwd,sessionId:sessionId||null}).then(value=>{if(alive)setOptions(value);}).catch(error=>{if(alive)setError(String(error));});return()=>{alive=false;};},[open,cwd,sessionId]);
  const attach=async(request:ShellContextRequest,label:string)=>{
    if(current.current.chips.length>=20){setError("Use at most 20 context items");return;}
    if(current.current.chips.some(chip=>JSON.stringify(chip.request)===JSON.stringify(request))){setOpen(false);return;}
    const epoch=generation.current;setBusy(true);setError("");
    try {const preview=await invoke<ShellContextItem[]>("shell_context_preview",{cwd,sessionId:sessionId||null,request});if(epoch!==generation.current)return;current.current.onChange([...current.current.chips,{label,request,preview}]);setOpen(false);}
    catch(error){if(epoch===generation.current)setError(String(error));}
    finally{if(epoch===generation.current)setBusy(false);}
  };
  const file=async()=>{try{const path=await openDialog({multiple:false,directory:false,defaultPath:cwd||undefined});if(typeof path==="string")await attach({kind:"file",path},`@file · ${path.split("/").pop()}`);}catch(error){setError(String(error));}};
  const filtered=options.filter(option=>`${option.label} ${option.detail}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="rl-shell-context-picker">
    {!!chips.length&&<div className="rl-shell-context-chips" aria-label="Attached context">{chips.map((chip,index)=><div key={JSON.stringify(chip.request)} className="rl-shell-context-chip"><details><summary>{chip.label}</summary>{chip.preview.map((item,index)=><div key={index}><small>{item.origin}</small><pre>{item.body}</pre></div>)}</details><button type="button" aria-label={`Remove ${chip.label}`} onClick={()=>onChange(chips.filter((_,i)=>i!==index))}>×</button></div>)}</div>}
    <button ref={trigger} type="button" disabled={busy} aria-haspopup="dialog" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>{busy?"Reading context…":"Attach context"}</button>
    {open&&<BrowserPopover anchor={trigger} title="Attach context" menu={false} width={420} onClose={()=>setOpen(false)}>
      <div className="rl-shell-context-menu"><input autoFocus aria-label="Find context" placeholder="Plan section, comment, browser tab…" value={query} onChange={event=>setQuery(event.target.value)}/><button type="button" disabled={busy} onClick={()=>void file()}>@file · Choose a project file…</button>{filtered.map(option=><button type="button" disabled={busy} key={JSON.stringify(option.request)} onClick={()=>void attach(option.request,option.label)}><span>{option.label}</span><small>{option.detail}</small></button>)}{!filtered.length&&<p>No matching plan or browser context. You can attach a project file.</p>}{error&&<p role="alert">{error}</p>}</div>
    </BrowserPopover>}
    {error&&!open&&<small role="alert">{error}</small>}
  </div>;
}
