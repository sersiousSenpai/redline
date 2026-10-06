#!/usr/bin/env python3
"""Disposable hosted Claude protocol probe; writes JSONL golden fixtures, no project edits."""
import argparse, http.server, json, os, pathlib, selectors, subprocess, tempfile, threading, time, uuid
P=argparse.ArgumentParser();P.add_argument('--out',default='/tmp/redline-agent-shell-spike');P.add_argument('--case',choices=['permissions','plan','multiblock','workflow','interrupt','slash'],default='permissions');args=P.parse_args()
out=pathlib.Path(args.out);out.mkdir(parents=True,exist_ok=True)
root=pathlib.Path(tempfile.mkdtemp(prefix='redline-shell-probe-'));(root/'fixture.txt').write_text('scratch fixture\n')
hooks=[];plan_count=0
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_POST(self):
  global plan_count
  payload=json.loads(self.rfile.read(int(self.headers['Content-Length'])));hooks.append(payload)
  if payload.get('hook_event_name')=='UserPromptSubmit':
   response={'hookSpecificOutput':{'hookEventName':'UserPromptSubmit','additionalContext':'Protocol probe context: the secret marker is ORCHID. Include ORCHID in your answer.'}}
  else:
   plan_count+=1;time.sleep(2)
   response={'hookSpecificOutput':{'hookEventName':'PreToolUse','permissionDecision':'deny' if plan_count==1 else 'allow','permissionDecisionReason':'Reviewer feedback: add a validation step and call ExitPlanMode again.' if plan_count==1 else 'Approved'}}
  body=json.dumps(response).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(body)
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
url='http://127.0.0.1:'+str(server.server_port)
settings={'hooks':{'UserPromptSubmit':[{'hooks':[{'type':'http','url':url+'/ingest','timeout':30}]}],'PreToolUse':[{'matcher':'ExitPlanMode','hooks':[{'type':'http','url':url+'/plan','timeout':43200}]}]}}
(root/'settings.json').write_text(json.dumps(settings))
env={k:v for k,v in os.environ.items() if not k.startswith('CLAUDE') and k!='REDLINE_AGENT_SEAT'}
sid=str(uuid.uuid4());cmd=['claude','-p','--input-format','stream-json','--output-format','stream-json','--include-partial-messages','--verbose','--replay-user-messages','--permission-prompts','host','--permission-prompt-tool','stdio','--session-id',sid,'--permission-mode','plan' if args.case=='plan' else 'manual','--settings',str(root/'settings.json'),'--setting-sources','','--strict-mcp-config']
p=subprocess.Popen(cmd,cwd=root,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
errors=[];threading.Thread(target=lambda:errors.extend(p.stderr.readlines()),daemon=True).start()
def send(v):p.stdin.write(json.dumps(v)+'\n');p.stdin.flush()
request_log=[]
def control(subtype,**kw):
 rid=str(uuid.uuid4());request={'type':'control_request','request_id':rid,'request':{'subtype':subtype,**kw}};request_log.append(request);send(request)
control('initialize')
if args.case=='interrupt':prompt='Use Bash to run sleep 20, then report done. This is a disposable interrupt protocol test.'
elif args.case=='slash':prompt='/context'
elif args.case=='workflow':prompt='Use the Workflow tool to launch an ultracode workflow for a disposable test: read fixture.txt and report its content, make no edits. The user approves only this disposable read task. Ask the host for workflow approval if needed. Do not substitute Task.'
elif args.case=='plan':prompt='Do not inspect the repository. Propose a two-step plan to add a greeting test in this disposable fixture. Call ExitPlanMode with your plan now. If the reviewer requests validation, add that step and call ExitPlanMode again. Stop after approval.'
elif args.case=='permissions':prompt='Protocol test in a disposable directory. First use Write to replace fixture.txt with the text protocol. Then use Bash to execute cat fixture.txt. Then call AskUserQuestion with one question asking which color I prefer (red or blue). Use my choice and the injected secret marker in your answer.'
else:prompt='What is the injected secret marker? Answer in one sentence.'
content=[{'type':'text','text':prompt}]
if args.case=='multiblock':content.append({'type':'text','text':'SECOND_BLOCK_CONTEXT. This is supplemental context, not part of the visible prompt.'})
send({'type':'user','message':{'role':'user','content':content}})
sel=selectors.DefaultSelector();sel.register(p.stdout,selectors.EVENT_READ);start=time.time();rows=[];results=0;done=None;controls_sent=False;interrupt_sent=False
while time.time()-start<150:
 for key,_ in sel.select(.25):
  line=key.fileobj.readline()
  if not line:continue
  try:v=json.loads(line)
  except:continue
  rows.append(v)
  if args.case=='interrupt' and not interrupt_sent and v.get('type')=='assistant' and any(block.get('name')=='Bash' for block in v.get('message',{}).get('content',[]) if isinstance(block,dict)):
   time.sleep(1);control('interrupt');interrupt_sent=True
  if v.get('type')=='control_request' and v.get('request',{}).get('subtype')=='can_use_tool':
   req=v['request'];input=req.get('input',{});tool=req.get('tool_name')
   if tool=='AskUserQuestion':input={**input,'answers':{q['question']:'blue' for q in input.get('questions',[])}}
   send({'type':'control_response','response':{'subtype':'success','request_id':v['request_id'],'response':{'behavior':'allow','updatedInput':input}}})
  if v.get('type')=='result':
   results+=1;done=time.time()
   if not controls_sent:
    control('set_permission_mode',mode='default');control('set_model',model='sonnet');control('interrupt');controls_sent=True
 if done and time.time()-done>3:break
 if p.poll() is not None:break
control_error=None
try:control('interrupt');time.sleep(.25)
except Exception as e:control_error=str(e)
p.kill();p.wait();server.shutdown()
(out/(args.case+'.jsonl')).write_text('\n'.join(json.dumps(row) for row in rows)+'\n')
(out/(args.case+'.hooks.json')).write_text(json.dumps(hooks,indent=2))
(out/(args.case+'.requests.json')).write_text(json.dumps(request_log,indent=2))
(out/(args.case+'.stderr')).write_text(''.join(errors))
print(json.dumps({'case':args.case,'session_id':sid,'result_count':results,'hooks':len(hooks),'plan_hooks':plan_count,'control_requests':[(row.get('request',{}).get('subtype'),row.get('request',{}).get('tool_name')) for row in rows if row.get('type')=='control_request'],'results':[row.get('result') for row in rows if row.get('type')=='result'],'control_error':control_error}))
