#!/bin/bash
# Double-click this to start watching the drop folder. Close the window to stop.
cd "$(dirname "$0")/.." || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
exec node tools/proxy.mjs --watch
