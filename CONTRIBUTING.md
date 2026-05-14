# Contributing To RCC

RCC is safety-critical local developer tooling. Contributions should be small, truthful, tested, and security-aware.

## Public Product Scope

Public language must preserve this scope:

- local-first remote supervision;
- starts with Codex;
- one trusted operator;
- one trusted Mac;
- Telegram-first public alpha;
- allowlisted chats/projects;
- thread-scoped attachments;
- explicit approvals and artifacts.

Do not describe RCC as a hosted coding platform, remote desktop, multi-user SaaS, production relay, or general agent marketplace unless implementation and verification support that claim.

## First Contribution Setup

```bash
npm install
npm run verify:quick
cp setup.example.md setup.md
```

Fill `setup.md` only for local testing. Never commit it.

## Branch Hygiene

Do not commit:

- `setup.md`;
- `.env` or `.env.*`;
- `.dist/`;
- SQLite DB/WAL/SHM files;
- logs;
- token handoff files;
- browser/Telegram screenshots with private data;
- local `test_images/` runtime captures;
- generated private artifacts.

## Code Areas

- Telegram commands: `src/services/telegramCommandService.ts`
- Codex bridge: `src/agents/codexBridgeAgent.ts`
- Approvals: `src/agents/approvalRouterAgent.ts`
- File intake: `src/agents/fileIntakeAgent.ts`
- Artifacts: `src/agents/artifactWatcherAgent.ts`
- Policy: `src/policies/`
- Config: `src/config.ts`
- Startup: `run.sh` and `src/services/rccDaemon.ts`

## Verification

Docs-only checks:

```bash
test -f README.md \
  && test -f INSTALL.md \
  && test -f QUICKSTART.md \
  && test -f EXAMPLES.md \
  && test -f SECURITY.md \
  && test -f ARCHITECTURE.md \
  && test -f TELEGRAM_BOT_SPEC.md \
  && test -f docs/SETUP_REFERENCE.md
```

Runtime-sensitive checks:

```bash
npm run verify:quick
npm run secrets:check
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

## Security Review Triggers

Request security review for changes touching:

- chat authorization;
- approval routing;
- stale/superseded approval behavior;
- attachment paths;
- artifact egress;
- local status server;
- web/relay code;
- Git guardrails;
- logging/redaction;
- project-root discovery.

## Pull Request Checklist

- Public claims are truthful.
- Working/prototype/roadmap boundaries are clear.
- Setup and verification commands are included.
- Security warnings are not weakened.
- No secrets or local state are committed.
- `npm run verify:quick` passes, or a docs-only skip is justified.
