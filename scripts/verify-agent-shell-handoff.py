#!/usr/bin/env python3
"""Live, disposable hosted -> TUI -> hosted continuity gate.
Uses the signed-in Claude account, no tools, and never runs two drivers at once.
"""
import argparse
import json
import os
import pathlib
import pty
import select
import re
import fcntl
import struct
import termios
import selectors
import shutil
import signal
import subprocess
import time
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--out', default='/tmp/redline-agent-shell-handoff')
parser.add_argument('--cwd', required=True, help='An existing trusted test folder; no tools or source writes are allowed by this probe')
args = parser.parse_args()
out = pathlib.Path(args.out); out.mkdir(parents=True, exist_ok=True)
root = pathlib.Path(args.cwd).resolve()
if not root.is_dir(): raise SystemExit('The test working folder must exist')
sid = str(uuid.uuid4()); marker = 'REDLINE-HANDOFF-' + uuid.uuid4().hex[:8]
cli = shutil.which('claude')
if not cli:
    raise SystemExit('Claude is not installed')
env = {key: value for key, value in os.environ.items() if not key.startswith('CLAUDE') and key != 'REDLINE_AGENT_SEAT'}
env['TERM'] = 'xterm-256color'
common = ['--model', 'haiku', '--tools', '', '--setting-sources', '', '--strict-mcp-config']
events = []

def hosted(prompt, resume=False):
    command = [cli, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio', '--resume' if resume else '--session-id', sid, *common]
    process = subprocess.Popen(command, cwd=root, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0, start_new_session=True)
    events.append({'driver': 'hosted', 'pid': process.pid, 'event': 'started', 'at': time.time()})
    process.stdin.write((json.dumps({'type': 'control_request', 'request_id': str(uuid.uuid4()), 'request': {'subtype': 'initialize'}}) + '\n').encode())
    process.stdin.write((json.dumps({'type': 'user', 'message': {'role': 'user', 'content': prompt}}) + '\n').encode()); process.stdin.flush()
    selector = selectors.DefaultSelector(); selector.register(process.stdout, selectors.EVENT_READ)
    result = None; buffer = b''; deadline = time.monotonic() + 90
    try:
        while time.monotonic() < deadline:
            for key, _ in selector.select(.2):
                data = os.read(key.fd, 65536)
                if not data:
                    if process.poll() is not None: raise RuntimeError('Hosted process exited without a result')
                    continue
                buffer += data
                while b'\n' in buffer:
                    line, buffer = buffer.split(b'\n', 1)
                    if not line.strip(): continue
                    value = json.loads(line)
                    if value.get('type') == 'result':
                        if value.get('is_error'): raise RuntimeError('Hosted turn failed: ' + str(value.get('errors', [])))
                        result = value.get('result', '')
            if result is not None: break
        if result is None: raise RuntimeError('Hosted turn did not finish within deadline')
        return result
    finally:
        process.stdin.close()
        try: process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try: process.wait(timeout=3)
            except subprocess.TimeoutExpired: os.killpg(process.pid, signal.SIGKILL); process.wait()
        events.append({'driver': 'hosted', 'pid': process.pid, 'event': 'reaped', 'at': time.time()})
        selector.close()

def transcript():
    files = list((pathlib.Path.home() / '.claude/projects').glob('*/' + sid + '.jsonl'))
    if not files: return []
    values = []
    for line in files[0].read_text().splitlines():
        try: values.append(json.loads(line))
        except json.JSONDecodeError: pass
    return values

def assistant_texts():
    return [text for item in transcript() if item.get('type') == 'assistant' for text in [''.join(block.get('text', '') for block in item.get('message', {}).get('content', []) if block.get('type') == 'text')] if text]

first = hosted(f'Remember this exact marker for this disposable continuity test: {marker}. Reply with only the marker. Do not use tools.')
assert marker in first, first
before = len(assistant_texts())
pid, fd = pty.fork()
if pid == 0:
    os.chdir(root)
    os.execve(cli, [cli, '--resume', sid, *common, f'Reply with exactly the marker I asked you to remember followed by TUI_OK. Do not use tools.'], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
events.append({'driver': 'tui', 'pid': pid, 'event': 'started', 'at': time.time()})
raw = bytearray(); done = False; tail = b''
try:
    deadline = time.monotonic() + 100
    while time.monotonic() < deadline:
        exited, status = os.waitpid(pid, os.WNOHANG)
        if exited:
            pid = 0
            break
        ready, _, _ = select.select([fd], [], [], .2)
        if ready:
            try: data = os.read(fd, 65536)
            except OSError: break
            raw.extend(data); tail = (tail + data)[-4000:]
            clean = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', tail)
            normalized = re.sub(rb'\s+', b'', clean)
            if b'Yes,Itrustthisfolder' in normalized:
                raise RuntimeError('Trust this disposable test folder interactively before running the continuity gate')
        if any(marker in text and 'TUI_OK' in text for text in assistant_texts()[before:]):
            done = True; break
    if not done: raise RuntimeError('TUI did not append the expected assistant answer before deadline')
    os.write(fd, b'/exit\r')
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        exited, _ = os.waitpid(pid, os.WNOHANG)
        if exited: pid = 0; break
        ready, _, _ = select.select([fd], [], [], .1)
        if ready:
            try: raw.extend(os.read(fd, 65536))
            except OSError: pass
finally:
    (out / 'tui-output.bin').write_bytes(raw)
    # macOS may hold a dying TUI in tty teardown until the master closes.
    # Stop the driver and close its input before waiting for its process.
    os.close(fd)
    if pid:
        exited, _ = os.waitpid(pid, os.WNOHANG)
        if not exited:
            try: os.killpg(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                try: os.kill(pid, signal.SIGKILL)
                except ProcessLookupError: pass
            deadline = time.monotonic() + 8
            while True:
                exited, _ = os.waitpid(pid, os.WNOHANG)
                if exited: break
                if time.monotonic() >= deadline: raise RuntimeError('TUI driver has not reaped; refusing hosted resume')
                time.sleep(.1)
    events.append({'driver': 'tui', 'event': 'reaped', 'at': time.time()})
    (out / 'events.json').write_text(json.dumps(events, indent=2))
last = hosted('What exact marker did the first user message ask you to remember? Reply with the marker only. Do not use tools.', resume=True)
assert marker in last, last
summary = {'session_id': sid, 'cwd': str(root), 'marker': marker, 'hosted_first': first, 'tui_persisted': done, 'hosted_resumed': last, 'assistant_turns': len(assistant_texts()), 'drivers_serialized': True}
(out / 'events.json').write_text(json.dumps(events, indent=2))
(out / 'summary.json').write_text(json.dumps(summary, indent=2))
print(json.dumps(summary))
