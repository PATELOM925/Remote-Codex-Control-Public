# Contributing to RCC

This guide explains how to change RCC safely. It is for contributors and for coding agents that work in this repository. The rules for coding agents are in [AGENTS.md](./AGENTS.md).

RCC is local developer tooling that can steer Codex and approve actions. Keep changes small, true to the docs, tested, and aware of security.

## Public product scope

Public text must keep this scope:

- local-first remote supervision;
- Codex as the only agent backend;
- one trusted operator;
- one trusted Mac;
- Telegram as the public alpha interface;
- allowlisted chats and project folders;
- uploads scoped to a thread;
- explicit approvals and artifacts.

Do not describe RCC as a hosted coding platform, a remote desktop, a multi-user service, a production relay, or an agent marketplace. Make such a claim only when the code and its tests support it.

## First setup

```bash
npm ci
npm run verify:quick
cp setup.example.md setup.md
```

Fill in `setup.md` only for local testing, and never commit it. The setup steps are in [INSTALL.md](./INSTALL.md).

## Branch hygiene

Do not commit these files or folders:

- `setup.md`;
- `.env` or `.env.*` with real values;
- `.dist/`;
- SQLite database, WAL, or SHM files;
- logs;
- token backup files;
- Telegram or browser screenshots that show private data;
- `test_images/` runtime captures;
- generated private artifacts.

## Code areas

- Telegram commands: `src/services/telegramCommandService.ts`
- Codex bridge: `src/agents/codexBridgeAgent.ts`
- Approvals: `src/agents/approvalRouterAgent.ts`
- File intake: `src/agents/fileIntakeAgent.ts`
- Artifacts: `src/agents/artifactWatcherAgent.ts`
- Policies: `src/policies/`
- Config: `src/config.ts`
- Startup: `run.sh` and `src/services/rccDaemon.ts`

## Design rules

- Use typed interfaces for bridge events.
- Use explicit state machines instead of boolean flags. The state names are in [ARCHITECTURE.md](./ARCHITECTURE.md#state-model).
- Store operator-visible state in SQLite. The schema is in [DB_SCHEMA.md](./DB_SCHEMA.md).
- Make every callback idempotent.
- Treat Telegram callbacks and Codex events as separate asynchronous streams.
- Log state transitions as structured log entries.
- Keep these parts separate: App Server integration, the Telegram transport, the session registry and state, artifacts, file intake, and Git guardrails.
- Show project and thread context on every approval.
- A Telegram upload belongs to one thread. Never store it as shared context.
- Model and reasoning changes apply to the next turn or a new thread. Never change a running turn.
- Do not claim access to hidden reasoning. Show only the Reasoning Summary that the App Server exposes.

## Verification

For a runtime change, run:

```bash
npm run verify:quick
```

It runs the static web check, the relay syntax check, the secret scan, the LaunchAgent check, the typecheck, and the integration tests. For a docs-only change, run `npm run secrets:check` and check each link you changed.

Before a release, run the Telegram smoke test with a real bot:

```text
/status
/projects
/threads 10
/pick 1
/where
/last
/approvals
```

The release checks are in [docs/SECURITY_ALPHA_CHECKLIST.md](./docs/SECURITY_ALPHA_CHECKLIST.md).

## Security review triggers

Ask for a security review when a change touches:

- chat authorization;
- approval routing;
- stale or superseded approval behaviour;
- attachment paths;
- artifact sending;
- the local status server;
- the web or relay code;
- Git guardrails;
- logging and redaction;
- project folder discovery.

## Pull request checklist

- Public claims are true, and the working, prototype, and planned parts are clearly separate.
- Setup and verification commands are included.
- Security checks are not weakened.
- No secrets or local state are committed.
- `npm run verify:quick` passes, or the change is docs-only and you say so.
