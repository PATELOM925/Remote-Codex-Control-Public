#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

mkdir -p .dist/backups

HANDOFF_FILE="${1:-}"
if [[ -z "$HANDOFF_FILE" ]]; then
  HANDOFF_FILE="$(ls -t .dist/backups/relay-token-handoff-*.txt 2>/dev/null | head -n 1 || true)"
fi

if [[ -z "$HANDOFF_FILE" || ! -f "$HANDOFF_FILE" ]]; then
  cat >&2 <<'EOF'
No relay token handoff file found.

Fast fix:
  ./scripts/setup_relay_quickstart.sh --configure-vercel --deploy
  ./run.sh

That command generates the missing handoff file, applies Mac relay settings,
configures the Vercel relay env if you own the project, and saves the web
operator token under .dist/backups/.

This helper only applies an existing local file like:
  .dist/backups/relay-token-handoff-YYYYMMDD-HHMMSS.txt

If you are setting this up manually, add these lines to setup.md:
  RCC_RELAY_ENABLED=true
  RCC_RELAY_BASE_URL=https://<your-relay-url>
  RCC_RELAY_MAC_ID=macbook-air
  RCC_RELAY_MAC_TOKEN=<private-mac-relay-token>
  RCC_RELAY_POLL_INTERVAL_MS=15000
  RCC_RELAY_SNAPSHOT_INTERVAL_MS=60000
EOF
  exit 1
fi

restore_setup() {
  local source="${RCC_SETUP_SOURCE:-}"
  local sibling="$ROOT_DIR/../Remote-Codex-Control/setup.md"

  if [[ -n "$source" && -f "$source" ]]; then
    cp "$source" setup.md
    echo "Restored setup.md from RCC_SETUP_SOURCE."
    return 0
  fi

  if [[ -f .dist/setup.backup.md ]]; then
    cp .dist/setup.backup.md setup.md
    echo "Restored setup.md from .dist/setup.backup.md"
    return 0
  fi

  if [[ -f "$sibling" && "$sibling" != "$ROOT_DIR/setup.md" ]]; then
    cp "$sibling" setup.md
    echo "Imported setup.md from sibling live checkout."
    return 0
  fi

  return 1
}

if [[ ! -f setup.md ]]; then
  if ! restore_setup; then
    cat >&2 <<'EOF'
setup.md is missing.

Create setup.md first with your Telegram bot values, or copy your existing local setup.md into this checkout.
You can also run:
  RCC_SETUP_SOURCE=/path/to/setup.md ./scripts/apply_relay_handoff.sh

This script only applies relay settings; it does not create Telegram credentials.
EOF
    exit 1
  fi
fi

VALUES_FILE=".dist/backups/relay-values-$(date +%Y%m%d-%H%M%S).tmp"
awk '
  /^Mac setup\.md:/ { inside = 1; next }
  inside && /^$/ { exit }
  inside && /^RCC_RELAY_[A-Z0-9_]+=/{ print }
' "$HANDOFF_FILE" > "$VALUES_FILE"

if ! grep -q '^RCC_RELAY_MAC_TOKEN=' "$VALUES_FILE"; then
  echo "Relay handoff did not include a Mac setup block with RCC_RELAY_MAC_TOKEN." >&2
  exit 1
fi

if ! grep -q '^RCC_RELAY_BASE_URL=https://' "$VALUES_FILE"; then
  rm -f "$VALUES_FILE"
  echo "Relay handoff must set RCC_RELAY_BASE_URL to an https:// URL. setup.md was not changed." >&2
  exit 1
fi

SETUP_BACKUP=".dist/backups/setup-before-relay-$(date +%Y%m%d-%H%M%S).md"
cp setup.md "$SETUP_BACKUP"

apply_kv() {
  local key="$1"
  local value="$2"
  local tmp
  tmp="$(mktemp)"
  awk -v key="$key" -v value="$value" '
    BEGIN { updated = 0 }
    $0 ~ "^" key "=" {
      print key "=" value
      updated = 1
      next
    }
    { print }
    END {
      if (!updated) {
        print key "=" value
      }
    }
  ' setup.md > "$tmp"
  mv "$tmp" setup.md
}

while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  key="${line%%=*}"
  value="${line#*=}"
  apply_kv "$key" "$value"
done < "$VALUES_FILE"

rm -f "$VALUES_FILE"
cp setup.md .dist/setup.backup.md

cat <<EOF
Relay settings applied to setup.md.

Backup created:
  $SETUP_BACKUP

Next step:
  ./run.sh

No relay secrets were printed. Keep setup.md and .dist/backups local-only.
EOF
