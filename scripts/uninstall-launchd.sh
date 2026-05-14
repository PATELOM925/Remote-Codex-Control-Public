#!/usr/bin/env bash
set -euo pipefail

LABEL="${RCC_LAUNCHD_LABEL:-com.remote-codex-control.daemon}"
DRY_RUN=false

usage() {
  cat <<USAGE
Usage: ./scripts/uninstall-launchd.sh [--dry-run] [--label LABEL]

Stops and removes the per-user RCC LaunchAgent installed by scripts/install-launchd.sh.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --label) LABEL="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$LABEL" ]]; then
  echo "LaunchAgent label cannot be empty." >&2
  exit 2
fi

TARGET_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "Would stop LaunchAgent: gui/$(id -u)/$LABEL"
  echo "Would remove plist: $TARGET_PLIST"
  exit 0
fi

launchctl bootout "gui/$(id -u)" "$TARGET_PLIST" >/dev/null 2>&1 || true
rm -f "$TARGET_PLIST"

echo "Removed RCC LaunchAgent: $LABEL"
