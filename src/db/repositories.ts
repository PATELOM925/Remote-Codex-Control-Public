import type { DatabaseSync } from 'node:sqlite';

import type {
  ApprovalStatus,
  ArtifactStatus,
  AttachmentStatus,
  DeliveryMode,
  FreshnessState,
  GitActionStatus,
  ReasoningEffort,
  SleepPreventionState,
  ThreadStatus,
  TransportStatus,
} from '../contracts/states.js';
import { newId } from '../utils/ids.js';
import { nowIso } from '../utils/time.js';

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  isEnabled: boolean;
  defaultModel?: string;
  defaultEffort?: ReasoningEffort;
  createdAt: string;
}

export interface ThreadRecord {
  id: string;
  projectId: string;
  codexThreadId: string;
  threadName?: string;
  cwd: string;
  status: ThreadStatus;
  currentModel?: string;
  currentEffort?: ReasoningEffort;
  activeTurnId?: string;
  queuedInstruction?: string;
  lastSeenAt?: string;
  createdAt: string;
}

export interface ApprovalRecord {
  id: string;
  threadId: string;
  codexRequestId: string;
  turnId?: string;
  actionType: string;
  summary: string;
  status: ApprovalStatus;
  expiresAt?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface AttachmentRecord {
  id: string;
  threadId: string;
  telegramFileId: string;
  originalName: string;
  mimeType?: string;
  sizeBytes?: number;
  localPath: string;
  status: AttachmentStatus;
  createdAt: string;
}

export interface ArtifactRecord {
  id: string;
  threadId: string;
  artifactType: string;
  filename: string;
  localPath: string;
  sizeBytes?: number;
  status: ArtifactStatus;
  createdAt: string;
}

export interface GitActionRecord {
  id: string;
  threadId: string;
  actionType: string;
  targetBranch?: string;
  status: GitActionStatus;
  summary?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface HealthSnapshotRecord {
  daemonAlive: boolean;
  codexTransportStatus: TransportStatus;
  lastEventAt?: string;
  activeThreadCount: number;
  sleepPreventionState: SleepPreventionState;
  freshnessState: FreshnessState;
  createdAt: string;
}

export interface OperatorMessageRecord {
  id: string;
  threadId: string;
  source: string;
  messageText: string;
  deliveryMode: DeliveryMode;
  createdAt: string;
}

export interface TurnOutputRecord {
  sequence: number;
  occurredAt: string;
  threadId: string;
  turnId?: string;
  kind: 'assistant_text' | 'tool_status' | 'system';
  text: string;
  method?: string;
}

export interface ReasoningSummaryRecord {
  sequence: number;
  occurredAt: string;
  threadId: string;
  turnId?: string;
  text: string;
  method?: string;
  source: 'app_server';
}

export class RccRepository {
  constructor(private readonly db: DatabaseSync) {}

  insertProject(project: Omit<ProjectRecord, 'createdAt'> & { createdAt?: string }): ProjectRecord {
    const record: ProjectRecord = {
      ...project,
      isEnabled: project.isEnabled,
      createdAt: project.createdAt ?? nowIso(),
    };

    // Upsert by id. A clash on the unique name raises an error and never deletes another project.
    this.db
      .prepare(
        `INSERT INTO projects (id, name, root_path, is_enabled, default_model, default_effort, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           root_path = excluded.root_path,
           is_enabled = excluded.is_enabled,
           default_model = excluded.default_model,
           default_effort = excluded.default_effort,
           created_at = excluded.created_at`
      )
      .run(
        record.id,
        record.name,
        record.rootPath,
        record.isEnabled ? 1 : 0,
        record.defaultModel ?? null,
        record.defaultEffort ?? null,
        record.createdAt,
      );

    return record;
  }

  listProjects(includeDisabled = false): ProjectRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, root_path, is_enabled, default_model, default_effort, created_at FROM projects ${includeDisabled ? '' : 'WHERE is_enabled = 1'} ORDER BY name ASC`
      )
      .all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      rootPath: String(row.root_path),
      isEnabled: Number(row.is_enabled) === 1,
      defaultModel: row.default_model ? String(row.default_model) : undefined,
      defaultEffort: row.default_effort ? (String(row.default_effort) as ReasoningEffort) : undefined,
      createdAt: String(row.created_at),
    }));
  }

  getProjectById(projectId: string): ProjectRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT id, name, root_path, is_enabled, default_model, default_effort, created_at FROM projects WHERE id = ? LIMIT 1'
      )
      .get(projectId) as Record<string, unknown> | undefined;

    if (!row) {
      return undefined;
    }

    return {
      id: String(row.id),
      name: String(row.name),
      rootPath: String(row.root_path),
      isEnabled: Number(row.is_enabled) === 1,
      defaultModel: row.default_model ? String(row.default_model) : undefined,
      defaultEffort: row.default_effort ? (String(row.default_effort) as ReasoningEffort) : undefined,
      createdAt: String(row.created_at),
    };
  }

  updateProjectName(projectId: string, name: string): ProjectRecord {
    this.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, projectId);
    const updated = this.getProjectById(projectId);
    if (!updated) {
      throw new Error(`Project ${projectId} not found after rename`);
    }
    return updated;
  }

  insertThread(thread: Omit<ThreadRecord, 'createdAt' | 'lastSeenAt'> & { createdAt?: string; lastSeenAt?: string }): ThreadRecord {
    const record: ThreadRecord = {
      ...thread,
      createdAt: thread.createdAt ?? nowIso(),
      lastSeenAt: thread.lastSeenAt ?? nowIso(),
    };

    this.db
      .prepare(
        'INSERT OR REPLACE INTO threads (id, project_id, codex_thread_id, thread_name, cwd, status, current_model, current_effort, active_turn_id, queued_instruction, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        record.id,
        record.projectId,
        record.codexThreadId,
        record.threadName ?? null,
        record.cwd,
        record.status,
        record.currentModel ?? null,
        record.currentEffort ?? null,
        record.activeTurnId ?? null,
        record.queuedInstruction ?? null,
        record.lastSeenAt ?? null,
        record.createdAt,
      );

    return record;
  }

  updateThreadStatus(threadId: string, status: ThreadStatus): void {
    this.db.prepare('UPDATE threads SET status = ?, last_seen_at = ? WHERE id = ?').run(status, nowIso(), threadId);
  }

  updateActiveTurn(threadId: string, turnId?: string): void {
    this.db
      .prepare('UPDATE threads SET active_turn_id = ?, last_seen_at = ? WHERE id = ?')
      .run(turnId ?? null, nowIso(), threadId);
  }

  updateThreadModel(threadId: string, model?: string, effort?: ReasoningEffort): void {
    this.db
      .prepare('UPDATE threads SET current_model = ?, current_effort = ?, last_seen_at = ? WHERE id = ?')
      .run(model ?? null, effort ?? null, nowIso(), threadId);
  }

  queueInstruction(threadId: string, message: string): void {
    this.db
      .prepare('UPDATE threads SET queued_instruction = ?, status = ?, last_seen_at = ? WHERE id = ?')
      .run(message, 'waiting_operator', nowIso(), threadId);
  }

  popQueuedInstruction(threadId: string): string | undefined {
    const row = this.db
      .prepare('SELECT queued_instruction FROM threads WHERE id = ? LIMIT 1')
      .get(threadId) as { queued_instruction: string | null } | undefined;

    if (!row?.queued_instruction) {
      return undefined;
    }

    this.db.prepare('UPDATE threads SET queued_instruction = NULL, last_seen_at = ? WHERE id = ?').run(nowIso(), threadId);
    return row.queued_instruction;
  }

  getThreadById(threadId: string): ThreadRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT id, project_id, codex_thread_id, thread_name, cwd, status, current_model, current_effort, active_turn_id, queued_instruction, last_seen_at, created_at FROM threads WHERE id = ? LIMIT 1'
      )
      .get(threadId) as Record<string, unknown> | undefined;

    if (!row) {
      return undefined;
    }

    return this.mapThread(row);
  }

  getThreadByCodexThreadId(codexThreadId: string): ThreadRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT id, project_id, codex_thread_id, thread_name, cwd, status, current_model, current_effort, active_turn_id, queued_instruction, last_seen_at, created_at FROM threads WHERE codex_thread_id = ? LIMIT 1'
      )
      .get(codexThreadId) as Record<string, unknown> | undefined;

    if (!row) {
      return undefined;
    }

    return this.mapThread(row);
  }

  listThreads(projectId?: string): ThreadRecord[] {
    const sql = projectId
      ? 'SELECT id, project_id, codex_thread_id, thread_name, cwd, status, current_model, current_effort, active_turn_id, queued_instruction, last_seen_at, created_at FROM threads WHERE project_id = ? ORDER BY last_seen_at DESC'
      : 'SELECT id, project_id, codex_thread_id, thread_name, cwd, status, current_model, current_effort, active_turn_id, queued_instruction, last_seen_at, created_at FROM threads ORDER BY last_seen_at DESC';

    const rows = (projectId ? this.db.prepare(sql).all(projectId) : this.db.prepare(sql).all()) as Array<Record<string, unknown>>;

    return rows.map((row) => this.mapThread(row));
  }

  countRunningThreads(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM threads WHERE status IN ('running', 'waiting_approval', 'waiting_operator')")
      .get() as { count: number };
    return row.count;
  }

  createApproval(input: Omit<ApprovalRecord, 'createdAt' | 'status' | 'resolvedAt'> & { status?: ApprovalStatus; createdAt?: string }): ApprovalRecord {
    const record: ApprovalRecord = {
      ...input,
      status: input.status ?? 'pending',
      createdAt: input.createdAt ?? nowIso(),
      resolvedAt: undefined,
    };

    this.db
      .prepare(
        'INSERT OR REPLACE INTO approvals (id, thread_id, codex_request_id, turn_id, action_type, summary, status, expires_at, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        record.id,
        record.threadId,
        record.codexRequestId,
        record.turnId ?? null,
        record.actionType,
        record.summary,
        record.status,
        record.expiresAt ?? null,
        record.createdAt,
        null,
      );

    return record;
  }

  updateApprovalStatus(approvalId: string, status: ApprovalStatus): void {
    const resolvedAt = status === 'pending' ? null : nowIso();
    this.db.prepare('UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ?').run(status, resolvedAt, approvalId);
  }

  findApprovalById(approvalId: string): ApprovalRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT id, thread_id, codex_request_id, turn_id, action_type, summary, status, expires_at, created_at, resolved_at FROM approvals WHERE id = ? LIMIT 1'
      )
      .get(approvalId) as Record<string, unknown> | undefined;

    if (!row) {
      return undefined;
    }

    return {
      id: String(row.id),
      threadId: String(row.thread_id),
      codexRequestId: String(row.codex_request_id),
      turnId: row.turn_id ? String(row.turn_id) : undefined,
      actionType: String(row.action_type),
      summary: String(row.summary),
      status: String(row.status) as ApprovalStatus,
      expiresAt: row.expires_at ? String(row.expires_at) : undefined,
      createdAt: String(row.created_at),
      resolvedAt: row.resolved_at ? String(row.resolved_at) : undefined,
    };
  }

  findApprovalByCodexRequestId(codexRequestId: string): ApprovalRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT id, thread_id, codex_request_id, turn_id, action_type, summary, status, expires_at, created_at, resolved_at FROM approvals WHERE codex_request_id = ? LIMIT 1'
      )
      .get(codexRequestId) as Record<string, unknown> | undefined;

    if (!row) {
      return undefined;
    }

    return {
      id: String(row.id),
      threadId: String(row.thread_id),
      codexRequestId: String(row.codex_request_id),
      turnId: row.turn_id ? String(row.turn_id) : undefined,
      actionType: String(row.action_type),
      summary: String(row.summary),
      status: String(row.status) as ApprovalStatus,
      expiresAt: row.expires_at ? String(row.expires_at) : undefined,
      createdAt: String(row.created_at),
      resolvedAt: row.resolved_at ? String(row.resolved_at) : undefined,
    };
  }

  listApprovals(threadId?: string): ApprovalRecord[] {
    const sql = threadId
      ? 'SELECT id, thread_id, codex_request_id, turn_id, action_type, summary, status, expires_at, created_at, resolved_at FROM approvals WHERE thread_id = ? ORDER BY created_at DESC'
      : 'SELECT id, thread_id, codex_request_id, turn_id, action_type, summary, status, expires_at, created_at, resolved_at FROM approvals ORDER BY created_at DESC';
    const rows = (threadId ? this.db.prepare(sql).all(threadId) : this.db.prepare(sql).all()) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      threadId: String(row.thread_id),
      codexRequestId: String(row.codex_request_id),
      turnId: row.turn_id ? String(row.turn_id) : undefined,
      actionType: String(row.action_type),
      summary: String(row.summary),
      status: String(row.status) as ApprovalStatus,
      expiresAt: row.expires_at ? String(row.expires_at) : undefined,
      createdAt: String(row.created_at),
      resolvedAt: row.resolved_at ? String(row.resolved_at) : undefined,
    }));
  }

  listPendingApprovals(): ApprovalRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, thread_id, codex_request_id, turn_id, action_type, summary, status, expires_at, created_at, resolved_at
         FROM approvals
         WHERE status = 'pending'
         ORDER BY created_at DESC`
      )
      .all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      threadId: String(row.thread_id),
      codexRequestId: String(row.codex_request_id),
      turnId: row.turn_id ? String(row.turn_id) : undefined,
      actionType: String(row.action_type) as ApprovalRecord['actionType'],
      summary: String(row.summary),
      status: String(row.status) as ApprovalStatus,
      expiresAt: row.expires_at ? String(row.expires_at) : undefined,
      createdAt: String(row.created_at),
      resolvedAt: row.resolved_at ? String(row.resolved_at) : undefined,
    }));
  }

  /**
   * Returns the id of the approval that superseded this one. Only the 200 most recent
   * superseded events are searched.
   */
  findSupersedingApprovalId(approvalId: string): string | undefined {
    // CASE stops json_extract from running on a malformed payload, which is then skipped.
    const row = this.db
      .prepare(
        `SELECT json_extract(payload_json, '$.supersededByApprovalId') AS superseded_by
         FROM event_log
         WHERE event_type = 'ApprovalSuperseded'
           AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.approvalId') END = ?
         ORDER BY sequence DESC
         LIMIT 1`
      )
      .get(approvalId) as { superseded_by: string | null } | undefined;
    return row?.superseded_by ?? undefined;
  }

  /**
   * Marks other pending approvals as superseded. The scope is the turn when turnId is set,
   * otherwise the whole thread.
   */
  supersedePendingApprovals(threadId: string, keepApprovalId: string, turnId?: string): string[] {
    const rows = (turnId
      ? this.db
          .prepare('SELECT id FROM approvals WHERE thread_id = ? AND status = ? AND id != ? AND turn_id = ?')
          .all(threadId, 'pending', keepApprovalId, turnId)
      : this.db
          .prepare('SELECT id FROM approvals WHERE thread_id = ? AND status = ? AND id != ?')
          .all(threadId, 'pending', keepApprovalId)) as Array<{ id: string }>;

    // One transaction, so a failure part-way leaves every approval pending.
    this.db.exec('BEGIN;');
    try {
      for (const row of rows) {
        this.db.prepare('UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ?').run('superseded', nowIso(), row.id);
      }
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }

    return rows.map((row) => row.id);
  }

  addOperatorMessage(threadId: string, messageText: string, deliveryMode: DeliveryMode): void {
    this.db
      .prepare('INSERT INTO operator_messages (id, thread_id, source, message_text, delivery_mode, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(newId(), threadId, 'telegram', messageText, deliveryMode, nowIso());
  }

  listOperatorMessages(threadId: string, limit = 10): OperatorMessageRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id, thread_id, source, message_text, delivery_mode, created_at FROM operator_messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?'
      )
      .all(threadId, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      threadId: String(row.thread_id),
      source: String(row.source),
      messageText: String(row.message_text),
      deliveryMode: String(row.delivery_mode) as DeliveryMode,
      createdAt: String(row.created_at),
    }));
  }

  listRecentTurnOutputs(threadId: string, limit = 10): TurnOutputRecord[] {
    const requestedLimit = Math.max(1, limit);
    // Scan extra rows, because noise filtering removes many of them.
    const scanLimit = Math.min(Math.max(requestedLimit * 10, 25), 250);
    const rows = this.db
      .prepare(
        `SELECT sequence, occurred_at, thread_id, turn_id, payload_json
         FROM event_log
         WHERE thread_id = ? AND event_type = 'TurnOutputObserved'
         ORDER BY sequence DESC
         LIMIT ?`
      )
      .all(threadId, scanLimit) as Array<Record<string, unknown>>;

    return rows
      .map((row) => {
        const payload = JSON.parse(String(row.payload_json)) as {
          threadId?: string;
          turnId?: string;
          kind?: 'assistant_text' | 'tool_status' | 'system';
          text?: string;
          method?: string;
        };

        return {
          sequence: Number(row.sequence),
          occurredAt: String(row.occurred_at),
          threadId: String(row.thread_id),
          turnId: row.turn_id ? String(row.turn_id) : payload.turnId,
          kind: payload.kind ?? 'system',
          text: payload.text ?? '',
          method: payload.method,
        } satisfies TurnOutputRecord;
      })
      .filter((record) => Boolean(record.text) && !this.isTurnOutputNoise(record))
      .slice(0, requestedLimit);
  }

  /** Drops protocol chatter. Tool status lines are kept only when they report a failure. */
  private isTurnOutputNoise(record: TurnOutputRecord): boolean {
    const text = record.text.trim();
    const method = record.method?.trim() ?? '';
    const noisyExact = new Set([
      'item/started',
      'item/completed',
      'thread/tokenUsage/updated',
      'turn/diff/updated',
    ]);
    if (noisyExact.has(text) || noisyExact.has(method)) {
      return true;
    }
    if (record.kind === 'tool_status' && !/error|failed|not found|permission denied/i.test(text)) {
      return true;
    }
    return false;
  }

  listRecentReasoningSummaries(threadId: string, limit = 10): ReasoningSummaryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT sequence, occurred_at, thread_id, turn_id, payload_json
         FROM event_log
         WHERE thread_id = ? AND event_type = 'ReasoningSummaryObserved'
         ORDER BY sequence DESC
         LIMIT ?`
      )
      .all(threadId, limit) as Array<Record<string, unknown>>;

    return rows
      .map((row) => {
        const payload = JSON.parse(String(row.payload_json)) as {
          threadId?: string;
          turnId?: string;
          text?: string;
          method?: string;
          source?: 'app_server';
        };

        return {
          sequence: Number(row.sequence),
          occurredAt: String(row.occurred_at),
          threadId: String(row.thread_id),
          turnId: row.turn_id ? String(row.turn_id) : payload.turnId,
          text: payload.text ?? '',
          method: payload.method,
          source: 'app_server',
        } satisfies ReasoningSummaryRecord;
      })
      .filter((record) => Boolean(record.text));
  }

  createAttachment(input: Omit<AttachmentRecord, 'createdAt'> & { createdAt?: string }): AttachmentRecord {
    const record: AttachmentRecord = {
      ...input,
      createdAt: input.createdAt ?? nowIso(),
    };

    this.db
      .prepare(
        'INSERT INTO attachments (id, thread_id, telegram_file_id, original_name, mime_type, size_bytes, local_path, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        record.id,
        record.threadId,
        record.telegramFileId,
        record.originalName,
        record.mimeType ?? null,
        record.sizeBytes ?? null,
        record.localPath,
        record.status,
        record.createdAt,
      );

    return record;
  }

  updateAttachmentStatus(attachmentId: string, status: AttachmentStatus, localPath?: string): void {
    this.db
      .prepare('UPDATE attachments SET status = ?, local_path = COALESCE(?, local_path) WHERE id = ?')
      .run(status, localPath ?? null, attachmentId);
  }

  createArtifact(input: Omit<ArtifactRecord, 'createdAt'> & { createdAt?: string }): ArtifactRecord {
    const record: ArtifactRecord = {
      ...input,
      createdAt: input.createdAt ?? nowIso(),
    };

    this.db
      .prepare(
        'INSERT INTO artifacts (id, thread_id, artifact_type, filename, local_path, size_bytes, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        record.id,
        record.threadId,
        record.artifactType,
        record.filename,
        record.localPath,
        record.sizeBytes ?? null,
        record.status,
        record.createdAt,
      );

    return record;
  }

  listArtifactsByThread(threadId: string): ArtifactRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id, thread_id, artifact_type, filename, local_path, size_bytes, status, created_at FROM artifacts WHERE thread_id = ? ORDER BY created_at DESC'
      )
      .all(threadId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      threadId: String(row.thread_id),
      artifactType: String(row.artifact_type),
      filename: String(row.filename),
      localPath: String(row.local_path),
      sizeBytes: row.size_bytes ? Number(row.size_bytes) : undefined,
      status: String(row.status) as ArtifactStatus,
      createdAt: String(row.created_at),
    }));
  }

  listPendingArtifactsByThread(threadId: string): ArtifactRecord[] {
    const rows = this.db
      .prepare(
        "SELECT id, thread_id, artifact_type, filename, local_path, size_bytes, status, created_at FROM artifacts WHERE thread_id = ? AND status = 'detected' ORDER BY created_at DESC"
      )
      .all(threadId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      threadId: String(row.thread_id),
      artifactType: String(row.artifact_type),
      filename: String(row.filename),
      localPath: String(row.local_path),
      sizeBytes: row.size_bytes ? Number(row.size_bytes) : undefined,
      status: String(row.status) as ArtifactStatus,
      createdAt: String(row.created_at),
    }));
  }

  updateArtifactStatus(artifactId: string, status: ArtifactStatus): void {
    this.db.prepare('UPDATE artifacts SET status = ? WHERE id = ?').run(status, artifactId);
  }

  markAllDetectedArtifactsAsSent(): number {
    const result = this.db.prepare("UPDATE artifacts SET status = 'sent' WHERE status = 'detected'").run();
    return Number(result.changes ?? 0);
  }

  createGitAction(threadId: string, actionType: string, targetBranch?: string, summary?: string): GitActionRecord {
    const record: GitActionRecord = {
      id: newId(),
      threadId,
      actionType,
      targetBranch,
      status: 'pending',
      summary,
      createdAt: nowIso(),
      resolvedAt: undefined,
    };

    this.db
      .prepare(
        'INSERT INTO git_actions (id, thread_id, action_type, target_branch, status, summary, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        record.id,
        record.threadId,
        record.actionType,
        record.targetBranch ?? null,
        record.status,
        record.summary ?? null,
        record.createdAt,
        null,
      );

    return record;
  }

  updateGitActionStatus(gitActionId: string, status: GitActionStatus, summary?: string): void {
    const resolvedAt = status === 'pending' ? null : nowIso();
    this.db
      .prepare('UPDATE git_actions SET status = ?, summary = COALESCE(?, summary), resolved_at = ? WHERE id = ?')
      .run(status, summary ?? null, resolvedAt, gitActionId);
  }

  findGitActionById(gitActionId: string): GitActionRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT id, thread_id, action_type, target_branch, status, summary, created_at, resolved_at FROM git_actions WHERE id = ? LIMIT 1'
      )
      .get(gitActionId) as Record<string, unknown> | undefined;

    if (!row) {
      return undefined;
    }

    return {
      id: String(row.id),
      threadId: String(row.thread_id),
      actionType: String(row.action_type),
      targetBranch: row.target_branch ? String(row.target_branch) : undefined,
      status: String(row.status) as GitActionStatus,
      summary: row.summary ? String(row.summary) : undefined,
      createdAt: String(row.created_at),
      resolvedAt: row.resolved_at ? String(row.resolved_at) : undefined,
    };
  }

  saveModelOverride(threadId: string, nextModel?: string, nextEffort?: ReasoningEffort): void {
    this.db
      .prepare(
        'INSERT INTO model_policy_overrides (thread_id, next_model, next_effort, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET next_model = excluded.next_model, next_effort = excluded.next_effort, updated_at = excluded.updated_at'
      )
      .run(threadId, nextModel ?? null, nextEffort ?? null, nowIso());
  }

  getModelOverride(threadId: string): { nextModel?: string; nextEffort?: ReasoningEffort } | undefined {
    const row = this.db
      .prepare('SELECT next_model, next_effort FROM model_policy_overrides WHERE thread_id = ? LIMIT 1')
      .get(threadId) as { next_model: string | null; next_effort: string | null } | undefined;

    if (!row) {
      return undefined;
    }

    return {
      nextModel: row.next_model ?? undefined,
      nextEffort: row.next_effort ? (row.next_effort as ReasoningEffort) : undefined,
    };
  }

  clearModelOverride(threadId: string): void {
    this.db.prepare('DELETE FROM model_policy_overrides WHERE thread_id = ?').run(threadId);
  }

  saveHealthSnapshot(snapshot: Omit<HealthSnapshotRecord, 'createdAt'>): HealthSnapshotRecord {
    const record: HealthSnapshotRecord = {
      ...snapshot,
      createdAt: nowIso(),
    };

    this.db
      .prepare(
        'INSERT INTO health_snapshots (daemon_alive, codex_transport_status, last_event_at, active_thread_count, sleep_prevention_state, freshness_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        record.daemonAlive ? 1 : 0,
        record.codexTransportStatus,
        record.lastEventAt ?? null,
        record.activeThreadCount,
        record.sleepPreventionState,
        record.freshnessState,
        record.createdAt,
      );

    return record;
  }

  latestHealthSnapshot(): HealthSnapshotRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT daemon_alive, codex_transport_status, last_event_at, active_thread_count, sleep_prevention_state, freshness_state, created_at FROM health_snapshots ORDER BY id DESC LIMIT 1'
      )
      .get() as Record<string, unknown> | undefined;

    if (!row) {
      return undefined;
    }

    return {
      daemonAlive: Number(row.daemon_alive) === 1,
      codexTransportStatus: String(row.codex_transport_status) as TransportStatus,
      lastEventAt: row.last_event_at ? String(row.last_event_at) : undefined,
      activeThreadCount: Number(row.active_thread_count),
      sleepPreventionState: String(row.sleep_prevention_state) as SleepPreventionState,
      freshnessState: String(row.freshness_state) as FreshnessState,
      createdAt: String(row.created_at),
    };
  }

  private mapThread(row: Record<string, unknown>): ThreadRecord {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      codexThreadId: String(row.codex_thread_id),
      threadName: row.thread_name ? String(row.thread_name) : undefined,
      cwd: String(row.cwd),
      status: String(row.status) as ThreadStatus,
      currentModel: row.current_model ? String(row.current_model) : undefined,
      currentEffort: row.current_effort ? (String(row.current_effort) as ReasoningEffort) : undefined,
      activeTurnId: row.active_turn_id ? String(row.active_turn_id) : undefined,
      queuedInstruction: row.queued_instruction ? String(row.queued_instruction) : undefined,
      lastSeenAt: row.last_seen_at ? String(row.last_seen_at) : undefined,
      createdAt: String(row.created_at),
    };
  }
}
