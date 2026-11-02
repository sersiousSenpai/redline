#!/usr/bin/env python3
"""Verify the Codex contract behind restoring a plan whose CLI never went away.

Experiment (p), docs/protocol-verification.md. A plan's hold can end while its
TUI lives on: the Stop hook's 12-hour limit passes, or Redline quits and the PTY
helper keeps the terminal. Against the installed `codex`, this measures:

  P1  `--listen unix://<path>` leaves a symlink at <path>, not a socket.
  P2  The state after the hold: the thread is idle and its server has it loaded.
  P3  `codex resume` through a second launcher fails on the thread's writer: the
      prompt never reaches the model, no hook fires, and the TUI stays up.
  P4  From a second client that never joined, in the order
      `codex_app_server::restore_on_live_thread` sends them, `thread/read`,
      `thread/settings/update` and `thread/queue/add` start a turn on the idle
      thread. It survives that client closing at once, the TUI shows it, and its
      Stop carries the marker, the same session and the terminal's environment.
  P5  The update puts a thread the approval hand-off opened back to read-only.
  P6  A turn already running reads `active`, and `turn/start` steers into it
      where `thread/queue/add` waits for it to end.
  P7  (--rust) `restore_on_live_thread` itself finds the thread through its own
      discovery, on this real server's socket, and starts the turn. A thread no
      server has comes back as nothing to do.

Isolation is verify-codex-mirror.py's: a throwaway CODEX_HOME and workspace and
a local mock model, so no account, model service or `~/.codex` is touched. P7's
discovery connects to the real launcher sockets in /tmp, as Redline does, and
only asks each which threads it has.

    python3 scripts/verify-codex-live-restore.py [--rust] [--codex PATH]

Exits non-zero if any measurement stopped holding. About 30 seconds, plus a
warm `cargo test` build with --rust.
"""
import argparse
import faulthandler
import importlib.util
import json
import os
import pathlib
import re
import shutil
import sys
import tempfile
import threading
import time

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("verify_codex_mirror", HERE / "verify-codex-mirror.py")
rig = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = rig
spec.loader.exec_module(rig)

PLAN = "<proposed_plan>\n# Greeting\n\n1. Create hello.txt.\n</proposed_plan>"
failures = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}{f'  [{detail}]' if detail else ''}", flush=True)
    if not ok:
        failures.append(name)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--codex", default=os.environ.get("REDLINE_PROBE_CODEX", "codex"))
    ap.add_argument("--rust", action="store_true")
    args = ap.parse_args()
    faulthandler.dump_traceback_later(420, exit=True)
    if args.rust:
        # Built before any TUI starts, so the probe itself only runs.
        built = rig.cargo("test", "--lib", "--no-run")
        if built.returncode:
            raise RuntimeError("cargo test --no-run failed: " + built.stderr[-2000:])

    root = pathlib.Path(tempfile.mkdtemp(prefix="rl-codex-live-restore-"))
    home, workspace = root / "home", root / "workspace"
    home.mkdir()
    workspace.mkdir()
    (workspace / "README.md").write_text("# probe\n")
    model = rig.Model()
    hook_log = root / "hooks.jsonl"
    (root / "hook.py").write_text(rig.HOOK)
    command = f"/usr/bin/python3 {root / 'hook.py'} {hook_log}"
    (home / "hooks.json").write_text(json.dumps({"hooks": {e: [{"hooks": [{"type": "command", "command": command, "timeout": 30}]}] for e in rig.EVENTS}}))
    # Only this isolated fixture bypasses trust; the production launcher never does.
    (home / "config.toml").write_text(
        'bypass_hook_trust = true\nmodel = "gpt-5.5"\nmodel_provider = "probe"\n'
        '[model_providers.probe]\nname = "Probe"\n'
        f'base_url = "http://127.0.0.1:{model.port}/v1"\n'
        'wire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n'
        f'\n[projects.{json.dumps(str(workspace))}]\ntrust_level = "trusted"\n')
    contract = rig.CONTRACT.read_text()
    (home / "redline-plan.config.toml").write_text("developer_instructions = " + json.dumps(contract) + "\n")
    env = rig.child_env({"CODEX_HOME": str(home), "TERM": "xterm-256color",
                         "REDLINE_TERMINAL_ID": rig.TERMINAL_ID, "REDLINE_PLAN_LAUNCH_ID": rig.LAUNCH_ID})
    hooks = rig.Hooks(hook_log)
    quiet = lambda _: None

    def launch(*extra):
        return rig.Tui(["/bin/sh", str(rig.LAUNCHER), args.codex, *extra, "-m", "gpt-5.5", "-p", "redline-plan",
                        "--dangerously-bypass-hook-trust", "--no-alt-screen"], workspace, env)

    def stops():
        return [r for r in hooks.all() if r["payload"].get("hook_event_name") == "Stop"]

    def wait_stops(count, seconds):
        end = time.time() + seconds
        while time.time() < end and len(stops()) < count:
            time.sleep(0.1)
        return stops()

    tuis = []
    try:
        print(rig.subprocess.run([args.codex, "--version"], capture_output=True, text=True).stdout.strip(), flush=True)

        # The state a dropped hold leaves: proposed, Stop answered, TUI alive.
        model.push({"items": [rig.message(PLAN, "final_answer")]})
        tui = launch("-s", "read-only", "-a", "never", "Plan a greeting.")
        tuis.append(tui)
        first = hooks.wait(rig.hook_is("SessionStart"), 30) or hooks.wait(rig.hook_is("UserPromptSubmit"), 30)
        if not first:
            raise RuntimeError("no hook fired; terminal: " + tui.screen())
        socket_path, thread = first["env"]["REDLINE_CODEX_SOCKET"], first["payload"]["session_id"]
        if not wait_stops(1, 30):
            raise RuntimeError("the plan's Stop never fired; terminal: " + tui.screen())
        time.sleep(1)

        check("P1 the launcher's socket path is a symlink", os.path.islink(socket_path))

        c = rig.Client(socket_path, "state", quiet)
        c.initialize()
        loaded = c.request("thread/loaded/list", {})
        read = c.request("thread/read", {"threadId": thread, "includeTurns": False})
        baseline = c.request("thread/resume", {"threadId": thread, "excludeTurns": True})
        c.close()
        check("P2 its server has the thread loaded", thread in (loaded or {}).get("data", []))
        check("P2 the thread is idle", read["thread"]["status"]["type"] == "idle", read["thread"]["status"]["type"])
        print(f"      baseline sandbox={json.dumps(baseline.get('sandbox'))} approvalPolicy={baseline.get('approvalPolicy')}", flush=True)

        # What Restore did before the fix.
        before, requests = len(hooks.all()), len(model.requests)
        second = launch("resume", thread, "Redline restore · resume")
        tuis.append(second)
        time.sleep(7)
        logs = sorted(pathlib.Path("/tmp").glob("rlcx.*/server.log"), key=lambda p: p.stat().st_mtime)
        log = logs[-1].read_text() if logs else ""
        screen = re.sub(r"\s+", " ", second.screen(6000))
        check("P3 resume fails on the thread's writer", "active writer" in log)
        check("P3 its prompt never reaches the model", len(model.requests) == requests)
        check("P3 no hook fires", len(hooks.all()) == before)
        check("P3 its TUI stays up, saying so", second.proc.poll() is None and "open in another app" in screen)
        second.stop()
        tuis.remove(second)

        # P5's setup: the approval hand-off opens the thread for building.
        c = rig.Client(socket_path, "handoff", quiet)
        c.initialize()
        opened = c.request("thread/settings/update", {"threadId": thread, "approvalPolicy": "on-request",
                                                      "sandboxPolicy": {"type": "workspaceWrite", "networkAccess": False}})
        check("P5 setup: the hand-off's settings are accepted", "error" not in (opened or {}), str(opened)[:120])
        c.close()

        # The restore: restore_on_live_thread's calls, on a connection that closes at once.
        count = len(stops())
        requests = len(model.requests)
        marker = f"<proposed_plan><!-- REDLINE_RESTORE:{thread} --></proposed_plan>"
        model.push({"delay": 2, "items": [rig.message(marker, "final_answer")]})
        c = rig.Client(socket_path, "restore", quiet)
        c.initialize()
        loaded = c.request("thread/loaded/list", {})
        read = c.request("thread/read", {"threadId": thread, "includeTurns": False})["thread"]
        settings = c.request("thread/settings/update", {
            "threadId": thread, "approvalPolicy": "never", "sandboxPolicy": {"type": "readOnly"},
            "collaborationMode": {"mode": "default", "settings": {"model": read.get("model"), "reasoning_effort": read.get("reasoningEffort"), "developer_instructions": contract}},
        })
        check("P4 the review settings are accepted", "error" not in (settings or {}), str(settings)[:160])
        queued = c.request("thread/queue/add", {"threadId": thread, "clientUserMessageId": "redline-restore-probe",
                                                "input": [{"type": "text", "text": "Redline restore · 2026-11-02 15:30 — end this turn"}]})
        check("P4 the queue acknowledges", bool(((queued or {}).get("queuedSubmission") or {}).get("id")), str(queued)[:160])
        c.close()  # before the model answers: `delay` above

        fired = wait_stops(count + 1, 25)
        stop = fired[count] if len(fired) > count else None
        check("P4 the turn runs after its client left, and its Stop fires", bool(stop))
        if stop:
            check("P4 the Stop carries the marker", stop["payload"].get("last_assistant_message") == marker)
            check("P4 the Stop is the same session", stop["payload"].get("session_id") == thread)
            check("P4 the Stop keeps the terminal's environment", stop["env"]["REDLINE_TERMINAL_ID"] == rig.TERMINAL_ID and stop["env"]["REDLINE_CODEX_SOCKET"] == socket_path)
        check("P4 the model got the trigger", "Redline restore" in json.dumps(model.requests[-1]["input_tail"]) if len(model.requests) > requests else False)
        check("P4 the TUI is up and shows the turn", tui.proc.poll() is None and "Redline restore" in re.sub(r"\s+", " ", tui.screen(20000)))

        time.sleep(1)
        c = rig.Client(socket_path, "after", quiet)
        c.initialize()
        after = c.request("thread/resume", {"threadId": thread, "excludeTurns": True})
        c.close()
        check("P5 the thread is read-only again", (after.get("sandbox") or {}).get("type") == "readOnly", json.dumps(after.get("sandbox")))
        check("P5 approvals are back to never", after.get("approvalPolicy") == "never", str(after.get("approvalPolicy")))
        check("P5 matches what the launcher gave it", after.get("sandbox") == baseline.get("sandbox"), f"{after.get('sandbox')} vs {baseline.get('sandbox')}")

        # A turn already running.
        gate = threading.Event()
        count = len(stops())
        model.push({"gate": gate, "items": [rig.message("first turn's answer", "final_answer")]},
                   {"items": [rig.message("steered", "final_answer")]},
                   {"items": [rig.message("queued ran after", "final_answer")]})
        tui.submit("do something long")
        c = rig.Client(socket_path, "busy", quiet)
        c.initialize()
        status = None
        end = time.time() + 10
        while time.time() < end:
            status = c.request("thread/read", {"threadId": thread, "includeTurns": False})["thread"]["status"]["type"]
            if status == "active":
                break
            time.sleep(0.1)
        check("P6 a running turn reads active", status == "active", str(status))
        steer = c.request("turn/start", {"threadId": thread, "input": [{"type": "text", "text": "steer"}]}, seconds=5)
        check("P6 turn/start is accepted mid-turn", "error" not in (steer or {}), str(steer)[:120])
        queue = c.request("thread/queue/add", {"threadId": thread, "clientUserMessageId": "redline-restore-busy",
                                               "input": [{"type": "text", "text": "queued"}]}, seconds=5)
        check("P6 the queue is accepted mid-turn", bool(((queue or {}).get("queuedSubmission") or {}).get("id")), str(queue)[:120])
        c.close()
        gate.set()
        fired = wait_stops(count + 2, 20)
        answers = [(s["payload"].get("last_assistant_message") or "") for s in fired[count:]]
        print(f"      Stops after the gate: {answers}", flush=True)
        check("P6 turn/start joined the running turn: one Stop, then the queued one's", answers == ["steered", "queued ran after"], str(answers))

        if args.rust:
            # Redline's own code on this server: its discovery through the
            # symlink, then the calls P4 made by hand.
            time.sleep(1)
            count = len(stops())
            model.push({"items": [rig.message(marker, "final_answer")]})
            probe = rig.subprocess.run(
                ["cargo", "test", "--lib", "codex_live_restore_probe", "--", "--ignored", "--nocapture"],
                cwd=rig.REPO / "src-tauri", capture_output=True, text=True, timeout=120,
                env=rig.child_env({"CARGO_BUILD_JOBS": "6", "REDLINE_PROBE_THREAD": thread, "REDLINE_PROBE_PROMPT": "Redline restore · from Rust"}))
            check("P7 restore_on_live_thread finds the thread and starts it", probe.returncode == 0, "" if probe.returncode == 0 else (probe.stdout + probe.stderr)[-500:])
            fired = wait_stops(count + 1, 20)
            stop = fired[count] if len(fired) > count else None
            check("P7 its Stop carries the marker", bool(stop) and stop["payload"].get("last_assistant_message") == marker)
    finally:
        for t in tuis:
            try:
                t.stop()
            except OSError:
                pass
        shutil.rmtree(root, ignore_errors=True)

    print(f"\n{len(failures)} failed" if failures else "\nall held", flush=True)
    sys.stdout.flush()
    os._exit(1 if failures else 0)  # Tui.close: never wait on a pty master


if __name__ == "__main__":
    main()
