# RCC Alpha Examples

These examples show what is safe to claim in the current alpha and how the Telegram workflow behaves.

## Example 1: Health And Thread Focus

Operator:

```text
/status
```

Expected use: confirm daemon, Codex transport, App Server compatibility, Telegram command installation, remote mode, approval mode, and sleep-prevention signals.

Operator:

```text
/threads 10
/pick 1
/where
/last
```

Expected behavior:

- `/threads` lists Codex threads visible to RCC.
- `/pick` selects one focused thread for live output.
- `/where` confirms the selected thread.
- `/last` shows recent RCC/Telegram instruction context, Codex session tail, approval state, and sync proof when available.

## Example 2: Start A Turn And Steer It

Operator:

```text
/run Inspect the public docs and report only unsupported launch claims.
```

While the turn is active:

```text
/say Also check docs/LAUNCH_SCOPE.md before answering.
```

Expected behavior:

- RCC starts or steers the selected Codex thread.
- The selected thread gets focused live updates.
- Background threads do not stream full transcripts.

## Example 2A: Create Or Resume A Thread

Operator:

```text
/projects
/new 1 Create a concise implementation checklist.
```

Expected behavior:

- RCC creates a new Codex thread inside the selected registered project root.
- If a task is included, RCC starts the first turn immediately.
- RCC selects the new thread as the focused thread.

Operator:

```text
/resume <threadRef> Continue from the latest status and list blockers.
```

Expected behavior:

- RCC attaches to the existing Codex thread.
- If a task is included, RCC starts a turn after resuming.
- Raw filesystem paths are not accepted as project targets for `/new`.

## Example 3: Approval Card

Approval card shape:

```text
Approval needed
Project: repo-x
Thread: Fix launch docs
Turn: turn_456
Action: run targeted test command
Scope: once
Approval ID: <approvalId>
```

Operator choices:

```text
/approvals
/approve <approvalId>
/deny <approvalId>
/interrupt
```

Expected behavior:

- Current approvals are listed by `/approvals`.
- Superseded or expired approval IDs are rejected.
- `Dismiss` hides repeated notification pressure but does not approve or deny the underlying Codex request.
- App Server approvals can be resolved from Telegram.
- Desktop-log-recovered approvals may require manual Codex desktop approval unless UI automation fallback is intentionally enabled and ready.

## Example 4: Attachment To A Thread

With a selected thread, attach a document in Telegram with this caption or message:

```text
/attach
```

Or use an explicit thread reference:

```text
/attach <threadRef>
```

Expected behavior:

- RCC requires a thread target.
- RCC downloads the Telegram document under `.dist/uploads/<rcc-thread-id>/` with a sanitized timestamped filename.
- RCC checks that the saved path stays inside the thread workspace.
- RCC sends Codex a follow-up instruction with the local file path.
- The uploaded file is treated as untrusted context, not trusted policy.

Default attachment size baseline: `RCC_TELEGRAM_DOWNLOAD_LIMIT=20971520` bytes.

## Example 5: Explicit Artifact Retrieval

Ask Codex to produce an artifact in RCC's artifact root for the active RCC thread. Then run:

```text
/artifact
```

If files are listed:

```text
/artifact send 1
/artifact send all
```

Expected behavior:

- RCC scans `.dist/artifacts/<rcc-thread-id>/` by default.
- RCC recognizes common artifact extensions such as `.md`, `.pdf`, `.docx`, `.pptx`, `.zip`, and image files.
- RCC does not auto-send all generated files.
- RCC sends selected files when under the Telegram send limit.
- If a file is too large, RCC tries a zip fallback and then writes a local manifest.

Default send baseline: `RCC_TELEGRAM_SEND_LIMIT=52428800` bytes.

## Example 6: Model And Reasoning Policy

Operator:

```text
/model gpt-5
/effort medium
```

Expected behavior:

- RCC queues model and reasoning-effort changes for the next turn, resumed thread, or new run.
- RCC does not mutate an already-running action with unsafe turn-level overrides.

## Example 7: Safe Demo Story

Use this compact demo narrative:

```text
RCC is supervising a local Codex run from Telegram. Execution stays on the Mac. Telegram is only the operator control plane for status, steering, approvals, scoped attachments, and explicit artifact retrieval.
```

Then demonstrate:

```text
/status
/threads 10
/pick 1
/last
/run Create a short demo note in .dist/artifacts for this thread.
/approvals
/artifact
/artifact send 1
```

## Non-Examples

Do not use these as alpha demos:

```text
/git-push main
/git-commit
/project-rename old new
```

Git Telegram workflows and project rename are not completed alpha workflows.
