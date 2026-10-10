# Telegram bot spec

This is the command contract for the Telegram bot. It is for operators who send commands and for contributors who change the command handlers in `src/services/telegramCommandService.ts`. The bot is the only supported remote interface in the public alpha.

Send `/help` to the bot for the short list that the bot shows.

## Health and discovery

- `/help`: show the command list.
- `/status`: daemon, Codex transport, App Server compatibility, approval mode, and bot command health.
- `/projects`: list the registered project folders.
- `/threads [limit]`: list recent Codex threads. The limit is 1 to 100. The default is 30.
- `/running [limit]`: list active or recently active threads. The limit rules are the same as `/threads`.

## Thread focus

- `/pick <threadRef>`: select a thread from the latest `/threads` or `/running` list. An explicit thread ID prefix also works.
- `/where`: show the selected thread.
- `/last [threadRef] [limit]`: show recent output, approval state, and the Codex session tail for the selected thread.
- `/thinking [threadRef] [limit]`: show the Reasoning Summary that the App Server exposes. This is not hidden reasoning.

## Work control

- `/new <projectRef> [task]`: create a thread in a registered project. Raw folder paths are not accepted.
- `/resume [threadRef] [task]`: attach to an existing thread and optionally start a turn.
- `/run [threadRef] <task>`: start a turn on the selected thread or on the named thread. Use `/run --thread=<threadRef> <task>` to target a thread other than the selected one. Use `/run --skill <skillName> <task>` to add a skill for the turn.
- `/plan [threadRef] <task>`: start a planning-only turn.
- `/say [threadRef] <message>`: steer the active turn. When no turn is active, the message is queued as the next instruction.
- `/interrupt [threadRef]`: ask Codex to stop the active turn.
- `/mode [threadRef] [plan|build]`: show or set the thread mode.
- `/skills [threadRef]`: list the skills that Codex reports for the thread.
- `/skill add <skillName>` or `/skill clear`: change the skills that the selected thread uses.
- `/model [threadRef] <model>`: queue a model for the next turn or resume.
- `/effort [threadRef] <low|medium|high>`: queue a reasoning effort for the next turn or resume.

## Approvals

- `/approvals`: list the approvals that you can still act on. Superseded and expired approvals are hidden.
- `/approve <approvalId>`: approve one current approval.
- `/deny <approvalId>`: deny one current approval.

Each approval comes as a card with these buttons: Approve once, Deny, Details, Dismiss, and Interrupt. Dismiss hides the card. It does not approve or deny the request.

The card shows enough context to decide:

```text
Approval needed
Category: <action category>
Risk: <low|medium|high|critical|unknown>
Why: <reason from Codex>
Impact: <what happens if you approve>
Project: <project name>
Thread: <thread name>
Turn: <turn ID or n/a>
cwd: <working folder>
Source: <app_server|desktop_log_recovered|demo>
Action: <short action summary>
Scope: <once or other scope>
Approval ID: <approvalId>
Age: <age> | Expiry: <time>
Command: <command preview, when Codex sends one>
Decision hint: <hint>
```

Fields such as `Why`, `Impact`, `Command`, and `Expiry` appear only when RCC has a value for them.

## Files and artifacts

- `/attach [threadRef]`: send a Telegram document with this command as its caption. The file goes to the selected thread or to the named thread.
- `/artifact [threadRef]`: list the artifacts for the thread.
- `/artifact send <index|all>`: send the listed artifacts that policy and size limits allow.

## Demo and test commands

- `/approval_demo`: create a demo approval card for the selected thread. Use it to test the approval path without Codex.

## Commands that do not run

These commands reply with a message and do not run:

- `/project-rename`, `/git-review`, `/git-commit`, and `/git-push`. The reply names the commands that work.

These older aliases reply with a deprecation message and do not run:

- `/codex`, `/codex-threads`, `/codex_threads`, `/sync-codex`, `/codex-sync`, `/sync_codex`, and `/codex_sync`. Use `/threads` instead.
- `/approval-demo`. Use `/approval_demo` instead.

## Ambiguity rules

- An ambiguous thread reference fails with a message. RCC does not pick a thread for you.
- A raw folder path is not a valid `/new` target.
- An old approval ID does not work once it is expired, superseded, or resolved.
- Text in a message does not grant more file, command, network, artifact, or Git access.
- A message with an unknown command gets this reply: `Unknown command <name>. Use /help`.
