# Install RCC public alpha

This guide installs the Telegram-first public alpha: one trusted operator, one Mac, one private Telegram bot, and local Codex execution. It is for the operator who sets up RCC on their own Mac.

## Requirements

- macOS.
- Codex app or Codex CLI installed and signed in locally.
- Node.js with `node:sqlite` support.
- `npm` on PATH.
- Telegram account.
- Private Telegram bot token from BotFather.

Check Node:

```bash
node -v
npm -v
node -e "import('node:sqlite').then(() => console.log('node:sqlite available'))"
```

If `node:sqlite` fails, install a newer Node.js runtime before starting RCC.

## Guided setup (recommended)

Run the installer in Terminal. It needs git and Node 22.5 or newer:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/PATELOM925/Remote-Codex-Control-Public/main/install.sh)"
```

The installer clones RCC into `~/Remote-Codex-Control` (set `RCC_DIR` to use another folder), runs `npm ci`, and starts the setup. It is safe to run again. If you already have a clone, run the setup from that folder:

```bash
cd Remote-Codex-Control-Public
npm ci
npm run setup
```

The setup asks for three things:

- The bot token. It comes from @BotFather, and the setup shows the steps. The token does not show on screen as you type it.
- Your Telegram chat. Send your new bot any message, such as `/start`. The setup shows who sent it and asks you to confirm that the chat is yours. It accepts only a private chat.
- The project folder the agent may work in. The default is the folder you ran the setup from. You can add more than one.

When it finishes, it writes `setup.md` with owner-only permissions (600). If `setup.md` already exists, the setup asks before it replaces the file. The old file is kept as `setup.md.bak-<timestamp>`.

The setup also checks for the Codex CLI. If Codex is missing, it still continues, but Codex must be installed and signed in before real use.

Then go to [Run RCC](#run-rcc).

To check the setup without writing anything, run it with `--dry-run`. For a script, use `--yes --chat-id <id> --project <path>` and set the token in `RCC_SETUP_BOT_TOKEN`. Run `npm run setup -- --help` for all options.

## Manual setup (alternative)

Use this path if you want to fill in `setup.md` yourself.

### Install dependencies

```bash
git clone https://github.com/PATELOM925/Remote-Codex-Control-Public.git
cd Remote-Codex-Control-Public
npm ci
npm run verify:quick
```

## Create a Telegram bot

Telegram's official bot docs describe BotFather as the bot-management path for creating and managing bots. In Telegram:

1. Open the verified `@BotFather` chat.
2. Send `/newbot`.
3. Choose a display name and username.
4. Copy the token BotFather gives you.
5. Treat the token like a password.

RCC uses Telegram long polling. Telegram's Bot API documents `getUpdates` as the long-polling method, and it will not work while a webhook is set for the same bot. If you previously configured a webhook for this bot, delete it before using RCC.

References:

- [Telegram Bot Features: BotFather](https://core.telegram.org/bots/features#botfather)
- [Telegram Bot API: getUpdates](https://core.telegram.org/bots/api#getupdates)

## Create `setup.md` by hand

Skip this section if `npm run setup` already wrote `setup.md`.

```bash
cp setup.example.md setup.md
```

Edit `setup.md`:

```bash
RCC_TELEGRAM_BOT_TOKEN=replace_with_botfather_token
RCC_OPERATOR_CHAT_ID=replace_with_your_numeric_chat_id
RCC_ALLOWED_CHAT_IDS=replace_with_your_numeric_chat_id
RCC_TELEGRAM_TRANSPORT=long_polling
RCC_PROJECT_ROOTS=/absolute/path/to/your/project
```

To find your chat ID:

1. Send `/start` to your new bot from your Telegram account.
2. Run:

```bash
./scripts/telegram_chat_ids.sh 30
```

Use the numeric ID it prints for `RCC_OPERATOR_CHAT_ID` and `RCC_ALLOWED_CHAT_IDS`.

For every config value, read [docs/SETUP_REFERENCE.md](./docs/SETUP_REFERENCE.md).

## Start Codex locally

Open Codex on the Mac and confirm it can see the projects/threads you want to supervise. RCC connects through Codex App Server, usually with:

```bash
codex app-server --listen stdio://
```

`./run.sh` tries to find `codex` on PATH and falls back to the Codex app bundle path if available.

## Run RCC

```bash
./run.sh
```

`./run.sh` will:

- validate `setup.md`;
- reject placeholder tokens/chat IDs;
- back up valid `setup.md` to `.dist/setup.backup.md`;
- keep the local status server localhost-only;
- find the Codex CLI;
- run `npm install` if needed;
- start the daemon.

RCC skips Telegram messages that arrived while it was stopped. Send the command again after you start RCC. To change this, see `RCC_TELEGRAM_DROP_PENDING_UPDATES_ON_START` in [docs/SETUP_REFERENCE.md](./docs/SETUP_REFERENCE.md).

## Verify from Telegram

Send these to your bot:

```text
/status
/projects
/threads 10
/pick 1
/where
/last
/approvals
```

Expected:

- `/status` says daemon alive.
- Telegram commands are installed or retrying with a clear error.
- Codex transport is connected or gives a clear disconnected reason.
- `/threads` lists Codex threads visible to RCC.
- `/pick` selects one thread for focused live updates.

## Optional: keep RCC running

Use a per-user LaunchAgent when you want RCC to restart after crashes and resist idle sleep while the Mac is awake and on power:

```bash
./scripts/install-launchd.sh
```

Remove it with:

```bash
./scripts/uninstall-launchd.sh
```

This does not bypass MacBook lid-close sleep. Closed-lid MacBook use requires Apple-supported closed-display mode: power, external display, and external keyboard/mouse or trackpad. If the Mac sleeps, RCC cannot answer Telegram or control Codex.

Read [docs/MAC_ALWAYS_ON_RUNTIME.md](./docs/MAC_ALWAYS_ON_RUNTIME.md).

## Troubleshooting

### `setup.md not found`

Run the guided setup:

```bash
npm run setup
```

Or copy the template and fill it in:

```bash
cp setup.example.md setup.md
```

### `Telegram rejected this token`

Copy the whole token from BotFather again. Run `npm run setup` to try again.

### `No confirmed message arrived`

The setup waits 120 seconds for a message. Send any message to your bot while it waits. Or type your numeric chat ID at the prompt.

### `placeholder RCC_TELEGRAM_BOT_TOKEN`

Paste the real token from BotFather. Do not include quotes.

### `placeholder RCC_OPERATOR_CHAT_ID`

Send `/start` to your bot, then run:

```bash
./scripts/telegram_chat_ids.sh 30
```

### `RCC cannot start because 127.0.0.1:4765 is already in use`

Another process holds the local status port. `./run.sh` prints the process details. If it is an old RCC daemon, stop that terminal with `Ctrl+C`. If no terminal is visible, stop the PID that `./run.sh` shows. To use another port, set `RCC_LOCAL_STATUS_PORT` in `setup.md`.

Do not run two RCC daemons against the same Telegram bot/database.

### `Unauthorized chat`

Your Telegram chat ID is not in `RCC_ALLOWED_CHAT_IDS`. Run `./scripts/telegram_chat_ids.sh 30` again and update `setup.md`.

### Codex transport disconnected

Open Codex locally, confirm it is signed in, and confirm `codex` is on PATH or installed in `/Applications/Codex.app`.

### Desktop-only approval cannot be resolved

Keep `RCC_UI_AUTOMATION_ENABLED=false` for public alpha. If an approval is desktop-only, resolve it in Codex on the Mac. UI automation fallback is prototype-only.
