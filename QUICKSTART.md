# RCC Telegram Quickstart

This is the shortest successful path after installation.

## 1. Start RCC

If you have not set up RCC yet, run `npm run setup` first. The setup writes `setup.md`. See [INSTALL.md](./INSTALL.md).

```bash
cd /path/to/Remote-Codex-Control-Public
npm run verify:quick
./run.sh
```

Keep the terminal running.

## 2. Check Health

In Telegram, send:

```text
/status
```

Look for:

- `Daemon: alive`
- `Codex Transport: connected` or a clear reason it is disconnected
- `Telegram Commands: installed`
- `Remote Mode: focused_thread_stream + background_alerts`

## 3. Find And Pick A Thread

```text
/projects
/threads 10
/running
/pick 1
/where
/last
```

`/pick` sets the focused thread. RCC streams selected-thread updates to Telegram and keeps background threads quieter.

## 4. Run Or Steer Codex

With a selected thread:

```text
/run Summarize this repository in five bullets and list any changed files.
```

While a turn is running:

```text
/say Keep it concise and do not make unsupported platform claims.
```

To target a specific thread explicitly:

```text
/run <threadRef> Inspect README and report public setup gaps.
/say <threadRef> Narrow the answer to verified blockers only.
```

## 5. Create Or Resume A Thread

```text
/projects
/new 1 Draft a short alpha status note.
/resume <threadRef> Continue with the next smallest safe step.
```

`/new` only accepts registered project references, not arbitrary filesystem paths.

## 6. Handle Approvals

```text
/approvals
/approve <approvalId>
/deny <approvalId>
```

Before approval, confirm:

- project;
- thread;
- action;
- path/network/git scope;
- source;
- age and supersession state.

If the card is unclear or stale, deny it or resolve directly in Codex desktop.

## 7. Attach A File

With a selected thread, send a document to the bot with caption:

```text
/attach
```

Or target explicitly:

```text
/attach <threadRef>
```

RCC stores the file under `.dist/uploads/<thread-id>/`, sanitizes the filename, checks path confinement, and sends Codex a local path reference. Uploaded files are untrusted context.

## 8. Retrieve Artifacts

Ask Codex to write artifacts under RCC's artifact root for the selected thread, then run:

```text
/artifact
/artifact send 1
```

RCC lists first and sends only explicit selections. If a file is too large, RCC falls back to zip/manifest/local-path summary depending on policy and size.

## 9. Optional Reasoning Summary

```text
/thinking
```

This shows `Reasoning Summary` only when Codex App Server exposes summary events. It is not hidden chain-of-thought.

## 10. Stop RCC

Press `Ctrl+C` in the terminal running `./run.sh`.

## Public Demo Script

```text
/status
/projects
/threads 10
/pick 1
/last
/run Create a short public-alpha demo note in .dist/artifacts for this thread.
/approvals
/artifact
/artifact send 1
```

Public wording:

```text
RCC supervises local Codex from Telegram. Execution, credentials, approvals, files, and state stay on the Mac.
```
