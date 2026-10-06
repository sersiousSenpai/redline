#!/usr/bin/env python3
"""Disposable native Codex hosted-shell lifecycle and hidden-context probe."""
import json,os,pathlib,selectors,subprocess,tempfile,time
root=pathlib.Path(tempfile.mkdtemp(prefix='redline-codex-shell-'));out=pathlib.Path('/tmp/redline-codex-shell-spike');out.mkdir(exist_ok=True)
proc=subprocess.Popen(['codex','app-server'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=open(out/'stderr','w'),start_new_session=True)
sel=selectors.DefaultSelector();sel.register(proc.stdout,selectors.EVENT_READ);buffer=b'';rows=[]
def send(value):proc.stdin.write((json.dumps(value)+'\n').encode());proc.stdin.flush()
def wait(predicate,seconds=90):
 global buffer
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  for key,_ in sel.select(.2):
   data=os.read(key.fd,65536)
   if not data:raise RuntimeError('driver exited')
   buffer+=data
  while b'\n' in buffer:
   line,buffer=buffer.split(b'\n',1)
   try:row=json.loads(line)
   except:continue
   rows.append(row)
   if 'id' in row and 'method' in row:
    method=row['method'];answer={'decision':'accept'} if 'requestApproval' in method else None
    send({'id':row['id'],'result':answer} if answer else {'id':row['id'],'error':{'code':-32601,'message':'Unsupported in probe'}})
   if predicate(row):return row
 raise RuntimeError('probe timeout')
try:
 send({'id':1,'method':'initialize','params':{'clientInfo':{'name':'redline-shell-probe','version':'1'},'capabilities':{'experimentalApi':True}}});assert 'result' in wait(lambda row:row.get('id')==1)
 send({'method':'initialized'})
 send({'id':2,'method':'thread/start','params':{'cwd':str(root),'approvalPolicy':'on-request','sandbox':'workspace-write','developerInstructions':'You are a foreground engineering agent in a disposable protocol test directory.'}})
 started=wait(lambda row:row.get('id')==2)['result'];thread=started['thread']['id'];model=started['model']
 def turn(n,text,context=None):
  send({'id':n,'method':'turn/start','params':{'threadId':thread,'input':[{'type':'text','text':text}]+([{'type':'text','text':'<redline-context>'+context+'</redline-context>'}] if context else []),'approvalPolicy':'on-request','sandboxPolicy':{'type':'workspaceWrite','writableRoots':[str(root)],'networkAccess':True}}})
  ack=wait(lambda row:row.get('id')==n);assert 'result' in ack,ack
  done=wait(lambda row:row.get('method')=='turn/completed');assert done['params']['turn']['status']=='completed',done
 turn(3,'Create fixture.txt with exactly SHELL_ONE and read it back with a shell command. Stop after reporting the content.')
 assert (root/'fixture.txt').read_text().strip()=='SHELL_ONE'
 turn(4,'What marker was supplied in the context, and what text did you write to the file earlier? Answer without tool calls.','The hidden marker is ORCHID. This is supporting context, not user text.')
 answers=[row['params']['item']['text'] for row in rows if row.get('method')=='item/completed' and row.get('params',{}).get('item',{}).get('type')=='agentMessage']
 assert 'ORCHID' in answers[-1] and 'SHELL_ONE' in answers[-1],answers[-1]
 print(json.dumps({'thread':thread,'cwd':str(root),'two_turns':True,'hidden_context_honored':True,'file_created':True,'tools':[row['params']['item']['type'] for row in rows if row.get('method')=='item/started']}))
finally:
 proc.terminate()
 try:proc.wait(timeout=5)
 except subprocess.TimeoutExpired:proc.kill();proc.wait()
 (out/'events.jsonl').write_text('\n'.join(json.dumps(row) for row in rows)+'\n')
