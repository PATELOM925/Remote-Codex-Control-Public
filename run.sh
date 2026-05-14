#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -d "$ROOT_DIR" ]]; then
  echo "RCC root not found at $ROOT_DIR" >&2
  exit 1
fi

cd "$ROOT_DIR"

mkdir -p ".dist"
BACKUP_FILE="${ROOT_DIR}/.dist/setup.backup.md"

# Guardrail: keep a recoverable copy of setup.md (gitignored) so local config
# doesn't get lost if the file is accidentally replaced/deleted.
if [[ ! -f "setup.md" ]]; then
  if [[ -f "$BACKUP_FILE" ]]; then
    cp "$BACKUP_FILE" setup.md
    echo "Restored setup.md from backup: $BACKUP_FILE" >&2
  else
    echo "setup.md not found. Create it with bot token/chat id first." >&2
    exit 1
  fi
fi

# Parse key=value from setup.md
get_val() {
  local key="$1"
  local line
  # Avoid ripgrep dependency; use grep available on macOS by default.
  line=$(grep -E "^${key}=" setup.md 2>/dev/null | head -n 1 | tr -d '\r')
  if [[ -z "$line" ]]; then
    echo "";
    return;
  fi
  # Trim leading/trailing whitespace so pasted values don't break URLs.
  echo "${line#${key}=}" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'
}

read_setup_values() {
  RCC_TELEGRAM_BOT_TOKEN=$(get_val "RCC_TELEGRAM_BOT_TOKEN")
  RCC_OPERATOR_CHAT_ID=$(get_val "RCC_OPERATOR_CHAT_ID")
  RCC_TELEGRAM_TRANSPORT=$(get_val "RCC_TELEGRAM_TRANSPORT")
  RCC_ALLOWED_CHAT_IDS=$(get_val "RCC_ALLOWED_CHAT_IDS")
  RCC_STRICT_SECURITY_DEFAULTS=$(get_val "RCC_STRICT_SECURITY_DEFAULTS")
  RCC_APPROVAL_STRATEGY=$(get_val "RCC_APPROVAL_STRATEGY")
  RCC_UI_AUTOMATION_ENABLED=$(get_val "RCC_UI_AUTOMATION_ENABLED")
  RCC_UI_AUTOMATION_PROVIDER=$(get_val "RCC_UI_AUTOMATION_PROVIDER")
  RCC_WEB_CONTROL_ENABLED=$(get_val "RCC_WEB_CONTROL_ENABLED")
  RCC_WEB_AUTH_TOKEN=$(get_val "RCC_WEB_AUTH_TOKEN")
  RCC_WEB_ALLOWED_ORIGINS=$(get_val "RCC_WEB_ALLOWED_ORIGINS")
  RCC_LOCAL_STATUS_ENABLED=$(get_val "RCC_LOCAL_STATUS_ENABLED")
  RCC_LOCAL_STATUS_HOST=$(get_val "RCC_LOCAL_STATUS_HOST")
  RCC_LOCAL_STATUS_PORT=$(get_val "RCC_LOCAL_STATUS_PORT")
  RCC_RELAY_ENABLED=$(get_val "RCC_RELAY_ENABLED")
  RCC_RELAY_BASE_URL=$(get_val "RCC_RELAY_BASE_URL")
  RCC_RELAY_MAC_ID=$(get_val "RCC_RELAY_MAC_ID")
  RCC_RELAY_MAC_TOKEN=$(get_val "RCC_RELAY_MAC_TOKEN")
  RCC_RELAY_POLL_INTERVAL_MS=$(get_val "RCC_RELAY_POLL_INTERVAL_MS")
  RCC_RELAY_SNAPSHOT_INTERVAL_MS=$(get_val "RCC_RELAY_SNAPSHOT_INTERVAL_MS")
}

read_setup_values

if [[ -z "$RCC_TELEGRAM_BOT_TOKEN" || -z "$RCC_OPERATOR_CHAT_ID" || -z "$RCC_TELEGRAM_TRANSPORT" ]]; then
  echo "Missing RCC_* values in setup.md" >&2
  exit 1
fi

looks_placeholder() {
  local v="$1"
  [[ "$v" == replace_with_* ]] || [[ "$v" == your_* ]] || [[ "$v" == "@your_"* ]]
}

# Fail fast on template values to avoid confusing Telegram 404s.
if looks_placeholder "$RCC_TELEGRAM_BOT_TOKEN"; then
  if [[ -f "$BACKUP_FILE" ]]; then
    echo "setup.md contains placeholder RCC_TELEGRAM_BOT_TOKEN; attempting restore from backup." >&2
    cp "$BACKUP_FILE" setup.md
    read_setup_values
  fi
  if looks_placeholder "$RCC_TELEGRAM_BOT_TOKEN"; then
    echo "setup.md still has a placeholder RCC_TELEGRAM_BOT_TOKEN. Paste the real bot token from BotFather." >&2
    exit 1
  fi
fi
if looks_placeholder "$RCC_OPERATOR_CHAT_ID"; then
  if [[ -f "$BACKUP_FILE" ]]; then
    echo "setup.md contains placeholder RCC_OPERATOR_CHAT_ID; attempting restore from backup." >&2
    cp "$BACKUP_FILE" setup.md
    read_setup_values
  fi
  if looks_placeholder "$RCC_OPERATOR_CHAT_ID"; then
    echo "setup.md still has a placeholder RCC_OPERATOR_CHAT_ID." >&2
    echo "" >&2
    echo "To discover your chat id:" >&2
    echo "1) Open Telegram and send /start to your bot" >&2
    echo "2) Run: ./scripts/telegram_chat_ids.sh 30" >&2
    echo "" >&2
    if [[ -x "./scripts/telegram_chat_ids.sh" ]]; then
      ./scripts/telegram_chat_ids.sh 5 || true
    fi
    exit 1
  fi
fi

if [[ -z "$RCC_ALLOWED_CHAT_IDS" ]]; then
  RCC_ALLOWED_CHAT_IDS="$RCC_OPERATOR_CHAT_ID"
fi
if [[ -z "$RCC_STRICT_SECURITY_DEFAULTS" ]]; then
  RCC_STRICT_SECURITY_DEFAULTS="true"
fi
if [[ -z "$RCC_APPROVAL_STRATEGY" ]]; then
  RCC_APPROVAL_STRATEGY="appserver_then_ui"
fi
if [[ -z "$RCC_UI_AUTOMATION_ENABLED" ]]; then
  RCC_UI_AUTOMATION_ENABLED="false"
fi
if [[ -z "$RCC_UI_AUTOMATION_PROVIDER" ]]; then
  RCC_UI_AUTOMATION_PROVIDER="applescript"
fi
if [[ -z "$RCC_WEB_CONTROL_ENABLED" ]]; then
  RCC_WEB_CONTROL_ENABLED="false"
fi
if [[ -z "$RCC_LOCAL_STATUS_ENABLED" ]]; then
  RCC_LOCAL_STATUS_ENABLED="true"
fi
if [[ -z "$RCC_LOCAL_STATUS_HOST" ]]; then
  RCC_LOCAL_STATUS_HOST="127.0.0.1"
fi
if [[ -z "$RCC_LOCAL_STATUS_PORT" ]]; then
  RCC_LOCAL_STATUS_PORT="4765"
fi
if [[ -z "$RCC_RELAY_ENABLED" ]]; then
  RCC_RELAY_ENABLED="false"
fi
if [[ -z "$RCC_RELAY_BASE_URL" ]]; then
  RCC_RELAY_BASE_URL="https://rcc-magnus-alpha.vercel.app"
fi
if [[ -z "$RCC_RELAY_MAC_ID" ]]; then
  RCC_RELAY_MAC_ID="default-mac"
fi
if [[ -z "$RCC_RELAY_POLL_INTERVAL_MS" ]]; then
  RCC_RELAY_POLL_INTERVAL_MS="2500"
fi
if [[ -z "$RCC_RELAY_SNAPSHOT_INTERVAL_MS" ]]; then
  RCC_RELAY_SNAPSHOT_INTERVAL_MS="10000"
fi

is_true() {
  local v
  v="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  [[ "$v" == "true" || "$v" == "1" || "$v" == "yes" ]]
}

if is_true "$RCC_WEB_CONTROL_ENABLED"; then
  if [[ -z "$RCC_WEB_AUTH_TOKEN" ]] || looks_placeholder "$RCC_WEB_AUTH_TOKEN"; then
    echo "RCC_WEB_CONTROL_ENABLED=true but RCC_WEB_AUTH_TOKEN is missing or placeholder." >&2
    echo "Set a long private token in setup.md before enabling web control." >&2
    exit 1
  fi
fi

if is_true "$RCC_RELAY_ENABLED"; then
  if [[ -z "$RCC_RELAY_MAC_TOKEN" ]] || looks_placeholder "$RCC_RELAY_MAC_TOKEN"; then
    echo "RCC_RELAY_ENABLED=true but RCC_RELAY_MAC_TOKEN is missing or placeholder." >&2
    echo "Run ./scripts/apply_relay_handoff.sh or paste the Mac relay token into setup.md." >&2
    exit 1
  fi
fi

export RCC_TELEGRAM_BOT_TOKEN
export RCC_OPERATOR_CHAT_ID
export RCC_TELEGRAM_TRANSPORT
export RCC_ALLOWED_CHAT_IDS
export RCC_STRICT_SECURITY_DEFAULTS
export RCC_APPROVAL_STRATEGY
export RCC_UI_AUTOMATION_ENABLED
export RCC_UI_AUTOMATION_PROVIDER
export RCC_WEB_CONTROL_ENABLED
export RCC_WEB_AUTH_TOKEN
export RCC_WEB_ALLOWED_ORIGINS
export RCC_LOCAL_STATUS_ENABLED
export RCC_LOCAL_STATUS_HOST
export RCC_LOCAL_STATUS_PORT
export RCC_RELAY_ENABLED
export RCC_RELAY_BASE_URL
export RCC_RELAY_MAC_ID
export RCC_RELAY_MAC_TOKEN
export RCC_RELAY_POLL_INTERVAL_MS
export RCC_RELAY_SNAPSHOT_INTERVAL_MS
export RCC_CODEX_CONNECTION_MODE="stdio"

# Resolve Codex CLI binary. Some installs don't place `codex` on PATH.
CODEX_BIN="$(command -v codex 2>/dev/null || true)"
if [[ -z "$CODEX_BIN" ]]; then
  if [[ -x "/Applications/Codex.app/Contents/Resources/codex" ]]; then
    CODEX_BIN="/Applications/Codex.app/Contents/Resources/codex"
  fi
fi

if [[ -z "$CODEX_BIN" ]]; then
  echo "Codex CLI not found. Install Codex app/CLI or ensure 'codex' is on PATH." >&2
  exit 1
fi

export RCC_CODEX_CONNECTION_COMMAND="${CODEX_BIN} app-server --listen stdio://"

# Update backup only after values are validated (avoid persisting placeholders).
cp setup.md "$BACKUP_FILE"

if is_true "$RCC_LOCAL_STATUS_ENABLED"; then
  if [[ "$RCC_LOCAL_STATUS_HOST" != "127.0.0.1" && "$RCC_LOCAL_STATUS_HOST" != "localhost" ]]; then
    echo "Refusing to start: RCC_LOCAL_STATUS_HOST must stay localhost-only for alpha safety." >&2
    echo "Current value: ${RCC_LOCAL_STATUS_HOST}" >&2
    exit 1
  fi
  if command -v lsof >/dev/null 2>&1; then
    PORT_OWNERS="$({ lsof -nP -iTCP:"$RCC_LOCAL_STATUS_PORT" -sTCP:LISTEN 2>/dev/null || true; } | awk 'NR>1 {print}')"
    if [[ -n "$PORT_OWNERS" ]]; then
      FIRST_PID="$(printf '%s\n' "$PORT_OWNERS" | awk 'NR==1 {print $2}')"
      echo "RCC cannot start because ${RCC_LOCAL_STATUS_HOST}:${RCC_LOCAL_STATUS_PORT} is already in use." >&2
      echo "" >&2
      echo "$PORT_OWNERS" >&2
      echo "" >&2
      echo "If this is an old RCC daemon, stop that terminal with Ctrl+C." >&2
      if [[ -n "$FIRST_PID" ]]; then
        echo "If no terminal is visible and the process is old RCC, stop it with: kill ${FIRST_PID}" >&2
      fi
      echo "" >&2
      echo "Alternative: choose another local API port by adding this to setup.md:" >&2
      echo "  RCC_LOCAL_STATUS_PORT=4875" >&2
      echo "" >&2
      echo "Telegram and Remote Relay also wait on this daemon, so resolve the port conflict before testing either channel." >&2
      exit 1
    fi
  fi
fi

npm install
npm run start
