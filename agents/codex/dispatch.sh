#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == --help ]]; then
  echo 'Usage: agents/codex/dispatch.sh PROJECT PROMPT_FILE LOG_DIR [CONTACT_SHEET.png ...]'
  echo '示例：后台启动 codex exec，保存 PID/日志并等待；运行前确认任务范围。'
  echo '可选附图：导演审过的上一轮联系表，以 --image 附在提示上（一轮一会话）。'
  exit 0
fi
[[ $# -ge 3 ]] || { echo 'Use --help' >&2; exit 2; }
scene_project=$(realpath "$1")
scene_prompt=$(realpath "$2")
mkdir -p "$3"
scene_logs=$(realpath "$3")
shift 3
scene_images=()
for scene_image in "$@"; do
  [[ -s "$scene_image" ]] || { echo "contact sheet missing or empty: $scene_image" >&2; exit 2; }
  scene_images+=(--image "$(realpath "$scene_image")")
done
codex exec --sandbox workspace-write -C "$scene_project" ${scene_images[@]+"${scene_images[@]}"} --json -o "$scene_logs/final.md" - < "$scene_prompt" > "$scene_logs/events.jsonl" 2> "$scene_logs/stderr.log" &
scene_pid=$!
printf '%s\n' "$scene_pid" > "$scene_logs/process.pid"
trap 'kill "$scene_pid" 2>/dev/null || true' INT TERM
set +e
wait "$scene_pid"
scene_status=$?
set -e
printf '%s\n' "$scene_status" > "$scene_logs/exit-code.txt"
exit "$scene_status"
