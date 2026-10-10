#!/usr/bin/env bash
# Creates the operator and Mac relay tokens, writes a local handoff file, and applies the Mac
# settings to setup.md. Needs an https relay URL (--base-url or RCC_RELAY_BASE_URL).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BASE_URL="${RCC_RELAY_BASE_URL:-}"
MAC_ID="${RCC_RELAY_MAC_ID:-$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-' || true)}"
MAC_ID="${MAC_ID:-macbook-air}"
CONFIGURE_VERCEL=false
DEPLOY_VERCEL=false

usage() {
  cat <<'EOF'
Usage:
  ./scripts/setup_relay_quickstart.sh [--configure-vercel] [--deploy] [--base-url URL] [--mac-id ID]

What this does:
  1. Generates a private operator token for the web page.
  2. Generates a private Mac relay token for the daemon.
  3. Writes a local-only handoff file under .dist/backups/.
  4. Applies Mac-side relay settings into setup.md.
  5. Copies the operator token to the clipboard when pbcopy exists.

Options:
  --configure-vercel  Also set Vercel production env for RCC_RELAY_OPERATOR_TOKEN,
                      RCC_RELAY_MAC_TOKEN, and RCC_RELAY_ALLOWED_ORIGINS.
  --deploy            After --configure-vercel, deploy production with `vercel --prod --yes`.
  --base-url URL      Your relay URL. Required, must start with https://. No default.
  --mac-id ID         Stable local Mac id. Default: hostname slug.

Notes:
  - setup.md must already contain Telegram bot credentials.
  - Never commit setup.md or .dist/backups.
  - If you are not the Vercel project owner, skip --configure-vercel and use your own deployed relay.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --configure-vercel)
      CONFIGURE_VERCEL=true
      ;;
    --deploy)
      DEPLOY_VERCEL=true
      ;;
    --base-url=*)
      BASE_URL="${arg#*=}"
      ;;
    --mac-id=*)
      MAC_ID="${arg#*=}"
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "$DEPLOY_VERCEL" == true && "$CONFIGURE_VERCEL" != true ]]; then
  echo "--deploy requires --configure-vercel." >&2
  exit 1
fi

if [[ -z "$BASE_URL" ]]; then
  echo "Missing relay URL. Set RCC_RELAY_BASE_URL or pass --base-url https://your-relay.example.com" >&2
  exit 1
fi
if [[ "$BASE_URL" != https://* ]]; then
  echo "The relay URL must start with https://. Set RCC_RELAY_BASE_URL or pass --base-url with an https URL." >&2
  exit 1
fi

generate_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return
  fi
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
}

# The value goes through a 0600 temp file, so it does not appear in the process list.
set_vercel_env() {
  local key="$1"
  local value="$2"
  local tmp
  tmp="$(mktemp)"
  chmod 600 "$tmp"
  printf '%s' "$value" > "$tmp"
  npx --no-install vercel env rm "$key" production --yes >/dev/null 2>&1 || true
  npx --no-install vercel env add "$key" production < "$tmp" >/dev/null
  rm -f "$tmp"
}

mkdir -p .dist/backups
# Token files are readable by the current user only.
umask 077

OPERATOR_TOKEN="${RCC_RELAY_OPERATOR_TOKEN:-$(generate_token)}"
MAC_TOKEN="${RCC_RELAY_MAC_TOKEN:-$(generate_token)}"
STAMP="$(date +%Y%m%d-%H%M%S)"
HANDOFF_FILE=".dist/backups/relay-token-handoff-${STAMP}.txt"
OPERATOR_TOKEN_FILE=".dist/backups/relay-operator-token-${STAMP}.txt"

cat > "$HANDOFF_FILE" <<EOF
RCC relay token handoff
Created: $(date -u +%Y-%m-%dT%H:%M:%SZ)
Relay base URL: $BASE_URL

Web console:
RCC_RELAY_OPERATOR_TOKEN=$OPERATOR_TOKEN

Mac setup.md:
RCC_RELAY_ENABLED=true
RCC_RELAY_BASE_URL=$BASE_URL
RCC_RELAY_MAC_ID=$MAC_ID
RCC_RELAY_MAC_TOKEN=$MAC_TOKEN
RCC_RELAY_POLL_INTERVAL_MS=15000
RCC_RELAY_SNAPSHOT_INTERVAL_MS=60000
EOF

printf '%s\n' "$OPERATOR_TOKEN" > "$OPERATOR_TOKEN_FILE"

./scripts/apply_relay_handoff.sh "$HANDOFF_FILE" >/dev/null

COPIED="no"
if command -v pbcopy >/dev/null 2>&1; then
  pbcopy < "$OPERATOR_TOKEN_FILE"
  COPIED="yes"
fi

if [[ "$CONFIGURE_VERCEL" == true ]]; then
  if [[ ! -f .vercel/project.json ]]; then
    echo 'Missing .vercel/project.json. Run `npx vercel link` first or skip --configure-vercel.' >&2
    exit 1
  fi
  if ! command -v npx >/dev/null 2>&1; then
    echo "npx is required to configure Vercel env." >&2
    exit 1
  fi

  echo "Configuring Vercel production relay env..."
  set_vercel_env RCC_RELAY_OPERATOR_TOKEN "$OPERATOR_TOKEN"
  set_vercel_env RCC_RELAY_MAC_TOKEN "$MAC_TOKEN"
  set_vercel_env RCC_RELAY_ALLOWED_ORIGINS "$BASE_URL"

  if [[ "$DEPLOY_VERCEL" == true ]]; then
    echo "Deploying Vercel production relay..."
    npx --no-install vercel --prod --yes
  else
    echo "Vercel env updated. Redeploy with: npx --no-install vercel --prod --yes"
  fi
fi

cat <<EOF
Relay quick setup complete.

Mac settings applied:
  setup.md

Operator token saved locally:
  $OPERATOR_TOKEN_FILE

Operator token copied to clipboard:
  $COPIED

Start RCC on the Mac:
  ./run.sh

Open on your phone:
  $BASE_URL/?mode=relay#connect

Paste the operator token from your clipboard, or reveal it locally with:
  cat "$OPERATOR_TOKEN_FILE"

Keep the Mac awake, online, signed into Codex, and running RCC.
EOF
