# RUNBOOK

## Local startup

1. Start the Codex app on the Mac.
2. Start the bridge daemon.
3. Start the Telegram bot service.
4. Confirm SQLite is accessible.
5. Run health check to confirm App Server connectivity.
6. Run Telegram webhook or polling connectivity check.

## Health checks

### App Server health
- can list or read thread state
- can receive event stream
- last heartbeat under threshold

### Telegram health
- bot token valid
- can send test message to operator
- callback routing active
- slash commands installed (`/threads`, `/running`, `/pick`, `/last`, `/run`, `/say`, `/attach`, `/artifact`, `/approve`, `/deny`, `/status`)

### Registry health
- SQLite writable
- thread mappings readable

## Remote operator model

- RCC is `focused + alerts`, not a full multi-thread transcript mirror.
- The picked thread gets live text updates.
- Other active threads still send important alerts:
  - turn started
  - turn completed
  - approval needed
  - after-approval summary
- `/last` is the authoritative sync command for the currently picked thread.

## When remote control works

- Mac is powered on and internet-connected
- user session is unlocked
- Codex desktop is running
- RCC daemon is running
- Telegram long polling is healthy
- operator has picked the intended thread before expecting live stream output

## When remote control only partly works

- Codex App Server is unavailable but RCC is still running:
  - `/status` still works
  - desktop-log-derived thread and approval visibility may still work
  - official turn control and official approval resolution may fail
- desktop-only approvals are visible in Telegram, but resolution still depends on UI fallback prerequisites
- artifacts written outside RCC watched paths may need manual retrieval

## When remote control will not work

- Mac is asleep, shut down, offline, or the user session is locked
- RCC daemon is not running
- Codex approval UI is not visible for a desktop-only approval that requires AppleScript fallback
- operator expects Telegram to mirror all active thread transcripts simultaneously

## Approval incident handling

### Symptom
Operator tapped approve, but nothing happened.

### Checks
- approval still pending and not expired
- correct codex request id mapping
- App Server connection active

### Recovery
- refresh thread state
- resend approval card if still pending
- mark prior card stale if superseded
- if approval source is `app_server`, resolve via `/approve` or `/deny`
- if approval source is `desktop_log_recovered`:
  - with `RCC_APPROVAL_STRATEGY=appserver_only`: approve in Codex desktop
  - with `RCC_APPROVAL_STRATEGY=appserver_then_ui` and `RCC_UI_AUTOMATION_ENABLED=true`: RCC attempts AppleScript fallback

### UI automation fallback prerequisites
- macOS host with active GUI session
- Codex app frontmost or activatable
- Accessibility permission granted for the RCC process/terminal
- approval card visibly present in the Codex window
- if any prerequisite is missing, fallback will fail and RCC will instruct desktop approval

## Attachment incident handling

### Symptom
File uploaded from Telegram but Codex cannot see it.

### Checks
- Telegram file download succeeded
- attachment row exists
- local file exists at expected path
- path is inside thread workspace
- follow-up instruction was sent to thread

### Recovery
- re-materialize file to workspace
- resend file reference instruction

## Artifact incident handling

### Symptom
Artifact created but not sent.

### Checks
- artifact watcher scanned correct directory
- file size under Telegram limit
- sendDocument call succeeded

### Recovery
- generate artifact manifest
- provide operator with fetch command
- if too large, compress or provide alternate retrieval path

## Git safety handling

### Rule set
- commit requires explicit approval
- push requires separate explicit approval
- pushing to `main` blocked in v1

### Recovery for unsafe request
- deny action
- send reason to operator
- suggest feature branch alternative

## Live Mirroring Validation Workflow

Use this when validating RCC from Telegram Web in Comet `YORK + WORK`.

1. Start Codex desktop and keep the Mac awake, online, and unlocked.
2. Start RCC from the repo root with `./run.sh`.
3. Open Telegram Web to the RCC bot in Comet.
4. Send `/status` and confirm:
   - `Daemon: alive`
   - `Codex Transport: connected`
   - `Telegram Commands: installed`
   - `Remote Mode: focused_thread_stream + background_alerts`
5. Send `/threads 5` or `/running`.
6. Select the intended thread with `/pick <index-or-id>`.
7. Confirm focus with `/where` and `/last`.
8. Send `/run <task>` or `/say <change>`.
9. Expect detailed live output only for the picked thread.
10. Expect background threads to send only high-signal alerts: started, completed, approval needed, and after-approval summary.
11. For files, run `/artifact`, review the list, then fetch explicitly with `/artifact send <n>`.

### Approval validation

RCC supports two approval paths:

- App Server approvals: resolved directly by `/approve <id>`, `/deny <id>`, or the Telegram card buttons.
- Desktop-recovered approvals: visible from Codex desktop logs and resolved by AppleScript only when `RCC_APPROVAL_STRATEGY=appserver_then_ui`, `RCC_UI_AUTOMATION_ENABLED=true`, the Mac is unlocked, and the Codex approval card is visible.

If desktop approval fallback cannot act, RCC must send an explicit reason instead of failing silently.

### Current known validation blocker

High-volume desktop threads can produce many approval cards and superseded notices. This is safer than missing approvals, but noisy. The next UX hardening target is latest-only approval coalescing per thread, plus an `/approvals` command for the current actionable set.

## Quick Verification

Run before restart or release:

```bash
npm run verify:quick
```

This runs bounded typecheck and integration tests. It is not a replacement for live Telegram validation, but it catches protocol, approval, and command regressions quickly.

## Approval Queue

Use `/approvals` to see current actionable approvals. Superseded and expired approvals are hidden and old card callbacks are rejected. If an old approval card is tapped, use `/approvals` to find the current request.
