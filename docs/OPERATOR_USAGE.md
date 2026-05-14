# Telegram Operator Usage

Use this after RCC is installed and running.

## Start

```bash
./run.sh
```

Keep the Mac awake, online, and signed into Codex.

## Daily Flow

```text
/status
/projects
/threads 10
/pick 1
/where
/last
/run <task>
/say <guidance>
/approvals
/artifact
```

## Approval Safety

Before approving:

- confirm project;
- confirm thread;
- inspect requested action;
- inspect file/path/network/git scope;
- check age and supersession;
- run `/last` if context is stale.

Deny unclear or stale approvals.

## Attachments

Send a Telegram document with `/attach` as the caption after selecting a thread, or use `/attach <threadRef>`.

Uploaded files are untrusted context. RCC stores them under a thread-scoped local path and tells Codex where to inspect them.

## Artifacts

Use `/artifact` to list and `/artifact send <index>` to send. RCC does not promise unlimited Telegram delivery; large files fall back to zip, manifest, or local-path summary depending on policy.
