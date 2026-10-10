#!/usr/bin/env bash
# Lists the chat ids that have messaged the bot whose token is in setup.md. Needs curl and python3.
# The optional argument is the long-poll timeout in seconds.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SETUP_FILE="${ROOT_DIR}/setup.md"

if [[ ! -f "$SETUP_FILE" ]]; then
  echo "setup.md not found at ${SETUP_FILE}" >&2
  exit 1
fi

get_val() {
  local key="$1"
  local line
  line=$(grep -E "^${key}=" "$SETUP_FILE" 2>/dev/null | head -n 1 | tr -d '\r' || true)
  if [[ -z "$line" ]]; then
    echo ""
    return
  fi
  echo "${line#${key}=}" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'
}

TOKEN="$(get_val "RCC_TELEGRAM_BOT_TOKEN")"
if [[ -z "$TOKEN" || "$TOKEN" == replace_with_* ]]; then
  echo "setup.md is missing a real RCC_TELEGRAM_BOT_TOKEN" >&2
  exit 1
fi

TIMEOUT_SEC="${1:-30}"
if ! [[ "$TIMEOUT_SEC" =~ ^[0-9]+$ ]]; then
  echo "Usage: $0 [timeout_seconds]" >&2
  exit 1
fi

# getUpdates long-polls for up to the timeout. Send the bot a message while this runs so its chat id is returned.
payload="$(curl -sS "https://api.telegram.org/bot${TOKEN}/getUpdates?limit=50&timeout=${TIMEOUT_SEC}" || true)"

python3 - <<'PY' "$payload"
import json, sys

raw = sys.argv[1] if len(sys.argv) > 1 else ""
if not raw.strip():
  print("No response from Telegram. Check network/VPN and try again.")
  raise SystemExit(0)

try:
  data = json.loads(raw)
except Exception as e:
  print("Failed to parse Telegram response:", e)
  raise SystemExit(0)

res = data.get("result") or []
rows = []
seen = set()

def add_chat(chat):
  if not isinstance(chat, dict):
    return
  cid = chat.get("id")
  if cid is None:
    return
  key = str(cid)
  if key in seen:
    return
  seen.add(key)
  title = chat.get("title") or chat.get("username") or ""
  ctype = chat.get("type") or ""
  rows.append((key, ctype, title))

for u in res:
  msg = u.get("message") or {}
  add_chat(msg.get("chat") or {})
  cq = u.get("callback_query") or {}
  add_chat((cq.get("message") or {}).get("chat") or {})

if not rows:
  print("No pending updates found.")
  print("Send a message to your bot (e.g. /start) and rerun this script.")
  raise SystemExit(0)

print("Discovered chat ids (use the numeric id for RCC_OPERATOR_CHAT_ID):")
for cid, ctype, title in rows:
  suffix = f" | {ctype}" if ctype else ""
  if title:
    suffix += f" | {title}"
  print(f"- {cid}{suffix}")

if len(rows) == 1:
  cid = rows[0][0]
  print("")
  print("Suggested setup.md values:")
  print(f"RCC_OPERATOR_CHAT_ID={cid}")
  print(f"RCC_ALLOWED_CHAT_IDS={cid}")
PY

