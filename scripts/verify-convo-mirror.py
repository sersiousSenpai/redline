#!/usr/bin/env python3
"""Verify the Claude Code contract behind Redline's conversation mirror.

Flow program, Wave B0 (docs/protocol-verification.md, experiment (m)). The
session stage mirrors a live `claude` TUI from its transcript, types into its
PTY, and answers permission and question asks through hooks. Against the
installed `claude`, this measures the facts each later step stands on:

  S1  SessionStart: which `source` fires for startup / resume / clear /
      compact / fork, the payload keys, and whether `transcript_path` and
      `session_id` change.
  S2  A nested `claude -p` (what a dock agent's Bash tool would start): does
      the entrypoint header tell it apart (`sdk-cli`)?
  S3  Transcript lag: how long after a hook POST its line is in the
      transcript (UserPromptSubmit -> prompt, Stop -> reply,
      PermissionRequest -> the tool_use it asks about).
  S4  PermissionRequest hold semantics: does the TUI show its own dialog
      while the hook is held; what an allow / deny / always / `{}` / timeout
      / dropped connection does; what answering natively or pressing Esc
      while the hook is held does to the hook.
  S5  AskUserQuestion answered through PreToolUse `updatedInput.answers`;
      whether PermissionRequest also fires for it.
  S6  A 20 KB bracketed paste arrives byte-equal; plain typing; when `\\r`
      may follow.
  S7  Shift+Tab's mode cycle and `/plan`, as the screen and transcript show
      them.
  S8  `/model` and `/effort` mid-session, as the transcript shows them.
  S9  Esc: interrupting a streaming reply; a double Esc on an empty prompt
      (the rewind menu) and how far apart two presses must be to stay single.
  S12 The OSC window titles the TUI sets, and the transcript's `ai-title`.

Plus the transcripts the golden fixtures are cut from: a plan turn that is
denied with feedback and then approved, compact, /clear, an interrupt, a
tool rejection, the type-ahead queue, a background-task notification and a
large tool result.

Two further passes cover what the first left open. FOLLOW: a card answered
while the TUI's dialog is up, a deny that interrupts, a question held by its
hook, paste thresholds, a pasted slash command, `/effort`'s confirmation and
SessionEnd. QUEUE: a prompt typed while tools run, which the CLI folds into
the running turn.

Isolation (the experiment (l) pattern): a throwaway project under the system
temp dir; hooks supplied with `--settings <file>` and `--setting-sources
project`, so the user's global hooks (Redline's own included) never load;
every `CLAUDE*` session marker stripped from each child; a cheap model. The
hooks are the exact command shapes Redline installs, pointed at a private
port served by this script instead of the daemon's :7676. The CLI's
transcripts for the throwaway project are copied into the temp dir
(`capture/`) and removed from ~/.claude unless --keep.

Run: python3 scripts/verify-convo-mirror.py [--model haiku] [--only S4,S5] [--keep]
     python3 scripts/verify-convo-mirror.py --only FOLLOW,QUEUE
Prints a JSON summary; the temp dir keeps `log.jsonl`, the screens and the
captured transcripts when --keep is given. Takes about ten minutes.
"""
import argparse
import fcntl
import http.server
import json
import os
import pathlib
import pty
import re
import select
import shutil
import socket
import struct
import subprocess
import tempfile
import termios
import threading
import time

MARKERS = re.compile(r"^(CLAUDE|CLAUDECODE)")
ANSI = re.compile(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-_]")
OSC_TITLE = re.compile(rb"\x1b\][012];([^\x07\x1b]*)(?:\x07|\x1b\\)")
PASTE_MODE = re.compile(rb"\x1b\[\?2004([hl])")

T0 = time.time()


def now():
    return round(time.time() - T0, 3)


def stripped_env(extra):
    env = {k: v for k, v in os.environ.items() if not MARKERS.match(k)}
    env.update(extra)
    return env


# --- the private daemon ------------------------------------------------------

class Daemon:
    """Logs every hook POST and answers the held routes from a policy the
    driver sets per step."""

    def __init__(self, root):
        self.lock = threading.Lock()
        self.log = []
        self.logfile = root / "log.jsonl"
        self.ask_policy = lambda payload: ("reply", {})
        self.pre_ask_policy = lambda payload: ("reply", {})
        self.plan_policy = lambda payload: ("reply", {})
        daemon = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length)
                try:
                    payload = json.loads(raw or b"{}")
                except ValueError:
                    payload = {"_raw": raw.decode("utf-8", "replace")}
                headers = {k: v for k, v in self.headers.items() if k.lower().startswith("x-redline")}
                rec = daemon.record({"kind": "post", "path": self.path, "headers": headers, "payload": payload})
                if self.path == "/v1/term/ask":
                    event = payload.get("hook_event_name")
                    policy = daemon.pre_ask_policy if event == "PreToolUse" else daemon.ask_policy
                    action = policy(payload)
                elif self.path == "/v1/plan":
                    action = daemon.plan_policy(payload)
                else:
                    action = ("reply", {})
                self.answer(rec["seq"], action)

            def answer(self, seq, action):
                kind = action[0]
                if kind == "drop":
                    # The daemon dies mid-hold: close without a response.
                    time.sleep(action[1])
                    daemon.record({"kind": "dropped", "seq": seq})
                    self.close_connection = True
                    try:
                        self.connection.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                    return
                body = action[-1]
                if kind == "hold":
                    end = time.time() + action[1]
                    while time.time() < end:
                        ready, _, _ = select.select([self.connection], [], [], 0.05)
                        if ready:
                            try:
                                peek = self.connection.recv(1, socket.MSG_PEEK)
                            except OSError:
                                peek = b""
                            if peek == b"":
                                daemon.record({"kind": "client_gone", "seq": seq})
                                return
                data = json.dumps(body).encode()
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    daemon.record({"kind": "answered", "seq": seq, "body": body})
                except OSError as e:
                    daemon.record({"kind": "answer_failed", "seq": seq, "error": str(e)})

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def record(self, rec):
        with self.lock:
            rec = dict(rec, t=now(), seq=rec.get("seq", len(self.log)))
            self.log.append(rec)
            with open(self.logfile, "a") as f:
                f.write(json.dumps(rec) + "\n")
            return rec

    def mark(self):
        with self.lock:
            return len(self.log)

    def since(self, mark):
        with self.lock:
            return list(self.log[mark:])

    def wait(self, mark, pred, seconds, pump=None):
        end = time.time() + seconds
        while time.time() < end:
            for rec in self.since(mark):
                if pred(rec):
                    return rec
            if pump:
                pump(0.1)
            else:
                time.sleep(0.05)
        return None


def event_is(name, source=None):
    def pred(rec):
        p = rec.get("payload") or {}
        return rec["kind"] == "post" and p.get("hook_event_name") == name and (
            source is None or p.get("source") == source)
    return pred


# --- the transcript watcher --------------------------------------------------

class Transcripts:
    """Every complete line any transcript in the project dir gains, stamped
    with when this watcher first saw it (10 ms polls)."""

    def __init__(self, folder):
        self.folder = folder
        self.lines = []
        self.offsets = {}
        self.lock = threading.Lock()
        threading.Thread(target=self.loop, daemon=True).start()

    def loop(self):
        while True:
            try:
                files = sorted(self.folder.glob("*.jsonl"))
            except OSError:
                files = []
            for path in files:
                try:
                    data = path.read_bytes()
                except OSError:
                    continue
                start = self.offsets.get(path, 0)
                end = data.rfind(b"\n") + 1
                if end <= start:
                    continue
                for raw in data[start:end].split(b"\n")[:-1]:
                    try:
                        row = json.loads(raw)
                    except ValueError:
                        row = {"_torn": True}
                    with self.lock:
                        self.lines.append({"t": now(), "file": path.name, "row": row, "bytes": len(raw)})
                self.offsets[path] = end
            time.sleep(0.01)

    def mark(self):
        with self.lock:
            return len(self.lines)

    def since(self, mark):
        with self.lock:
            return list(self.lines[mark:])

    def wait(self, mark, pred, seconds, pump):
        end = time.time() + seconds
        while time.time() < end:
            for line in self.since(mark):
                if pred(line["row"]):
                    return line
            pump(0.1)
        return None


def text_of(row):
    content = (row.get("message") or {}).get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def brief_row(row):
    out = {k: row.get(k) for k in ("type", "subtype", "operation", "permissionMode", "mode", "aiTitle",
                                   "toolDenialKind", "isMeta", "isCompactSummary") if row.get(k) is not None}
    content = (row.get("message") or {}).get("content")
    if isinstance(content, list):
        out["blocks"] = [b.get("type") + (":" + b.get("name") if b.get("name") else "") for b in content if isinstance(b, dict)]
    t = text_of(row) or row.get("content") or ""
    if isinstance(t, str) and t:
        out["text"] = t[:160]
    if row.get("type") == "assistant":
        out["model"] = (row.get("message") or {}).get("model")
        out["effort"] = row.get("effort")
    if row.get("type") == "attachment":
        out["attachment"] = (row.get("attachment") or {}).get("type")
    return out


# --- the TUI -----------------------------------------------------------------

class Tui:
    def __init__(self, argv, cwd, env, name, root):
        self.name = name
        self.root = root
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.execvpe(argv[0], argv, env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
        self.raw = bytearray()
        self.screen = ""
        self.titles = []
        self.paste = []
        self.carry = b""
        self.started = time.time()

    def pump(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([self.fd], [], [], 0.05)
            if not ready:
                continue
            try:
                chunk = os.read(self.fd, 65536)
            except OSError:
                return
            self.raw.extend(chunk)
            # Escape sequences can straddle reads: scan with a short carry.
            scan = self.carry + chunk
            for m in OSC_TITLE.finditer(scan):
                title = m.group(1).decode("utf-8", "replace")
                if not self.titles or self.titles[-1]["title"] != title:
                    self.titles.append({"t": now(), "title": title})
            for m in PASTE_MODE.finditer(scan):
                on = m.group(1) == b"h"
                if not self.paste or self.paste[-1]["on"] != on:
                    self.paste.append({"t": now(), "on": on})
            self.carry = scan[-64:]
            self.screen = (self.screen + ANSI.sub("", chunk.decode("utf-8", "replace")))[-30000:]

    def write(self, data):
        os.write(self.fd, data if isinstance(data, bytes) else data.encode())

    def paced(self, data, chunk=512, pause=0.004):
        """Redline's `pty::paced`: 512-byte chunks, 4 ms apart."""
        data = data if isinstance(data, bytes) else data.encode()
        for i in range(0, len(data), chunk):
            if i:
                self.pump(pause)
            self.write(data[i:i + chunk])

    def type(self, text, settle=0.6):
        self.write(text)
        self.pump(settle)
        self.write(b"\r")

    def tail(self, n=600):
        return self.screen[-n:]

    def snap(self, label):
        path = self.root / f"screen-{self.name}-{label}.txt"
        path.write_text(self.screen[-6000:])
        return self.tail(400)

    def close(self):
        for sig, grace in ((15, 3), (9, 3)):
            try:
                os.kill(self.pid, sig)
            except ProcessLookupError:
                return
            end = time.time() + grace
            while time.time() < end:
                try:
                    if os.waitpid(self.pid, os.WNOHANG)[0]:
                        return
                except ChildProcessError:
                    return
                time.sleep(0.1)


# --- hooks: the exact command shapes Redline installs --------------------------

def attention_command(port):
    return ("[ -n \"${REDLINE_TERMINAL_ID:-}\" ] && curl -s --max-time 1 -X POST "
            "-H 'Content-Type: application/json' -H \"X-Redline-Terminal: ${REDLINE_TERMINAL_ID}\" "
            "-H \"X-Redline-Entrypoint: ${CLAUDE_CODE_ENTRYPOINT:-}\" "
            f"--data-binary @- http://127.0.0.1:{port}/v1/term/event >/dev/null 2>&1 || true")


def ask_command(port):
    return ("[ -n \"${REDLINE_TERMINAL_ID:-}\" ] || exit 0; curl -sf --max-time 3600 -X POST "
            "-H 'Content-Type: application/json' -H \"X-Redline-Terminal: ${REDLINE_TERMINAL_ID}\" "
            f"--data-binary @- http://127.0.0.1:{port}/v1/term/ask || true")


def settings(port, ask_timeout):
    att = {"type": "command", "command": attention_command(port), "async": True, "timeout": 5}
    ask = {"type": "command", "command": ask_command(port), "timeout": ask_timeout}
    return {"hooks": {
        "SessionStart": [{"hooks": [att]}],
        "UserPromptSubmit": [{"hooks": [att]}],
        "Stop": [{"hooks": [att]}],
        "Notification": [{"hooks": [att]}],
        "SessionEnd": [{"hooks": [att]}],
        "PreToolUse": [
            {"matcher": "ExitPlanMode", "hooks": [{"type": "http", "url": f"http://127.0.0.1:{port}/v1/plan", "timeout": 600}]},
            {"matcher": "^AskUserQuestion$", "hooks": [ask]},
        ],
        "PermissionRequest": [{"matcher": "*", "hooks": [ask]}],
    }}


def perm_reply(behavior, **extra):
    decision = {"behavior": behavior, **extra}
    return {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": decision}}


# --- the run -----------------------------------------------------------------

class Run:
    def __init__(self, args):
        self.args = args
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="rl-convo-")).resolve()
        self.proj = self.root / "proj"
        self.proj.mkdir()
        (self.proj / "big.txt").write_text(("0123456789abcdef" * 63 + "\n") * 400)
        self.slug = re.sub(r"[^A-Za-z0-9]", "-", str(self.proj))
        self.folder = pathlib.Path.home() / ".claude" / "projects" / self.slug
        self.daemon = Daemon(self.root)
        self.transcripts = Transcripts(self.folder)
        self.results = {}
        self.only = set(args.only.split(",")) if args.only else None

    def wanted(self, case):
        return self.only is None or case in self.only

    def env(self, terminal="probe-term"):
        return stripped_env({"REDLINE_TERMINAL_ID": terminal, "TERM": "xterm-256color"})

    def cfg(self, name, ask_timeout):
        path = self.root / f"{name}.settings.json"
        path.write_text(json.dumps(settings(self.daemon.port, ask_timeout)))
        return path

    def tui(self, name, extra, ask_timeout=10):
        argv = [self.args.claude, "--model", self.args.model, "--setting-sources", "project",
                "--settings", str(self.cfg(name, ask_timeout))] + extra
        tui = Tui(argv, self.proj, self.env(), name, self.root)
        mark = self.daemon.mark()
        tui.pump(5)
        if "trust" in tui.screen.lower():
            tui.write(b"\x1b[B")
            tui.pump(0.5)
            tui.write(b"\r")
        start = self.daemon.wait(mark, event_is("SessionStart"), 25, tui.pump)
        tui.pump(1.5)
        return tui, start

    def turn(self, tui, prompt, seconds=90, how="typed"):
        """Submit a prompt and wait for its Stop. Returns (ups, stop) records
        plus the transcript mark taken before the send."""
        dm, tm = self.daemon.mark(), self.transcripts.mark()
        if how == "typed":
            tui.type(prompt)
        ups = self.daemon.wait(dm, event_is("UserPromptSubmit"), 15, tui.pump)
        stop = self.daemon.wait(dm, event_is("Stop"), seconds, tui.pump)
        # The reply lands in the transcript a beat after Stop (experiment (l)).
        tui.pump(1.0)
        return ups, stop, dm, tm

    def lag(self, hook_rec, tm, pred):
        """ms from a hook POST to the first transcript line matching pred."""
        if not hook_rec:
            return None
        for line in self.transcripts.since(tm):
            if pred(line["row"]):
                return round((line["t"] - hook_rec["t"]) * 1000)
        return None

    # S1 + S3 + S6 + S12 on the first session --------------------------------

    def session_a(self):
        tui, start = self.tui("a", ["--permission-mode", "default"], ask_timeout=10)
        r = self.results
        r["S1_startup"] = self.start_brief(start)
        r["S12_titles_at_start"] = list(tui.titles)
        r["paste_mode_at_start"] = list(tui.paste)
        try:
            self.s3_and_s6(tui)
            if self.wanted("S4"):
                self.s4(tui)
            if self.wanted("S5"):
                self.s5(tui)
            if self.wanted("S9"):
                self.s9(tui)
            if self.wanted("S7"):
                self.s7(tui)
            if self.wanted("S8"):
                self.s8(tui)
            if self.wanted("FIX"):
                self.fixtures_a(tui)
            if self.wanted("S1"):
                self.s1_compact_clear(tui)
        finally:
            r["S12_titles"] = tui.titles[-12:]
            r["paste_mode_transitions"] = tui.paste[-20:]
            tui.pump(1)
            tui.close()

    def start_brief(self, start):
        if not start:
            return None
        p = start["payload"]
        return {"source": p.get("source"), "keys": sorted(p), "session_id": p.get("session_id"),
                "transcript_path": p.get("transcript_path"), "headers": start["headers"],
                "model": p.get("model"), "transcript_exists_at_fire": bool(p.get("transcript_path") and os.path.exists(p["transcript_path"]))}

    def s3_and_s6(self, tui):
        r = self.results
        # S3: typed, then Return after a settle.
        ups, stop, dm, tm = self.turn(tui, "Reply with the single word pong.")
        r["S3_ups_keys"] = sorted(ups["payload"]) if ups else None
        r["S3_lag_ms"] = {
            "ups_to_prompt_line": self.lag(ups, tm, lambda row: row.get("type") == "user" and "pong" in text_of(row)),
            "stop_to_reply_line": self.lag(stop, tm, lambda row: row.get("type") == "assistant" and "pong" in text_of(row).lower()),
        }
        r["S3_stop_has_last_message"] = bool(stop and stop["payload"].get("last_assistant_message"))
        r["S3_turn_lines"] = [brief_row(l["row"]) for l in self.transcripts.since(tm)]
        # S6a: text and Return in ONE write.
        dm = self.daemon.mark()
        tui.write(b"Reply with the single word ping.\r")
        ups = self.daemon.wait(dm, event_is("UserPromptSubmit"), 8, tui.pump)
        r["S6_one_write_submits"] = bool(ups)
        if not ups:
            r["S6_one_write_screen"] = tui.snap("one-write")
            tui.write(b"\r")
        self.daemon.wait(dm, event_is("Stop"), 60, tui.pump)
        tui.pump(1)
        # S6b: a 20 KB bracketed paste, paced like pty::paced, then Return.
        filler = []
        line_no = 0
        head = "Reply with the single word ok. Ignore everything below this line.\n"
        size = len(head.encode())
        while size < 20 * 1024:
            line = f"{line_no:04d}\tfiller — é ✓ 日本 \"quotes\" 'single' $HOME `tick` \\back\n"
            filler.append(line)
            size += len(line.encode())
            line_no += 1
        body = head + "".join(filler)
        body = body.rstrip("\n")
        dm, tm = self.daemon.mark(), self.transcripts.mark()
        t0 = time.time()
        tui.paced(b"\x1b[200~" + body.encode() + b"\x1b[201~")
        r["S6_paste_write_ms"] = round((time.time() - t0) * 1000)
        tui.pump(0.4)
        r["S6_screen_after_paste"] = tui.snap("paste")[-200:]
        tui.write(b"\r")
        ups = self.daemon.wait(dm, event_is("UserPromptSubmit"), 15, tui.pump)
        prompt = (ups or {}).get("payload", {}).get("prompt")
        r["S6_paste"] = {"bytes": len(body.encode()), "submitted": bool(ups), "ups_byte_equal": prompt == body,
                         "ups_len": len(prompt.encode()) if isinstance(prompt, str) else None}
        wrapped = re.search(r'<pasted_content id="(\w+)">\n(.*)\n</pasted_content id="\1">', prompt or "", re.S)
        if wrapped:
            # A long paste comes back wrapped, with its tabs expanded.
            r["S6_paste"]["wrapped_as_pasted_content"] = True
            r["S6_paste"]["wrapper_prefix"] = (prompt or "")[:wrapped.start()]
            r["S6_paste"]["inner_equal_after_tab_expansion"] = wrapped.group(2) == body.replace("\t", "    ")
            r["S6_paste"]["inner_equal_verbatim"] = wrapped.group(2) == body
        line = self.transcripts.wait(tm, lambda row: row.get("type") == "user" and not row.get("isMeta") and "filler" in text_of(row), 10, tui.pump)
        if line:
            r["S6_paste"]["transcript_equals_hook_prompt"] = text_of(line["row"]) == prompt
        # The threshold: a 10-line paste.
        dm = self.daemon.mark()
        ten = "Reply with the single word ten.\n" + "\n".join(f"line {i}\tx" for i in range(9))
        tui.paced(b"\x1b[200~" + ten.encode() + b"\x1b[201~")
        tui.pump(0.3)
        tui.write(b"\r")
        ups10 = self.daemon.wait(dm, event_is("UserPromptSubmit"), 15, tui.pump)
        p10 = (ups10 or {}).get("payload", {}).get("prompt") or ""
        r["S6_ten_line_paste"] = {"verbatim": p10 == ten, "wrapped": "pasted_content" in p10, "tabs_kept": "\t" in p10}
        self.daemon.wait(dm, event_is("Stop"), 60, tui.pump)
        self.daemon.wait(dm, event_is("Stop"), 60, tui.pump)
        tui.pump(1)
        # S6c: a small multi-line paste with Return in the same write.
        dm = self.daemon.mark()
        tui.write(b"\x1b[200~Reply with the single word two.\nSecond line.\x1b[201~\r")
        ups = self.daemon.wait(dm, event_is("UserPromptSubmit"), 8, tui.pump)
        r["S6_paste_then_cr_same_write_submits"] = bool(ups)
        if not ups:
            r["S6_paste_same_write_screen"] = tui.snap("paste-cr")[-200:]
            tui.write(b"\r")
        self.daemon.wait(dm, event_is("Stop"), 60, tui.pump)
        tui.pump(1)

    # S4 ----------------------------------------------------------------------

    def perm_case(self, tui, label, command, policy, during=None, wait_stop=60):
        """One permission ask under `policy`. `during(tui, rec)` runs once the
        ask POST has arrived (to press keys while it is held)."""
        self.daemon.ask_policy = policy
        dm, tm = self.daemon.mark(), self.transcripts.mark()
        tui.type(f"Use the Bash tool to run exactly this command and nothing else: {command}")
        ask = self.daemon.wait(dm, lambda rec: rec["kind"] == "post" and rec["path"] == "/v1/term/ask"
                               and rec["payload"].get("hook_event_name") == "PermissionRequest", 40, tui.pump)
        out = {"ask_arrived": bool(ask)}
        if ask:
            p = ask["payload"]
            out["payload_keys"] = sorted(p)
            out["tool_name"] = p.get("tool_name")
            out["suggestions"] = p.get("permission_suggestions")
            out["tool_use_line_lag_ms"] = self.lag(ask, tm, lambda row: row.get("type") == "assistant" and any(
                isinstance(b, dict) and b.get("type") == "tool_use" for b in (row.get("message") or {}).get("content") or []))
            tui.pump(1.5)
            out["screen_while_held"] = tui.snap(f"{label}-held")[-260:]
            out["dialog_visible_while_held"] = "proceed" in tui.tail(1500).lower()
            if during:
                during(tui, ask, out)
        stop = self.daemon.wait(dm, event_is("Stop"), wait_stop, tui.pump)
        out["stop"] = bool(stop)
        out["hook_records"] = [{k: rec.get(k) for k in ("kind", "t", "body")} for rec in self.daemon.since(dm)
                               if rec["kind"] in ("answered", "client_gone", "dropped", "answer_failed")]
        out["ask_t"] = ask["t"] if ask else None
        out["lines"] = [brief_row(l["row"]) for l in self.transcripts.since(tm) if l["row"].get("type") in ("user", "assistant", "system")][-8:]
        out["screen_after"] = tui.snap(f"{label}-after")[-200:]
        tui.pump(1)
        return out

    def s4(self, tui):
        r = self.results["S4"] = {}
        held = lambda secs, body: (lambda p: ("hold", secs, body))
        r["allow"] = self.perm_case(tui, "allow", "touch a-allow.txt", lambda p: ("reply", perm_reply("allow")))
        r["allow"]["file_written"] = (self.proj / "a-allow.txt").exists()
        r["deny"] = self.perm_case(tui, "deny", "touch a-deny.txt",
                                   lambda p: ("reply", perm_reply("deny", message="Not now. Reply with the single word understood.")))
        r["deny"]["file_written"] = (self.proj / "a-deny.txt").exists()
        r["hold_then_empty"] = self.perm_case(tui, "release", "touch a-release.txt", held(4, {}),
                                              during=lambda t, ask, out: (t.pump(4), out.__setitem__("dialog_after_release", "proceed" in t.tail(1500).lower()), t.write(b"\r")))
        r["hold_then_empty"]["file_written"] = (self.proj / "a-release.txt").exists()

        def answer_native(t, ask, out):
            out["answered_native_at"] = now()
            t.write(b"\r")
        r["native_answer_while_held"] = self.perm_case(tui, "native", "touch a-native.txt", held(30, perm_reply("deny", message="late")), during=answer_native)
        r["native_answer_while_held"]["file_written"] = (self.proj / "a-native.txt").exists()

        def esc_held(t, ask, out):
            out["esc_at"] = now()
            t.write(b"\x1b")
        r["esc_while_held"] = self.perm_case(tui, "esc", "touch a-esc.txt", held(30, perm_reply("allow")), during=esc_held, wait_stop=20)
        r["esc_while_held"]["file_written"] = (self.proj / "a-esc.txt").exists()
        tui.write(b"\x15")
        tui.pump(1)

        def after_timeout(t, ask, out):
            t.pump(10)
            out["screen_after_timeout"] = t.snap("timeout")[-260:]
            out["dialog_after_timeout"] = "proceed" in t.tail(1500).lower()
            t.write(b"\r")
        r["hook_timeout"] = self.perm_case(tui, "timeout", "touch a-timeout.txt", held(40, perm_reply("deny", message="late")), during=after_timeout)
        r["hook_timeout"]["file_written"] = (self.proj / "a-timeout.txt").exists()

        def after_drop(t, ask, out):
            t.pump(3)
            out["dialog_after_drop"] = "proceed" in t.tail(1500).lower()
            t.write(b"\r")
        r["daemon_drop"] = self.perm_case(tui, "drop", "touch a-drop.txt", lambda p: ("drop", 1.0), during=after_drop)
        r["daemon_drop"]["file_written"] = (self.proj / "a-drop.txt").exists()

        def always(p):
            return ("reply", perm_reply("allow", updatedPermissions=p.get("permission_suggestions") or []))
        r["always"] = self.perm_case(tui, "always", "touch a-always.txt", always)
        r["always"]["file_written"] = (self.proj / "a-always.txt").exists()
        self.daemon.ask_policy = lambda p: ("reply", {})
        again = self.perm_case(tui, "always-again", "touch a-always.txt", lambda p: ("reply", perm_reply("deny", message="should not ask")), wait_stop=60)
        r["always"]["asked_again_for_same_rule"] = again["ask_arrived"]
        if again["ask_arrived"]:
            tui.pump(1)
        local = self.proj / ".claude" / "settings.local.json"
        r["always"]["settings_local"] = json.loads(local.read_text()) if local.exists() else None
        self.daemon.ask_policy = lambda p: ("reply", {})

        # A rejection answered in the TUI (a fixture): `{}`, then Esc on the dialog.
        def reject(t, ask, out):
            t.pump(2)
            t.write(b"\x1b")
        r["native_reject"] = self.perm_case(tui, "reject", "touch a-reject.txt", lambda p: ("reply", {}), during=reject, wait_stop=20)
        tui.write(b"\x15")
        tui.pump(1)

    # S5 ----------------------------------------------------------------------

    def s5(self, tui):
        r = self.results["S5"] = {}
        prompt = ("Use the AskUserQuestion tool to ask me one question: which color I prefer, with the options Red and Blue "
                  "(header 'Color'). After I answer, reply with only the color I chose.")

        def answer(p):
            inp = dict(p.get("tool_input") or {})
            qs = inp.get("questions") or []
            inp["answers"] = {q.get("question"): "Blue" for q in qs}
            return ("reply", {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow", "updatedInput": inp}})
        self.daemon.pre_ask_policy = answer
        self.daemon.ask_policy = lambda p: ("reply", {})
        ups, stop, dm, tm = self.turn(tui, prompt, 60)
        posts = [rec for rec in self.daemon.since(dm) if rec["kind"] == "post" and rec["path"] == "/v1/term/ask"]
        r["answers"] = {
            "pretooluse_payload_keys": sorted(posts[0]["payload"]) if posts else None,
            "tool_input": posts[0]["payload"].get("tool_input") if posts else None,
            "permission_request_fired": any(p["payload"].get("hook_event_name") == "PermissionRequest" for p in posts),
            "events": [p["payload"].get("hook_event_name") for p in posts],
            "stop": bool(stop),
            "last_message": (stop or {}).get("payload", {}).get("last_assistant_message"),
            "lines": [brief_row(l["row"]) for l in self.transcripts.since(tm) if l["row"].get("type") in ("user", "assistant")][-6:],
        }
        for l in self.transcripts.since(tm):
            if l["row"].get("type") == "user" and l["row"].get("toolUseResult"):
                r["answers"]["tool_use_result"] = l["row"]["toolUseResult"]
        # The same ask, released to the TUI.
        self.daemon.pre_ask_policy = lambda p: ("reply", {})
        dm, tm = self.daemon.mark(), self.transcripts.mark()
        tui.type(prompt)
        self.daemon.wait(dm, lambda rec: rec["kind"] == "post" and rec["path"] == "/v1/term/ask", 40, tui.pump)
        tui.pump(3)
        posts = [rec for rec in self.daemon.since(dm) if rec["kind"] == "post" and rec["path"] == "/v1/term/ask"]
        r["native"] = {"events": [p["payload"].get("hook_event_name") for p in posts], "screen": tui.snap("ask-native")[-300:]}
        stop = None
        for _ in range(4):
            tui.write(b"\r")
            stop = self.daemon.wait(dm, event_is("Stop"), 10, tui.pump)
            if stop:
                break
        r["native"]["stop"] = bool(stop)
        r["native"]["events_after"] = [p["payload"].get("hook_event_name") for p in self.daemon.since(dm) if p["kind"] == "post" and p["path"] == "/v1/term/ask"]
        tui.pump(1)

    # S9 ----------------------------------------------------------------------

    def s9(self, tui):
        r = self.results["S9"] = {}
        dm, tm = self.daemon.mark(), self.transcripts.mark()
        tui.type("Write a 400-word essay about the history of tea.")
        self.daemon.wait(dm, event_is("UserPromptSubmit"), 10, tui.pump)
        tui.pump(3)
        esc_t = now()
        tui.write(b"\x1b")
        line = self.transcripts.wait(tm, lambda row: "interrupted" in text_of(row).lower(), 8, tui.pump)
        stop = self.daemon.wait(dm, event_is("Stop"), 6, tui.pump)
        r["interrupt"] = {"line": brief_row(line["row"]) if line else None,
                          "line_after_esc_ms": round((line["t"] - esc_t) * 1000) if line else None,
                          "stop_fired": bool(stop), "screen": tui.snap("interrupt")[-300:],
                          "prompt_back_in_box": "history of tea" in tui.tail(800)}
        tui.write(b"\x15")
        tui.pump(1)
        # Double Esc on an empty prompt, 150 ms apart.
        tui.write(b"\x1b")
        tui.pump(0.15)
        tui.write(b"\x1b")
        tui.pump(1.5)
        r["double_esc_150ms"] = tui.snap("esc2-150")[-400:]
        r["double_esc_150ms_rewind"] = "rewind" in tui.tail(1500).lower() or "restore" in tui.tail(1500).lower()
        tui.write(b"\x1b")
        tui.pump(1.5)
        r["after_closing_esc"] = tui.tail(300)
        for gap in (0.4, 0.7, 1.0):
            tui.write(b"\x1b")
            tui.pump(gap)
            tui.write(b"\x1b")
            tui.pump(1.2)
            opened = "rewind" in tui.tail(1200).lower() or "restore the" in tui.tail(1200).lower()
            r[f"double_esc_{int(gap * 1000)}ms_rewind"] = opened
            r[f"double_esc_{int(gap * 1000)}ms_screen"] = tui.snap(f"esc2-{int(gap * 1000)}")[-300:]
            if opened:
                tui.write(b"\x1b")
                tui.pump(1.2)
        # Esc twice with text in the box.
        tui.write(b"half typed text")
        tui.pump(0.5)
        tui.write(b"\x1b")
        tui.pump(0.15)
        tui.write(b"\x1b")
        tui.pump(1.2)
        r["double_esc_with_text"] = tui.snap("esc2-text")[-300:]
        tui.write(b"\x1b")
        tui.pump(0.8)
        tui.write(b"\x15")
        tui.pump(0.8)
        # The type-ahead queue: a prompt typed while a reply streams.
        dm, tm = self.daemon.mark(), self.transcripts.mark()
        tui.type("Write a 300-word essay about the history of coffee.")
        self.daemon.wait(dm, event_is("UserPromptSubmit"), 10, tui.pump)
        tui.pump(1.5)
        tui.type("Then reply with the single word queued.")
        self.daemon.wait(dm, lambda rec: event_is("Stop")(rec) and "queued" in (rec["payload"].get("last_assistant_message") or "").lower(), 120, tui.pump)
        r["queue_lines"] = [brief_row(l["row"]) for l in self.transcripts.since(tm)
                            if l["row"].get("type") in ("queue-operation", "user") or (l["row"].get("attachment") or {}).get("type") == "queued_command"]
        r["queue_ups"] = [rec["payload"].get("prompt", "")[:60] for rec in self.daemon.since(dm) if event_is("UserPromptSubmit")(rec)]
        tui.pump(1)

    # S7 ----------------------------------------------------------------------

    def s7(self, tui):
        r = self.results["S7"] = {"shift_tab": []}
        tm = self.transcripts.mark()
        for i in range(4):
            tui.write(b"\x1b[Z")
            tui.pump(1.2)
            r["shift_tab"].append(tui.snap(f"shift-tab-{i}")[-160:])
        r["shift_tab_lines"] = [brief_row(l["row"]) for l in self.transcripts.since(tm)]
        # Back to default by cycling until the plan label is gone.
        tm = self.transcripts.mark()
        dm = self.daemon.mark()
        tui.type("/plan")
        tui.pump(3)
        r["slash_plan_screen"] = tui.snap("slash-plan")[-300:]
        r["slash_plan_lines"] = [brief_row(l["row"]) for l in self.transcripts.since(tm)]
        r["slash_plan_ups"] = [rec["payload"].get("prompt") for rec in self.daemon.since(dm) if event_is("UserPromptSubmit")(rec)]
        ups, stop, dm, tm = self.turn(tui, "Reply with the single word mode.", 60)
        r["mode_after_plan"] = (ups or {}).get("payload", {}).get("permission_mode")
        r["mode_after_plan_lines"] = [brief_row(l["row"]) for l in self.transcripts.since(tm)][:6]
        # Leave plan mode the way a user would.
        tm = self.transcripts.mark()
        for i in range(3):
            tui.write(b"\x1b[Z")
            tui.pump(1.0)
            if "plan mode" not in tui.tail(400).lower() and "accept edits" not in tui.tail(400).lower():
                break
        r["leave_plan_lines"] = [brief_row(l["row"]) for l in self.transcripts.since(tm)]
        r["leave_plan_screen"] = tui.tail(200)

    # S8 ----------------------------------------------------------------------

    def s8(self, tui):
        r = self.results["S8"] = {}
        tm, dm = self.transcripts.mark(), self.daemon.mark()
        tui.type("/model sonnet")
        tui.pump(3)
        r["model_lines"] = [brief_row(l["row"]) for l in self.transcripts.since(tm)]
        r["model_screen"] = tui.snap("model")[-300:]
        r["model_ups"] = [rec["payload"].get("prompt") for rec in self.daemon.since(dm) if event_is("UserPromptSubmit")(rec)]
        ups, stop, dm, tm = self.turn(tui, "Reply with the single word sonnet.", 60)
        r["model_after"] = [brief_row(l["row"]) for l in self.transcripts.since(tm) if l["row"].get("type") == "assistant"][:2]
        tm = self.transcripts.mark()
        tui.type("/effort low")
        tui.pump(3)
        r["effort_lines"] = [brief_row(l["row"]) for l in self.transcripts.since(tm)]
        r["effort_screen"] = tui.snap("effort")[-300:]
        ups, stop, dm, tm = self.turn(tui, "Reply with the single word effort.", 60)
        r["effort_after"] = [brief_row(l["row"]) for l in self.transcripts.since(tm) if l["row"].get("type") == "assistant"][:2]
        r["effort_stop_payload"] = (stop or {}).get("payload", {}).get("effort")
        tm = self.transcripts.mark()
        tui.type(f"/model {self.args.model}")
        tui.pump(3)
        r["model_back_lines"] = [brief_row(l["row"]) for l in self.transcripts.since(tm)]

    # fixtures ------------------------------------------------------------------

    def fixtures_a(self, tui):
        r = self.results["FIX"] = {}
        self.daemon.ask_policy = lambda p: ("reply", perm_reply("allow"))
        ups, stop, dm, tm = self.turn(tui, "Use the Bash tool with run_in_background set to true to run: sleep 2 && echo done. "
                                           "Then reply with the single word started.", 60)
        note = self.daemon.wait(dm, lambda rec: event_is("UserPromptSubmit")(rec) and "task-notification" in (rec["payload"].get("prompt") or ""), 40, tui.pump)
        r["task_notification_ups"] = bool(note)
        self.daemon.wait(self.daemon.mark() if not note else dm, event_is("Stop"), 40, tui.pump)
        tui.pump(3)
        ups, stop, dm, tm = self.turn(tui, "Use the Bash tool to run exactly: head -c 300000 big.txt — then reply with the single word read.", 90)
        r["huge_lines"] = [{"bytes": l["bytes"], **brief_row(l["row"])} for l in self.transcripts.since(tm) if l["row"].get("type") == "user"][:3]
        self.daemon.ask_policy = lambda p: ("reply", {})

    def s1_compact_clear(self, tui):
        r = self.results
        dm, tm = self.daemon.mark(), self.transcripts.mark()
        tui.type("/compact")
        start = self.daemon.wait(dm, event_is("SessionStart"), 120, tui.pump)
        tui.pump(3)
        r["S1_compact"] = self.start_brief(start)
        r["S1_compact_lines"] = [brief_row(l["row"]) for l in self.transcripts.since(tm)][:12]
        r["S1_compact_other_posts"] = [rec["payload"].get("hook_event_name") for rec in self.daemon.since(dm) if rec["kind"] == "post"]
        dm, tm = self.daemon.mark(), self.transcripts.mark()
        tui.type("/clear")
        start = self.daemon.wait(dm, event_is("SessionStart"), 30, tui.pump)
        tui.pump(2)
        r["S1_clear"] = self.start_brief(start)
        r["S1_clear_lines"] = [dict(file=l["file"], **brief_row(l["row"])) for l in self.transcripts.since(tm)][:12]
        r["S1_clear_other_posts"] = [rec["payload"].get("hook_event_name") for rec in self.daemon.since(dm) if rec["kind"] == "post"]
        ups, stop, dm, tm = self.turn(tui, "Reply with the single word fresh.", 60)
        r["S1_after_clear_session"] = (ups or {}).get("payload", {}).get("session_id")
        self.last_session = r["S1_after_clear_session"] or (start or {}).get("payload", {}).get("session_id")

    # the plan turn, resume, fork, headless ----------------------------------------

    def session_plan(self):
        r = self.results["PLAN"] = {}
        calls = []

        def plan(p):
            calls.append(p)
            if len(calls) == 1:
                return ("reply", {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                                         "permissionDecisionReason": "Plan returned for revision: add a step that verifies the file. Revise and call ExitPlanMode again."}})
            return ("reply", {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow",
                                                     "permissionDecisionReason": "Approved in review."}})
        self.daemon.plan_policy = plan
        self.daemon.ask_policy = lambda p: ("reply", perm_reply("allow")) if p.get("tool_name") != "ExitPlanMode" else ("reply", {})
        tui, start = self.tui("plan", ["--permission-mode", "plan"], ask_timeout=30)
        r["start"] = self.start_brief(start)
        self.plan_session = (start or {}).get("payload", {}).get("session_id")
        try:
            dm, tm = self.daemon.mark(), self.transcripts.mark()
            tui.type("Plan adding a file NOTES.md containing the single line hello. Keep the plan to two short steps, "
                     "then present it with ExitPlanMode. Once it is approved, carry it out.")
            done = None
            end = time.time() + 240
            while time.time() < end and not done:
                done = self.daemon.wait(dm, lambda rec: event_is("Stop")(rec) and len(calls) >= 2, 5, tui.pump)
                if "proceed" in tui.tail(800).lower() and "plan" in tui.tail(800).lower():
                    r.setdefault("native_plan_dialog_seen", now())
                    tui.write(b"\r")
            r["exit_plan_calls"] = len(calls)
            r["plan_payload_keys"] = sorted(calls[0]) if calls else None
            r["notes_written"] = (self.proj / "NOTES.md").exists()
            r["perm_for_exit_plan_mode"] = [rec["payload"].get("tool_name") for rec in self.daemon.since(dm)
                                            if rec["kind"] == "post" and rec["path"] == "/v1/term/ask"]
            r["lines"] = [brief_row(l["row"]) for l in self.transcripts.since(tm) if l["row"].get("type") in ("user", "assistant", "system", "permission-mode")][:40]
            r["titles"] = tui.titles[-6:]
        finally:
            tui.close()

    def session_resume(self):
        sid = getattr(self, "last_session", None)
        if not sid:
            return
        tui, start = self.tui("resume", ["--permission-mode", "default", "--resume", sid])
        self.results["S1_resume"] = dict(self.start_brief(start) or {}, resumed_from=sid)
        tui.close()
        psid = getattr(self, "plan_session", None) or sid
        tui, start = self.tui("fork", ["--permission-mode", "default", "--resume", psid, "--fork-session"])
        self.results["S1_fork"] = dict(self.start_brief(start) or {}, forked_from=psid)
        try:
            ups, stop, dm, tm = self.turn(tui, "Reply with the single word forked.", 60)
            self.results["S1_fork_first_prompt_session"] = (ups or {}).get("payload", {}).get("session_id")
        finally:
            tui.close()

    # follow-ups: what the first pass left open -----------------------------------

    def session_follow(self):
        r = self.results["FOLLOW"] = {}
        tui, start = self.tui("follow", ["--permission-mode", "default"], ask_timeout=12)
        try:
            # A card answered while the TUI's own dialog is on screen.
            out = self.perm_case(tui, "late-allow", "touch f-late.txt", lambda p: ("hold", 3, perm_reply("allow")),
                                 during=lambda t, ask, o: (t.pump(2.5), o.__setitem__("dialog_after_allow", "proceed" in t.tail(600).lower())))
            out["file_written"] = (self.proj / "f-late.txt").exists()
            r["late_allow"] = out
            # Deny with no message, interrupting the turn the way the TUI's No does.
            out = self.perm_case(tui, "deny-interrupt", "touch f-deny.txt",
                                 lambda p: ("reply", perm_reply("deny", message="Denied in Redline.", interrupt=True)), wait_stop=20)
            out["file_written"] = (self.proj / "f-deny.txt").exists()
            r["deny_interrupt"] = out
            tui.write(b"\x15")
            tui.pump(1)
            # A question held by its PreToolUse hook: what the TUI shows, then a
            # timeout (12 s) that lets the TUI ask on its own.
            self.daemon.pre_ask_policy = lambda p: ("hold", 30, {})
            self.daemon.ask_policy = lambda p: ("reply", {})
            dm, tm = self.daemon.mark(), self.transcripts.mark()
            tui.type("Use the AskUserQuestion tool to ask me one question: which fruit I prefer, Apple or Pear. "
                     "Then reply with only my answer.")
            ask = self.daemon.wait(dm, lambda rec: rec["kind"] == "post" and rec["path"] == "/v1/term/ask", 40, tui.pump)
            tui.pump(3)
            q = {"arrived": bool(ask), "screen_while_held": tui.snap("q-held")[-300:],
                 "card_visible_while_held": "apple" in tui.tail(1500).lower() and "enter to select" in tui.tail(1500).lower()}
            tui.pump(12)
            q["screen_after_timeout"] = tui.snap("q-timeout")[-300:]
            q["card_after_timeout"] = "enter to select" in tui.tail(1500).lower()
            q["events"] = [rec["payload"].get("hook_event_name") for rec in self.daemon.since(dm) if rec["kind"] == "post" and rec["path"] == "/v1/term/ask"]
            q["hook_records"] = [{k: rec.get(k) for k in ("kind", "t")} for rec in self.daemon.since(dm) if rec["kind"] in ("client_gone", "answered")]
            tui.write(b"\r")
            q["stop"] = bool(self.daemon.wait(dm, event_is("Stop"), 30, tui.pump))
            r["question_held"] = q
            self.daemon.pre_ask_policy = lambda p: ("reply", {})
            tui.pump(1)
            # Paste thresholds, and whether a pasted slash command runs.
            for label, text in (("five_lines", "Reply with the single word five.\n" + "\n".join(f"l{i}" for i in range(4))),
                                ("long_line", "Reply with the single word long. " + "x" * 1500)):
                dm = self.daemon.mark()
                tui.paced(b"\x1b[200~" + text.encode() + b"\x1b[201~")
                tui.pump(0.3)
                tui.write(b"\r")
                ups = self.daemon.wait(dm, event_is("UserPromptSubmit"), 15, tui.pump)
                prompt = (ups or {}).get("payload", {}).get("prompt") or ""
                r[f"paste_{label}"] = {"verbatim": prompt == text, "wrapped": "pasted_content" in prompt}
                self.daemon.wait(dm, event_is("Stop"), 60, tui.pump)
                tui.pump(1)
            dm, tm = self.daemon.mark(), self.transcripts.mark()
            tui.write(b"\x1b[200~/plan\x1b[201~")
            tui.pump(0.3)
            tui.write(b"\r")
            tui.pump(3)
            r["pasted_slash_command"] = {"ups": [rec["payload"].get("prompt") for rec in self.daemon.since(dm) if event_is("UserPromptSubmit")(rec)],
                                         "lines": [brief_row(l["row"]) for l in self.transcripts.since(tm) if l["row"].get("type") == "user"],
                                         "screen": tui.tail(200)}
            # /effort: its confirmation dialog, confirmed with a second Return.
            for level in ("low", "medium"):
                tm = self.transcripts.mark()
                tui.type(f"/effort {level}")
                tui.pump(2)
                dialog = "change effort level" in tui.tail(1500).lower()
                tui.write(b"\r")
                tui.pump(2)
                r[f"effort_{level}"] = {"dialog": dialog, "lines": [brief_row(l["row"]) for l in self.transcripts.since(tm)],
                                        "screen": tui.tail(160)}
            ups, stop, dm, tm = self.turn(tui, "Reply with the single word effort.", 60)
            r["effort_stop"] = (stop or {}).get("payload", {}).get("effort")
            r["effort_assistant"] = [brief_row(l["row"]) for l in self.transcripts.since(tm) if l["row"].get("type") == "assistant"][:1]
            # SessionEnd on /exit.
            dm = self.daemon.mark()
            tui.type("/exit")
            end = self.daemon.wait(dm, event_is("SessionEnd"), 15, tui.pump)
            r["session_end_exit"] = {k: (end or {}).get("payload", {}).get(k) for k in ("reason", "session_id", "transcript_path")} if end else None
            r["paste_mode_after_exit"] = tui.paste[-3:]
        finally:
            tui.close()
        # SessionEnd when the process is killed.
        tui, start = self.tui("killed", ["--permission-mode", "default"])
        dm = self.daemon.mark()
        tui.close()
        time.sleep(3)
        end = [rec for rec in self.daemon.since(dm) if event_is("SessionEnd")(rec)]
        r["session_end_on_sigterm"] = end[0]["payload"].get("reason") if end else None

    def session_queue(self):
        """Type-ahead while tools run: the CLI can fold it into the running
        turn (`remove`, reason `absorbed_mid_turn`) instead of queueing it
        for after (`dequeue`, S9)."""
        r = self.results["QUEUE"] = {}
        self.daemon.ask_policy = lambda p: ("reply", perm_reply("allow"))
        tui, start = self.tui("queue", ["--permission-mode", "default"])
        try:
            dm, tm = self.daemon.mark(), self.transcripts.mark()
            tui.type("Use the Bash tool to run exactly: sleep 6. When it finishes, use the Bash tool to run exactly: sleep 6. "
                     "Then reply with the single word done.")
            self.transcripts.wait(tm, lambda row: row.get("type") == "assistant" and any(
                isinstance(b, dict) and b.get("type") == "tool_use" for b in (row.get("message") or {}).get("content") or []), 60, tui.pump)
            tui.pump(1.5)
            tui.type("Also reply with the word absorbed.")
            self.daemon.wait(dm, lambda rec: event_is("Stop")(rec) and "absorbed" in (rec["payload"].get("last_assistant_message") or "").lower(), 90, tui.pump)
            tui.pump(2)
            r["lines"] = [brief_row(l["row"]) for l in self.transcripts.since(tm)
                          if l["row"].get("type") in ("queue-operation", "user", "assistant")
                          or (l["row"].get("attachment") or {}).get("type") == "queued_command"]
            r["queue_rows"] = [l["row"] for l in self.transcripts.since(tm) if l["row"].get("type") == "queue-operation"]
            r["ups"] = [rec["payload"].get("prompt", "")[:60] for rec in self.daemon.since(dm) if event_is("UserPromptSubmit")(rec)]
        finally:
            tui.close()
            self.daemon.ask_policy = lambda p: ("reply", {})

    def headless(self):
        cfg = self.cfg("headless", 10)
        dm = self.daemon.mark()
        out = subprocess.run([self.args.claude, "-p", "Reply with the single word pong.", "--model", self.args.model,
                              "--setting-sources", "project", "--settings", str(cfg)],
                             cwd=self.proj, env=self.env("probe-headless"), stdin=subprocess.DEVNULL,
                             capture_output=True, text=True, timeout=180)
        time.sleep(2)
        starts = [rec for rec in self.daemon.since(dm) if event_is("SessionStart")(rec)]
        self.results["S2_headless"] = {
            "stdout": out.stdout.strip()[-80:],
            "session_start": self.start_brief(starts[0]) if starts else None,
            "entrypoints": sorted({rec["headers"].get("X-Redline-Entrypoint", "") for rec in self.daemon.since(dm) if rec["kind"] == "post"}),
        }

    def capture(self):
        dest = self.root / "capture"
        dest.mkdir(exist_ok=True)
        if self.folder.exists():
            for path in self.folder.glob("*.jsonl"):
                shutil.copy(path, dest / path.name)
        (self.root / "transcript-lines.jsonl").write_text(
            "\n".join(json.dumps({"t": l["t"], "file": l["file"], "row": brief_row(l["row"]), "bytes": l["bytes"]})
                      for l in self.transcripts.since(0)))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--model", default="haiku")
    p.add_argument("--claude", default=shutil.which("claude") or "claude")
    p.add_argument("--only", default="", help="comma-separated cases: S1,S2,S4,S5,S7,S8,S9,FIX,PLAN,FOLLOW,QUEUE")
    p.add_argument("--keep", action="store_true", help="keep the temp dir and the CLI's transcripts")
    args = p.parse_args()
    run = Run(args)
    version = subprocess.run([args.claude, "--version"], capture_output=True, text=True, env=stripped_env({})).stdout.strip()
    try:
        steps = []
        if run.only is None or run.only & {"S1", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "FIX", "NONE"}:
            steps.append(("A", run.session_a))
        if run.wanted("FOLLOW"):
            steps.append(("FOLLOW", run.session_follow))
        if run.wanted("QUEUE"):
            steps.append(("QUEUE", run.session_queue))
        if run.wanted("PLAN"):
            steps.append(("PLAN", run.session_plan))
        if run.wanted("S1"):
            steps.append(("RESUME", run.session_resume))
        if run.wanted("S2"):
            steps.append(("S2", run.headless))
        for name, step in steps:
            try:
                step()
            except Exception as e:  # one failed step must not lose the rest
                run.results.setdefault("errors", []).append(f"{name}: {type(e).__name__}: {e}")
        time.sleep(2)
        run.capture()
        print(json.dumps({"claude": version, "root": str(run.root), "port": run.daemon.port, **run.results}, indent=1, default=str))
    finally:
        if not args.keep:
            shutil.rmtree(run.folder, ignore_errors=True)
            shutil.rmtree(run.root, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
