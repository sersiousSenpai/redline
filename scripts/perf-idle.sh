#!/bin/bash
# Sample Redline's WebKit GPU and renderer processes while the app sits idle,
# and report the numbers that found the 2026-10-09 paint storm
# (docs/perf-budget.md "Responsiveness"):
#
#   - the GPU process's CPU, and the share of its rendering threads' samples
#     spent in WebCore::Gradient::paint (repainting a gradient every frame);
#   - how much of the renderer's layer-commit queue
#     (RemoteLayerTreeDrawingArea.CommitQueue) is spent waiting on the GPU
#     process in flushAndCollectHandles — every keystroke's frame commits
#     behind that backlog;
#   - each process's physical footprint;
#   - the responsiveness probe's own numbers from GET /v1/perf, if it is on,
#     and the renderer footprint Redline reads for itself (`renderer`).
#
# The probe can stay on: its frame sampler runs only while you interact.
# Touch nothing for a few seconds before and while it samples.
#
# Usage: scripts/perf-idle.sh [--seconds N] [--app NAME] [--port P] [--keep]
#                             [--gpu PID] [--renderer PID]
#   --app       whose WebKit processes to sample (default Redline; any WebKit
#               app works, e.g. --app Safari, to check the recipe itself)
#   --gpu, --renderer   skip discovery and sample these pids
#   --keep      keep the raw `sample` reports and print where they are
set -euo pipefail

SECONDS_TO_SAMPLE=3
APP=Redline
PORT=7676
KEEP=0
GPU=""
RENDERER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --seconds) SECONDS_TO_SAMPLE=$2; shift 2 ;;
    --app) APP=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --gpu) GPU=$2; shift 2 ;;
    --renderer) RENDERER=$2; shift 2 ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

# WebKit's helper processes are launchd's children, not the app's, so `ps`
# can't tie them to it. LaunchServices can: each one checks in under the
# app's name ("Redline Web Content", "Redline Graphics and Media").
display_name() { lsappinfo info -app "$1" 2>/dev/null | head -1 | sed -n 's/^"\(.*\)" ASN.*/\1/p'; }
find_helpers() { # <WebKit service suffix> <display-name suffix>
  local pid name lower_app
  lower_app=$(printf '%s' "$APP" | tr '[:upper:]' '[:lower:]')
  for pid in $(pgrep -f "com.apple.WebKit.$1.xpc/" || true); do
    name=$(display_name "$pid" | tr '[:upper:]' '[:lower:]')
    case "$name" in "$lower_app $2"*) echo "$pid" ;; esac
  done
}
# Oldest first: the app's own webview starts with it; browser tabs come later.
# No pids prints nothing and succeeds, so `set -e` leaves the report below to
# say what's missing.
oldest() { [ $# -gt 0 ] || return 0; ps -o etime=,pid= -p "$(IFS=,; echo "$*")" | awk '
  { n = split($1, a, /[-:]/); s = 0; m = 1
    for (i = n; i >= 1; i--) { s += a[i] * m; m = (i == n || i == n - 1) ? m * 60 : (i == n - 2 ? m * 24 : m) }
    if (s > best) { best = s; pid = $2 } }
  END { print pid }'; }

if [ -z "$GPU" ]; then GPU=$(oldest $(find_helpers GPU "graphics and media")); fi
RENDERERS=$(find_helpers WebContent "web content" | tr '\n' ' ')
if [ -z "$RENDERER" ]; then RENDERER=$(oldest $RENDERERS); fi
if [ -z "$GPU" ] || [ -z "$RENDERER" ]; then
  echo "✗ no running $APP WebKit processes found (gpu='${GPU}' renderer='${RENDERER}')." >&2
  echo "  Is $APP open? Pass --gpu/--renderer pids to skip discovery." >&2
  exit 1
fi

TMP=${TMPDIR:-/tmp}
OUT=$(mktemp -d "${TMP%/}/redline-perf-idle.XXXXXX")
cpu_seconds() { ps -o time= -p "$1" | awk '{ n = split($1, a, ":"); s = 0; for (i = 1; i <= n; i++) s = s * 60 + a[i]; print s }'; }

OTHERS=$(echo "$RENDERERS" | tr ' ' '\n' | awk -v r="$RENDERER" 'NF && $0 != r' | xargs)
echo "Sampling $APP for ${SECONDS_TO_SAMPLE}s — GPU pid $GPU, renderer pid $RENDERER${OTHERS:+ (other renderers, e.g. browser tabs: $OTHERS)}"
g0=$(cpu_seconds "$GPU"); r0=$(cpu_seconds "$RENDERER"); t0=$(date +%s.%N)
sample "$GPU" "$SECONDS_TO_SAMPLE" -mayDie -file "$OUT/gpu.txt" >/dev/null 2>&1 &
sample "$RENDERER" "$SECONDS_TO_SAMPLE" -mayDie -file "$OUT/renderer.txt" >/dev/null 2>&1 &
wait
g1=$(cpu_seconds "$GPU"); r1=$(cpu_seconds "$RENDERER"); t1=$(date +%s.%N)
pct() { awk -v a="$1" -v b="$2" -v s="$t0" -v e="$t1" 'BEGIN { printf "%.1f%%", 100 * (b - a) / (e - s) }'; }

# Per thread of a `sample` call graph: its sample count, and how many of
# those sit under a frame matching PATTERN (outermost match only, so
# recursion isn't counted twice). Prints "samples<TAB>matched<TAB>thread".
share() { # <report> <frame pattern>
  awk -v pat="$2" '
    /^Call graph:/ { on = 1; next }
    on && /^Total number in stack/ { flush(); on = 0 }
    function flush() { if (name != "") printf "%d\t%d\t%s\n", total, hit, name; name = "" }
    on && /^    [0-9]+ Thread_/ {
      flush(); total = $1; hit = 0; at = -1
      name = $0; sub(/^ +[0-9]+ /, "", name); gsub(/  +/, " ", name); next
    }
    on && match($0, /[0-9]+ /) {
      depth = RSTART; count = substr($0, RSTART, RLENGTH - 1) + 0
      if (at >= 0 && depth <= at) at = -1
      if (at < 0 && index($0, pat) > 0) { hit += count; at = depth }
    }' "$1"
}
# The worst thread matching THREAD PATTERN (a pool, like the GPU process's
# rendering queues, reports its busiest member), then the whole process.
report() { # <report> <thread pattern> <frame pattern> <label>
  share "$1" "$3" | awk -F'\t' -v tp="$2" -v label="$4" '
    $3 ~ tp {
      n++; r = $1 ? $2 / $1 : 0
      if (n == 1 || r > best) { best = r; samples = $1; thread = $3 }
    }
    { all += $1; hits += $2 }
    END {
      if (n) printf "    %-32s %5.1f%% of %d samples  (%s%s)\n", label, 100 * best, samples, substr(thread, 1, 60), (n > 1 ? sprintf("; worst of %d", n) : "")
      else printf "    %-32s no such thread in this sample (idle, or not WebKit)\n", label
      printf "    %-32s %5.1f%% of all %d samples\n", "  …across the process", (all ? 100 * hits / all : 0), all
    }'
}
footprint_of() { sed -n 's/^Physical footprint: *//p' "$1" | head -1; }

echo
echo "GPU process ($(display_name "$GPU"), pid $GPU)"
printf "    %-32s %6s   footprint %s\n" "CPU" "$(pct "$g0" "$g1")" "$(footprint_of "$OUT/gpu.txt")"
report "$OUT/gpu.txt" "RemoteRenderingBackend" "Gradient::paint" "Gradient::paint"
echo
echo "Renderer ($(display_name "$RENDERER"), pid $RENDERER)"
printf "    %-32s %6s   footprint %s\n" "CPU" "$(pct "$r0" "$r1")" "$(footprint_of "$OUT/renderer.txt")"
report "$OUT/renderer.txt" "CommitQueue" "flushAndCollectHandles" "commit queue waiting on GPU"
report "$OUT/renderer.txt" "com.apple.main-thread" "Gradient::paint" "main thread in Gradient::paint"

echo
echo "Responsiveness probe (GET :$PORT/v1/perf, last ${SECONDS_TO_SAMPLE}s)"
WINDOW_MS=$(( SECONDS_TO_SAMPLE * 1000 ))
if PROBE=$(curl -s --max-time 4 "http://127.0.0.1:$PORT/v1/perf?windowMs=$WINDOW_MS"); then
  if command -v jq >/dev/null 2>&1; then
    echo "$PROBE" | jq -c 'if .running then {renderer} + (.snapshot | {input: .input.all, frames: (.frames | del(.histogram)), histogram: [.frames.histogram[] | "\(.upToMs // "more"):\(.n)"]}) else . end'
  else
    echo "    $PROBE"
  fi
else
  echo "    (no daemon on :$PORT)"
fi

if [ "$KEEP" = 1 ]; then echo; echo "Raw reports: $OUT"; else rm -rf "$OUT"; fi
