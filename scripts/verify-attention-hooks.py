#!/usr/bin/env python3
"""Verify the Claude Code hook contract behind Redline's terminal attention.

Terminal-wall Phase 0 (docs/protocol-verification.md, experiment (l)). Against
the installed `claude`, measures:

  1. the Notification payload: which `notification_type` fires for a tool
     permission prompt, an AskUserQuestion card and an idle prompt (after a
     finished turn and after an interrupted one), and what `message` / `title`
     carry;
  2. the Stop payload: `last_assistant_message`, `stop_hook_active` (forced
     true once by a blocking Stop gate), whether Stop fires for an
     interrupted turn, and how long `transcript_path` takes to hold the final
     reply (the fallback when `last_assistant_message` is missing);
  3. whether an `async: true` command hook blocks the turn, and what happens to
     one still running when a `-p` session ends;
  4. whether hook commands inherit the launching environment, so a
     `REDLINE_TERMINAL_ID` set on the PTY reaches the hook's curl, and what a
     claude launched from *inside* another claude's Bash tool looks like.

Isolation: a throwaway project under the system temp dir, hooks supplied with
`--settings <file>` and `--setting-sources project` (the user's global
`~/.claude/settings.json` hooks, including Redline's own, never load), and the
caller's CLAUDE* session markers stripped from every child. Uses a cheap model
and one-line prompts. Transcripts the CLI writes for the throwaway project are
removed afterwards unless --keep. The interactive half drives the real TUI
through a pty; with the idle waits it takes about seven minutes.

Run: python3 scripts/verify-attention-hooks.py [--model haiku] [--skip-idle] [--skip-tui] [--keep]
Prints a JSON summary; with --keep the raw hook logs stay in the temp dir.
"""
import argparse
import fcntl
import json
import os
import pathlib
import pty
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time

# Every hook runs this with `<log> <label>`. Labels: `ups`/`stop`/`notification`
# log and return; `ups-async` sleeps 8 s (does an async hook hold the turn?);
# `stop-async` polls the transcript until it holds `last_assistant_message`
# (how stale is the fallback?); `stop-gate` blocks the first Stop once (what
# does `stop_hook_active` look like on the continuation?).
LOGGER = r'''import json, os, pathlib, sys, time
log, label = sys.argv[1], sys.argv[2]
t0 = time.time()
payload = json.load(sys.stdin)
# Values for the identity markers only; names for everything else, since the
# environment can carry tokens.
SHOW = {"REDLINE_TERMINAL_ID", "CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION",
        "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PROJECT_DIR"}
env = {k: (v if k in SHOW else "<set>") for k, v in os.environ.items()
       if k.startswith(("CLAUDE", "REDLINE"))}
tp = payload.get("transcript_path")
def transcript_tail():
    if not (tp and os.path.exists(tp)):
        return None
    tail = None
    for line in pathlib.Path(tp).read_text().splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if entry.get("type") != "assistant":
            continue
        content = (entry.get("message") or {}).get("content") or []
        text = "".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text")
        if text:
            tail = text
    return tail
def write(rec):
    with open(log, "a") as f:
        f.write(json.dumps(rec) + "\n")
gate = None
if label == "stop-gate":
    flag = pathlib.Path(log).with_suffix(".gated")
    if not flag.exists():
        flag.write_text("1")
        gate = "blocked"
write({"label": label, "phase": "start", "t": t0, "payload": payload, "env": env,
       "transcript_exists": bool(tp and os.path.exists(tp)),
       "transcript_tail": transcript_tail() if label.startswith("stop") else None, "gate": gate})
if label == "ups-async":
    time.sleep(8)
    write({"label": label, "phase": "end", "t": time.time()})
if label == "stop-async":
    want = payload.get("last_assistant_message")
    lag = None
    while time.time() - t0 < 5:
        if want and transcript_tail() == want:
            lag = round(time.time() - t0, 3)
            break
        time.sleep(0.05)
    write({"label": label, "phase": "end", "t": time.time(), "tail_lag_s": lag})
if gate == "blocked":
    sys.stderr.write("Before stopping, reply with the single word again.")
    sys.exit(2)
'''

MARKERS = re.compile(r"^(CLAUDE|CLAUDECODE)")
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-_]")


def stripped_env(extra):
    env = {k: v for k, v in os.environ.items() if not MARKERS.match(k)}
    env.update(extra)
    return env


def hook(logger, log, label, is_async=False):
    entry = {"type": "command", "command": f"python3 -I {logger} {log} {label}"}
    if is_async:
        entry["async"] = True
    return entry


def settings(logger, log, gate):
    stop = [hook(logger, log, "stop"), hook(logger, log, "stop-async", True)]
    if gate:
        stop.append(hook(logger, log, "stop-gate"))
    return {"hooks": {
        "UserPromptSubmit": [{"hooks": [hook(logger, log, "ups"), hook(logger, log, "ups-async", True)]}],
        "Stop": [{"hooks": stop}],
        "Notification": [{"hooks": [hook(logger, log, "notification")]}],
    }}


def read_log(log):
    if not log.exists():
        return []
    return [json.loads(line) for line in log.read_text().splitlines() if line.strip()]


def run_headless(claude, model, root, name, env, gate):
    log = root / f"{name}.jsonl"
    cfg = root / f"{name}.settings.json"
    cfg.write_text(json.dumps(settings(root / "logger.py", log, gate)))
    t0 = time.time()
    out = subprocess.run(
        [claude, "-p", "Reply with the single word pong.", "--model", model,
         "--setting-sources", "project", "--settings", str(cfg)],
        cwd=root / "proj", env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=180)
    t1 = time.time()
    time.sleep(10)  # an async hook that survived teardown would finish by now
    return {"t_start": t0, "t_exit": t1, "stdout": out.stdout.strip()[-200:], "code": out.returncode, "log": read_log(log)}


class Tui:
    def __init__(self, argv, cwd, env, log):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.execvpe(argv[0], argv, env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        self.screen = ""
        self.log = log
        self.mark = 0

    def pump(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([self.fd], [], [], 0.2)
            if ready:
                try:
                    chunk = os.read(self.fd, 65536).decode("utf-8", "replace")
                except OSError:
                    return
                self.screen = (self.screen + ANSI.sub("", chunk))[-20000:]

    def key(self, raw):
        os.write(self.fd, raw)

    def prompt(self, text):
        """Type a prompt and submit it; later waits only see hook records after it."""
        self.mark = len(read_log(self.log))
        os.write(self.fd, text.encode())
        self.pump(0.8)
        os.write(self.fd, b"\r")

    def wait(self, label, seconds):
        """The first record with `label` (start phase) since the last prompt/rearm."""
        end = time.time() + seconds
        while time.time() < end:
            self.pump(0.4)
            for record in read_log(self.log)[self.mark:]:
                if record["label"] == label and record["phase"] == "start":
                    return record
        return None

    def rearm(self):
        self.mark = len(read_log(self.log))

    def close(self):
        # The TUI can ignore SIGTERM, so escalate rather than wait forever.
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


def brief(record):
    if not record:
        return None
    p = record["payload"]
    out = {k: p[k] for k in ("notification_type", "message", "title", "stop_hook_active") if k in p}
    if "last_assistant_message" in p:
        out["last_assistant_message"] = (p["last_assistant_message"] or "")[:160]
    return out


def run_tui(claude, model, root, skip_idle):
    log = root / "tui.jsonl"
    cfg = root / "tui.settings.json"
    cfg.write_text(json.dumps(settings(root / "logger.py", log, False)))
    env = stripped_env({"REDLINE_TERMINAL_ID": "probe-tui", "TERM": "xterm-256color"})
    # `default`, not the account's own mode: in `auto` the classifier approves
    # a plain write and no permission card ever appears.
    tui = Tui([claude, "--model", model, "--permission-mode", "default", "--setting-sources", "project",
               "--settings", str(cfg)], root / "proj", env, log)
    steps = {}
    try:
        tui.pump(6)
        if "trust" in tui.screen.lower():
            # The workspace-trust card defaults to "No, exit".
            tui.key(b"\x1b[B")
            tui.pump(0.5)
            tui.key(b"\r")
            tui.pump(5)

        # 0. A one-word turn, so the 8 s async hook is still asleep at Stop.
        tui.prompt("Reply with the single word pong.")
        steps["quick_stop"] = brief(tui.wait("stop", 60))

        # 1. A tool permission prompt left unanswered (a write, so it is not
        #    auto-approved the way a read-only `echo` is), then approved.
        t = time.time()
        tui.prompt("Use the Bash tool to run exactly: touch probe.txt")
        note = tui.wait("notification", 40)
        steps["permission"] = brief(note)
        steps["permission_delay_s"] = round(note["t"] - t, 1) if note else None
        tui.rearm()
        tui.key(b"\r")  # "Yes"
        steps["permission_stop"] = brief(tui.wait("stop", 60))

        # 2. An AskUserQuestion card left unanswered, then answered.
        tui.prompt("Use the AskUserQuestion tool to ask me whether I prefer red or blue. Ask nothing else.")
        steps["ask"] = brief(tui.wait("notification", 30))
        steps["ask_screen_tail"] = tui.screen[-400:]
        tui.rearm()
        for _ in range(4):  # pick the first option, then confirm if the card asks to submit
            tui.key(b"\r")
            stop = tui.wait("stop", 10)
            if stop:
                steps["ask_stop"] = brief(stop)
                break

        # 3. Idle after a finished turn.
        if not skip_idle:
            tui.rearm()
            steps["idle_after_stop"] = brief(tui.wait("notification", 90))

        # 4. An interrupted turn: Esc while the reply is still streaming. (A
        #    long `sleep` is no good: the CLI moves it to the background, and
        #    its completion later starts a turn of its own.)
        tui.prompt("Write a 400-word essay about the history of tea.")
        tui.wait("ups", 10)
        tui.pump(2.5)
        tui.rearm()
        tui.key(b"\x1b")
        steps["stop_after_interrupt"] = brief(tui.wait("stop", 12))
        steps["interrupt_screen_tail"] = tui.screen[-300:]

        # 5. Idle after an interrupted turn. The CLI puts the interrupted
        #    prompt back in the input box, so wait once with it there and
        #    once more after clearing it (Ctrl+U).
        if not skip_idle:
            tui.rearm()
            steps["idle_after_interrupt"] = brief(tui.wait("notification", 90))
            tui.key(b"\x15")
            tui.rearm()
            steps["idle_after_cleared_interrupt"] = brief(tui.wait("notification", 90))
        tui.pump(9)  # let the async hooks of the last turn finish
    finally:
        tui.close()
    return {"steps": steps, "log": read_log(log)}


def by(log, label, phase="start"):
    return [r for r in log if r["label"] == label and r["phase"] == phase]


def summarize(headless, nested, tui):
    out = {}
    stops = by(headless["log"], "stop")
    out["stop_payload_keys"] = sorted(stops[0]["payload"]) if stops else None
    out["headless_stops"] = [{"stop_hook_active": r["payload"].get("stop_hook_active"),
                              "last_assistant_message": r["payload"].get("last_assistant_message"),
                              "transcript_tail_at_fire": r["transcript_tail"]} for r in stops]
    ups = by(headless["log"], "ups-async")
    out["headless_async"] = {
        "ups_async_started": bool(ups),
        "ups_async_finished": bool(by(headless["log"], "ups-async", "end")),
        "stop_async_finished": bool(by(headless["log"], "stop-async", "end")),
        "first_stop_after_ups_async_start_s": round(stops[0]["t"] - ups[0]["t"], 2) if ups and stops else None,
        "process_exit_after_start_s": round(headless["t_exit"] - headless["t_start"], 2),
    }
    out["headless_env"] = stops[0]["env"] if stops else None
    if nested:
        nstops = by(nested["log"], "stop")
        out["nested_env"] = nstops[0]["env"] if nstops else None
    if tui:
        log = tui["log"]
        notes = by(log, "notification")
        out["notification_payload_keys"] = sorted(notes[0]["payload"]) if notes else None
        out["tui_steps"] = tui["steps"]
        t_stop = by(log, "stop")
        # Per turn: did the turn end while its prompt's 8 s async hook was
        # still asleep? Turns that waited on a card take longer than 8 s and
        # can't tell either way.
        turns = []
        for stop in t_stop:
            started = [r for r in by(log, "ups-async") if r["t"] <= stop["t"]]
            if not started:
                continue
            start = started[-1]
            ends = [r for r in by(log, "ups-async", "end") if r["t"] >= start["t"]]
            turns.append({
                "stop_after_prompt_s": round(stop["t"] - start["t"], 2),
                "async_hook_still_running_at_stop": not ends or ends[0]["t"] > stop["t"],
            })
        out["tui_async"] = {
            "ups_async_started": len(by(log, "ups-async")),
            "ups_async_finished": len(by(log, "ups-async", "end")),
            "turns": turns,
        }
        out["tui_transcript_lag_s"] = [r.get("tail_lag_s") for r in by(log, "stop-async", "end")]
        out["tui_transcript_tail_at_fire_matches"] = [
            r["transcript_tail"] == r["payload"].get("last_assistant_message") for r in t_stop]
        out["tui_env"] = t_stop[0]["env"] if t_stop else None
        out["tui_ups_keys"] = sorted(by(log, "ups")[0]["payload"]) if by(log, "ups") else None
    return out


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--model", default="haiku")
    p.add_argument("--claude", default=shutil.which("claude") or "claude")
    p.add_argument("--skip-idle", action="store_true", help="skip the ~60-90 s idle_prompt waits")
    p.add_argument("--skip-tui", action="store_true", help="headless experiments only")
    p.add_argument("--keep", action="store_true", help="keep the temp dir and the CLI's transcripts")
    args = p.parse_args()

    root = pathlib.Path(tempfile.mkdtemp(prefix="rl-attn-")).resolve()
    (root / "proj").mkdir()
    (root / "logger.py").write_text(LOGGER)
    version = subprocess.run([args.claude, "--version"], capture_output=True, text=True,
                             env=stripped_env({})).stdout.strip()
    try:
        headless = run_headless(args.claude, args.model, root, "headless",
                                stripped_env({"REDLINE_TERMINAL_ID": "probe-headless"}), True)
        nested = None
        if os.environ.get("CLAUDECODE"):
            # This probe is itself running under a claude's Bash tool: launching
            # with the inherited environment IS the nested case.
            nested = run_headless(args.claude, args.model, root, "nested",
                                  dict(os.environ, REDLINE_TERMINAL_ID="probe-nested"), False)
        tui = None if args.skip_tui else run_tui(args.claude, args.model, root, args.skip_idle)
        print(json.dumps({"claude": version, "root": str(root), **summarize(headless, nested, tui)}, indent=2))
    finally:
        if not args.keep:
            slug = re.sub(r"[^A-Za-z0-9]", "-", str(root / "proj"))
            shutil.rmtree(pathlib.Path.home() / ".claude" / "projects" / slug, ignore_errors=True)
            shutil.rmtree(root, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
