# Public Alpha Scope

## Public Promise

RCC lets one trusted operator supervise local Codex from Telegram while execution, credentials, files, approvals, and state stay on the Mac.

## Working Alpha

- Telegram long polling.
- Strict chat allowlist.
- Local Codex App Server bridge.
- Local SQLite state.
- Thread discovery and selection.
- Run, steer, interrupt.
- Approval list/approve/deny.
- Thread-scoped Telegram attachments.
- Explicit artifact listing and sending.
- Reasoning Summary only when App Server exposes it.

## Prototype Only

- Web console.
- Hosted relay.
- Desktop UI approval automation.
- Telegram Git commit/push workflows.

## Roadmap Only

- Multi-user/RBAC.
- Cloud execution.
- Native mobile apps.
- Non-Codex backends.
- Full transcript mirroring for all threads.

## Release Gate

```bash
npm run verify:quick
npm run secrets:check
git status --short
```

Manual Telegram smoke:

```text
/status
/projects
/threads 10
/pick 1
/where
/last
/approvals
```
