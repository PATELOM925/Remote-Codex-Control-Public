# Remote Codex Control (RCC)

RCC is a local-first remote supervision layer for Codex running on your Mac. The public alpha lets one trusted operator use a private Telegram bot to inspect Codex threads, steer work, handle approvals, attach files to a selected thread, and retrieve explicit artifacts while execution stays on the local machine.

RCC is not a hosted coding platform, remote desktop, cloud Codex runner, or multi-user SaaS. For this public branch, Telegram is the documented operator surface. Web and relay code exists in the repository, but it is experimental and not part of the public setup path yet.

## Public Alpha Scope

Working now:

- One Mac, one trusted operator, one private Telegram bot.
- Codex execution remains local through Codex App Server.
- Telegram long polling for `/status`, `/projects`, `/threads`, `/pick`, `/run`, `/say`, `/last`, `/approvals`, `/approve`, `/deny`, `/attach`, and `/artifact` flows.
- Strict Telegram chat allowlist using `RCC_OPERATOR_CHAT_ID` and `RCC_ALLOWED_CHAT_IDS`.
- Local SQLite state under `.dist/` with WAL mode.
- Thread-scoped uploads and explicit artifact sends.
- Approval records with project/thread/action context and stale/superseded callback protection.
- Model and reasoning-effort selections for the next turn, not unsafe mid-action mutation.
- `Reasoning Summary` only when Codex App Server exposes summary events. RCC does not expose hidden chain-of-thought.

Prototype or experimental:

- Local web console in `apps/web`.
- Hosted relay in `api/relay.js` and `supabase/rcc_relay_schema.sql`.
- Desktop UI approval automation fallback.
- Git commit/push workflows from Telegram.

Roadmap:

- Multi-user/RBAC.
- Cloud execution.
- Native mobile apps.
- Non-Codex agent backends.
- Full transcript mirroring for every thread.

## Quick Install

```bash
git clone https://github.com/PATELOM925/Remote-Codex-Control.git
cd Remote-Codex-Control
npm install
npm run verify:quick
cp setup.example.md setup.md
```

Edit `setup.md` with your own Telegram bot token and chat ID, then start RCC:

```bash
./run.sh
```

Open your private Telegram bot and send:

```text
/status
/threads 10
/pick 1
/last
```

## Telegram Setup Summary

1. Create a Telegram bot with BotFather.
2. Copy the bot token into `setup.md` as `RCC_TELEGRAM_BOT_TOKEN`.
3. Send `/start` to your bot.
4. Run `./scripts/telegram_chat_ids.sh 30` to discover your numeric chat ID.
5. Put that ID in both `RCC_OPERATOR_CHAT_ID` and `RCC_ALLOWED_CHAT_IDS`.
6. Start RCC with `./run.sh`.

See [Install](./INSTALL.md) and [Setup Reference](./docs/SETUP_REFERENCE.md) for exact values and troubleshooting.

## Safety Defaults

Keep these defaults unless you know why you are changing them:

```bash
RCC_TELEGRAM_TRANSPORT=long_polling
RCC_STRICT_SECURITY_DEFAULTS=true
RCC_APPROVAL_STRATEGY=appserver_then_ui
RCC_UI_AUTOMATION_ENABLED=false
RCC_WEB_CONTROL_ENABLED=false
RCC_RELAY_ENABLED=false
```

Do not commit `setup.md`, `.env`, `.dist/`, SQLite files, logs, runtime screenshots, bot tokens, chat IDs, relay tokens, or generated private artifacts.

## Documentation

- [Install](./INSTALL.md) - local Telegram setup.
- [Quickstart](./QUICKSTART.md) - first Telegram demo run.
- [Examples](./EXAMPLES.md) - common operator flows.
- [Architecture](./ARCHITECTURE.md) - daemon, Telegram, Codex, state, and trust boundaries.
- [Architecture Diagram](./docs/ARCHITECTURE_DIAGRAM.md) - Mermaid diagrams and boundaries.
- [Telegram Bot Spec](./TELEGRAM_BOT_SPEC.md) - supported command contract.
- [Setup Reference](./docs/SETUP_REFERENCE.md) - every public `setup.md` key explained.
- [Security](./SECURITY.md) - threat model and required controls.
- [Contributing](./CONTRIBUTING.md) - contribution rules and verification.
- [Maintainer Notes](./docs/MAINTAINER_NOTES.md) - experimental web/relay code boundary.

## Verification

For docs and runtime sanity:

```bash
npm run verify:quick
npm run secrets:check
git status --short
```

For a real Telegram smoke test:

```text
/status
/projects
/threads 10
/pick 1
/where
/last
/approvals
```

## Public Claim Boundary

Use this wording publicly:

> RCC lets a trusted operator supervise local Codex from Telegram while execution, credentials, files, approvals, and state stay on the Mac.

Do not claim hosted cloud execution, raw hidden reasoning access, production relay reliability, multi-user support, or unlimited artifact delivery.
