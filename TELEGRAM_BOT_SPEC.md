# Telegram Bot Spec

RCC's public alpha bot is the sole documented remote operator interface.

## Command Contract

### Health And Discovery

- `/help` - show command help.
- `/status` - daemon, Codex transport, thread-list, approval, and Telegram health.
- `/projects` - list registered allowlisted projects.
- `/threads [limit]` - list recent Codex threads.
- `/running [limit]` - list active or recently active threads.

### Thread Focus

- `/pick <threadRef>` - select a thread from `/threads` or by explicit ID prefix.
- `/where` - show selected thread.
- `/last [threadRef] [limit]` - show recent selected-thread context, output, approvals, and Codex session tail.
- `/thinking [threadRef]` - show App Server-exposed `Reasoning Summary` when available.

### Work Control

- `/new <projectRef> [task]` - create a new Codex thread inside a registered project and optionally start work.
- `/resume [threadRef] [task]` - resume a thread and optionally start work.
- `/run [threadRef] <task>` - start a turn on the selected or explicit thread.
- `/say [threadRef] <message>` - steer an active turn or queue guidance for the selected/explicit thread.
- `/interrupt [threadRef]` - request interruption.

### Approvals

- `/approvals` - list actionable approvals.
- `/approve <approvalId>` - approve one current approval.
- `/deny <approvalId>` - deny one current approval.

Approval cards must show enough context to decide safely:

```text
Approval needed
Project: repo-x
Thread: Fix launch docs
Turn: turn_456
Category: shell command
Risk: low|medium|high|critical|unknown
Action: run targeted test command
Scope: once
Source: app_server|desktop_log_recovered|demo
Approval ID: <approvalId>
Age: 2m
```

### Files And Artifacts

- `/attach [threadRef]` - attach the next Telegram document to a selected or explicit thread.
- `/artifact [threadRef]` - list artifacts for a selected or explicit thread.
- `/artifact send <index|all>` - explicitly send listed artifact files when policy and size allow.

### Next-Turn Preferences

- `/model [threadRef] <model>` - queue model preference for the next turn/resume.
- `/effort [threadRef] <low|medium|high>` - queue reasoning-effort preference for the next turn/resume.

## Ambiguity Rules

- Ambiguous thread references must ask for clarification or fail safely.
- Raw filesystem paths are not valid `/new` project targets.
- Old approval IDs must not be applied if expired, superseded, or already resolved.
- Free-text guidance does not grant additional file, command, network, artifact, or Git authority.

## Prototype Or Reserved Commands

These are not public alpha workflows unless a future release promotes and verifies them:

- `/git-review`
- `/git-commit`
- `/git-push`
- `/project-rename`
- `/sync-codex`
- old `/codex-threads` aliases
