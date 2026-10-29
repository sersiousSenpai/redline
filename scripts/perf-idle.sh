#!/bin/bash
# Sample Redline while it sits idle — its WebKit GPU and renderer processes and
# the host (the app's own process) — and report the numbers that found the
# 2026-10-09 paint storm and the 2026-10-27 idle heat (docs/perf-budget.md
# "Responsiveness" and "Idle heat"):
#
#   - per process: CPU over the window, idle wakeups per second (top's idlew
#     delta) and physical footprint;
#   - the GPU process's share of rendering-thread samples in
#     WebCore::Gradient::paint (repainting a gradient every frame);
#   - how much of the renderer's layer-commit queue
#     (RemoteLayerTreeDrawingArea.CommitQueue) waits on the GPU process in
#     flushAndCollectHandles — every keystroke's frame commits behind it;
#   - the host's display link: how often its CVDisplayLink thread is awake. A
#     still window parks it; an animation that WebKit cannot composite keeps
#     it ticking every vsync;
#   - the idle-heat flags, per process: LegacyRenderSVG* (an <svg> painted on
#     the main thread every frame — a rotating SVG spinner),
#     setAnimatedPropertiesInStyle (CSS animations resolved per frame),
#     paintBoxShadow, IOWorkLoop (GPU submission), posix_spawn (a fork per
#     poll);
#   - child processes the host spawned during the window (lsof/ps polls);
#   - the responsiveness probe's own numbers from GET /v1/perf, if it is on,
#     and the renderer footprint Redline reads for itself (`renderer`);
#   - the terminal helper (`redline-ptyd`, the process that owns the
#     terminals so they outlive the app), discovered like the host: its CPU,
#     wakeups, footprint and the children it spawned in the window. With the
#     app quit, `--helper-only` samples it alone.
#
# The probe can stay on: its frame sampler runs only while you interact.
# Touch nothing for a few seconds before and while it samples. Twelve seconds
# is a good idle window; the default three is enough for a smoke check.
#
# Usage: scripts/perf-idle.sh [--seconds N] [--app NAME] [--port P] [--keep]
#                             [--gpu PID] [--renderer PID] [--host PID]
#                             [--helper PID] [--helper-only]
#   --app       whose processes to sample (default Redline; any WebKit app
#               works, e.g. --app Safari, to check the recipe itself). The
#               dev binary is `redline`, the bundle `Redline`; both match.
#   --gpu, --renderer, --host, --helper   skip discovery and sample these pids
#   --helper-only   sample only the terminal helper (the app may be quit)
#   --keep      keep the raw `sample` and `top` reports and print where they are
set -euo pipefail

SECONDS_TO_SAMPLE=3
APP=Redline
PORT=7676
KEEP=0
GPU=""
RENDERER=""
HOST_PID=""
HELPER_PID=""
HELPER_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --seconds) SECONDS_TO_SAMPLE=$2; shift 2 ;;
    --app) APP=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --gpu) GPU=$2; shift 2 ;;
    --renderer) RENDERER=$2; shift 2 ;;
    --host) HOST_PID=$2; shift 2 ;;
    --helper) HELPER_PID=$2; shift 2 ;;
    --helper-only) HELPER_ONLY=1; shift ;;
    -h|--help) sed -n '2,44p' "$0"; exit 0 ;;
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

# The terminal helper is launchd's child too (it double-forks out of the
# app's session), so it is found by name: the oldest, should two builds' be up.
if [ -z "$HELPER_PID" ]; then HELPER_PID=$(oldest $(pgrep -x redline-ptyd || true)); fi

TMP=${TMPDIR:-/tmp}

if [ "$HELPER_ONLY" = 1 ]; then
  if [ -z "$HELPER_PID" ]; then
    echo "✗ no redline-ptyd running (pass --helper PID)." >&2
    exit 1
  fi
  OUT=$(mktemp -d "${TMP%/}/redline-perf-idle.XXXXXX")
  echo "Sampling the terminal helper alone for ${SECONDS_TO_SAMPLE}s — pid $HELPER_PID ($(pgrep -P "$HELPER_PID" | wc -l | tr -d ' ') children)"
  top -l 2 -s "$SECONDS_TO_SAMPLE" -stats pid,idlew,cpu -pid "$HELPER_PID" > "$OUT/top.txt" 2>/dev/null &
  sample "$HELPER_PID" "$SECONDS_TO_SAMPLE" -mayDie -file "$OUT/helper.txt" >/dev/null 2>&1 &
  BEFORE=" $(pgrep -P "$HELPER_PID" | tr '\n' ' ') "
  NEW=0
  END=$(( $(date +%s) + SECONDS_TO_SAMPLE ))
  while [ "$(date +%s)" -lt "$END" ]; do
    for c in $(pgrep -P "$HELPER_PID" || true); do
      case "$BEFORE" in *" $c "*) ;; *) NEW=$((NEW + 1)); BEFORE="$BEFORE$c " ;; esac
    done
    sleep 0.2
  done
  wait
  awk -v secs="$SECONDS_TO_SAMPLE" -v pid="$HELPER_PID" '
    /^PID/ { block++; next }
    block > 0 && $1 == pid { w[block] = $2; c[block] = $3 }
    END { printf "%-44s %7s%% %12.1f   %s\n", "terminal helper (pid " pid ")", c[2], (w[2] - w[1]) / secs, "" }' "$OUT/top.txt"
  printf "    %-32s %s\n" "footprint" "$(sed -n 's/^Physical footprint: *//p' "$OUT/helper.txt" | head -1)"
  printf "    %-32s %d new child process(es) in %ss\n" "spawned children" "$NEW" "$SECONDS_TO_SAMPLE"
  if [ "$KEEP" = 1 ]; then echo "Raw reports: $OUT"; else rm -rf "$OUT"; fi
  exit 0
fi

if [ -z "$GPU" ]; then GPU=$(oldest $(find_helpers GPU "graphics and media")); fi
RENDERERS=$(find_helpers WebContent "web content" | tr '\n' ' ')
if [ -z "$RENDERER" ]; then RENDERER=$(oldest $RENDERERS); fi
# The host is the app itself: the process named after it (`redline` from
# `tauri dev`, `Redline` from the bundle). The oldest one, should a second
# instance be up.
if [ -z "$HOST_PID" ]; then HOST_PID=$(oldest $(pgrep -xi "$APP" || true)); fi
if [ -z "$GPU" ] || [ -z "$RENDERER" ]; then
  echo "✗ no running $APP WebKit processes found (gpu='${GPU}' renderer='${RENDERER}')." >&2
  echo "  Is $APP open? Pass --gpu/--renderer pids to skip discovery." >&2
  exit 1
fi
if [ -z "$HOST_PID" ]; then
  echo "✗ no process named $APP found for the host (pass --host PID)." >&2
  exit 1
fi

OUT=$(mktemp -d "${TMP%/}/redline-perf-idle.XXXXXX")

# Children the host spawns during the window: anything that appears under it
# and wasn't there at the start (a pty shell is; an `lsof` or `ps` per poll
# isn't). Polled every 200 ms, so a fork shorter than that can slip through —
# the posix_spawn flag below is the second witness.
spawn_watch() { # <host pid> <seconds> → count of new child pids
  local end before seen c
  end=$(( $(date +%s) + $2 ))
  before=" $(pgrep -P "$1" | tr '\n' ' ') "
  seen=" "
  while [ "$(date +%s)" -lt "$end" ]; do
    for c in $(pgrep -P "$1" || true); do
      case "$before$seen" in *" $c "*) ;; *) seen="$seen$c " ;; esac
    done
    sleep 0.2
  done
  echo "$seen" | wc -w | tr -d ' '
}

OTHERS=$(echo "$RENDERERS" | tr ' ' '\n' | awk -v r="$RENDERER" 'NF && $0 != r' | xargs)
echo "Sampling $APP for ${SECONDS_TO_SAMPLE}s — host pid $HOST_PID, GPU pid $GPU, renderer pid $RENDERER${OTHERS:+ (other renderers, e.g. browser tabs: $OTHERS)}"
# `top -l 2` prints one sample now and one after the delay; the second one's
# %CPU is the window's average and its IDLEW, minus the first's, the wakeups.
top -l 2 -s "$SECONDS_TO_SAMPLE" -stats pid,idlew,cpu -pid "$GPU" -pid "$RENDERER" -pid "$HOST_PID" ${HELPER_PID:+-pid "$HELPER_PID"} > "$OUT/top.txt" 2>/dev/null &
if [ -n "$HELPER_PID" ]; then sample "$HELPER_PID" "$SECONDS_TO_SAMPLE" -mayDie -file "$OUT/helper.txt" >/dev/null 2>&1 & fi
sample "$GPU" "$SECONDS_TO_SAMPLE" -mayDie -file "$OUT/gpu.txt" >/dev/null 2>&1 &
sample "$RENDERER" "$SECONDS_TO_SAMPLE" -mayDie -file "$OUT/renderer.txt" >/dev/null 2>&1 &
sample "$HOST_PID" "$SECONDS_TO_SAMPLE" -mayDie -file "$OUT/host.txt" >/dev/null 2>&1 &
SPAWNS=$(spawn_watch "$HOST_PID" "$SECONDS_TO_SAMPLE")
wait

# "pid<TAB>wakeups/s<TAB>cpu%" per process, from top's two samples.
top_rows() {
  awk -v secs="$SECONDS_TO_SAMPLE" '
    /^PID/ { block++; next }
    block > 0 && $1 ~ /^[0-9]+$/ { idlew[block, $1] = $2; cpu[block, $1] = $3; pids[$1] = 1 }
    END {
      for (p in pids) if ((2, p) in idlew)
        printf "%s\t%.0f\t%s\n", p, (idlew[2, p] - idlew[1, p]) / secs, cpu[2, p]
    }' "$OUT/top.txt"
}
top_field() { # <pid> <2=wakeups|3=cpu>
  top_rows | awk -F'\t' -v p="$1" -v f="$2" '$1 == p { print $f; found = 1 } END { if (!found) print "?" }'
}

# Per thread of a `sample` call graph: its sample count, and how many of
# those sit under a frame matching PATTERN (outermost match only, so
# recursion isn't counted twice). Prints "samples<TAB>matched<TAB>thread".
share() { # <report> <frame pattern (substring)>
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
# Same, with PATTERN an extended regex matched against the whole frame line.
share_re() { # <report> <frame regex>
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
      if (at < 0 && $0 ~ pat) { hit += count; at = depth }
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
# The idle-heat flags: each pattern's share of the whole process's samples.
# `sample` records every thread at every tick, parked or not, so a share is
# "of all thread-ticks"; what matters is zero versus not.
FLAGS="LegacyRenderSVG setAnimatedPropertiesInStyle paintBoxShadow IOWorkLoop posix_spawn"
flags() { # <report>
  local pat
  for pat in $FLAGS; do
    share "$1" "$pat" | awk -F'\t' -v label="$pat" '
      { all += $1; hits += $2 }
      END { printf "    %-32s %6d samples  (%.2f%% of %d)%s\n", label, hits, (all ? 100 * hits / all : 0), all, (hits ? "  ◀" : "") }'
  done
}
# A thread's awake share: its ticks not sitting in a wait syscall. For the
# host's CVDisplayLink thread this is the display link firing.
WAIT_RE='mach_msg2_trap|__psynch_cvwait|__ulock_wait|semaphore_wait_trap|__workq_kernreturn|kevent|__semwait_signal|__select|poll'
awake() { # <report> <thread pattern> <label>
  share_re "$1" "$WAIT_RE" | awk -F'\t' -v tp="$2" -v label="$3" -v secs="$SECONDS_TO_SAMPLE" '
    $3 ~ tp { n++; total += $1; awake += $1 - $2 }
    END {
      if (!n) { printf "    %-32s no such thread in this sample\n", label; exit }
      per = awake / secs
      printf "    %-32s awake %d of %d ticks  (%.0f/s%s) → %s\n", label, awake, total, per, (n > 1 ? sprintf(", %d threads", n) : ""), (per >= 5 ? "FIRING" : "parked")
    }'
}
footprint_of() { sed -n 's/^Physical footprint: *//p' "$1" | head -1; }

echo
printf "%-44s %8s %12s   %s\n" "Process" "CPU" "wakeups/s" "footprint"
printf "%-44s %7s%% %12s   %s\n" "host ($(display_name "$HOST_PID" | cut -c1-30), pid $HOST_PID)" "$(top_field "$HOST_PID" 3)" "$(top_field "$HOST_PID" 2)" "$(footprint_of "$OUT/host.txt")"
printf "%-44s %7s%% %12s   %s\n" "GPU process (pid $GPU)" "$(top_field "$GPU" 3)" "$(top_field "$GPU" 2)" "$(footprint_of "$OUT/gpu.txt")"
printf "%-44s %7s%% %12s   %s\n" "renderer (pid $RENDERER)" "$(top_field "$RENDERER" 3)" "$(top_field "$RENDERER" 2)" "$(footprint_of "$OUT/renderer.txt")"
if [ -n "$HELPER_PID" ]; then
  printf "%-44s %7s%% %12s   %s\n" "terminal helper (pid $HELPER_PID)" "$(top_field "$HELPER_PID" 3)" "$(top_field "$HELPER_PID" 2)" "$(footprint_of "$OUT/helper.txt")"
fi

echo
echo "Host"
awake "$OUT/host.txt" "CVDisplayLink" "display link"
printf "    %-32s %d new child process(es) in %ss  (%.0f/min)\n" "spawned children" "$SPAWNS" "$SECONDS_TO_SAMPLE" "$(awk -v n="$SPAWNS" -v s="$SECONDS_TO_SAMPLE" 'BEGIN { print 60 * n / s }')"
flags "$OUT/host.txt"

echo
echo "GPU process"
report "$OUT/gpu.txt" "RemoteRenderingBackend" "Gradient::paint" "Gradient::paint"
flags "$OUT/gpu.txt"

echo
echo "Renderer"
report "$OUT/renderer.txt" "CommitQueue" "flushAndCollectHandles" "commit queue waiting on GPU"
report "$OUT/renderer.txt" "com.apple.main-thread" "Gradient::paint" "main thread in Gradient::paint"
awake "$OUT/renderer.txt" "com.apple.main-thread" "main thread"
flags "$OUT/renderer.txt"

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
