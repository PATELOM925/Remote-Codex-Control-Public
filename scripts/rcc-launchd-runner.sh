#!/usr/bin/env bash
# Starts ./run.sh for launchd. Wraps it in caffeinate unless RCC_DISABLE_CAFFEINATE=true.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# launchd starts with a minimal PATH. Keep this explicit so Node/npm/Codex app
# installs found by normal Terminal sessions are also visible to the daemon.
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Applications/Codex.app/Contents/Resources:${PATH:-}"

mkdir -p .dist/logs

if [[ ! -x ./run.sh ]]; then
  echo "run.sh is missing or not executable at $ROOT_DIR/run.sh" >&2
  exit 1
fi

if [[ ! -f setup.md ]]; then
  echo "setup.md is missing. Run RCC setup before installing the LaunchAgent." >&2
  exit 1
fi

if [[ "${RCC_DISABLE_CAFFEINATE:-false}" == "true" ]]; then
  exec ./run.sh
fi

if [[ ! -x /usr/bin/caffeinate ]]; then
  echo "caffeinate not found; starting RCC without sleep assertion." >&2
  exec ./run.sh
fi

# -i prevents idle system sleep, -m prevents disk idle sleep, -s requests system
# sleep prevention on AC power. Lid-close sleep still follows macOS policy.
exec /usr/bin/caffeinate -i -m -s ./run.sh
