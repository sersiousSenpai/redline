import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CommentThread } from "../../src/components/CommentThread";
import { MarkdownView } from "../../src/components/MarkdownView";
import { SidebarTabStrip } from "../../src/components/SidebarTabStrip";
import { PlanStateMenu } from "../../src/components/PlanStateMenu";
import { MoveToRepoDialog } from "../../src/components/MoveToRepoDialog";
import { ServersPane } from "../../src/components/ServersPane";
import type { FolderTab } from "../../src/types";
import type { SidebarTab } from "../../src/hooks/useFolderWorkspaces";
import { applyTheme } from "../../src/theme/applyTheme";
import "../../src/styles.css";
function Fixture() {
 const [move,setMove]=useState(false),[surface,setSurface]=useState("plan");
 const [folders,setFolders]=useState<FolderTab[]>([{id:"one",path:"/code/redline",name:"redline"},{id:"two",path:"/code/another-project",name:"another-project"}]);
 const [sidebarTab,setSidebarTab]=useState<SidebarTab>({kind:"folder",id:"one"}),[linked,setLinked]=useState(true);
 const sidebar=<SidebarTabStrip openFolders={folders} sidebarTab={sidebarTab} onSelectSessions={()=>setSidebarTab({kind:"sessions"})} onSelectFolder={id=>setSidebarTab({kind:"folder",id})} onCloseFolder={id=>{setFolders(old=>old.filter(folder=>folder.id!==id));if(sidebarTab.kind==="folder"&&sidebarTab.id===id)setSidebarTab({kind:"sessions"});}} linkNav={linked} onToggleLink={()=>setLinked(old=>!old)}/>;
 useEffect(()=>{(window as any).__qa={setTheme:applyTheme,setMove,setSurface,getState:()=>({folders,sidebarTab,linked})};document.documentElement.dataset.qaReady="true";},[folders,sidebarTab,linked]);
 if(surface==="servers")return <ServersPane scan={{running:[{pid:100,port:5173,extraPorts:[5174],url:"http://localhost:5173",comm:"node",args:"vite",projectPath:"/code/redline",projectName:"Redline",stack:"Redline (Vite)",runCommand:"npm run dev",thumbPath:null},{pid:101,port:3000,extraPorts:[],url:"http://localhost:3000",comm:"node",args:"next dev",projectPath:"/code/machine-os",projectName:"MachineOS",stack:"MachineOS (Next.js)",runCommand:"npm run dev",thumbPath:null}],recent:[{id:1,projectPath:"/code/research",projectName:"Research",port:4321,url:"http://localhost:4321",stack:"Research (Astro)",runCommand:"npm run dev",lastSeenAt:Date.now()-1200000,thumbPath:null,portBusy:false}],others:[{pid:9,port:5353,comm:"mDNSResponder"}],redline:[{port:7676,role:"Bridge"}]}} error={null} onRefresh={()=>{(window as any).__qaRefreshed=true;}} onStop={()=>{(window as any).__qaStopped=true;}} onPlanStop={async()=>({root:100,rootLabel:"Vite",pids:[100],collateralPorts:[]})} projectOptions={[]} onRun={(path,command)=>{(window as any).__qaRun={path,command};}} onOpenUrl={url=>{(window as any).__qaOpen=url;}}/>;
 if(surface==="sidebar")return <main style={{padding:20,color:"var(--color-ink)",background:"var(--color-paper)",height:"100vh"}}><h1>Sidebar projects</h1><div style={{width:"100%",maxWidth:360,marginTop:20}}>{sidebar}</div><p style={{padding:12}}>{sidebarTab.kind==="sessions"?"Sessions":folders.find(folder=>folder.id===sidebarTab.id)?.name}</p></main>;
 return <main style={{height:"100vh",overflow:"auto",padding:24,background:"var(--color-paper)",color:"var(--color-ink)"}}>
 <h1 style={{fontSize:20,marginBottom:16}}>Redline · Plan discussion</h1>
 <div style={{display:"flex",gap:24,alignItems:"start",flexWrap:"wrap"}}>
 <article style={{width:430,border:"1px solid var(--color-rule)",padding:16,borderRadius:12}}>
 <p>How should we scope this?</p>
 <CommentThread sessionId="qa-sidecar" comment={{id:"qa-c",body:"How should we scope this?",type:"question",status:"resolved",createdAt:1,anchorId:"A.1"}} autoOpen/>
 </article>
 <aside style={{width:360}}><h2>Plan controls</h2>
 {sidebar}
 <div style={{padding:16}}><PlanStateMenu session={{status:"approved",runState:null}} onState={()=>{}} onMove={()=>setMove(true)}>Approved · not built</PlanStateMenu></div>
 <p>The plan editor keeps its light figure plate:</p><MarkdownView rich body={'```mermaid\nflowchart LR\n  review[review] --> build[build]\n```'}/>
 </aside></div>
 {move&&<MoveToRepoDialog markdown="# Redline work" currentProject="/code/redline" options={[{path:"/code/redline",name:"redline",source:"folder"}]} onConfirm={async()=>{}} onCancel={()=>setMove(false)}/>}
 </main>;
}
applyTheme("studio");
createRoot(document.getElementById("root")!).render(<Fixture/>);
