#!/usr/bin/env bash
# Installs the RCC LaunchAgent for the current user and starts it. Needs macOS, setup.md,
# and the plist template in launchd/.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="${RCC_LAUNCHD_LABEL:-com.remote-codex-control.daemon}"
DRY_RUN=false
NO_BOOTSTRAP=false
PLIST_OUTPUT=""

usage() {
  cat <<USAGE
Usage: ./scripts/install-launchd.sh [--dry-run] [--no-bootstrap] [--label LABEL] [--plist-output PATH]

Installs a per-user macOS LaunchAgent that starts RCC through scripts/rcc-launchd-runner.sh.
The runner wraps ./run.sh with /usr/bin/caffeinate -i -m -s so RCC resists idle sleep while on AC power.

This does not bypass MacBook lid-close sleep. Lid-closed operation requires Apple-supported closed-display mode.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --no-bootstrap) NO_BOOTSTRAP=true; shift ;;
    --label) LABEL="${2:-}"; shift 2 ;;
    --plist-output) PLIST_OUTPUT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$LABEL" ]]; then
  echo "LaunchAgent label cannot be empty." >&2
  exit 2
fi

RUNNER_PATH="$ROOT_DIR/scripts/rcc-launchd-runner.sh"
TEMPLATE="$ROOT_DIR/launchd/com.remote-codex-control.daemon.plist.template"
LOG_DIR="$ROOT_DIR/.dist/logs"
GENERATED_DIR="$ROOT_DIR/.dist/launchd"
TARGET_DIR="$HOME/Library/LaunchAgents"
TARGET_PLIST="$TARGET_DIR/$LABEL.plist"
GENERATED_PLIST="${PLIST_OUTPUT:-$GENERATED_DIR/$LABEL.plist}"

if [[ ! -f "$TEMPLATE" ]]; then
  echo "Missing LaunchAgent template: $TEMPLATE" >&2
  exit 1
fi
if [[ ! -x "$RUNNER_PATH" ]]; then
  echo "Runner is missing or not executable: $RUNNER_PATH" >&2
  exit 1
fi
if [[ "$DRY_RUN" != "true" && ! -f "$ROOT_DIR/setup.md" ]]; then
  echo "setup.md is missing. Configure RCC locally before installing LaunchAgent." >&2
  exit 1
fi

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

mkdir -p "$LOG_DIR" "$(dirname "$GENERATED_PLIST")"

label_xml="$(xml_escape "$LABEL")"
root_xml="$(xml_escape "$ROOT_DIR")"
runner_xml="$(xml_escape "$RUNNER_PATH")"
out_xml="$(xml_escape "$LOG_DIR/launchd.out.log")"
err_xml="$(xml_escape "$LOG_DIR/launchd.err.log")"

# Fill the plist template placeholders with the XML-escaped values.
sed \
  -e "s#__LABEL__#$label_xml#g" \
  -e "s#__ROOT_DIR__#$root_xml#g" \
  -e "s#__RUNNER_PATH__#$runner_xml#g" \
  -e "s#__STDOUT_PATH__#$out_xml#g" \
  -e "s#__STDERR_PATH__#$err_xml#g" \
  "$TEMPLATE" > "$GENERATED_PLIST"

if command -v plutil >/dev/null 2>&1; then
  plutil -lint "$GENERATED_PLIST" >/dev/null
fi

if [[ "$DRY_RUN" == "true" ]]; then
  echo "Dry run complete. Generated plist: $GENERATED_PLIST"
  echo "No LaunchAgent was installed or bootstrapped."
  exit 0
fi

mkdir -p "$TARGET_DIR"
cp "$GENERATED_PLIST" "$TARGET_PLIST"

if [[ "$NO_BOOTSTRAP" == "true" ]]; then
  echo "Installed LaunchAgent plist without bootstrapping: $TARGET_PLIST"
  echo "Start later with: launchctl bootstrap gui/$(id -u) '$TARGET_PLIST'"
  exit 0
fi

# Remove any agent with this label before bootstrapping the new one.
launchctl bootout "gui/$(id -u)" "$TARGET_PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$TARGET_PLIST"
launchctl enable "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
launchctl kickstart -k "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true

cat <<DONE
Installed and started RCC LaunchAgent.
Label: $LABEL
Plist: $TARGET_PLIST
Logs:
  $LOG_DIR/launchd.out.log
  $LOG_DIR/launchd.err.log

RCC still needs the Mac awake/online. Lid-closed MacBook use requires Apple-supported closed-display mode.
DONE
