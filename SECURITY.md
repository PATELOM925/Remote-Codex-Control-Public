# Security policy

This policy describes the security model of RCC, the controls it has, and how to report a problem. It is for operators who run RCC, for contributors who change it, and for reviewers.

RCC can steer Codex, approve or deny actions, receive files, and send artifacts through Telegram. Treat every configuration value and output path as sensitive until you have checked it.

## Scope

Public alpha assumes:

- one trusted operator;
- one trusted Mac user session;
- one private Telegram bot;
- Codex already signed in on the Mac;
- Telegram chat IDs that are explicitly allowlisted;
- local state under `.dist/`.

RCC does not treat Telegram messages, uploaded files, generated artifacts, or model output as safe. The threat model is in [docs/THREAT_MODEL.md](./docs/THREAT_MODEL.md).

## Main risks

- Leaked Telegram bot token.
- Chat access by an unauthorized user.
- Replay of a stale approval.
- Confusion about a desktop-only approval.
- Upload with a malicious filename or path traversal.
- Artifact sent to the wrong chat.
- Prompt injection through an uploaded file or generated content.
- Secrets shown in `/last`, artifacts, screenshots, or logs.
- A message sent to the wrong project or thread.
- Claims about hidden reasoning or cloud execution that the code does not support.

## Required settings

- Keep `RCC_TELEGRAM_BOT_TOKEN` in `setup.md` or another ignored local file.
- Set `RCC_OPERATOR_CHAT_ID`.
- Set `RCC_ALLOWED_CHAT_IDS` to trusted chat IDs only.
- Keep `RCC_STRICT_SECURITY_DEFAULTS=true`.
- Keep `RCC_UI_AUTOMATION_ENABLED=false` for public alpha.
- Keep `RCC_LOCAL_STATUS_HOST=127.0.0.1`.
- Keep `RCC_WEB_CONTROL_ENABLED=false` and `RCC_RELAY_ENABLED=false` unless you test an experimental surface on purpose.
- Do not commit `.env`, `setup.md`, `.dist/`, SQLite files, logs, token backups, runtime screenshots, or generated private artifacts.

## Controls in the code

Telegram and approvals:

- The chat allowlist drops messages from chats that are not on the list. The reply says the chat is unauthorized.
- Each approval card names the project, thread, turn, and action.
- Expired approvals cannot be approved or denied. Their old buttons are rejected.
- Superseded approvals cannot be approved or denied. The newer approval is named in the reply.
- Approval callbacks are idempotent. A repeated tap does not act twice.
- An App Server approval stays pending in RCC until Codex confirms the resolution.
- Git push to `main` is blocked by policy.

Files and artifacts:

- An upload needs a selected or named thread. It is stored in that thread's folder.
- Upload file names are sanitized. The saved path must stay inside the thread's upload folder.
- Artifacts are listed first. A file is sent only when you select it with `/artifact send`.
- Before an artifact is sent, RCC checks that the file is inside the thread's artifact folder.

Redaction and reasoning:

- Approval summaries and command previews have secret-looking values masked before they are shown.
- Reasoning Summary text is masked for common token shapes before it is shown or saved.
- The bot shows only the Reasoning Summary that the App Server exposes.

State and local services:

- SQLite runs in WAL mode. If the database fails to open with an I/O, lock, or database error, RCC copies the database files to a recovery folder under `.dist/` and then retries.
- The local status server refuses to start when its host is not `127.0.0.1`, `::1`, or `localhost`.

Experimental relay (off by default):

- `RCC_RELAY_BASE_URL` must start with `https://`. A loopback `http://` URL is allowed for local tests. Any other value keeps the relay off.
- The hosted relay returns 503 when its token is unset or shorter than 32 characters. It compares tokens in constant time.
- The hosted relay rejects a request body larger than 1 MiB with 413. It rejects a command message larger than 64 KiB, except for file uploads.
- The hosted relay accepts only the origins in `RCC_RELAY_ALLOWED_ORIGINS` when that list is set. If the list is not set, the relay accepts any origin outside Vercel, and it accepts only same-origin requests on Vercel.
- The hosted relay keeps its data in memory unless `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set.

## Known limits

- RCC is not a remote desktop. It has no multi-user access control.
- Desktop UI approval automation is a prototype and is off by default.
- A Telegram bot token is a bearer credential. If it leaks, revoke it in BotFather.
- Uploaded files can contain prompt injection.
- Artifact redaction is not complete. Review a file before you send it.
- Redaction of reasoning text is best effort. Do not paste secrets into Codex or RCC.
- The web console and the relay are experimental. The public setup does not use them.
- The Codex App Server protocol can change. `/status` shows whether RCC supports the App Server version it found, but a change can still break RCC.
- Telegram messages that arrive while RCC is stopped are skipped on start by default. See [docs/SETUP_REFERENCE.md](./docs/SETUP_REFERENCE.md).

## Before you push a change

Run the checks in [docs/SECURITY_ALPHA_CHECKLIST.md](./docs/SECURITY_ALPHA_CHECKLIST.md). At minimum, run:

```bash
npm run verify:quick
npm run secrets:check
git status --short
```

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Send an email to `iampatelom@gmail.com` with the subject line "RCC security". Describe the problem and the steps to reproduce it. Do not publish exploit details before the report is fixed. The maintainer aims to reply within 7 days.
