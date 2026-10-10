# Database schema

This page lists the SQLite tables that RCC creates. It is for contributors who change state code or inspect `.dist/rcc.sqlite`. The source of truth is `src/db/migrations.ts`.

RCC stores its state in `.dist/rcc.sqlite`. The database uses WAL mode and foreign keys. The file is local state and must never be committed.

For the status values that these tables store, see [ARCHITECTURE.md](./ARCHITECTURE.md#state-model).

## Tables

### projects

- `id` TEXT PRIMARY KEY
- `name` TEXT NOT NULL UNIQUE
- `root_path` TEXT NOT NULL
- `is_enabled` INTEGER NOT NULL DEFAULT 1
- `default_model` TEXT
- `default_effort` TEXT
- `created_at` TEXT NOT NULL

### threads

- `id` TEXT PRIMARY KEY
- `project_id` TEXT NOT NULL, references `projects(id)`
- `codex_thread_id` TEXT NOT NULL UNIQUE
- `thread_name` TEXT
- `cwd` TEXT NOT NULL
- `status` TEXT NOT NULL
- `current_model` TEXT
- `current_effort` TEXT
- `active_turn_id` TEXT
- `queued_instruction` TEXT
- `last_seen_at` TEXT
- `created_at` TEXT NOT NULL

### approvals

- `id` TEXT PRIMARY KEY
- `thread_id` TEXT NOT NULL, references `threads(id)`
- `codex_request_id` TEXT NOT NULL
- `turn_id` TEXT
- `action_type` TEXT NOT NULL
- `summary` TEXT NOT NULL
- `status` TEXT NOT NULL
- `expires_at` TEXT
- `created_at` TEXT NOT NULL
- `resolved_at` TEXT
- UNIQUE (`thread_id`, `codex_request_id`)

### operator_messages

- `id` TEXT PRIMARY KEY
- `thread_id` TEXT NOT NULL, references `threads(id)`
- `source` TEXT NOT NULL
- `message_text` TEXT NOT NULL
- `delivery_mode` TEXT NOT NULL: `turn_start`, `steer_active_turn`, or `queue_next_instruction`
- `created_at` TEXT NOT NULL

### attachments

- `id` TEXT PRIMARY KEY
- `thread_id` TEXT NOT NULL, references `threads(id)`
- `telegram_file_id` TEXT NOT NULL
- `original_name` TEXT NOT NULL
- `mime_type` TEXT
- `size_bytes` INTEGER
- `local_path` TEXT NOT NULL
- `status` TEXT NOT NULL
- `created_at` TEXT NOT NULL

### artifacts

- `id` TEXT PRIMARY KEY
- `thread_id` TEXT NOT NULL, references `threads(id)`
- `artifact_type` TEXT NOT NULL
- `filename` TEXT NOT NULL
- `local_path` TEXT NOT NULL
- `size_bytes` INTEGER
- `status` TEXT NOT NULL
- `created_at` TEXT NOT NULL

### git_actions

- `id` TEXT PRIMARY KEY
- `thread_id` TEXT NOT NULL, references `threads(id)`
- `action_type` TEXT NOT NULL
- `target_branch` TEXT
- `status` TEXT NOT NULL
- `summary` TEXT
- `created_at` TEXT NOT NULL
- `resolved_at` TEXT

The Git guardrail code writes these rows for commit and push requests. No Telegram command calls it in the public alpha.

### event_log

An append-only journal of daemon events.

- `sequence` INTEGER PRIMARY KEY AUTOINCREMENT
- `event_id` TEXT NOT NULL UNIQUE
- `event_type` TEXT NOT NULL
- `occurred_at` TEXT NOT NULL
- `project_id`, `thread_id`, `turn_id` TEXT
- `causation_id`, `correlation_id` TEXT
- `payload_json` TEXT NOT NULL
- `created_at` TEXT NOT NULL

### idempotency_keys

Keys for commands and callbacks that RCC already handled. A repeated key is ignored.

- `idempotency_key` TEXT PRIMARY KEY
- `source` TEXT NOT NULL
- `created_at` TEXT NOT NULL

### stream_checkpoints

The last event ID that each named stream read, so a reader can resume.

- `checkpoint_name` TEXT PRIMARY KEY
- `last_event_id` TEXT NOT NULL
- `updated_at` TEXT NOT NULL

### health_snapshots

Periodic health records.

- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `daemon_alive` INTEGER NOT NULL
- `codex_transport_status` TEXT NOT NULL
- `last_event_at` TEXT
- `active_thread_count` INTEGER NOT NULL
- `sleep_prevention_state` TEXT NOT NULL
- `freshness_state` TEXT NOT NULL
- `created_at` TEXT NOT NULL

### model_policy_overrides

The model and reasoning effort that are queued for a thread's next turn.

- `thread_id` TEXT PRIMARY KEY, references `threads(id)`
- `next_model` TEXT
- `next_effort` TEXT
- `updated_at` TEXT NOT NULL

## Indexes

The migrations create these indexes:

- `threads(project_id, status)`
- `approvals(thread_id, status)`
- `attachments(thread_id, created_at)`
- `artifacts(thread_id, created_at)`
- `git_actions(thread_id, status)`
- `event_log(thread_id, occurred_at)`
