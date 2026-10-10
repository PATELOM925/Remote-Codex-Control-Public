# RCC local setup template
# Copy this file to setup.md, fill in your own values, and never commit setup.md.

# Required Telegram values
RCC_TELEGRAM_BOT_TOKEN=replace_with_botfather_token
RCC_OPERATOR_CHAT_ID=replace_with_your_numeric_chat_id
RCC_ALLOWED_CHAT_IDS=replace_with_your_numeric_chat_id
RCC_TELEGRAM_TRANSPORT=long_polling

# Optional. Folders the agent may work in, separated by commas.
# RCC_PROJECT_ROOTS=/absolute/path/to/your/project

# Recommended public-alpha safety defaults
RCC_STRICT_SECURITY_DEFAULTS=true
RCC_APPROVAL_STRATEGY=appserver_then_ui
RCC_UI_AUTOMATION_ENABLED=false
RCC_UI_AUTOMATION_PROVIDER=applescript

# Local Codex App Server connection
RCC_CODEX_CONNECTION_MODE=stdio
# Leave unset unless your Codex binary is not auto-detected.
# RCC_CODEX_CONNECTION_COMMAND=codex app-server --listen stdio://

# Local runtime state. These paths are gitignored.
RCC_DB_PATH=.dist/rcc.sqlite
RCC_UPLOADS_ROOT=.dist/uploads
RCC_ARTIFACTS_ROOT=.dist/artifacts

# Local read-only status page. Keep localhost-only for alpha.
RCC_LOCAL_STATUS_ENABLED=true
RCC_LOCAL_STATUS_HOST=127.0.0.1
RCC_LOCAL_STATUS_PORT=4765

# Web and hosted relay are experimental in this public branch.
RCC_WEB_CONTROL_ENABLED=false
RCC_RELAY_ENABLED=false
# Required when RCC_RELAY_ENABLED=true. Must start with https://. No default.
# RCC_RELAY_BASE_URL=

# Optional limits
RCC_TELEGRAM_SEND_LIMIT=52428800
RCC_TELEGRAM_DOWNLOAD_LIMIT=20971520
