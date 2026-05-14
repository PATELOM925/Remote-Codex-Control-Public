# Architecture

RCC is a Mac-local control layer that connects a private Telegram bot to local Codex through a daemon.

```text
Telegram operator
   |
Telegram Bot API (long polling)
   |
RCC daemon on Mac
   |-- Codex App Server (stdio)
   |-- SQLite state (.dist/rcc.sqlite)
   |-- Thread-scoped uploads (.dist/uploads)
   |-- Thread-scoped artifacts (.dist/artifacts)
   |-- Safety policies (allowlist, approvals, paths, artifact egress, git)
```

See [docs/ARCHITECTURE_DIAGRAM.md](./docs/ARCHITECTURE_DIAGRAM.md) for Mermaid diagrams.

## Core Principle

Keep execution on the Mac. Move only the operator control surface to Telegram.

RCC does not send Codex credentials to Telegram, does not run Codex in the cloud, and does not expose hidden model reasoning. It mediates explicit operator commands through deterministic policy and local Codex App Server APIs.

## Components

### Telegram Adapter

- Polls Telegram with the configured bot token.
- Rejects chats not in `RCC_ALLOWED_CHAT_IDS`.
- Sends status, thread lists, approval cards, output summaries, and artifacts.

### Command Service

- Resolves `/threads`, `/pick`, `/run`, `/say`, `/attach`, and `/artifact` commands.
- Keeps one selected thread per operator chat.
- Avoids destructive defaults when thread references are ambiguous.

### Codex Bridge

- Starts and resumes Codex threads through Codex App Server.
- Starts turns, steers active turns, interrupts turns, and receives events.
- Normalizes operator-visible outputs and approval state.

### Session Registry

Stores stable mappings for:

- RCC project ID;
- project root;
- Codex thread ID;
- thread name;
- active turn ID;
- status;
- model and reasoning-effort preferences.

### SQLite Event Store

Local durability for operator-visible state. SQLite lives under `.dist/` and must never be committed.

### Approval Router

- Enriches approvals with project/thread/action context.
- Rejects stale, superseded, and duplicate callbacks.
- Prefers App Server approval resolution.
- Leaves desktop UI automation disabled by default.

### File Intake

- Requires an explicit thread target.
- Downloads Telegram files under a thread-scoped root.
- Sanitizes filenames and checks final path confinement.
- Sends Codex a local path reference.

### Artifact Watcher

- Lists candidate files under the thread artifact root.
- Sends files only after explicit `/artifact send` request.
- Falls back to zip, manifest, or local path summary when direct Telegram delivery is not safe.

## State Model

Thread states:

- `idle`
- `running`
- `waiting_approval`
- `waiting_operator`
- `completed`
- `interrupted`
- `failed`

Approval states:

- `pending`
- `approved`
- `denied`
- `expired`
- `superseded`

Attachment states:

- `received`
- `downloaded`
- `materialized`
- `announced_to_codex`
- `consumed`
- `failed`

## Experimental Surfaces

The repository includes web and relay code:

- `apps/web/`
- `api/relay.js`
- `supabase/rcc_relay_schema.sql`

These are not part of the public Telegram setup path. Do not describe them as production or public-alpha features unless they pass fresh deployment, storage, security, and end-to-end command tests.
