import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryMapTab } from "../../src/components/MemoryMap";
import { graphicsAllocation } from "../../src/lib/graphicsAllocation";
import type { CosmosView } from "../../src/lib/memoryMap3d";
import { setCount } from "./services";
function Fixture() {
  const view=useRef<CosmosView>({}); const [tab,setTab]=useState("map"); const [focus,setFocus]=useState<unknown>(null);
  (window as unknown as {__cosmos:unknown}).__cosmos={view,setTab,setCount,graphicsAllocation,getFocus:()=>focus};
  return <div style={{height:"100vh",display:"flex",flexDirection:"column",background:"#060b16",fontFamily:"system-ui",color:"#cfdeef"}}>
    <header style={{height:54,flexShrink:0,display:"flex",alignItems:"center",gap:16,padding:"0 20px",borderBottom:"1px solid #293950"}}><strong style={{letterSpacing:3,fontSize:12}}>REDLINE / MEMORY</strong><span style={{flex:1}}/><button id="map-tab" onClick={()=>setTab("map")}>Cosmos</button><button id="timeline-tab" onClick={()=>setTab("timeline")}>Timeline</button></header>
    {tab==="map"?<MemoryMapTab view={view} onFocus={f=>{setFocus(f);setTab("timeline");}}/>:<div style={{padding:24}}><h2>Timeline</h2><pre>{JSON.stringify(focus,null,2)}</pre></div>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
