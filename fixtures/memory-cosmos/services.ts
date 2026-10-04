import type { MemoryMapData, MapNode } from "../../src/lib/memoryMap";
const names = ["Research & evidence", "Case strategy", "Product decisions", "Design language", "People & conversations", "Engineering practice", "Long-term questions", "Personal knowledge"];
const topics = ["Origins", "Field notes", "Open questions", "Observations", "Design review", "Next steps", "Experiments", "Connections", "Decisions", "Source trail", "Reflections", "Working draft"];
const listeners = new Map<string, Set<() => void>>();
let count = 150;
export function makeData(total = count): MemoryMapData {
  const nodes: MapNode[] = Array.from({length:total},(_,i)=>({ id:`memory-${i}`, kind:i<8?"class":i%7===0?"digest":i%3===0?"session":"thread", label:i<8?names[i]:`${topics[i%topics.length]} ${Math.floor(i/12)+1}`, mass:i<8?45+i*20:2+(i*13)%70, parentId:i<8?null:`memory-${i<60?i%8:8+i%40}`, pinned:i%19===0, projectPath:null, classNodeId:i<8?`class-${i}`:null, sessionId:i>=8&&i%3===0?`session-${i}`:null, browseId:i>=8&&i%3===1?`browser-${i}`:null, threadId:i>=8&&i%3===2?`thread-${i}`:null }));
  return {generatedTs:0,nodes,edges:[...nodes.filter(n=>n.parentId).map(n=>({kind:"contains" as const,from:n.parentId!,to:n.id,weight:1,basis:"Filed beneath this memory class"})),...nodes.filter((_,i)=>i>10&&i%9===0).map((n,i)=>({kind:(i%3===0?"supersedes":i%3===1?"lineage":"co_occurs") as "supersedes"|"lineage"|"co_occurs",from:`memory-${i%8}`,to:n.id,weight:1,basis:"A recorded connection in the synthetic validation corpus"}))]};
}
export async function invoke(command:string) { if(command==="memory_map")return makeData(); throw new Error(`Unexpected fixture command ${command}`); }
export async function listen(name:string,fn:()=>void) { if(!listeners.has(name))listeners.set(name,new Set()); listeners.get(name)!.add(fn); return()=>{listeners.get(name)?.delete(fn);}; }
export function setCount(value:number) { count=value; for(const fn of listeners.get("classmem-changed")??[])fn(); }
