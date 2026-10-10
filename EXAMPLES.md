# Telegram workflow examples

These examples show how the Telegram commands behave in the public alpha. They are for operators learning the bot and for reviewers who check that the docs match the behaviour. For a first run, use [QUICKSTART.md](./QUICKSTART.md). For the full command list, use [TELEGRAM_BOT_SPEC.md](./TELEGRAM_BOT_SPEC.md).

## Example 1: Health and thread focus

Operator:

```text
/status
```

Expected use: confirm the daemon, the Codex transport, App Server compatibility, bot command installation, remote mode, approval mode, and sleep prevention.

Operator:

```text
/threads 10
/pick 1
/where
/last
```

Expected behavior:

- `/threads` lists the Codex threads that RCC can see.
- `/pick` selects one focused thread for live output.
- `/where` confirms the selected thread.
- `/last` shows recent instructions, the Codex session tail, approval state, and sync details when they exist.

## Example 2: Start a turn and steer it

Operator:

```text
/run Inspect the public docs and report only unsupported launch claims.
```

While the turn is active:

```text
/say Also check docs/LAUNCH_SCOPE.md before answering.
```

Expected behavior:

- RCC starts a turn on the selected thread, or steers it when a turn is active.
- The selected thread gets live updates.
- Background threads do not stream full transcripts.

## Example 2A: Create or resume a thread

Operator:

```text
/projects
/new 1 Create a concise implementation checklist.
```

Expected behavior:

- RCC creates a new Codex thread in the selected registered project folder.
- When you give a task, RCC starts the first turn at once.
- RCC selects the new thread as the focused thread.

Operator:

```text
/resume <threadRef> Continue from the latest status and list blockers.
```

Expected behavior:

- RCC attaches to the existing Codex thread.
- When you give a task, RCC starts a turn after it resumes the thread.
- `/new` does not accept a raw folder path as the project.

## Example 3: Approval card

Each approval comes as a card. The card shows the category, risk, reason, project, thread, turn, source, action, scope, approval ID, and age. It has Approve once, Deny, Details, Dismiss, and Interrupt buttons. The full field list is in [TELEGRAM_BOT_SPEC.md](./TELEGRAM_BOT_SPEC.md#approvals).

A short example:

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

- `/approvals` lists the approvals you can still act on.
- Superseded and expired approval IDs are rejected.
- Dismiss hides the card. It does not approve or deny the Codex request.
- App Server approvals can be resolved from Telegram.
- Desktop-recovered approvals may need a decision in the Codex desktop app. The UI automation fallback works only when it is enabled and ready.

## Example 4: Attach a file to a thread

With a selected thread, send a document to the bot with this caption:

```text
/attach
```

Or name the thread:

```text
/attach <threadRef>
```

Expected behavior:

- RCC needs a thread. It uses the selected thread, or the one you name.
- RCC downloads the file under `.dist/uploads/<rcc-thread-id>/`. The file name is sanitized and has a timestamp prefix.
- RCC checks that the saved path stays inside the thread's upload folder.
- RCC tells Codex the local path of the file.
- RCC treats the file as untrusted context.

The default download limit is 20 MiB (`RCC_TELEGRAM_DOWNLOAD_LIMIT=20971520`).

## Example 5: Send artifacts

Ask Codex to write artifacts into the artifact folder of the thread. Then run:

```text
/artifact
```

If RCC lists files, send the ones you choose:

```text
/artifact send 1
/artifact send all
```

Expected behavior:

- RCC scans `.dist/artifacts/<rcc-thread-id>/` by default.
- RCC lists common types such as `.md`, `.pdf`, `.docx`, `.pptx`, `.zip`, and image files.
- RCC does not send generated files on its own.
- RCC sends the selected files when they are under the Telegram send limit.
- A file that is too large makes RCC try to zip it with the system `zip` command. If that fails, RCC writes a manifest with the local path.

The default send limit is 50 MiB (`RCC_TELEGRAM_SEND_LIMIT=52428800`).

## Example 6: Model and reasoning effort

Operator:

```text
/model gpt-5
/effort medium
```

Expected behavior:

- RCC queues the model and the reasoning effort for the next turn, the next resume, or a new thread.
- RCC does not change a turn that is already running.

## Commands that do not run

These commands reply with a short message and do not run. Do not use them as part of a demo:

```text
/git-push main
/git-commit
/project-rename old new
```

Telegram commit, push, and project rename are not part of the public alpha. See [TELEGRAM_BOT_SPEC.md](./TELEGRAM_BOT_SPEC.md#commands-that-do-not-run).
