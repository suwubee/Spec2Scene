#!/usr/bin/env bash
set -euo pipefail
# Keep the command bounded; downloads and Blender output remain in the selected
# ignored project directory.  The Node implementation performs path and SHA
# checks before any rename.
exec timeout 1800s node "$(dirname "$0")/fetch-character-assets.mjs" "$@"
