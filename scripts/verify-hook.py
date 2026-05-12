#!/usr/bin/env python3
"""Verify Claude Code hook contract for Redline Milestone 0.

Listens on 127.0.0.1:<port>/v1/plan, logs every POST payload, and returns a
configurable response so we can observe Claude Code's behavior. See
docs/protocol-verification.md for the experiments this supports.
"""
import argparse
import json
import sys
import time
from datetime import datetime, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

LOG_FILE = Path(__file__).parent / "hook-log.jsonl"


def now():
    return datetime.now(timezone.utc).isoformat()


def append_log(entry):
    with LOG_FILE.open("a") as f:
        f.write(json.dumps(entry) + "\n")


def build_response(mode, reason, modify_plan):
    if mode == "allow":
        resp = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "permissionDecisionReason": reason or "verify-hook: allow",
            }
        }
        if modify_plan is not None:
            # Best-guess field name; experiment (f) verifies whether honored.
            resp["modifiedToolInput"] = {"plan": modify_plan}
        return resp
    if mode in ("deny", "ask", "defer"):
        return {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": mode,
                "permissionDecisionReason": reason or f"verify-hook: {mode}",
            }
        }
    if mode == "legacy-deny":
        return {"decision": "deny", "reason": reason or "verify-hook: legacy deny"}
    if mode == "legacy-allow":
        return {"decision": "allow"}
    raise ValueError(f"unknown mode: {mode}")


class HookHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(body) if body else {}
        except json.JSONDecodeError:
            payload = {"_raw_body": body.decode("utf-8", errors="replace")}

        req_entry = {
            "ts": now(),
            "kind": "request",
            "path": self.path,
            "headers": {k: v for k, v in self.headers.items()},
            "payload": payload,
        }
        append_log(req_entry)
        print(f"\n[{req_entry['ts']}] POST {self.path}", file=sys.stderr)
        print(json.dumps(payload, indent=2)[:4000], file=sys.stderr, flush=True)

        if self.path != "/v1/plan":
            self.send_response(404)
            self.end_headers()
            return

        cfg = self.server.cfg
        if cfg.sleep > 0:
            print(f"  sleeping {cfg.sleep}s before responding...", file=sys.stderr, flush=True)
            time.sleep(cfg.sleep)

        try:
            resp = build_response(cfg.mode, cfg.reason, cfg.modify_plan)
        except Exception as e:
            resp = {"_error": str(e)}

        resp_bytes = json.dumps(resp).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(resp_bytes)))
        self.end_headers()
        try:
            self.wfile.write(resp_bytes)
        except BrokenPipeError:
            print("  client disconnected before response was read", file=sys.stderr, flush=True)

        append_log({"ts": now(), "kind": "response", "body": resp})
        print(f"  -> {json.dumps(resp)}", file=sys.stderr, flush=True)

    def log_message(self, fmt, *args):
        return  # silence default access log; we emit structured entries above


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--mode",
        default="allow",
        choices=["allow", "deny", "ask", "defer", "legacy-deny", "legacy-allow"],
        help="response shape to return",
    )
    p.add_argument("--reason", default=None, help="permissionDecisionReason text")
    p.add_argument("--sleep", type=int, default=0, help="seconds to delay before responding")
    p.add_argument(
        "--modify-plan",
        dest="modify_plan",
        default=None,
        help="when --mode=allow, also send modifiedToolInput.plan=<TEXT>",
    )
    p.add_argument("--port", type=int, default=7676)
    args = p.parse_args()

    server = HTTPServer(("127.0.0.1", args.port), HookHandler)
    server.cfg = args
    print(
        f"verify-hook listening on http://127.0.0.1:{args.port}/v1/plan\n"
        f"  mode={args.mode}  sleep={args.sleep}s  reason={args.reason!r}\n"
        f"  modify_plan={args.modify_plan!r}\n"
        f"  log={LOG_FILE}\n"
        f"  (ctrl+c to stop)",
        file=sys.stderr,
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nverify-hook shutdown", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
