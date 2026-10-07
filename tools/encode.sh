#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
  echo 'Usage: tools/encode.sh --frames DIR --out FILE [--fps 24 --start 0 --count N --audio FILE --crf 18]'
  echo '需要连续 frame-%06d.png；不填补缺帧；音频按起始帧裁切，BT.709 / yuv420p / faststart。'
  exit 0
fi
exec node "$(dirname "$0")/encode.mjs" "$@"
