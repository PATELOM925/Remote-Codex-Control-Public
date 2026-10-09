# DB SCHEMA

## SQLite tables

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
- `project_id` TEXT NOT NULL
- `codex_thread_id` TEXT NOT NULL
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
- `thread_id` TEXT NOT NULL
- `codex_request_id` TEXT NOT NULL
- `turn_id` TEXT
- `action_type` TEXT NOT NULL
- `summary` TEXT NOT NULL
- `status` TEXT NOT NULL
- `expires_at` TEXT
- `created_at` TEXT NOT NULL
- `resolved_at` TEXT

### operator_messages
- `id` TEXT PRIMARY KEY
- `thread_id` TEXT NOT NULL
- `source` TEXT NOT NULL
- `message_text` TEXT NOT NULL
- `delivery_mode` TEXT NOT NULL
- `created_at` TEXT NOT NULL

### attachments
- `id` TEXT PRIMARY KEY
- `thread_id` TEXT NOT NULL
- `telegram_file_id` TEXT NOT NULL
- `original_name` TEXT NOT NULL
- `mime_type` TEXT
- `size_bytes` INTEGER
- `local_path` TEXT NOT NULL
- `status` TEXT NOT NULL
- `created_at` TEXT NOT NULL

### artifacts
- `id` TEXT PRIMARY KEY
- `thread_id` TEXT NOT NULL
- `artifact_type` TEXT NOT NULL
- `filename` TEXT NOT NULL
- `local_path` TEXT NOT NULL
- `size_bytes` INTEGER
- `status` TEXT NOT NULL
- `created_at` TEXT NOT NULL

### git_actions
- `id` TEXT PRIMARY KEY
- `thread_id` TEXT NOT NULL
- `action_type` TEXT NOT NULL
- `target_branch` TEXT
- `status` TEXT NOT NULL
- `summary` TEXT
- `created_at` TEXT NOT NULL
- `resolved_at` TEXT

### event_log
Append-only journal of daemon events, with the project, thread, and turn IDs and a JSON payload.

### idempotency_keys
Keys for commands and callbacks already handled. A repeated key is ignored.

### stream_checkpoints
The last event ID read for each named stream, so a reader can resume.

### health_snapshots
Periodic health records: daemon alive, Codex transport, freshness, and sleep prevention state.

### model_policy_overrides
The model and reasoning effort queued for a thread's next turn.

## Index recommendations
- `threads(project_id, status)`
- `approvals(thread_id, status)`
- `attachments(thread_id, created_at)`
- `artifacts(thread_id, created_at)`
- `git_actions(thread_id, status)`
