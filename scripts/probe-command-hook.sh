#!/usr/bin/env bash
# Phase 0 / Question B probe — does Claude Code stream stderr live during a
# held command hook, or buffer it until exit?
#
# Install temporarily by writing to your project's .claude/settings.local.json:
#
#   {
#     "hooks": {
#       "PreToolUse": [
#         {
#           "matcher": "ExitPlanMode",
#           "hooks": [{ "type": "command",
#                       "command": "/Users/yusufalbazian/redline/scripts/probe-command-hook.sh",
#                       "timeout": 120 }]
#         }
#       ]
#     }
#   }
#
# Then in a *fresh* claude session, ask: "make a 3-sentence plan for hello
# world in python". Observe: does the banner appear immediately when the hook
# fires, or only after ~60s when the script exits?

set -u

# 1. Drop stdin (Claude Code passes the hook payload here).
cat >/dev/null

# 2. Print banner to stderr immediately. If Claude Code streams stderr, the
#    user sees this RIGHT NOW. If it buffers, they see it after step 3.
{
  printf '\033[31m▶ plan ready — intercepted by redline\033[0m\n'
  printf '  waiting for review on 127.0.0.1:7676\n'
  printf '\n'
  printf '\033[90m# while you review, terminal stays\033[0m\n'
  printf '\033[90m# open. submit in redline to resume.\033[0m\n'
} >&2

# 3. Simulate the held POST (Redline daemon would normally block here).
sleep 60

# 4. Return a deny response so the test exits cleanly.
cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"(probe) command-hook stderr-timing experiment — replace with real Redline flow once verified"}}
EOF
