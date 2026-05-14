# Agent Guidance

Be pragmatic, evidence-grounded, and safety-first. RCC can remotely steer and approve local coding-agent actions, so correctness and conservative defaults matter more than broad claims.

## Product Boundary

Public alpha is Telegram-first:

- one trusted operator;
- one trusted Mac;
- one private Telegram bot;
- local Codex App Server;
- local SQLite state;
- thread-scoped attachments and artifacts.

Web/relay code exists for experimentation, but public docs must not promote it as the supported setup path until it has fresh security and end-to-end verification.

## Engineering Rules

- Do not commit `setup.md`, `.env`, `.dist/`, SQLite files, logs, token files, or runtime screenshots.
- Do not copy real local config values into docs.
- Do not broaden filesystem or network authority without explicit policy and tests.
- Do not let file uploads bypass thread scoping.
- Do not let stale or superseded approvals resolve.
- Do not claim hidden chain-of-thought access; RCC displays only App Server-exposed `Reasoning Summary` content.
- Prefer small, testable changes over large rewrites.

## Code Ownership Map

- Telegram commands: `src/services/telegramCommandService.ts`
- Codex bridge: `src/agents/codexBridgeAgent.ts`
- Approvals: `src/agents/approvalRouterAgent.ts`
- File intake: `src/agents/fileIntakeAgent.ts`
- Artifacts: `src/agents/artifactWatcherAgent.ts`
- Policies: `src/policies/`
- Config: `src/config.ts`
- Startup: `run.sh` and `src/services/rccDaemon.ts`

## Verification

For runtime changes:

```bash
npm run verify:quick
```

For docs-only public release changes:

```bash
npm run secrets:check
git status --short
git grep -n "$HOME" -- . ':!package-lock.json' | grep -v 'git grep' || true
```
