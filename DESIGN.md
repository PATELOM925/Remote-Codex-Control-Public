# Design

This note explains why RCC works the way it does. It is for maintainers and reviewers who change how approvals, steering, files, or artifacts behave.

## Product thesis

A coding agent is most useful when the operator can supervise and redirect it without sitting at the keyboard. RCC keeps the agent on the Mac and moves only the operator's control surface to Telegram.

## Primary user

One operator who runs Codex on a personal Mac and wants to watch, steer, and approve its work from a phone.

## Jobs to be done

1. When Codex needs approval, show the project, thread, and action so the operator can decide quickly.
2. When the operator changes direction, let them send a message that steers the active turn or queues for the next turn.
3. When Codex needs more context, let the operator upload a file from Telegram into a chosen thread.
4. When the operator asks, send the files that a thread produced.
5. Keep Git actions out of Telegram. Block pushes to `main` by policy.

## Constraints

- The Mac runs Codex and holds the code, credentials, and state.
- The bot is private and serves one operator.
- RCC starts new Codex threads only in registered project folders.
- A Telegram upload belongs to one thread. It is never shared context.
- Pushes to `main` are blocked by policy.

## Principles

### Approval speed

A request must make sense on one phone screen without opening the laptop.

### Context continuity

Every approval and message names its project, thread, and turn.

### Scoped files

A Telegram upload is stored under the folder of the thread that received it. The reply names that thread.

### Operator control

The operator can interrupt, steer, deny, or dismiss at any time.

### Safe by default

Artifacts are listed first and sent only when selected. Ambiguous thread references fail instead of guessing. Expired and superseded approvals cannot be resolved.

## Interaction patterns

### Approval card

Each card shows the category, risk, reason, project, thread, turn, source, approval ID, and age. It has these buttons: Approve once, Deny, Details, Dismiss, and Interrupt. The full card format is in [TELEGRAM_BOT_SPEC.md](./TELEGRAM_BOT_SPEC.md#approvals).

### Steering

`/say` steers the active turn. When no turn is active, it queues the message as the next instruction for the thread.

### Attaching a file

`/attach` takes the next Telegram document. The file goes to the selected thread or to the thread named in the command. The reply names the thread and the saved path.

### Returning artifacts

When a turn finishes, RCC reports the status. It does not send generated files. The operator runs `/artifact` to list them and `/artifact send` to pick the files to send. Files over the Telegram limit fall back to a zip, a manifest, or a local path summary.

## Known limits

- One Mac and one operator. There is no multi-user access.
- The operator sees live output only for the focused thread. Other threads send alerts.
- Telegram cannot commit or push in the public alpha.
- Desktop-only approvals may need to be resolved in the Codex app.
