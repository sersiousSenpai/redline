#!/usr/bin/env python3
"""Exercise a real Codex TUI, Stop hook, and Redline's Rust approval adapter.

Uses an isolated CODEX_HOME, a temporary workspace, and a local mock Responses
server; no model service or user account is contacted. Requires Codex >=0.154,
Cargo, and permission to bind loopback / run Codex's native sandbox.
Run: python3 scripts/probe-codex-approval.py [--restore]
"""
import fcntl, json, os, pathlib, pty, signal, struct, subprocess, sys, tempfile, termios, threading, time

REPO = pathlib.Path(__file__).resolve().parent.parent
CODEX = os.environ.get('REDLINE_PROBE_CODEX', 'codex')
RESTORE = '--restore' in sys.argv
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
if "<proposed_plan>" not in (payload.get("last_assistant_message") or ""):
 print("{}")
 sys.exit(0)
payload["redline_socket"] = os.environ.get("REDLINE_CODEX_SOCKET")
(root/"held.json").write_text(json.dumps(payload))
while not (root/"release.json").exists(): time.sleep(.05)
print((root/"release.json").read_text())
''')
# Only this isolated fixture bypasses trust; the production launcher never does.
(home/'hooks.json').write_text(json.dumps({'hooks':{'Stop':[{'hooks':[{'type':'command','command':'/usr/bin/python3 '+str(hook),'timeout':240}]}]}}))
(home/'config.toml').write_text('bypass_hook_trust = true\nmodel = "gpt-5.5"\nmodel_provider = "probe"\n[model_providers.probe]\nname = "Probe"\nbase_url = "http://127.0.0.1:'+str(server.server_port)+'/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n')
contract = (REPO/'src-tauri/src/codex_plan_contract.txt').read_text()
(home/'redline-plan.config.toml').write_text('developer_instructions = '+json.dumps(contract)+'\n')
with (home/'config.toml').open('a') as config:
    config.write('\n[projects.'+json.dumps(str(workspace))+']\ntrust_level = "trusted"\n')
env = dict(os.environ, CODEX_HOME=str(home), TERM='xterm-256color', REDLINE_PLAN_LAUNCH_ID='approval-probe')
def launch(resume=None):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
    args = ['resume', resume] if resume else ['-s', 'read-only', '-a', 'never']
    child = subprocess.Popen(['/bin/sh', str(REPO/'src-tauri/src/codex_plan_launch.sh'), CODEX, *args,
        '-m', 'gpt-5.5', '-c', 'model_reasoning_effort="high"',
        '-p', 'redline-plan', '--dangerously-bypass-hook-trust', '--no-alt-screen', 'Return the plan.'],
        stdin=slave, stdout=slave, stderr=slave, env=env, cwd=workspace, start_new_session=True,
        preexec_fn=lambda: fcntl.ioctl(0, termios.TIOCSCTTY, 0))
    os.close(slave)
    terminal = []
    def read_terminal():
        trusted_fixture = False
        try:
            while True:
                data = os.read(master, 65536)
                if not data: break
                terminal.append(data.decode(errors='replace'))
                if b'\x1b[6n' in data: os.write(master, b'\x1b[1;1R')
                if not trusted_fixture and 'Hooks need review' in ''.join(terminal):
                    # Codex resume still asks for trust despite the fixture's
                    # bypass flag. Trust ONLY our vetted temporary hook.
                    trusted_fixture = True
                    print('Trusting isolated fixture hook…', flush=True)
                    time.sleep(.25)
                    os.write(master, b'2')
                    time.sleep(.1)
                    os.write(master, b'\r')
        except OSError: pass
    threading.Thread(target=read_terminal, daemon=True).start()
    return child, master, terminal

def stop(child, master):
    try: os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError: pass
    try: child.wait(timeout=3)
    except subprocess.TimeoutExpired: child.kill(); child.wait()
    os.close(master)

def wait_for_hook(child, terminal):
    until=time.time()+35
    while not (root/'held.json').exists() and time.time()<until and child.poll() is None: time.sleep(.05)
    if not (root/'held.json').exists(): raise RuntimeError('Stop hook never held; terminal: '+''.join(terminal)[-3000:])
    return json.loads((root/'held.json').read_text())

child, master, terminal = launch()

try:
    held = wait_for_hook(child, terminal)
    if RESTORE:
        thread_id = held['session_id']
        stop(child, master)
        (root/'initial-terminal.log').write_text(''.join(terminal))
        (root/'held.json').unlink()
        child, master, terminal = launch(thread_id)
        held = wait_for_hook(child, terminal)
        assert held['session_id'] == thread_id, 'Restore created a different thread'
        assert 'read-only' in json.dumps(requests[1]) and 'rl:blk-' in json.dumps(requests[1])
        print('PASS: restored the same thread in a new terminal with its plan profile.', flush=True)
    assert held['redline_socket'], 'Launcher did not propagate its socket to the hook'
    first=json.dumps(requests[0])
    assert 'read-only' in first and 'rl:blk-' in first, 'Planning permissions or profile lost in remote TUI'
    assert requests[0]['model']=='gpt-5.5'
    assert requests[0]['reasoning']['effort']=='high'
    print('PASS: remote TUI preserved profile, read-only sandbox, model, effort, and hook socket.', flush=True)
    result=subprocess.run(['cargo','test','--manifest-path',str(REPO/'src-tauri/Cargo.toml'),
        '--lib','codex_live_approval_probe','--','--ignored','--nocapture'],
        env=dict(env, REDLINE_PROBE_SOCKET=held['redline_socket'], REDLINE_PROBE_THREAD=held['session_id']),
        cwd=REPO, capture_output=True, text=True, timeout=180)
    (root/'rust-test.log').write_text(result.stdout+result.stderr)
    if result.returncode: raise RuntimeError('Rust handoff failed: '+result.stdout[-2500:]+result.stderr[-1500:])
    print('PASS: Rust WebSocket adapter acknowledged approval and a duplicate retry.', flush=True)
    (root/'release.json').write_text('{}')
    until=time.time()+25
    while len(requests)<PLAN_TURNS + 1 and time.time()<until: time.sleep(.05)
    assert len(requests)>=PLAN_TURNS + 1, 'No implementation request'
    (root/'requests.json').write_text(json.dumps(requests,indent=2))
    second=json.dumps(requests[PLAN_TURNS])
    assert requests[PLAN_TURNS]["reasoning"]["effort"] == "high"
    assert requests[PLAN_TURNS]["model"] == "gpt-5.5"
    assert 'Redline plan approved' in second
    assert 'workspace-write' in second, 'Continuation stayed read-only'
    assert 'earlier Redline planning-only instructions are complete' in second, 'Continuation kept old mode instructions'
    until=time.time()+10
    while not (workspace/'approved.txt').exists() and time.time()<until: time.sleep(.05)
    assert (workspace/'approved.txt').read_text().strip() == 'approved', 'Implementation did not write the workspace file'
    print('PASS: approval starts a new implementation turn and writes approved.txt through Codex exec_command.',flush=True)
    if RESTORE:
        until = time.time() + 10
        while len(requests) < PLAN_TURNS + 2 and time.time() < until: time.sleep(.05)
        stop(child, master)
        (root/'build-terminal.log').write_text(''.join(terminal))
        (root/'held.json').unlink()
        (root/'release.json').unlink()
        restore_after_build = True
        child, master, terminal = launch(held['session_id'])
        held_again = wait_for_hook(child, terminal)
        assert held_again['session_id'] == held['session_id']
        latest = json.dumps(requests[-1])
        permissions = latest[latest.rfind('<permissions instructions>'):]
        assert '`sandbox_mode` is `read-only`' in permissions, 'Restoring an approved thread retained write access'
        print('PASS: restoring the approved thread resets it to read-only review.', flush=True)
finally:
    (root/'terminal.log').write_text(''.join(terminal))
    (root/'requests.json').write_text(json.dumps(requests,indent=2))
    stop(child, master)
    server.shutdown()
    print('Probe artifacts:',root,flush=True)
