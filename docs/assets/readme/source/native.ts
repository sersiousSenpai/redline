import {session,summaries,sections} from './data';
const requested='document';
const noop=()=>{};const events=new Map<string,Set<Function>>();
let interceptSeeded=false;
export const calls:string[]=[];
export async function invoke(command:string,args:any={}){
 if(!calls.includes(command)){calls.push(command);document.documentElement.dataset.calls=JSON.stringify(calls)}
 switch(command){
 case 'bootstrap_state':return {sessions:summaries,heldSessionId:session.sessionId,mode:'active',daemon:'ready',workspace:JSON.stringify({version:1,landing:'document'}),harnessFlavor:null,harnesses:[]};
 case 'get_session':{
  if(requested==='document'&&!interceptSeeded){interceptSeeded=true;setTimeout(()=>void emit('plan-received',{sessionId:session.sessionId,version:3,isNewSession:false,threadStart:false,resolutionsAttached:1,unmatchedResolutionIds:[],unresolvedSubmittedIds:[],resolutionParseError:null,mode:'revise',restored:false}),1200)}
  return session;
 }
 case 'bookshelf_list':return {folders:[],drafts:[]};
 case 'draft_source_list':return [];
 case 'list_sessions':return summaries;
 case 'parse_markdown_sections':return sections;
 case 'get_ui_prefs':return {theme:'terminal',font:'san-francisco',lint:'off'};
 case 'get_thread':return args.commentId==='c-002'?[{id:'t-001',sessionId:session.sessionId,commentId:'c-002',role:'assistant',body:'Exercise the lease boundary: pause worker A, let its lease expire, then claim the job with worker B. Assert that only B can commit the result.',status:'complete',createdAt:Date.now()-20000}]:[];
 case 'fork_thread_status':return {streaming:false,startedAt:null,partial:null,seq:0,queued:[]};
 case 'thread_meters':return {};
 case 'pty_list':return [];
 case 'pty_cwds':return {};
 case 'pty_cwd':return null;
 case 'fork_thread_model':return [null,null];
 case 'pty_is_live':return false;
 case 'pty_spawn':case 'pty_attach':{
  const output='\u001b]0;Claude Code\u0007\u001b[2muser ~ % claude\u001b[0m\r\n\u001b[1m❯ /updated plan\u001b[0m\r\n  Updated durable state, idempotent retries, and recovery checks.\r\n';
  args.onOutput?.onmessage(new TextEncoder().encode(output).buffer);return null;
 }
 case 'pty_ack':case 'pty_detach':case 'pty_write':return null;
 case 'daemon_state':return 'ready';
 case 'scan_hook_conflicts':return {conflicts:[],errors:[],inactivePlugins:[]};
 case 'watch_hook_conflicts':return 'preview-watch';
 case 'preflight_status':return {claude:{found:true,path:'/sample/bin/claude',source:'fixture'},curl:{ok:true,version:'sample'},mode:'active',hook:{installed:true,conflictingUrl:null,settingsPath:'/sample/.claude/settings.json'},skill:{installed:true,outdated:false,skillPath:'/sample/skills/redline-plan-review'}};
 case 'get_relay_config':return {displayName:'Reviewer',signaling:[]};
 case 'memory_status':return {live:true,itemCount:24,backlog:0,lastOrganizedTs:null,lastOrganizedSummary:null,chainOk:true,compactedCount:0,reclaimedBytes:0,lastCompactionTs:null,queuedProposals:0};
 case 'get_work_graph':return {items:[],edges:[],readyIds:[]};
 case 'home_dir':return '/sample';
 case 'get_collab_share':return null;
 case 'get_hook_status':return {installed:true};
 case 'get_skill_status':return {installed:true,outdated:false};
 case 'get_version':return '0.1.0';
 case 'list_harnesses':case 'companion_list':case 'self_develop_list':case 'list_themes':case 'list_fonts':case 'get_agent_seats':case 'list_extensions':case 'list_dir':case 'get_mission_list':case 'mission_list':case 'bookshelf_folders':case 'review_sessions_list':case 'list_plan_runs':case 'list_orchestrations':return [];
 }
 if(/^(set_|save_|record_|watch_|unwatch_|show_|browser_set|browser_enable|browser_install|surface_|pty_resize)/.test(command))return null;
 // Unknown service calls cannot reach a real daemon, process, filesystem, or provider.
 throw new Error(`Preview service is not implemented: ${command}`);
}
export async function listen(name:string,fn:Function){let group=events.get(name);if(!group)events.set(name,group=new Set());group.add(fn);return()=>group!.delete(fn)}
export async function emit(name:string,payload:any){events.get(name)?.forEach(fn=>fn({event:name,payload}))}
export const emitTo=async(_target:string,name:string,payload:any)=>emit(name,payload);
export async function once(name:string,fn:Function){const off=await listen(name,(e:any)=>{off();fn(e)});return off}
export async function open(){return null}export const save=open;export async function openUrl(){}export async function revealItemInDir(){}export async function openPath(){}
export function convertFileSrc(p:string){return p}export function isTauri(){return false}export class Channel{onmessage=noop;id=0}
export const getVersion=async()=> '0.1.0';export const getName=async()=> 'Redline';export const getCurrent=async()=>null;export const onOpenUrl=async()=>noop;
export const homeDir=async()=>'/sample';export const appDataDir=async()=>'/sample';export const join=async(...p:string[])=>p.join('/');
export class LogicalPosition{constructor(public x:number,public y:number){}}export class LogicalSize{constructor(public width:number,public height:number){}}export class PhysicalPosition extends LogicalPosition{}export class PhysicalSize extends LogicalSize{}
const nativeWindow=new Proxy({label:'main',onResized:async()=>noop,onMoved:async()=>noop,onFocusChanged:async()=>noop,onCloseRequested:async()=>noop,listen,once,emit,isFullscreen:async()=>false,isMaximized:async()=>false,scaleFactor:async()=>1,innerSize:async()=>new PhysicalSize(innerWidth,innerHeight),outerPosition:async()=>new PhysicalPosition(0,0)},{get:(o,k)=>k in o?(o as any)[k]:async()=>null});
export const getCurrentWindow=()=>nativeWindow;
export class Window{static getCurrent(){return nativeWindow}static async getByLabel(){return nativeWindow}}
export const getCurrentWebview=()=>({...nativeWindow,onDragDropEvent:async()=>noop});
// Native pages are outside the Document-only fixture.
export class Webview{label:string;constructor(_window:any,label:string,_options:any){this.label=label}async once(){return noop}async listen(){return noop}async setPosition(){}async setSize(){}async setFocus(){}async show(){}async hide(){}async close(){}async reparent(){}static async getAll(){return []}static async getByLabel(){return null}}
