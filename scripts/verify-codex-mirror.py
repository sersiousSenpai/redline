#!/usr/bin/env python3
"""Verify the Codex contract behind Redline's conversation mirror.

Flow program, Wave B0, the Codex half (docs/protocol-verification.md,
experiment (m), S10 and S11). A Codex plan session runs as Redline's launcher
starts it (`src-tauri/src/codex_plan_launch.sh`): a private
`codex app-server --listen unix://…` process with the TUI attached to it
through `--remote`. Against the installed `codex`, this measures whether
Redline can mirror that TUI's conversation from a second connection to the
same socket, and how a dock terminal learns which socket and thread it is:

  S10 a  A second client can connect and `initialize` while the TUI runs.
      b  Without joining the thread, does it hear the TUI's turn?
      c  `thread/resume` on the running thread rejoins it: live
         `item/started` / `item/completed` / `turn/completed` arrive, and the
         TUI keeps working.
      d  `thread/read`, `thread/turns/list` and `thread/items/list` give the
         same items, with the same ids and order, as the live stream.
      e  Item shapes: user and agent messages, reasoning, command execution,
         file changes, the `<proposed_plan>` envelope.
      f  Approvals (after the build hand-off's `thread/settings/update`):
         which clients receive `item/commandExecution/requestApproval`, and
         whether the second client's answer runs the command and clears the
         TUI's prompt.
      g  Esc in the TUI interrupts: what the second client sees.
      h  A restored thread (`codex resume` through the launcher, a new
         server and socket) reads back with the same item ids.
      i  The composer's send path (`pty::submit_text`: a bracketed paste
         paced 512 B / 4 ms, a 30 ms beat, Return): does the TUI turn paste
         mode on, and does a short, a multi-line and a 20 KB send arrive
         as one prompt, byte-equal?
      j  Closing the second client leaves the TUI's thread running.
  S11 Codex's hooks in a launcher terminal: which of SessionStart,
      UserPromptSubmit, Stop and SessionEnd fire, when, with which payload
      keys; whether they carry the terminal id and the socket in their
      environment; `/new` and `resume`.

Isolation (the probe-codex-approval.py pattern): a throwaway `CODEX_HOME`
and workspace under the system temp dir, and a local mock Responses endpoint
that scripts the model's output, so no account, model service or the user's
own `~/.codex` is touched. The app-server, the TUI and the item mapping are
the installed CLI's own; only what the model says is scripted. The fixture's
hook trust is bypassed for its own recording hook only (the production
launcher never bypasses trust). Every `CLAUDE*` and `REDLINE_*` variable of
the caller is stripped from the children.

With --rust the rig also runs the Rust mirror itself against the live TUI
(`convo::tests::codex_live_mirror_probe`, ignored otherwise): it joins the
thread through `CodexSource`, sees the turn the rig types, answers its
approval from the stage's side, and reads the thread back cold.

With --fixtures DIR it writes the golden fixtures
(`codex_*.jsonl` under `src-tauri/tests/fixtures/convo/`): the second
client's item stream for each phase, and two cold reads, with the temp
paths, user and host names scrubbed. `CONVO_BLESS=1 cargo test --lib
convo::tests` then writes their `.events.json`.

Run: python3 scripts/verify-codex-mirror.py [--keep] [--rust] [--fixtures DIR] [--codex PATH]
Prints a JSON summary. With --keep the temp dir keeps `hooks.jsonl`,
`client.jsonl` (every message the second client received, stamped),
`requests.json`, the terminals' output and `capture/`. Takes about two
minutes (plus a warm `cargo test` build with --rust).
"""
import argparse
import base64
import collections
import faulthandler
import fcntl
import getpass
import http.server
import json
import os
import pathlib
import pty
import re
import select
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time

REPO = pathlib.Path(__file__).resolve().parent.parent
LAUNCHER = REPO / "src-tauri/src/codex_plan_launch.sh"
CONTRACT = REPO / "src-tauri/src/codex_plan_contract.txt"
MARKERS = re.compile(r"^(CLAUDE|CLAUDECODE|REDLINE_)")
PASTE_MODE = re.compile(rb"\x1b\[\?2004([hl])")
TERMINAL_ID = "5f0c2a8e-7d41-4b6a-9e3f-1c2b3d4e5f60"
LAUNCH_ID = "codex-mirror-probe"

T0 = time.time()


def now():
    return round(time.time() - T0, 3)


def child_env(extra):
    env = {k: v for k, v in os.environ.items() if not MARKERS.match(k)}
    env.update(extra)
    return env


# --- the model ----------------------------------------------------------------

def message(text, phase=None):
    item = {"type": "message", "role": "assistant", "status": "completed",
            "content": [{"type": "output_text", "text": text, "annotations": []}]}
    if phase:
        item["phase"] = phase
    return item


def reasoning(summary):
    return {"type": "reasoning", "summary": [{"type": "summary_text", "text": summary}], "encrypted_content": None}


def call(name, args):
    return {"type": "function_call", "name": name, "arguments": json.dumps(args)}


def patch(text):
    return {"type": "custom_tool_call", "name": "apply_patch", "input": text, "status": "completed"}


class Model:
    """A Responses endpoint whose replies the driver queues per turn. A reply
    can wait on a gate, so the driver can connect its client first."""

    def __init__(self):
        self.lock = threading.Lock()
        self.queue = collections.deque()
        self.requests = []
        self.tools = None
        self.specs = {}
        self.count = 0
        model = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                last_user = next((i for i in reversed(body.get("input", [])) if i.get("role") == "user"), {})
                if "Generate a concise, single-line task title" in json.dumps(last_user):
                    reply = {"items": [message("Mirror probe")]}
                else:
                    with model.lock:
                        model.requests.append({"t": now(), "input_tail": body.get("input", [])[-3:]})
                        if model.tools is None:
                            model.tools = [t.get("name") or t.get("type") for t in body.get("tools", [])]
                            model.specs = {t.get("name"): t for t in body.get("tools", []) if t.get("name") == "request_user_input"}
                        reply = model.queue.popleft() if model.queue else {"items": [message("ok")]}
                gate = reply.get("gate")
                if gate is not None:
                    gate.wait(60)
                time.sleep(reply.get("delay", 0))
                data = model.sse(reply["items"])
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def push(self, *replies):
        """Script the next turn. Whatever an earlier turn left unused (an
        interrupted turn never asks for its second reply) is dropped, so each
        step gets exactly its own replies."""
        with self.lock:
            self.queue.clear()
            self.queue.extend(replies)

    def sse(self, items):
        with self.lock:
            self.count += 1
            n = self.count
        rid = f"resp_{n}"
        events = [("response.created", {"response": {"id": rid, "object": "response", "status": "in_progress", "output": []}})]
        done = []
        for i, item in enumerate(items):
            item = dict(item, id=f"{item['type'][:3]}_{n}_{i}")
            if item["type"] in ("function_call", "custom_tool_call"):
                item["call_id"] = f"call_{n}_{i}"
            done.append(item)
            if item["type"] == "message":
                text = item["content"][0]["text"]
                events += [
                    ("response.output_item.added", {"output_index": i, "item": dict(item, status="in_progress", content=[])}),
                    ("response.content_part.added", {"item_id": item["id"], "output_index": i, "content_index": 0, "part": {"type": "output_text", "text": "", "annotations": []}}),
                    ("response.output_text.delta", {"item_id": item["id"], "output_index": i, "content_index": 0, "delta": text}),
                ]
            elif item["type"] == "function_call":
                events.append(("response.output_item.added", {"output_index": i, "item": dict(item, arguments="")}))
            elif item["type"] == "custom_tool_call":
                events.append(("response.output_item.added", {"output_index": i, "item": dict(item, input="")}))
            else:
                events.append(("response.output_item.added", {"output_index": i, "item": dict(item, summary=[])}))
            events.append(("response.output_item.done", {"output_index": i, "item": item}))
        usage = {"input_tokens": 10, "output_tokens": 10, "total_tokens": 20}
        events.append(("response.completed", {"response": {"id": rid, "object": "response", "status": "completed", "output": done, "usage": usage}}))
        return "".join(f"event: {k}\ndata: {json.dumps(dict(p, type=k))}\n\n" for k, p in events).encode()


# --- the hooks ----------------------------------------------------------------

# Records every fire. A Stop whose turn proposed a plan answers as Redline's
# review does: `block` with the reviewer's feedback when the driver left a
# `feedback.txt`, or held until it leaves `release` (the approval hand-off).
HOOK = r'''import json, os, pathlib, sys, time
payload = json.load(sys.stdin)
env = {k: os.environ.get(k) for k in ("REDLINE_TERMINAL_ID", "REDLINE_CODEX_SOCKET", "REDLINE_PLAN_LAUNCH_ID")}
with open(sys.argv[1], "a") as f:
    f.write(json.dumps({"t": time.time(), "payload": payload, "env": env}) + "\n")
root = pathlib.Path(sys.argv[1]).parent
out = {}
if payload.get("hook_event_name") == "Stop" and "<proposed_plan>" in (payload.get("last_assistant_message") or ""):
    feedback = root / "feedback.txt"
    if feedback.exists():
        out = {"decision": "block", "reason": feedback.read_text()}
        feedback.unlink()
    elif (root / "hold").exists():
        while not (root / "release").exists():
            time.sleep(0.05)
        (root / "release").unlink()
        (root / "hold").unlink()
print(json.dumps(out))
'''
EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd", "PreToolUse", "PostToolUse", "PermissionRequest"]


class Hooks:
    def __init__(self, path):
        self.path = path

    def all(self):
        try:
            lines = self.path.read_text().splitlines()
        except OSError:
            return []
        out = []
        for line in lines:
            rec = json.loads(line)
            rec["t"] = round(rec["t"] - T0, 3)
            out.append(rec)
        return out

    def wait(self, pred, seconds, after=0):
        end = time.time() + seconds
        while time.time() < end:
            for rec in self.all()[after:]:
                if pred(rec):
                    return rec
            time.sleep(0.05)
        return None


def hook_is(name, **fields):
    return lambda rec: rec["payload"].get("hook_event_name") == name and all(rec["payload"].get(k) == v for k, v in fields.items())


# --- the second client --------------------------------------------------------

class Client:
    """A JSON-RPC client over the app-server's Unix socket, which speaks
    WebSocket (an HTTP upgrade, then frames). Every message it receives is
    kept with its arrival time."""

    def __init__(self, path, name, log):
        self.name = name
        self.log = log
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.connect(path)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((
            "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("socket closed during the upgrade")
            buf += chunk
        head, self.buf = buf.split(b"\r\n\r\n", 1)
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise RuntimeError(f"no upgrade: {head[:200]!r}")
        self.lock = threading.Lock()
        self.messages = []
        self.next_id = 0
        self.closed = False
        threading.Thread(target=self.reader, daemon=True).start()

    def frame(self, opcode, payload):
        header = bytes([0x80 | opcode])
        n = len(payload)
        if n < 126:
            header += bytes([0x80 | n])
        elif n < 65536:
            header += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            header += bytes([0x80 | 127]) + struct.pack(">Q", n)
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def read_exact(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise EOFError
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def reader(self):
        parts = b""
        try:
            while True:
                b0, b1 = self.read_exact(2)
                opcode, n = b0 & 0x0F, b1 & 0x7F
                if n == 126:
                    n = struct.unpack(">H", self.read_exact(2))[0]
                elif n == 127:
                    n = struct.unpack(">Q", self.read_exact(8))[0]
                mask = self.read_exact(4) if b1 & 0x80 else None
                data = self.read_exact(n)
                if mask:
                    data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
                if opcode == 0x9:
                    self.frame(0xA, data)
                    continue
                if opcode == 0x8:
                    break
                if opcode in (0x1, 0x0):
                    parts += data
                    if b0 & 0x80:
                        msg = json.loads(parts)
                        parts = b""
                        rec = {"t": now(), "client": self.name, "msg": msg}
                        with self.lock:
                            self.messages.append(rec)
                        self.log(rec)
        except (EOFError, OSError):
            pass
        self.closed = True

    def send(self, obj):
        self.frame(0x1, json.dumps(obj).encode())

    def request(self, method, params, seconds=15):
        with self.lock:
            self.next_id += 1
            rid = self.next_id
        self.send({"id": rid, "method": method, "params": params})
        end = time.time() + seconds
        while time.time() < end:
            with self.lock:
                for rec in self.messages:
                    m = rec["msg"]
                    if m.get("id") == rid and "method" not in m:
                        if "error" in m:
                            return {"error": m["error"]}
                        return m.get("result")
            time.sleep(0.02)
        return {"error": "timeout"}

    def initialize(self):
        result = self.request("initialize", {"clientInfo": {"name": "redline-probe", "version": "0"}, "capabilities": {"experimentalApi": True}})
        self.send({"method": "initialized", "params": {}})
        return result

    def mark(self):
        with self.lock:
            return len(self.messages)

    def since(self, mark=0):
        with self.lock:
            return list(self.messages[mark:])

    def wait(self, pred, seconds, after=0):
        end = time.time() + seconds
        while time.time() < end:
            for rec in self.since(after):
                if pred(rec["msg"]):
                    return rec
            time.sleep(0.02)
        return None

    def close(self):
        try:
            self.frame(0x8, b"")
            self.sock.shutdown(socket.SHUT_RDWR)
            self.sock.close()
        except OSError:
            pass


# --- the TUI ------------------------------------------------------------------

class Tui:
    def __init__(self, argv, cwd, env):
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
        self.proc = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=slave, env=env, cwd=cwd,
                                     start_new_session=True, preexec_fn=lambda: fcntl.ioctl(0, termios.TIOCSCTTY, 0))
        os.close(slave)
        self.fd = master
        self.raw = bytearray()
        self.paste = []
        self.lock = threading.Lock()
        self.trusted = False
        self.kept_model = False
        self.reading = threading.Thread(target=self.reader, daemon=True)
        self.reading.start()

    def reader(self):
        carry = b""
        while True:
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                return
            if not data:
                return
            with self.lock:
                self.raw.extend(data)
            scan = carry + data
            for m in PASTE_MODE.finditer(scan):
                on = m.group(1) == b"h"
                if not self.paste or self.paste[-1]["on"] != on:
                    self.paste.append({"t": now(), "on": on})
            carry = scan[-8:]
            if b"\x1b[6n" in data:
                os.write(self.fd, b"\x1b[1;1R")
            if not self.kept_model and "Useexistingmodel" in re.sub(r"\s", "", self.screen(20000)):
                # A new-model notice; the mock model doesn't care which.
                self.kept_model = True
                time.sleep(0.25)
                os.write(self.fd, b"2")
                time.sleep(0.1)
                os.write(self.fd, b"\r")
            if not self.trusted and "Hooksneedreview" in re.sub(r"\s", "", self.screen(20000)):
                # `codex resume` asks for hook trust despite the fixture's
                # bypass flag; trust only this fixture's own recording hook.
                self.trusted = True
                time.sleep(0.25)
                os.write(self.fd, b"2")
                time.sleep(0.1)
                os.write(self.fd, b"\r")

    def screen(self, last=4000):
        with self.lock:
            text = bytes(self.raw[-last:]).decode("utf-8", "replace")
        return re.sub(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-_]", "", text)

    def write(self, data):
        os.write(self.fd, data)

    def submit(self, text):
        """`pty::submit_text`, byte for byte: a bracketed paste in 512-byte
        chunks 4 ms apart, a 30 ms beat, then Return."""
        data = b"\x1b[200~" + text.encode() + b"\x1b[201~"
        for i in range(0, len(data), 512):
            if i:
                time.sleep(0.004)
            os.write(self.fd, data[i:i + 512])
        time.sleep(0.03)
        os.write(self.fd, b"\r")

    def type_slowly(self, text):
        for ch in text:
            os.write(self.fd, ch.encode())
            time.sleep(0.04)

    def stop(self):
        try:
            os.killpg(self.proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()

    def close(self):
        # Never close the master: on macOS that close can block for good
        # while the tty drains. The rig exits soon after; exit releases it.
        self.reading.join(3)


# --- the run --------------------------------------------------------------------

def items_of(messages, method="item/completed"):
    return [m["msg"]["params"]["item"] for m in messages if m["msg"].get("method") == method]


def brief(item):
    out = {"type": item.get("type"), "id": item.get("id")}
    for k in ("text", "command", "status", "exitCode", "phase", "summary"):
        if item.get(k) not in (None, [], ""):
            v = item[k]
            out[k] = v[:120] if isinstance(v, str) else v
    if item.get("type") == "userMessage":
        out["text"] = "".join(c.get("text", "") for c in item.get("content", []) if c.get("type") == "text")[:120]
    if item.get("type") == "fileChange":
        out["changes"] = [(c.get("path"), (c.get("kind") or {}).get("type")) for c in item.get("changes", [])]
    return out


# What a fixture keeps of the stream: the item lifecycle, turns, the
# thread's state, and the approvals. Deltas, hooks' own runs, usage and the
# server's identity stay out.
FIXTURE_METHODS = {
    "item/started", "item/completed", "turn/started", "turn/completed", "thread/status/changed",
    "thread/settings/updated", "thread/name/updated", "serverRequest/resolved",
    "item/commandExecution/requestApproval", "item/fileChange/requestApproval",
}


def scrub(value, root):
    text = json.dumps(value)
    for old, new in [(str(root.resolve()), "/tmp/probe"), (str(root), "/tmp/probe"),
                     (os.path.expanduser("~"), "/Users/user"), (getpass.getuser(), "user"),
                     (socket.gethostname(), "host")]:
        text = text.replace(old, new)
    return json.loads(text)


def write_fixture(directory, name, messages, root, thread_id, joined=None):
    """A phase's stream, headed by the read the mirror makes when it joins
    (`thread/items/list`, newest first) when the client joined mid-turn."""
    keep = [m for m in messages if m.get("method") in FIXTURE_METHODS and (m.get("params") or {}).get("threadId") == thread_id]
    if joined is not None:
        keep.insert(0, {"id": 1, "result": joined})
    path = pathlib.Path(directory) / f"codex_{name}.jsonl"
    path.write_text("".join(json.dumps(scrub(m, root), separators=(",", ":")) + "\n" for m in keep))
    return path.name


def write_read(directory, name, response, root):
    """A cold read: `thread/items/list`'s answer, as the one line it arrived as."""
    path = pathlib.Path(directory) / f"codex_{name}.jsonl"
    path.write_text(json.dumps(scrub({"id": 1, "result": response}, root), separators=(",", ":")) + "\n")
    return path.name


def cargo(*args, env=None, timeout=900):
    return subprocess.run(["cargo", *args], cwd=REPO / "src-tauri", env=child_env(dict(env or {}, CARGO_BUILD_JOBS="6")),
                          capture_output=True, text=True, timeout=timeout)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--rust", action="store_true")
    ap.add_argument("--fixtures")
    ap.add_argument("--codex", default=os.environ.get("REDLINE_PROBE_CODEX", "codex"))
    args = ap.parse_args()
    # A wedged CLI must not wedge the rig: dump every thread's stack and quit.
    faulthandler.dump_traceback_later(600, exit=True)

    root = pathlib.Path(tempfile.mkdtemp(prefix="rl-codex-mirror-"))
    home, workspace, capture = root / "home", root / "workspace", root / "capture"
    for d in (home, workspace, capture):
        d.mkdir()
    (workspace / "README.md").write_text("# probe\n")
    model = Model()
    hook_log = root / "hooks.jsonl"
    (root / "hook.py").write_text(HOOK)
    hook_command = f"/usr/bin/python3 {root / 'hook.py'} {hook_log}"
    (home / "hooks.json").write_text(json.dumps({"hooks": {e: [{"hooks": [{"type": "command", "command": hook_command, "timeout": 30}]}] for e in EVENTS}}))
    # Only this isolated fixture bypasses trust; the production launcher never does.
    (home / "config.toml").write_text(
        'bypass_hook_trust = true\nmodel = "gpt-5.5"\nmodel_provider = "probe"\n'
        '[model_providers.probe]\nname = "Probe"\n'
        f'base_url = "http://127.0.0.1:{model.port}/v1"\n'
        'wire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n'
        f'\n[projects.{json.dumps(str(workspace))}]\ntrust_level = "trusted"\n')
    (home / "redline-plan.config.toml").write_text("developer_instructions = " + json.dumps(CONTRACT.read_text()) + "\n")
    env = child_env({"CODEX_HOME": str(home), "TERM": "xterm-256color",
                     "REDLINE_TERMINAL_ID": TERMINAL_ID, "REDLINE_PLAN_LAUNCH_ID": LAUNCH_ID})
    hooks = Hooks(hook_log)
    client_log = open(root / "client.jsonl", "a")
    log_lock = threading.Lock()

    def log(rec):
        with log_lock:
            client_log.write(json.dumps(rec) + "\n")
            client_log.flush()

    results = {"codex": subprocess.run([args.codex, "--version"], capture_output=True, text=True).stdout.strip(), "root": str(root)}
    if args.rust:
        # Built before any TUI starts, so the probe itself only runs.
        built = cargo("test", "--lib", "--no-run")
        if built.returncode:
            raise RuntimeError("cargo test --no-run failed: " + built.stderr[-2000:])

    def launch(*extra):
        argv = ["/bin/sh", str(LAUNCHER), args.codex, *extra, "-m", "gpt-5.5", "-c", 'model_reasoning_effort="high"',
                "-p", "redline-plan", "--dangerously-bypass-hook-trust", "--no-alt-screen"]
        return Tui(argv, workspace, env)

    tuis = []
    try:
        # ---- S11 + S10 a/b/c: the first turn, joined live ----------------------
        gate = threading.Event()
        model.push(
            {"gate": gate, "items": [reasoning("Looking at the workspace first."), call("exec_command", {"cmd": "ls"})]},
            {"items": [message("I listed the workspace.", "commentary"),
                       message("<proposed_plan>\n# Add a greeting file\n\n1. Create `hello.txt` with a greeting.\n2. Read it back.\n</proposed_plan>", "final_answer")]},
        )
        launched = now()
        tui = launch("-s", "read-only", "-a", "never", "Plan a greeting file for this workspace.")
        tuis.append(tui)
        start = hooks.wait(hook_is("SessionStart"), 30)
        prompt = hooks.wait(hook_is("UserPromptSubmit"), 30)
        if not start and not prompt:
            raise RuntimeError("no hook fired; terminal: " + tui.screen())
        first = start or prompt
        socket_path = first["env"]["REDLINE_CODEX_SOCKET"]
        thread_id = first["payload"].get("session_id")
        results["S11"] = {
            "launched_at": launched,
            "session_start": start and {"t": start["t"], "keys": sorted(start["payload"]), "source": start["payload"].get("source"), "env": start["env"]},
            "first_prompt": prompt and {"t": prompt["t"], "keys": sorted(prompt["payload"]), "env": prompt["env"]},
        }
        a = Client(socket_path, "A", log)
        init = a.initialize()
        results["S10a_initialize"] = {"ok": "error" not in (init or {}), "keys": sorted(init or {})}
        loaded = a.request("thread/loaded/list", {})
        results["S10a_loaded_list"] = loaded
        # b: a client that only initialized, never joined.
        b = Client(socket_path, "B", log)
        b.initialize()
        resumed = a.request("thread/resume", {"threadId": thread_id, "excludeTurns": True})
        a_joined = a.request("thread/items/list", {"threadId": thread_id, "sortDirection": "desc", "limit": 200})
        results["S10c_resume"] = {"ok": isinstance(resumed, dict) and "error" not in resumed,
                                  "error": (resumed or {}).get("error"),
                                  "thread_status": ((resumed or {}).get("thread") or {}).get("status"),
                                  "approvalPolicy": (resumed or {}).get("approvalPolicy"),
                                  "cursors": [k for k in ("turnsBackwardsCursor", "itemsBackwardsCursor") if (resumed or {}).get(k)]}
        released = now()
        gate.set()
        done1 = a.wait(lambda m: m.get("method") == "turn/completed", 30)
        stop1 = hooks.wait(hook_is("Stop"), 15)
        live = a.since()
        results["S10c_live"] = {
            "released_at": released,
            "turn_completed_at": done1 and done1["t"],
            "methods": sorted({m["msg"].get("method") for m in live if m["msg"].get("method")}),
            "items": [brief(i) for i in items_of(live)],
        }
        results["S10b_unjoined"] = {"methods": sorted({m["msg"].get("method") for m in b.since() if m["msg"].get("method")})}
        results["S11"]["stop"] = stop1 and {"t": stop1["t"], "keys": sorted(stop1["payload"]), "env": stop1["env"],
                                            "has_plan": "<proposed_plan>" in (stop1["payload"].get("last_assistant_message") or "")}
        (capture / "turn1.live.json").write_text(json.dumps([m["msg"] for m in live], indent=1))

        # ---- d: the reads ----------------------------------------------------
        read = a.request("thread/read", {"threadId": thread_id, "includeTurns": True})
        turns = a.request("thread/turns/list", {"threadId": thread_id, "sortDirection": "asc", "itemsView": "full"})
        items = a.request("thread/items/list", {"threadId": thread_id})
        (capture / "turn1.read.json").write_text(json.dumps({"read": read, "turns": turns, "items": items}, indent=1))
        live_ids = [i["id"] for i in items_of(live)]
        listed = [e["item"]["id"] for e in (items or {}).get("data", [])] if isinstance(items, dict) else []
        read_ids = [i["id"] for t in ((read or {}).get("thread") or {}).get("turns", []) for i in t.get("items", [])]
        results["S10d_reads"] = {
            "read_error": (read or {}).get("error"), "turns_error": (turns or {}).get("error"), "items_error": (items or {}).get("error"),
            "live_ids": live_ids, "items_list_ids": listed, "thread_read_ids": read_ids,
            "same_order": listed == read_ids and [i for i in listed if i in live_ids] == [i for i in live_ids if i in listed],
            "item_entry_keys": sorted(((items or {}).get("data") or [{}])[0]) if isinstance(items, dict) and items.get("data") else None,
            "turn_keys": sorted(((turns or {}).get("data") or [{}])[0]) if isinstance(turns, dict) and turns.get("data") else None,
        }

        # ---- i: the composer's send path ----------------------------------------
        results["S10i_paste_mode"] = tui.paste[:4]
        sends = [("short", "Reply with ok."), ("lines", "First line\nsecond line\twith a tab\n\nfourth line"),
                 ("long", "".join(f"{n:05d} the quick brown fox jumps over the lazy dog\n" for n in range(420)).strip())]
        results["S10i_sends"] = {}
        for name, text in sends:
            model.push({"items": [message(f"Got the {name} send.")]})
            mark = a.mark()
            hmark = len(hooks.all())
            sent = now()
            tui.submit(text)
            got = a.wait(lambda m: m.get("method") == "item/completed" and m["params"]["item"]["type"] == "userMessage", 30, mark)
            done = a.wait(lambda m: m.get("method") == "turn/completed", 30, mark)
            ups = hooks.wait(hook_is("UserPromptSubmit"), 5, hmark)
            arrived = "".join(c.get("text", "") for c in got["msg"]["params"]["item"]["content"] if c.get("type") == "text") if got else None
            results["S10i_sends"][name] = {
                "bytes": len(text.encode()), "submitted": bool(got), "turn_done": bool(done),
                "equal": arrived == text, "lag_ms": got and int((got["t"] - sent) * 1000),
                "content_types": got and [c.get("type") for c in got["msg"]["params"]["item"]["content"]],
                "prompt_hook_equal": ups and ups["payload"].get("prompt") == text,
                "arrived_head": arrived and arrived[:80],
            }
            time.sleep(0.5)

        # ---- f: approvals, after the build hand-off's settings update ---------------
        read = a.request("thread/read", {"threadId": thread_id})
        thread = (read or {}).get("thread") or {}
        update = a.request("thread/settings/update", {
            "threadId": thread_id, "approvalPolicy": "on-request",
            "sandboxPolicy": {"type": "workspaceWrite", "networkAccess": False},
            "collaborationMode": {"mode": "default", "settings": {"model": thread.get("model"), "reasoning_effort": thread.get("reasoningEffort"),
                                                                   "developer_instructions": "Build the approved plan."}}})
        if args.rust:
            # The Rust mirror on the live TUI: it joins, sees this turn, and
            # answers the approval itself (client A hears it too and keeps quiet).
            ready = root / "rust-ready"
            model.push(
                {"items": [reasoning("Checking first."), call("exec_command", {"cmd": "touch from-rust.txt", "sandbox_permissions": "require_escalated", "justification": "Probe: answered by the Rust mirror"})]},
                {"items": [message("Mirror probe reply.")]},
            )
            probe = subprocess.Popen(
                ["cargo", "test", "--lib", "codex_live_mirror_probe", "--", "--ignored", "--nocapture"],
                cwd=REPO / "src-tauri", stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                env=child_env({"CARGO_BUILD_JOBS": "6", "REDLINE_PROBE_SOCKET": socket_path, "REDLINE_PROBE_THREAD": thread_id, "REDLINE_PROBE_READY": str(ready)}))
            until = time.time() + 120
            while not ready.exists() and time.time() < until and probe.poll() is None:
                time.sleep(0.1)
            if ready.exists():
                tui.submit("Mirror probe prompt.")
            try:
                output, _ = probe.communicate(timeout=120)
            except subprocess.TimeoutExpired:
                probe.kill()
                output, _ = probe.communicate()
            (root / "rust-probe.log").write_text(output)
            summary = next((line[len("PROBE "):] for line in output.splitlines() if line.startswith("PROBE ")), None)
            results["S10k_rust"] = {"passed": probe.returncode == 0, "ran_command": (workspace / "from-rust.txt").exists(),
                                    "summary": summary and json.loads(summary), "tail": None if probe.returncode == 0 else output[-3000:]}
            time.sleep(0.5)
        model.push(
            {"items": [call("exec_command", {"cmd": "touch from-client.txt", "sandbox_permissions": "require_escalated", "justification": "Probe: answered by the second client"})]},
            {"items": [call("exec_command", {"cmd": "touch from-tui.txt", "sandbox_permissions": "require_escalated", "justification": "Probe: answered in the TUI"})]},
            {"items": [patch("*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch\n")]},
            {"items": [message("Built it.")]},
        )
        mark = a.mark()
        bmark = b.mark()
        tui.submit("Build the approved plan.")
        ask1 = a.wait(lambda m: m.get("method") == "item/commandExecution/requestApproval", 30, mark)
        ask1_b = b.wait(lambda m: m.get("method") == "item/commandExecution/requestApproval", 2, bmark)
        screen1 = tui.screen(6000)
        answered = None
        if ask1:
            a.send({"id": ask1["msg"]["id"], "result": {"decision": "accept"}})
            answered = now()
        resolved1 = a.wait(lambda m: m.get("method") == "serverRequest/resolved", 10, mark)
        ran1 = a.wait(lambda m: m.get("method") == "item/completed" and m["params"]["item"]["type"] == "commandExecution" and "from-client" in m["params"]["item"].get("command", ""), 15, mark)
        mark2 = a.mark()
        ask2 = a.wait(lambda m: m.get("method") == "item/commandExecution/requestApproval", 30, mark2)
        time.sleep(1.0)
        screen2 = tui.screen(6000)
        tui.write(b"y")
        resolved2 = a.wait(lambda m: m.get("method") == "serverRequest/resolved", 10, mark2)
        done = a.wait(lambda m: m.get("method") == "turn/completed", 30, mark)
        results["S10f_approvals"] = {
            "settings_update": update,
            "client_got_ask": bool(ask1), "unjoined_client_got_ask": bool(ask1_b),
            "ask_params_keys": ask1 and sorted(ask1["msg"]["params"]),
            "ask_available_decisions": ask1 and ask1["msg"]["params"].get("availableDecisions"),
            "tui_showed_prompt": "from-client" in screen1 or "Would you like" in screen1 or "approve" in screen1.lower(),
            "answered_at": answered, "resolved_notice": resolved1 and resolved1["msg"].get("params"),
            "command_ran": (workspace / "from-client.txt").exists(),
            "item_status": ran1 and ran1["msg"]["params"]["item"].get("status"),
            "tui_answer": {"client_got_ask": bool(ask2), "resolved_notice": bool(resolved2), "command_ran": (workspace / "from-tui.txt").exists(),
                           "screen_had_prompt": "from-tui" in screen2},
            "file_change": (workspace / "hello.txt").exists(),
            "turn_done": bool(done),
        }
        (capture / "build.live.json").write_text(json.dumps([m["msg"] for m in a.since(mark)], indent=1))

        # ---- g: Esc interrupts ------------------------------------------------------
        model.push({"items": [call("exec_command", {"cmd": "sleep 20"})]}, {"items": [message("Slept.")]})
        mark = a.mark()
        tui.submit("Wait a while.")
        started = a.wait(lambda m: m.get("method") == "item/started" and m["params"]["item"]["type"] == "commandExecution", 30, mark)
        time.sleep(0.5)
        esc = now()
        tui.write(b"\x1b")
        done = a.wait(lambda m: m.get("method") == "turn/completed", 15, mark)
        hmark = len(hooks.all())
        results["S10g_interrupt"] = {
            "started": bool(started), "turn_status": done and done["msg"]["params"]["turn"].get("status"),
            "lag_ms": done and int((done["t"] - esc) * 1000),
            "command_item": [brief(i) for i in items_of(a.since(mark)) if i["type"] == "commandExecution"],
        }
        (capture / "interrupt.live.json").write_text(json.dumps([m["msg"] for m in a.since(mark)], indent=1))
        time.sleep(1.0)

        # ---- j: the second client leaves -----------------------------------------------
        a_ids = [e["item"]["id"] for e in (a.request("thread/items/list", {"threadId": thread_id, "limit": 200}) or {}).get("data", [])]
        a.request("thread/unsubscribe", {"threadId": thread_id})
        a.close()
        b.close()
        model.push({"items": [message("Still here.")]})
        c = Client(socket_path, "C", log)
        c.initialize()
        c.request("thread/resume", {"threadId": thread_id, "excludeTurns": True})
        mark = c.mark()
        tui.submit("Are you still there?")
        still = c.wait(lambda m: m.get("method") == "turn/completed", 20, mark)
        results["S10j_after_leave"] = {"tui_turn_ran": bool(still)}

        # ---- S11: exit, SessionEnd ---------------------------------------------------
        hmark = len(hooks.all())
        tui.type_slowly("/quit")
        time.sleep(0.3)
        tui.write(b"\r")
        try:
            tui.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass
        end = hooks.wait(hook_is("SessionEnd"), 5, hmark)
        results["S11"]["session_end"] = end and {"t": end["t"], "keys": sorted(end["payload"]), "reason": end["payload"].get("reason")}
        results["S11"]["tui_exited"] = tui.proc.poll() is not None
        results["S10i_paste_mode_all"] = tui.paste
        (root / "terminal1.log").write_bytes(bytes(tui.raw))
        tui.stop()
        tui.close()
        c.close()

        # ---- h: restore, a new server and socket ---------------------------------------
        hmark = len(hooks.all())
        model.push({"items": [message("Restored and listening.")]})
        tui = launch("resume", thread_id, "Continue from where we were.")
        tuis.append(tui)
        start = hooks.wait(hook_is("SessionStart"), 30, hmark)
        prompt = hooks.wait(hook_is("UserPromptSubmit"), 30, hmark)
        first = start or prompt
        socket2 = first and first["env"]["REDLINE_CODEX_SOCKET"]
        results["S11"]["resume"] = {
            "session_start": start and {"source": start["payload"].get("source"), "same_id": start["payload"].get("session_id") == thread_id},
            "new_socket": socket2 != socket_path,
        }
        d = Client(socket2, "D", log)
        d.initialize()
        d.request("thread/resume", {"threadId": thread_id, "excludeTurns": True})
        d.wait(lambda m: m.get("method") == "turn/completed", 20)
        # Read as the mirror reads: newest first.
        restored = d.request("thread/items/list", {"threadId": thread_id, "sortDirection": "desc", "limit": 200})
        restored_ids = [e["item"]["id"] for e in reversed((restored or {}).get("data", []))]
        results["S10h_restore"] = {
            "same_ids_prefix": restored_ids[:len(a_ids)] == a_ids, "before": len(a_ids), "after": len(restored_ids),
            "first_ids": restored_ids[:4],
        }
        (capture / "restored.items.json").write_text(json.dumps(restored, indent=1))

        # ---- S11: /new starts another thread on the same server ------------------------------
        hmark = len(hooks.all())
        mark = d.mark()
        tui.type_slowly("/new")
        time.sleep(0.3)
        tui.write(b"\r")
        time.sleep(2.0)
        model.push({"items": [message("A fresh thread.")]})
        tui.submit("Start over.")
        new_prompt = hooks.wait(hook_is("UserPromptSubmit"), 20, hmark)
        new_start = [r for r in hooks.all()[hmark:] if r["payload"].get("hook_event_name") == "SessionStart"]
        results["S11"]["new"] = {
            "session_starts": [{"source": r["payload"].get("source"), "same_id": r["payload"].get("session_id") == thread_id} for r in new_start],
            "prompt_thread_changed": bool(new_prompt) and new_prompt["payload"].get("session_id") != thread_id,
            "client_heard": sorted({m["msg"].get("method") for m in d.since(mark) if m["msg"].get("method")}),
        }
        (root / "terminal2.log").write_bytes(bytes(tui.raw))
        d.close()

        # ---- the review loop: feedback, approval, a question, parallel reads ------
        hmark = len(hooks.all())
        (root / "feedback.txt").write_text("Add a step that verifies the file.")
        gate = threading.Event()
        model.push(
            {"gate": gate, "items": [call("exec_command", {"cmd": "cat README.md"}), call("exec_command", {"cmd": "rg probe ."}),
                                     call("exec_command", {"cmd": "ls -la"})]},
            {"items": [message("<proposed_plan>\n# Greeting v1\n\n1. Create `hello.txt`.\n</proposed_plan>")]},
            {"items": [message("Revised as asked.\n\n<proposed_plan>\n# Greeting v2\n\n1. Create `hello.txt`.\n2. Verify it.\n</proposed_plan>")]},
        )
        tui = launch("-s", "read-only", "-a", "never", "Plan a greeting file for my review.")
        tuis.append(tui)
        prompt = hooks.wait(hook_is("UserPromptSubmit"), 30, hmark)
        socket3, thread3 = prompt["env"]["REDLINE_CODEX_SOCKET"], prompt["payload"]["session_id"]
        e = Client(socket3, "E", log)
        e.initialize()
        e.request("thread/resume", {"threadId": thread3, "excludeTurns": True})
        e_joined = e.request("thread/items/list", {"threadId": thread3, "sortDirection": "desc", "limit": 200})
        mark = e.mark()
        (root / "hold").write_text("")
        gate.set()
        held = hooks.wait(lambda r: hook_is("Stop")(r) and "Greeting v2" in (r["payload"].get("last_assistant_message") or ""), 30, hmark)
        review = e.since(mark)
        # Approve as `codex_app_server::queue_plan_implementation` does, then let Stop go.
        thread = (e.request("thread/read", {"threadId": thread3}) or {}).get("thread") or {}
        e.request("thread/settings/update", {
            "threadId": thread3, "approvalPolicy": "on-request", "sandboxPolicy": {"type": "workspaceWrite", "networkAccess": False},
            "collaborationMode": {"mode": "default", "settings": {"model": thread.get("model"), "reasoning_effort": thread.get("reasoningEffort"),
                                                                   "developer_instructions": "Build the approved plan."}}})
        question = {"questions": [{"id": "color", "header": "Color", "question": "Which color should the greeting be?",
                                   "options": [{"label": "Red", "description": "Warm"}, {"label": "Blue", "description": "Cool"}]}]}
        model.push({"items": [call("request_user_input", question)]}, {"items": [message("Implemented in blue.")]})
        queued = e.request("thread/queue/add", {"threadId": thread3, "clientUserMessageId": "probe-approval",
                                                "input": [{"type": "text", "text": "Redline plan approved. Begin implementing the approved plan now. "
                                                           "Do not ask for confirmation or submit the same plan again.\n\nApproved plan:\n# Greeting v2"}]})
        mark2 = e.mark()
        (root / "release").write_text("")
        ask = e.wait(lambda m: m.get("method") == "item/tool/requestUserInput", 20, mark2)
        if ask:
            e.send({"id": ask["msg"]["id"], "result": {"answers": {"color": {"answers": ["Blue"]}}}})
        built = e.wait(lambda m: m.get("method") == "turn/completed", 20, mark2)
        approval = e.since(mark2)
        desc = e.request("thread/items/list", {"threadId": thread3, "sortDirection": "desc", "limit": 3})
        older = desc and desc.get("nextCursor") and e.request("thread/items/list", {"threadId": thread3, "sortDirection": "desc", "limit": 3, "cursor": desc["nextCursor"]})
        everything = e.request("thread/items/list", {"threadId": thread3, "sortDirection": "desc", "limit": 200})
        results["S10e_review"] = {
            "held_v2": bool(held),
            "items": [brief(i) for i in items_of(review)],
            "hook_prompts": [i for i in items_of(review) if i["type"] == "hookPrompt"],
            "parallel_started": [m["msg"]["params"]["item"]["id"] for m in review if m["msg"].get("method") == "item/started" and m["msg"]["params"]["item"]["type"] == "commandExecution"],
            "parallel_completed": [i["id"] for i in items_of(review) if i["type"] == "commandExecution"],
            "command_actions": [i.get("commandActions") for i in items_of(review) if i["type"] == "commandExecution"],
            "queued": queued,
            "approval_items": [brief(i) for i in items_of(approval)],
            "question_ask": ask and ask["msg"].get("params"),
            "question_spec": model.specs.get("request_user_input"),
            "built": bool(built),
            "desc_page": desc and [x["item"]["id"] for x in desc.get("data", [])], "desc_cursor": desc and desc.get("nextCursor"),
            "older_page": older and [x["item"]["id"] for x in older.get("data", [])],
            "all_ids": everything and [x["item"]["id"] for x in reversed(everything.get("data", []))],
        }
        (capture / "review.live.json").write_text(json.dumps([m["msg"] for m in review + approval], indent=1))
        (capture / "review.items.json").write_text(json.dumps(everything, indent=1))
        e.close()

        results["hooks"] = [{"t": r["t"], "event": r["payload"].get("hook_event_name"), "source": r["payload"].get("source"),
                             "session": (r["payload"].get("session_id") or "")[:8], "turn": (r["payload"].get("turn_id") or "")[:8],
                             "transcript": bool(r["payload"].get("transcript_path")), "env_terminal": r["env"].get("REDLINE_TERMINAL_ID") == TERMINAL_ID,
                             "env_socket": bool(r["env"].get("REDLINE_CODEX_SOCKET"))} for r in hooks.all()]
        results["hook_payload_samples"] = {}
        for r in hooks.all():
            name = r["payload"].get("hook_event_name")
            if name not in results["hook_payload_samples"]:
                results["hook_payload_samples"][name] = {k: (v if not isinstance(v, str) or len(v) < 100 else v[:100] + "…") for k, v in r["payload"].items()}
        results["model_tools"] = model.tools
        if args.fixtures:
            results["fixtures"] = [
                write_fixture(args.fixtures, "plan_turn", [m["msg"] for m in live], root, thread_id, a_joined),
                write_fixture(args.fixtures, "build_approvals", json.loads((capture / "build.live.json").read_text()), root, thread_id),
                write_fixture(args.fixtures, "interrupt", json.loads((capture / "interrupt.live.json").read_text()), root, thread_id),
                write_fixture(args.fixtures, "review_loop", [m["msg"] for m in review + approval], root, thread3, e_joined),
                write_read(args.fixtures, "review_read", everything, root),
                write_read(args.fixtures, "restored_read", restored, root),
            ]
    finally:
        for t in tuis:
            t.stop()
            t.close()
        (root / "requests.json").write_text(json.dumps(model.requests, indent=1))
        client_log.close()
        model.server.shutdown()
    print(json.dumps(results, indent=1))
    if not args.keep:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    main()
