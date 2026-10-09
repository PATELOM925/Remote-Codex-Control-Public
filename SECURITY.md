# Security Policy

RCC is safety-critical local developer tooling. It can remotely steer Codex, approve or deny actions, attach files, and send artifacts through Telegram. Treat every configuration value and output path as sensitive until proven otherwise.

## Public Alpha Threat Model

Assumptions:

- one trusted operator;
- one trusted Mac user session;
- one private Telegram bot;
- local Codex already authenticated on the Mac;
- explicitly allowlisted Telegram chat IDs;
- local state under `.dist/`.

RCC does not assume Telegram messages, uploaded files, generated artifacts, or model outputs are safe.

## Primary Risks

- Telegram bot token leakage.
- Unauthorized chat access.
- Stale approval replay.
- Desktop-only approval confusion.
- Malicious upload or path traversal.
- Artifact leakage to Telegram.
- Prompt injection through uploaded files or generated content.
- Local secret exposure in `/last`, artifacts, screenshots, or logs.
- Confused project/thread targeting.
- Unsupported claims about hidden reasoning or cloud execution.

## Required Controls

- Store `RCC_TELEGRAM_BOT_TOKEN` only in ignored local config such as `setup.md`.
- Set `RCC_OPERATOR_CHAT_ID`.
- Set `RCC_ALLOWED_CHAT_IDS` to trusted chat IDs only.
- Keep `RCC_STRICT_SECURITY_DEFAULTS=true`.
- Keep `RCC_UI_AUTOMATION_ENABLED=false` for public alpha.
- Keep `RCC_LOCAL_STATUS_HOST=127.0.0.1`.
- Keep `RCC_WEB_CONTROL_ENABLED=false` and `RCC_RELAY_ENABLED=false` unless intentionally testing experimental surfaces.
- Do not commit `.env`, `setup.md`, `.dist/`, SQLite files, logs, token backups, runtime screenshots, or generated private artifacts.

## Current Defenses

- Telegram chat allowlist rejects unauthorized chats.
- Attachments require an explicit thread target.
- Attachment paths are sanitized and confined.
- Artifacts are list-first and explicit-send.
- Artifact sends re-check path confinement.
- Approval callbacks are idempotent.
- Expired and superseded approvals are rejected.
- App Server approvals remain pending locally until Codex acknowledges resolution.
- Git push to `main` is blocked by policy.
- `Reasoning Summary` is App Server-exposed summary content only, with secret-looking value redaction before display/persistence.
- SQLite uses WAL mode and guarded startup recovery.
- Local status service refuses non-loopback host binding.

## Known Limitations

- RCC is not a remote desktop replacement.
- RCC has no multi-user RBAC in public alpha.
- Desktop UI approval automation is prototype-only and disabled by default.
- Telegram is a bearer-token integration. Leaked bot tokens must be revoked in BotFather.
- Uploaded files can contain prompt injection.
- Artifact redaction is not complete. Review sensitive files before sending.
- Reasoning-summary redaction is best-effort. Do not paste secrets into Codex/RCC.
- Web and relay code is experimental in this public branch and not covered by the Telegram-first public setup.
- Codex App Server protocol changes can break RCC; `/status` surfaces compatibility state, but drift is still possible.

## Release Checklist

Before making the repository public:

```bash
npm run verify:quick
npm run secrets:check
git grep -n "$HOME" -- . ':!package-lock.json' | grep -v 'git grep' || true
git status --short
```

Manual review required:

- no local `setup.md` values copied into docs;
- no screenshots with tokens, chat IDs, private paths, or private project names;
- no `.dist/` or SQLite files tracked;
- public docs do not claim hosted relay, cloud Codex, or hidden chain-of-thought access.

## Disclosure

This project is early-stage. If you find a security issue, do not publish exploit details first. Report it by email to `iampatelom@gmail.com` with the subject line "RCC security". Do not open a public issue for a vulnerability. Expect a reply within 7 days.
