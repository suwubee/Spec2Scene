#!/usr/bin/env bash
set -uo pipefail
if [[ "${1:-}" == --help ]]; then
  echo 'Usage: scripts/doctor.sh [--help]'
  echo '只读检查 Node>=20、Python3、FFmpeg、Playwright/Chromium 与可选智能体 CLI。核心缺失返回非零。'
  exit 0
fi
[[ $# == 0 ]] || { echo 'Unknown argument' >&2; exit 2; }
cd "$(dirname "$0")/.."
failed=0
for scene_cmd in node npm python3 ffmpeg ffprobe; do
  if command -v "$scene_cmd" >/dev/null; then echo "PASS $scene_cmd available"; else echo "FAIL $scene_cmd missing"; failed=1; fi
done
if command -v node >/dev/null; then
  node --input-type=module -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1); console.log("PASS Node " + process.versions.node)' || failed=1
  node --input-type=module -e 'import {chromium} from "playwright"; import {access} from "node:fs/promises"; await access(process.env.SCENE_CHROMIUM || chromium.executablePath()); console.log("PASS Playwright Chromium installed")' 2>/dev/null || { echo 'OPTIONAL Playwright/Chromium absent: npm ci; npx playwright install chromium'; }
fi
for scene_cmd in codex claude rubberband; do
  if command -v "$scene_cmd" >/dev/null; then echo "PASS optional $scene_cmd available"; else echo "OPTIONAL $scene_cmd absent"; fi
done
printf '%s\n' 'INFO Python analysis dependencies: install tools/music/requirements.txt in a project virtual environment' 'INFO No services started or system configuration changed'
exit "$failed"
