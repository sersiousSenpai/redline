#!/usr/bin/env python3
"""Exercise hosted Codex stdio, a held Stop hook, and the same approval RPC sequence.

Uses an isolated CODEX_HOME, a temporary workspace, and a local mock Responses
server; no model service or user account is contacted. Requires Codex >=0.154,
Cargo, and permission to bind loopback / run Codex's native sandbox.
Run: python3 scripts/probe-codex-approval.py [--restore]
"""
import fcntl, json, os, pathlib, pty, signal, struct, subprocess, sys, tempfile, termios, threading, time

REPO = pathlib.Path(__file__).resolve().parent.parent
CODEX = os.environ.get('REDLINE_PROBE_CODEX', 'codex')
RESTORE = False
PLAN_TURNS = 2 if RESTORE else 1
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

root = pathlib.Path(tempfile.mkdtemp(prefix="rlcx-", dir="/private/tmp"))
home = root / "home"
home.mkdir()
workspace = root / "workspace"
workspace.mkdir()
requests = []
restore_after_build = False

class Mock(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        last_user = next((item for item in reversed(body.get('input', [])) if item.get('role') == 'user'), {})
        title_request = 'Generate a concise, single-line task title' in json.dumps(last_user)
        if not title_request: requests.append(body)
        text = '<proposed_plan>Write approved.txt and verify it.</proposed_plan>' if len(requests) <= PLAN_TURNS or restore_after_build else 'Implementation turn received.'
        if title_request: text = 'Approval probe'
        item = {'id':'msg_'+str(len(requests)), 'type':'message', 'role':'assistant', 'status':'completed', 'content':[{'type':'output_text','text':text,'annotations':[]}]}
        events = [
            ('response.created', {'response': {'id':'resp_'+str(len(requests)),'object':'response','status':'in_progress','output':[]}}),
            ('response.output_item.added', {'output_index':0,'item':dict(item, status='in_progress',content=[])}),
            ('response.content_part.added', {'item_id':item['id'],'output_index':0,'content_index':0,'part':{'type':'output_text','text':'','annotations':[]}}),
            ('response.output_text.delta', {'item_id':item['id'],'output_index':0,'content_index':0,'delta':text}),
            ('response.output_item.done', {'output_index':0,'item':item}),
            ('response.completed', {'response': {'id':'resp_'+str(len(requests)),'object':'response','status':'completed','output':[item],'usage':{'input_tokens':10,'output_tokens':10,'total_tokens':20}}})
        ]
        if not title_request and len(requests) == PLAN_TURNS + 1:
            item = {'id':'fc_write','type':'function_call','call_id':'call_write','name':'exec_command','arguments':json.dumps({'cmd':"printf 'approved\\n' > approved.txt"})}
            events = [('response.created', {'response':{'id':'resp_2','object':'response','status':'in_progress','output':[]}}), ('response.output_item.added',{'output_index':0,'item':dict(item,arguments='')}), ('response.output_item.done',{'output_index':0,'item':item}), ('response.completed',{'response':{'id':'resp_2','object':'response','status':'completed','output':[item],'usage':{'input_tokens':10,'output_tokens':10,'total_tokens':20}}})]
        data = ''.join('event: '+kind+'\ndata: '+json.dumps(dict(payload,type=kind))+'\n\n' for kind,payload in events).encode()
        self.send_response(200)
        self.send_header('Content-Type','text/event-stream')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

server = ThreadingHTTPServer(('127.0.0.1',0), Mock)
threading.Thread(target=server.serve_forever,daemon=True).start()
hook = root / 'hook.py'
hook.write_text('''import json,os,pathlib,sys,time
root=pathlib.Path(__file__).parent
payload=json.load(sys.stdin)
if payload.get("hook_event_name")=="UserPromptSubmit":
 with (root/"prompts.jsonl").open("a") as output: output.write(json.dumps(payload)+"\\n")
 print("{}")
 sys.exit(0)
if "<proposed_plan>" not in (payload.get("last_assistant_message") or ""):
 print("{}")
 sys.exit(0)
payload["redline_socket"] = os.environ.get("REDLINE_CODEX_SOCKET")
(root/"held.json").write_text(json.dumps(payload))
while not (root/"release.json").exists(): time.sleep(.05)
print((root/"release.json").read_text())
''')
# Only the exact discovered fixture hook hashes are trusted for this test thread.
(home/'hooks.json').write_text(json.dumps({'hooks':{'Stop':[{'hooks':[{'type':'command','command':'/usr/bin/python3 '+str(hook),'timeout':240}]}],'UserPromptSubmit':[{'hooks':[{'type':'command','command':'/usr/bin/python3 '+str(hook),'timeout':30}]}]}}))
(home/'config.toml').write_text('features.hooks = true\nmodel = "gpt-5.5"\nmodel_provider = "probe"\n[model_providers.probe]\nname = "Probe"\nbase_url = "http://127.0.0.1:'+str(server.server_port)+'/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n')
contract = (REPO/'src-tauri/src/codex_plan_contract.txt').read_text()
(home/'redline-plan.config.toml').write_text('developer_instructions = '+json.dumps(contract)+'\n')
with (home/'config.toml').open('a') as config:
    config.write('\n[projects.'+json.dumps(str(workspace))+']\ntrust_level = "trusted"\n')
env = dict(os.environ, CODEX_HOME=str(home), TERM='xterm-256color', REDLINE_PLAN_LAUNCH_ID='approval-probe')

import selectors
child=subprocess.Popen([CODEX,'app-server'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=open(root/'stderr.log','w'),cwd=workspace,env=env,start_new_session=True)
selector=selectors.DefaultSelector();selector.register(child.stdout,selectors.EVENT_READ);buffer=b'';rows=[];request_id=0

def send(value):child.stdin.write((json.dumps(value)+'\n').encode());child.stdin.flush()
def receive(predicate,seconds=20):
 global buffer
 until=time.monotonic()+seconds
 while time.monotonic()<until:
  for key,_ in selector.select(.05):
   data=os.read(key.fd,65536)
   if not data:raise RuntimeError('App server exited')
   buffer+=data
  while b'\n' in buffer:
   line,buffer=buffer.split(b'\n',1)
   try:row=json.loads(line)
   except:continue
   rows.append(row)
   if row.get('method','').endswith('/requestApproval'):send({'id':row['id'],'result':{'decision':'accept'}})
   if predicate(row):return row
  if predicate(None):return None
 raise RuntimeError('Timed out waiting for protocol acknowledgement')
def request(method,params):
 global request_id
 request_id+=1;rid='probe-'+str(request_id);send({'id':rid,'method':method,'params':params});response=receive(lambda row:row is not None and row.get('id')==rid)
 if 'error' in response:raise RuntimeError(str(response['error']))
 return response['result']
try:
 request('initialize',{'clientInfo':{'name':'redline-hosted-probe','version':'1'},'capabilities':{'experimentalApi':True}});send({'method':'initialized'})
 hooks=request('hooks/list',{'cwds':[str(workspace)]});(root/'hooks-list.json').write_text(json.dumps(hooks,indent=2))
 def grants(value):
  found={}
  if isinstance(value,dict):
   if 'key' in value and 'currentHash' in value:found[value['key']]={'trusted_hash':value['currentHash']}
   for child in value.values():found.update(grants(child))
  elif isinstance(value,list):
   for child in value:found.update(grants(child))
  return found
 trust=grants(hooks);assert trust,'Fixture hook unavailable for scoped trust'
 thread=request('thread/start',{'cwd':str(workspace),'model':'gpt-5.5','approvalPolicy':'on-request','sandbox':'read-only','developerInstructions':contract,'config':{'hooks.state':trust}})['thread']['id']
 request('turn/start',{'threadId':thread,'input':[{'type':'text','text':'Return the plan.'},{'type':'text','text':'<redline-context>ORCHID</redline-context>'}],'model':'gpt-5.5','effort':'high','approvalPolicy':'on-request','sandboxPolicy':{'type':'readOnly','networkAccess':True}})
 receive(lambda row:(root/'held.json').exists())
 held=json.loads((root/'held.json').read_text());assert held['session_id']==thread
 assert not (workspace/'approved.txt').exists()
 current=request('thread/read',{'threadId':thread,'includeTurns':False})['thread'];assert current['status']['type']=='active'
 queue=request('thread/queue/list',{'threadId':thread,'cursor':None});assert not queue['data']
 request('thread/settings/update',{'threadId':thread,'approvalPolicy':'on-request','sandboxPolicy':{'type':'workspaceWrite','networkAccess':False},'collaborationMode':{'mode':'default','settings':{'model':current['model'],'reasoning_effort':current.get('reasoningEffort'),'developer_instructions':'The reviewer has approved the plan in Redline. The earlier Redline planning-only instructions are complete and no longer apply. Implement the approved plan.'}}})
 queued=request('thread/queue/add',{'threadId':thread,'clientUserMessageId':'hosted-approval','input':[{'type':'text','text':'Redline plan approved. Begin implementing the approved plan now.\n\nApproved plan: Write approved.txt and verify it.'}]});assert queued['queuedSubmission']['id']
 retry=request('thread/queue/list',{'threadId':thread,'cursor':None});assert sum(item.get('clientUserMessageId')=='hosted-approval' for item in retry['data'])==1
 (root/'release.json').write_text('{}')
 receive(lambda row:(workspace/'approved.txt').exists(),30)
 assert (workspace/'approved.txt').read_text().strip()=='approved'
 assert 'workspace-write' in json.dumps(requests[1]);assert requests[1]['model']=='gpt-5.5';assert requests[1]['reasoning']['effort']=='high'
 print('Prompt hook:',(root/'prompts.jsonl').read_text() if (root/'prompts.jsonl').exists() else 'missing',flush=True)
 print('PASS: same hosted driver held plan, acknowledged settings and queue, deduplicated retry, and wrote approved.txt after release.',flush=True)
finally:
 child.terminate()
 try:child.wait(timeout=3)
 except subprocess.TimeoutExpired:child.kill();child.wait()
 (root/'events.jsonl').write_text('\n'.join(json.dumps(row) for row in rows)+'\n');(root/'requests.json').write_text(json.dumps(requests,indent=2));server.shutdown();print('Probe artifacts:',root,flush=True)
