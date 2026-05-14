# Security Alpha Checklist

Run before public push.

## Local Files

- `setup.md` is ignored and not staged.
- `.env*` with real values is not staged.
- `.dist/` is not staged.
- SQLite files are not staged.
- Logs and runtime screenshots are not staged.
- `test_images/` runtime captures are ignored or removed.

## Secrets

```bash
npm run secrets:check
git grep -n "$HOME" -- . ':!package-lock.json' | grep -v 'git grep' || true
```

Rotate any token that appears in public artifacts, screenshots, logs, or chat transcripts.

## Telegram

- Bot token came from BotFather.
- `RCC_ALLOWED_CHAT_IDS` contains only trusted chats.
- `/status` works.
- Unauthorized chats are rejected.

## Approvals

- Approval cards include project/thread/action context.
- Stale or superseded approvals are rejected.
- Desktop UI automation remains disabled for public alpha.

## Attachments And Artifacts

- Attachments require selected/explicit thread.
- Paths stay under thread-scoped roots.
- Artifacts are list-first and explicit-send.
- Large artifacts use fallback behavior.

## Public Claims

Do not claim:

- cloud Codex execution;
- production hosted relay;
- raw hidden reasoning access;
- multi-user/RBAC;
- unlimited artifact delivery.
