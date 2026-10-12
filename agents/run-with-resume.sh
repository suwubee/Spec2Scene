#!/usr/bin/env bash
# run-with-resume.sh — provider-agnostic resume loop for one agent session.
# Runs a launch command; when the attempt's log tail matches a transient provider error (overload, 5xx, quota,
# reconnect exhausted), it kills orphaned servers on the given ports by PID, waits, optionally probes the provider,
# and relaunches with a "resume from breakpoint" note prefixed to the prompt. The session itself resumes from its
# own file state (LOG / CHECKPOINT); this wrapper never edits project files.
set -uo pipefail

usage() {
  cat <<'EOF'
Usage: agents/run-with-resume.sh --prompt FILE --log-dir DIR [options] -- LAUNCH_CMD [ARG ...]

Runs LAUNCH_CMD with the prompt on stdin (and {prompt_file} in any ARG replaced by the attempt's prompt path).
Each attempt writes DIR/attempt-N.log (stdout+stderr) and DIR/prompt-N.md; DIR/attempts.tsv records the result.

Options
  --prompt FILE          original task prompt (required)
  --log-dir DIR          attempt logs and prompts (required; created)
  --pattern REGEX        transient provider error (extended regex, case-insensitive); repeatable
  --patterns-file FILE   one regex per line (# comments allowed)
                         default when none given: overloaded|\b50[234]\b|rate.?limit|usage limit|quota|Reconnecting\.\.\.|temporarily unavailable
  --watch FILE           another log the launcher writes (e.g. its own stderr log); its tail is matched too when it
                         was modified during the attempt; repeatable
  --tail N               only the last N log lines are matched (default 200) so task output quoting "503" earlier is ignored
  --retry-after SECONDS  wait between attempts (default 600)
  --max-attempts N       total attempts (default 12)
  --probe CMD            run with bash -c before each retry; non-zero exit = provider still down (that attempt is spent waiting)
  --ports P1,P2          ports this session was assigned; listeners left on them are killed by PID between attempts
  --resume-note TEXT     replaces the default note prefixed to the prompt from attempt 2 on
  -h, --help             this help

Exit: 0 the session finished; the launcher's own code when it failed without a transient marker (not retried);
      75 attempts exhausted; 2 usage error.
Environment for the launcher: RESUME_ATTEMPT (1-based), RESUME_PROMPT_FILE, RESUME_LOG_FILE.
Never kills by name: only PIDs found listening on --ports, never this wrapper or its parent.
EOF
}

prompt='' log_dir='' tail_n=200 retry_after=600 max_attempts=12 probe='' ports='' note=''
patterns=() watch=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --prompt) prompt=${2:-}; shift 2 ;;
    --log-dir) log_dir=${2:-}; shift 2 ;;
    --pattern) patterns+=("${2:-}"); shift 2 ;;
    --patterns-file)
      [[ -r "${2:-}" ]] || { echo "patterns file not readable: ${2:-}" >&2; exit 2; }
      while IFS= read -r line || [[ -n "$line" ]]; do [[ -z "$line" || "$line" == \#* ]] || patterns+=("$line"); done < "$2"
      shift 2 ;;
    --watch) watch+=("${2:-}"); shift 2 ;;
    --tail) tail_n=${2:-}; shift 2 ;;
    --retry-after) retry_after=${2:-}; shift 2 ;;
    --max-attempts) max_attempts=${2:-}; shift 2 ;;
    --probe) probe=${2:-}; shift 2 ;;
    --ports) ports=${2:-}; shift 2 ;;
    --resume-note) note=${2:-}; shift 2 ;;
    --) shift; break ;;
    *) echo "unknown option: $1 (use --help)" >&2; exit 2 ;;
  esac
done
[[ $# -ge 1 ]] || { echo 'missing -- LAUNCH_CMD (use --help)' >&2; exit 2; }
[[ -n "$prompt" && -s "$prompt" ]] || { echo 'missing or empty --prompt FILE' >&2; exit 2; }
[[ -n "$log_dir" ]] || { echo 'missing --log-dir DIR' >&2; exit 2; }
for n in "$tail_n" "$retry_after" "$max_attempts"; do [[ "$n" =~ ^[0-9]+$ ]] || { echo "not a non-negative integer: $n" >&2; exit 2; }; done
[[ "$max_attempts" -ge 1 && "$tail_n" -ge 1 ]] || { echo '--max-attempts and --tail must be >= 1' >&2; exit 2; }
if [[ -n "$ports" ]]; then
  IFS=, read -r -a port_list <<< "$ports"
  for p in "${port_list[@]}"; do [[ "$p" =~ ^[0-9]+$ && "$p" -ge 1 && "$p" -le 65535 ]] || { echo "bad port: $p" >&2; exit 2; }; done
else port_list=(); fi
[[ ${#patterns[@]} -gt 0 ]] || patterns=('overloaded|\b50[234]\b|rate.?limit|usage limit|quota|Reconnecting\.\.\.|temporarily unavailable')
joined=$(IFS='|'; echo "${patterns[*]}")
printf '' | grep -Eiq -- "$joined" 2>/dev/null; [[ $? -le 1 ]] || { echo "invalid pattern: $joined" >&2; exit 2; }
[[ -n "$note" ]] || note='断点续跑 / Resume from breakpoint: the previous attempt was cut off by a provider error (overload, 5xx or quota), not by a task failure. Before doing anything else, read your own LOG / CHECKPOINT and the files you already wrote, state the last completed step, and continue from the next one. Do not redo finished steps, do not reset or revert files, and restart any server you need on your assigned port.'

mkdir -p "$log_dir" || exit 2
log_dir=$(cd "$log_dir" && pwd)
launch=("$@")
status_file="$log_dir/attempts.tsv"
printf 'attempt\tresult\texit\tstarted\tended\n' > "$status_file"

kill_orphans() {   # by PID only, for listeners on our own ports
  local p pid
  for p in "${port_list[@]}"; do
    for pid in $(ss -ltnpH "sport = :$p" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
      [[ "$pid" == "$$" || "$pid" == "$PPID" ]] && continue
      echo "[resume] port $p: killing orphaned PID $pid" >&2
      kill -TERM "$pid" 2>/dev/null || continue
      for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
      kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null
    done
  done
  return 0
}

child=''
trap '[[ -n "$child" ]] && kill -TERM "$child" 2>/dev/null; kill_orphans; exit 130' INT TERM

for ((attempt = 1; attempt <= max_attempts; attempt++)); do
  if [[ $attempt -gt 1 && -n "$probe" ]] && ! bash -c "$probe" >> "$log_dir/probe.log" 2>&1; then
    echo "[resume] attempt $attempt: probe failed, provider still unavailable; waiting ${retry_after}s" >&2
    printf '%s\tprobe-failed\t-\t%s\t%s\n' "$attempt" "$(date -u +%FT%TZ)" "$(date -u +%FT%TZ)" >> "$status_file"
    [[ $attempt -lt $max_attempts ]] && sleep "$retry_after"
    continue
  fi
  prompt_file="$log_dir/prompt-$attempt.md"
  log_file="$log_dir/attempt-$attempt.log"
  if [[ $attempt -eq 1 ]]; then cp "$prompt" "$prompt_file"
  else { printf '%s\n(attempt %d of %d)\n\n---\n\n' "$note" "$attempt" "$max_attempts"; cat "$prompt"; } > "$prompt_file"; fi
  args=()
  for a in "${launch[@]}"; do args+=("${a//\{prompt_file\}/$prompt_file}"); done
  started=$(date -u +%FT%TZ)
  before=()
  for w in ${watch[@]+"${watch[@]}"}; do before+=("$(stat -c '%y %s %i' "$w" 2>/dev/null || echo absent)"); done
  RESUME_ATTEMPT=$attempt RESUME_PROMPT_FILE=$prompt_file RESUME_LOG_FILE=$log_file "${args[@]}" < "$prompt_file" > "$log_file" 2>&1 &
  child=$!
  wait "$child"; code=$?
  child=''
  ended=$(date -u +%FT%TZ)
  transient=0
  tail -n "$tail_n" "$log_file" | grep -Eiq -- "$joined" && transient=1
  for i in "${!watch[@]}"; do   # only logs written during this attempt; a stale file from an earlier attempt is ignored
    w=${watch[$i]}
    [[ -f "$w" && "$(stat -c '%y %s %i' "$w" 2>/dev/null)" != "${before[$i]}" ]] && tail -n "$tail_n" "$w" | grep -Eiq -- "$joined" && transient=1
  done
  if [[ $transient -eq 1 ]]; then
    printf '%s\ttransient\t%s\t%s\t%s\n' "$attempt" "$code" "$started" "$ended" >> "$status_file"
    echo "[resume] attempt $attempt: transient provider error (exit $code); see $log_file" >&2
    kill_orphans
    [[ $attempt -lt $max_attempts ]] && { echo "[resume] retry in ${retry_after}s" >&2; sleep "$retry_after"; }
    continue
  fi
  if [[ $code -eq 0 ]]; then
    printf '%s\tdone\t0\t%s\t%s\n' "$attempt" "$started" "$ended" >> "$status_file"
    echo "[resume] attempt $attempt finished" >&2
    exit 0
  fi
  printf '%s\tfailed\t%s\t%s\t%s\n' "$attempt" "$code" "$started" "$ended" >> "$status_file"
  echo "[resume] attempt $attempt failed with exit $code and no transient marker; not retrying" >&2
  exit "$code"
done
echo "[resume] gave up after $max_attempts attempts" >&2
kill_orphans
exit 75
