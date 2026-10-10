# Runbook

This runbook covers starting RCC, checking its health, and recovering from common faults. It is for the operator who runs RCC on the Mac.

## Local startup

1. Start the Codex app on the Mac, and make sure you are signed in.
2. Start RCC with `./run.sh`.
3. Check the daemon from Telegram with `/status`.
4. Confirm that `Codex Transport: connected` and `Telegram Commands: installed` appear.

RCC skips Telegram messages that arrived while it was stopped. This is the default, set by `RCC_TELEGRAM_DROP_PENDING_UPDATES_ON_START`. Send the command again after you start RCC. See [docs/SETUP_REFERENCE.md](./docs/SETUP_REFERENCE.md).

## Health checks

### App Server

- RCC can list or read thread state.
- RCC receives the event stream.
- The last heartbeat is inside the freshness threshold. The threshold is `RCC_EVENT_FRESHNESS_MS`.

### Telegram

- The bot token works. A message from RCC reaches the operator.
- Approval buttons reach the daemon.
- The bot command menu is installed. `/status` shows `Telegram Commands: installed`.

### Registry

- SQLite is writable.
- Thread mappings are readable.

## Remote operator model

- RCC uses focused streaming and background alerts. It does not mirror every thread transcript.
- The picked thread gets live text updates.
- Other active threads send alerts for these events:
  - turn started
  - turn completed
  - approval needed
  - after-approval summary
- `/last` is the command that shows the current sync state for the picked thread.

## When remote control works

- The Mac is on and connected to the internet.
- The user session is unlocked.
- The Codex app is running.
- The RCC daemon is running.
- Telegram long polling is healthy.
- The operator has picked the thread before expecting live output.

## When remote control only partly works

- The Codex App Server is unavailable, but RCC still runs:
  - `/status` still works.
  - Thread and approval visibility from the desktop logs may still work.
  - Turn control and approval resolution through the App Server may fail.
- Desktop-only approvals appear in Telegram, but you can resolve them only if the UI fallback is ready. See the UI automation prerequisites below.
- Artifacts written outside the watched artifact folder need manual retrieval.

## When remote control does not work

- The Mac is asleep, shut down, offline, or locked.
- The RCC daemon is not running.
- A desktop-only approval needs the AppleScript fallback, and the Codex approval card is not on screen.
- You expect Telegram to mirror every active thread at the same time.

## Approval incident handling

### Symptom

You tapped Approve, and nothing happened.

### Checks

- The approval is still pending and has not expired.
- The Codex request ID maps to the approval.
- The App Server connection is active.

### Recovery

- Run `/approvals` to see whether the request is still pending.
- If a card is superseded, use `/approvals` to find the current request. Old cards are rejected.
- If the approval source is `app_server`, resolve it with `/approve` or `/deny`.
- If the approval source is `desktop_log_recovered`:
  - With `RCC_APPROVAL_STRATEGY=appserver_only`, approve it in the Codex desktop app.
  - With `RCC_APPROVAL_STRATEGY=appserver_then_ui` and `RCC_UI_AUTOMATION_ENABLED=true`, RCC tries the AppleScript fallback.

### UI automation fallback prerequisites

- A macOS host with an active GUI session.
- The Codex app is in front, or can be brought to the front.
- The terminal or the RCC process has Accessibility permission.
- The approval card is visible in the Codex window.

If a prerequisite is missing, the fallback fails. RCC then tells you to approve in the desktop app.

## Attachment incident handling

### Symptom

You uploaded a file from Telegram, but Codex cannot see it.

### Checks

- The Telegram file download succeeded.
- The attachment row exists in the database.
- The local file exists at the saved path.
- The saved path is inside the thread's upload folder.
- RCC sent the follow-up instruction to the thread.

### Recovery

- Upload the file again with `/attach`.
- Ask Codex to read the saved path that RCC reports.

## Artifact incident handling

### Symptom

Codex wrote an artifact, but you did not receive it.

### Checks

- The artifact watcher scanned the right folder. Each thread has its own folder under the artifact root.
- The file type is one that RCC lists.
- The file is under the Telegram send limit.
- The `sendDocument` call succeeded.

### Recovery

- Run `/artifact` to list the files again.
- If the file is too large, RCC sends a zip or a manifest with the local path instead.
- Retrieve the file from the Mac directly if you need the original.

## Git safety handling

The public alpha does not let you commit or push from Telegram. The `/git-commit`, `/git-push`, and `/git-review` commands reply with a short message and do not run.

Pushes to `main` are blocked by policy. If Codex asks for one, deny the request and push from a feature branch on the Mac.

## Known limits

- High-volume desktop threads can produce many approval cards and superseded notices. Old cards are rejected, so no action runs by mistake. The chat can be noisy.

## Live validation checklist

Use this checklist after you change RCC or before you rely on it for remote work.

1. Start Codex on the Mac and keep the Mac awake, online, and unlocked.
2. Start RCC from the repo root with `./run.sh`.
3. Open the bot in Telegram on your phone or in Telegram Web.
4. Send `/status`. Confirm these lines:
   - `Daemon: alive`
   - `Codex Transport: connected`
   - `Telegram Commands: installed`
   - `Remote Mode: focused_thread_stream + background_alerts`
5. Send `/threads 5` or `/running`.
6. Select the thread with `/pick <index or id>`.
7. Confirm the selection with `/where` and `/last`.
8. Send `/run <task>` or `/say <change>`.
9. Expect detailed live output only for the picked thread.
10. Expect background threads to send only alerts: started, completed, approval needed, and after-approval summary.
11. For files, run `/artifact`, review the list, then send the files you want with `/artifact send <n>`.

### Approval validation

RCC supports two approval paths:

- App Server approvals. You resolve them with `/approve <id>`, `/deny <id>`, or the buttons on the card.
- Desktop-recovered approvals. RCC sees them in the Codex desktop logs. It resolves them with AppleScript only when `RCC_APPROVAL_STRATEGY=appserver_then_ui`, `RCC_UI_AUTOMATION_ENABLED=true`, the Mac is unlocked, and the Codex approval card is visible.

If the desktop fallback cannot act, RCC sends a message that gives the reason. It does not fail silently.

## Quick verification

Run this before you restart RCC or publish a change:

```bash
npm run verify:quick
```

The script runs these checks in order: the web static check, the relay syntax check, the tracked-file secret scan, the LaunchAgent static check, the TypeScript typecheck, and the integration tests. It does not check live Telegram or Codex behaviour. Run the live checklist above for that.

## Approval queue

Use `/approvals` to see the approvals you can act on now. Superseded and expired approvals are hidden, and their old buttons are rejected. If you tap an old card, run `/approvals` to find the current request.
