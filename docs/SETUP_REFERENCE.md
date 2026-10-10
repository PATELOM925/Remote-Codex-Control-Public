# Setup reference

This page explains the keys in `setup.md`. It is for operators who set up RCC by hand or want to change a default. The guided setup writes the required keys for you.

`setup.md` is a local file that `./run.sh` loads. It holds your bot token and machine-specific settings. Never commit it.

To create it with the guided setup:

```bash
npm run setup
```

To write it by hand, start from the template:

```bash
cp setup.example.md setup.md
```

## Required values

### `RCC_TELEGRAM_BOT_TOKEN`

The bot token from Telegram BotFather.

To get it:

1. Open Telegram and chat with the verified `@BotFather`.
2. Send `/newbot` and follow the prompts.
3. Copy the token that BotFather returns.

RCC uses the token to call the Telegram Bot API, for example `getUpdates`, `sendMessage`, `sendDocument`, and the command menu.

Treat the token like a password. If it leaks, revoke it in BotFather at once.

### `RCC_OPERATOR_CHAT_ID`

The numeric Telegram chat ID of the operator.

To find it:

1. Put the bot token in `setup.md`.
2. Send `/start` to your bot.
3. Run:

```bash
./scripts/telegram_chat_ids.sh 30
```

RCC uses this ID as the trusted operator.

### `RCC_ALLOWED_CHAT_IDS`

A comma-separated list of chat IDs that may send commands.

```bash
RCC_ALLOWED_CHAT_IDS=123456789
```

RCC rejects commands from any chat that is not on this list. Keep the list to one private chat ID for the public alpha.

### `RCC_TELEGRAM_TRANSPORT`

```bash
RCC_TELEGRAM_TRANSPORT=long_polling
```

The public alpha uses Telegram long polling. RCC does not need a public webhook URL.

## Project folders

### `RCC_PROJECT_ROOTS`

Optional. A comma-separated list of folders that the agent may work in. RCC registers each folder as a project at startup. A folder that is already registered is not added again. A path that is not a folder is skipped, with a warning in the terminal.

```bash
RCC_PROJECT_ROOTS=/absolute/path/to/app-one,/absolute/path/to/app-two
```

`npm run setup` writes this key. A path cannot contain a comma.

When this key is set, RCC does not discover other projects from Codex threads. To discover them as well, also set `RCC_PROJECT_AUTODISCOVER_LIMIT`.

## Recommended safety defaults

### `RCC_STRICT_SECURITY_DEFAULTS`

```bash
RCC_STRICT_SECURITY_DEFAULTS=true
```

RCC fails closed when the operator configuration is missing or unsafe.

### `RCC_APPROVAL_STRATEGY`

```bash
RCC_APPROVAL_STRATEGY=appserver_then_ui
```

RCC prefers App Server approval resolution. `appserver_only` turns off the desktop fallback. Desktop-recovered approvals then need a decision in the Codex desktop app.

### `RCC_UI_AUTOMATION_ENABLED`

```bash
RCC_UI_AUTOMATION_ENABLED=false
```

The desktop fallback needs an unlocked Mac, Accessibility permission, and a visible Codex approval card. It is a prototype. Keep it off for the public alpha, and resolve desktop-only approvals in Codex on the Mac.

### `RCC_UI_AUTOMATION_PROVIDER`

```bash
RCC_UI_AUTOMATION_PROVIDER=applescript
```

The only provider name is `applescript`. It has no effect while `RCC_UI_AUTOMATION_ENABLED=false`.

## Codex connection

### `RCC_CODEX_CONNECTION_MODE`

```bash
RCC_CODEX_CONNECTION_MODE=stdio
```

RCC starts the Codex App Server over stdio. The other modes, `websocket` and `mock`, are for development. The mock mode is what `npm run demo` uses.

Do not set `RCC_CODEX_CONNECTION_COMMAND` in `setup.md`. `./run.sh` finds the Codex binary and sets that value itself. Your value is ignored when you start RCC with `./run.sh`.

## Local state paths

### `RCC_DB_PATH`

```bash
RCC_DB_PATH=.dist/rcc.sqlite
```

The SQLite database for RCC state. It holds thread metadata, approvals, events, and references to attachments and artifacts. Do not commit it.

### `RCC_UPLOADS_ROOT`

```bash
RCC_UPLOADS_ROOT=.dist/uploads
```

The folder for files uploaded from Telegram. Each thread has its own subfolder.

### `RCC_ARTIFACTS_ROOT`

```bash
RCC_ARTIFACTS_ROOT=.dist/artifacts
```

The folder that `/artifact` reads. Each thread has its own subfolder.

## Local status page

### `RCC_LOCAL_STATUS_ENABLED`

```bash
RCC_LOCAL_STATUS_ENABLED=true
```

Turns on the local status page on the Mac. The page shows health, threads, approvals, and events. With web control off, the page is read-only.

### `RCC_LOCAL_STATUS_HOST`

```bash
RCC_LOCAL_STATUS_HOST=127.0.0.1
```

Keep this on localhost. RCC refuses to start when the host is anything other than `127.0.0.1`, `::1`, or `localhost`.

### `RCC_LOCAL_STATUS_PORT`

```bash
RCC_LOCAL_STATUS_PORT=4765
```

If the port is in use, `./run.sh` stops with a message that names the process that holds it. Stop the old RCC process, or choose another port.

## Optional limits

### `RCC_TELEGRAM_SEND_LIMIT`

```bash
RCC_TELEGRAM_SEND_LIMIT=52428800
```

The largest file, in bytes, that RCC tries to send to Telegram. The default is 50 MiB. Larger files fall back to a zip, a manifest, or a local path.

### `RCC_TELEGRAM_DOWNLOAD_LIMIT`

```bash
RCC_TELEGRAM_DOWNLOAD_LIMIT=20971520
```

The largest file, in bytes, that RCC accepts from a Telegram upload. The default is 20 MiB.

## Other keys

These keys have defaults that work for most operators. Keys that only tests and smoke checks use are not listed.

| Key | Default | What it does |
| --- | --- | --- |
| `RCC_TELEGRAM_DROP_PENDING_UPDATES_ON_START` | `true` | Skips Telegram messages that arrived while RCC was stopped. Set to `false` to process them on start. |
| `RCC_TELEGRAM_HTTP_TIMEOUT_MS` | `30000` | Timeout for each Telegram Bot API request. |
| `RCC_PROJECT_AUTODISCOVER_LIMIT` | `3` | How many projects RCC discovers from Codex threads. Discovery is off when `RCC_PROJECT_ROOTS` is set, unless this key is also set. |
| `RCC_CODEX_CONNECTION_URL` | `ws://127.0.0.1:4500` | The WebSocket address, used only when `RCC_CODEX_CONNECTION_MODE=websocket`. |
| `RCC_EVENT_FRESHNESS_MS` | `90000` | The age after which `/status` treats the event stream as stale. |
| `RCC_DESKTOP_APPROVAL_STALE_MS` | `86400000` (24 hours) | The age after which RCC expires a pending desktop-recovered approval. |
| `RCC_HEALTH_SNAPSHOT_INTERVAL_MS` | `30000` | How often RCC writes a health snapshot to SQLite. |
| `RCC_WAL_AUTOCHECKPOINT_PAGES` | `1000` | The SQLite WAL auto-checkpoint size, in pages. |
| `RCC_WAL_CHECKPOINT_INTERVAL_MS` | `60000` | How often RCC runs a WAL checkpoint. |
| `RCC_WAL_GROWTH_ALERT_BYTES` | `134217728` (128 MiB) | The WAL size that triggers a health alert. |
| `RCC_REASONING_SUMMARY_ENABLED` | `true` | Turns on `/thinking`, which shows the App Server Reasoning Summary. |
| `RCC_REASONING_PERSIST_SUMMARY` | `true` | Saves Reasoning Summary text to SQLite, after masking. |
| `RCC_REASONING_TEXT_DELTA_ENABLED` | `false` | Experimental. Passes reasoning text deltas from the App Server through. Keep it off for the public alpha. |
| `RCC_REASONING_PERSIST_TEXT_DELTA` | `false` | Experimental. Saves reasoning text deltas to SQLite. Keep it off for the public alpha. |
| `RCC_ARTIFACT_EXTERNAL_BASE_URL` | unset | Base URL for an external link to an artifact that is too large for Telegram. |
| `RCC_LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, or `error`. |
| `RCC_DNS_ORDER` | `ipv4first` | Set to `verbatim` to keep the system DNS order. |
| `RCC_CODEX_BIN` | auto | The Codex binary that RCC uses when it builds the App Server command. `CODEX_BIN` also works. |
| `RCC_DISABLE_CAFFEINATE` | `false` | Set to `true` to start the LaunchAgent without `caffeinate`. See [MAC_ALWAYS_ON_RUNTIME.md](./MAC_ALWAYS_ON_RUNTIME.md). |
| `RCC_LAUNCHD_LABEL` | `com.remote-codex-control.daemon` | The label for the LaunchAgent that the install script creates. |

## Experimental values not used in public setup

Keep these disabled for the Telegram-first public alpha:

```bash
RCC_WEB_CONTROL_ENABLED=false
RCC_RELAY_ENABLED=false
```

### `RCC_WEB_CONTROL_ENABLED`, `RCC_WEB_AUTH_TOKEN`, `RCC_WEB_ALLOWED_ORIGINS`

When web control is on, the local status server also accepts commands from the web console. It requires `RCC_WEB_AUTH_TOKEN`, a private token of your own. `RCC_WEB_ALLOWED_ORIGINS` lists the browser origins that may call that API. It is empty by default.

### `RCC_RELAY_ENABLED`, `RCC_RELAY_BASE_URL`, `RCC_RELAY_MAC_ID`, `RCC_RELAY_MAC_TOKEN`

If you turn on the relay, set `RCC_RELAY_BASE_URL` to your own relay URL. It has no default. It must start with `https://`. `http://127.0.0.1` and `http://localhost` are allowed for local tests. If the URL is missing or is not HTTPS, the relay stays off. RCC logs `relay-disabled`, and Telegram keeps working.

`RCC_RELAY_MAC_TOKEN` is required when the relay is on. `RCC_RELAY_MAC_ID` names this Mac to the relay. The default is `default-mac`.

Do not share your relay URL or any token with other people.

`RCC_RELAY_POLL_INTERVAL_MS` defaults to `15000` and `RCC_RELAY_SNAPSHOT_INTERVAL_MS` to `60000`. These values keep a small hosted relay within a free plan's request limits.
