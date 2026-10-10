# Security checklist for public changes

This checklist covers what to check before you push a change that touches the public repository. It is for the maintainer and for any contributor who prepares a release.

## Local files

- `setup.md` is ignored and not staged.
- `.env` files with real values are not staged.
- `.dist/` is not staged.
- SQLite files are not staged.
- Logs and runtime screenshots are not staged.
- `test_images/` runtime captures are ignored or removed.

## Secrets

Run these commands:

```bash
npm run secrets:check
git grep -n "$HOME" -- . ':!package-lock.json' | grep -v 'git grep' || true
```

If a token appears in a public file, a screenshot, a log, or a chat transcript, revoke or rotate it.

## Telegram

- The bot token came from BotFather.
- `RCC_ALLOWED_CHAT_IDS` lists only trusted chats.
- `/status` answers.
- Messages from unauthorized chats get a reply and no action.

## Approvals

- Approval cards show the project, thread, and action.
- Expired and superseded approvals are rejected.
- The desktop UI automation fallback is off.

## Uploads and artifacts

- Uploads need a selected or named thread.
- Paths stay inside the thread's upload and artifact folders.
- Artifacts are listed first and sent only when selected.
- Large artifacts use the fallback.

## Public claims

Do not claim:

- cloud Codex execution;
- a production hosted relay;
- access to hidden reasoning;
- multi-user access or role-based permissions;
- unlimited artifact delivery.
