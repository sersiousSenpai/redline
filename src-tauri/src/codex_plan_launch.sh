#!/bin/sh
# Generated/installed by Redline. Keep the server under the terminal's process
# tree so lifecycle hooks retain launch metadata and resolve to the right tile.
set -eu
codex_bin=$1
shift
# Remote TUI forwards model/effort/sandbox, but not its profile's developer
# instructions. Apply our generated TOML value to the server as well. This
# argv never traverses the terminal's small input buffer; do not eval it.
contract_override=$(sed -n '/^developer_instructions = /p' "${CODEX_HOME:-$HOME/.codex}/redline-plan.config.toml")
if [ -z "$contract_override" ]; then
  echo "The Redline Codex plan profile is missing. Install the integration in Redline." >&2
  exit 1
fi
socket_dir=$(mktemp -d /tmp/rlcx.XXXXXXXX)
export REDLINE_CODEX_SOCKET="$socket_dir/server.sock"
"$codex_bin" app-server -c "$contract_override" -c 'sandbox_mode="read-only"' -c 'approval_policy="never"' --listen "unix://$REDLINE_CODEX_SOCKET" >"$socket_dir/server.log" 2>&1 &
server_pid=$!
cleanup() {
  kill "$server_pid" 2>/dev/null || :
  wait "$server_pid" 2>/dev/null || :
  rm -f "$REDLINE_CODEX_SOCKET" "$socket_dir/server.log"
  rmdir "$socket_dir" 2>/dev/null || :
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
tries=0
while [ ! -S "$REDLINE_CODEX_SOCKET" ]; do
  tries=$((tries + 1))
  if ! kill -0 "$server_pid" 2>/dev/null || [ "$tries" -ge 160 ]; then
    cat "$socket_dir/server.log" >&2
    echo "Redline could not start the Codex plan server. Retry the launch." >&2
    exit 1
  fi
  sleep 0.05
done
"$codex_bin" --remote "unix://$REDLINE_CODEX_SOCKET" "$@"
