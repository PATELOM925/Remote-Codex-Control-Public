# Setup Reference

`setup.md` is a local-only environment file loaded by `./run.sh`. It contains secrets and machine-specific settings. Do not commit it.

The easiest way to create it is the guided setup:

```bash
npm run setup
```

To write it by hand, start from the template:

```bash
cp setup.example.md setup.md
```

## Required Values

### `RCC_TELEGRAM_BOT_TOKEN`

Private token from Telegram BotFather.

How to get it:

1. Open Telegram.
2. Chat with verified `@BotFather`.
3. Send `/newbot`.
4. Copy the token returned by BotFather.

Why RCC needs it: RCC uses this token to call Telegram Bot API methods such as `getUpdates`, `sendMessage`, `sendDocument`, and command registration.

Security: treat it like a password. If leaked, revoke or rotate it in BotFather immediately.

### `RCC_OPERATOR_CHAT_ID`

Numeric Telegram chat ID for the primary operator.

How to get it:

1. Put your bot token in `setup.md`.
2. Send `/start` to your bot.
3. Run:

```bash
./scripts/telegram_chat_ids.sh 30
```

Why RCC needs it: RCC uses this as the default trusted operator identity.

### `RCC_ALLOWED_CHAT_IDS`

Comma-separated Telegram chat allowlist.

Example:

```bash
RCC_ALLOWED_CHAT_IDS=123456789
```

Why RCC needs it: commands from any chat not in this list are rejected.

Public alpha recommendation: keep this to one private chat ID.

### `RCC_TELEGRAM_TRANSPORT`

Use:

```bash
RCC_TELEGRAM_TRANSPORT=long_polling
```

Why RCC needs it: public alpha uses Telegram long polling, so RCC does not require a public webhook URL.

## Project Folders

### `RCC_PROJECT_ROOTS`

Optional. Folders the agent may work in, separated by commas. RCC registers each folder as a project when it starts. A folder that is already registered is not added again. A path that is not a folder is skipped, with a warning in the terminal.

```bash
RCC_PROJECT_ROOTS=/Users/you/Work/app-one,/Users/you/Work/app-two
```

`npm run setup` writes this key. A path cannot contain a comma.

## Recommended Safety Defaults

### `RCC_STRICT_SECURITY_DEFAULTS`

Recommended:

```bash
RCC_STRICT_SECURITY_DEFAULTS=true
```

Why: fail closed on missing or unsafe operator configuration.

### `RCC_APPROVAL_STRATEGY`

Recommended:

```bash
RCC_APPROVAL_STRATEGY=appserver_then_ui
```

Why: prefer Codex App Server approval resolution. Desktop UI automation remains prototype-only.

### `RCC_UI_AUTOMATION_ENABLED`

Recommended:

```bash
RCC_UI_AUTOMATION_ENABLED=false
```

Why: desktop UI automation depends on an unlocked Mac, Accessibility permission, and a visible Codex approval card. Public alpha should resolve desktop-only approvals directly in Codex on the Mac.

### `RCC_UI_AUTOMATION_PROVIDER`

Default:

```bash
RCC_UI_AUTOMATION_PROVIDER=applescript
```

Why: reserved provider name for local desktop fallback experiments. It does nothing when `RCC_UI_AUTOMATION_ENABLED=false`.

## Codex Connection

### `RCC_CODEX_CONNECTION_MODE`

Recommended:

```bash
RCC_CODEX_CONNECTION_MODE=stdio
```

Why: RCC starts Codex App Server over stdio by default.

### `RCC_CODEX_CONNECTION_COMMAND`

Usually leave unset. `./run.sh` auto-detects `codex` on PATH or the Codex app bundle.

Set only if needed:

```bash
RCC_CODEX_CONNECTION_COMMAND=/absolute/path/to/codex app-server --listen stdio://
```

## Local State Paths

### `RCC_DB_PATH`

Default:

```bash
RCC_DB_PATH=.dist/rcc.sqlite
```

Local SQLite database for RCC state. It can contain thread metadata, approvals, events, attachment refs, and artifact refs. Do not commit it.

### `RCC_UPLOADS_ROOT`

Default:

```bash
RCC_UPLOADS_ROOT=.dist/uploads
```

Thread-scoped uploaded files from Telegram.

### `RCC_ARTIFACTS_ROOT`

Default:

```bash
RCC_ARTIFACTS_ROOT=.dist/artifacts
```

Thread-scoped artifact root used by `/artifact`.

## Local Status Page

### `RCC_LOCAL_STATUS_ENABLED`

Default:

```bash
RCC_LOCAL_STATUS_ENABLED=true
```

Enables a localhost-only read-only health/status page.

### `RCC_LOCAL_STATUS_HOST`

Recommended:

```bash
RCC_LOCAL_STATUS_HOST=127.0.0.1
```

Do not bind to LAN/public interfaces in public alpha.

### `RCC_LOCAL_STATUS_PORT`

Default:

```bash
RCC_LOCAL_STATUS_PORT=4765
```

If startup reports `EADDRINUSE`, another RCC daemon is probably already running.

## Optional Limits

### `RCC_TELEGRAM_SEND_LIMIT`

Default:

```bash
RCC_TELEGRAM_SEND_LIMIT=52428800
```

Maximum bytes RCC attempts to send to Telegram as a document.

### `RCC_TELEGRAM_DOWNLOAD_LIMIT`

Default:

```bash
RCC_TELEGRAM_DOWNLOAD_LIMIT=20971520
```

Maximum bytes RCC accepts from Telegram uploads.

## Experimental Values Not Used In Public Setup

Keep these disabled for the Telegram-first public alpha:

```bash
RCC_WEB_CONTROL_ENABLED=false
RCC_RELAY_ENABLED=false
```

The repository includes web/relay code for future work, but the public setup path is Telegram-only.

If you enable the relay, set `RCC_RELAY_BASE_URL` to your own relay URL. It has no default. It must start with `https://`; `http://127.0.0.1` and `http://localhost` are allowed for local tests. If it is missing or not https, the relay stays off, RCC logs `relay-disabled`, and Telegram keeps working.
