import type { DatabaseSync } from 'node:sqlite';

import { nowIso } from '../utils/time.js';

const MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    root_path TEXT NOT NULL,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    default_model TEXT,
    default_effort TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    codex_thread_id TEXT NOT NULL UNIQUE,
    thread_name TEXT,
    cwd TEXT NOT NULL,
    status TEXT NOT NULL,
    current_model TEXT,
    current_effort TEXT,
    active_turn_id TEXT,
    queued_instruction TEXT,
    last_seen_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id)
  );

  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    codex_request_id TEXT NOT NULL,
    turn_id TEXT,
    action_type TEXT NOT NULL,
    summary TEXT NOT NULL,
    status TEXT NOT NULL,
    expires_at TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    UNIQUE(thread_id, codex_request_id),
    FOREIGN KEY(thread_id) REFERENCES threads(id)
  );

  CREATE TABLE IF NOT EXISTS operator_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    source TEXT NOT NULL,
    message_text TEXT NOT NULL,
    delivery_mode TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(thread_id) REFERENCES threads(id)
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    telegram_file_id TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER,
    local_path TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(thread_id) REFERENCES threads(id)
  );

  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    artifact_type TEXT NOT NULL,
    filename TEXT NOT NULL,
    local_path TEXT NOT NULL,
    size_bytes INTEGER,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(thread_id) REFERENCES threads(id)
  );

  CREATE TABLE IF NOT EXISTS git_actions (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    target_branch TEXT,
    status TEXT NOT NULL,
    summary TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    FOREIGN KEY(thread_id) REFERENCES threads(id)
  );

  CREATE TABLE IF NOT EXISTS event_log (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    project_id TEXT,
    thread_id TEXT,
    turn_id TEXT,
    causation_id TEXT,
    correlation_id TEXT,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS idempotency_keys (
    idempotency_key TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS stream_checkpoints (
    checkpoint_name TEXT PRIMARY KEY,
    last_event_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS health_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    daemon_alive INTEGER NOT NULL,
    codex_transport_status TEXT NOT NULL,
    last_event_at TEXT,
    active_thread_count INTEGER NOT NULL,
    sleep_prevention_state TEXT NOT NULL,
    freshness_state TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS model_policy_overrides (
    thread_id TEXT PRIMARY KEY,
    next_model TEXT,
    next_effort TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(thread_id) REFERENCES threads(id)
  );

  CREATE INDEX IF NOT EXISTS idx_threads_project_status ON threads(project_id, status);
  CREATE INDEX IF NOT EXISTS idx_approvals_thread_status ON approvals(thread_id, status);
  CREATE INDEX IF NOT EXISTS idx_attachments_thread_created ON attachments(thread_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_artifacts_thread_created ON artifacts(thread_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_git_actions_thread_status ON git_actions(thread_id, status);
  CREATE INDEX IF NOT EXISTS idx_event_log_thread_time ON event_log(thread_id, occurred_at);
  `,
];

export const runMigrations = (db: DatabaseSync): void => {
  db.exec('BEGIN;');
  try {
    for (const migrationSql of MIGRATIONS) {
      db.exec(migrationSql);
    }

    db.prepare(
      `INSERT OR IGNORE INTO stream_checkpoints (checkpoint_name, last_event_id, updated_at)
       VALUES ('projection', 'none', ?)`
    ).run(nowIso());

    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
};
