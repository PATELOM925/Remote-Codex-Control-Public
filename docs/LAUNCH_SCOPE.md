# Public alpha scope

This page lists what the public alpha does, what is prototype only, and what is planned. It is for maintainers and reviewers who decide what public text may claim.

## Public promise

RCC lets one trusted operator supervise local Codex from Telegram. Execution, credentials, files, approvals, and state stay on the Mac.

## Working in the public alpha

- Telegram long polling.
- A strict chat allowlist.
- A local Codex App Server bridge.
- Local SQLite state.
- Thread discovery and selection.
- Run, steer, and interrupt.
- List, approve, and deny approvals.
- Thread-scoped uploads from Telegram.
- Explicit artifact listing and sending.
- Reasoning Summary, only when the App Server exposes it.

## Prototype only

- The web console.
- The hosted relay.
- Desktop UI approval automation.
- Git commit and push from Telegram. The commands reply with a message and do not run.

## Planned, not built

- Multi-user access and role-based permissions.
- Cloud execution.
- Native mobile apps.
- Backends other than Codex.
- Full transcript mirroring for every thread.

## Release checks

Run the checks in [SECURITY_ALPHA_CHECKLIST.md](./SECURITY_ALPHA_CHECKLIST.md) before a release. The Telegram smoke test is in [CONTRIBUTING.md](../CONTRIBUTING.md#verification).
