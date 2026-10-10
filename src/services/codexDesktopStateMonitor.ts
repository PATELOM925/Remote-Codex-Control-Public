import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type {
  ApprovalAwaitingOperatorPayload,
  ApprovalResolutionAckedPayload,
  ApprovalSupersededPayload,
  RccEventEnvelope,
} from '../contracts/events.js';
import type { ApprovalActionType, ApprovalStatus, ThreadStatus } from '../contracts/states.js';
import type { RccRepository, ThreadRecord } from '../db/repositories.js';
import type { EventJournal } from '../event-journal/eventJournal.js';
import type { Logger } from '../logger.js';
import type { RccEventBus } from '../runtime/eventBus.js';
import { newId } from '../utils/ids.js';

import { SessionRegistryAgent } from '../agents/sessionRegistryAgent.js';

interface DesktopLogRow {
  id: number;
  ts: number;
  thread_id?: string | null;
  target?: string | null;
  feedback_log_body?: string | null;
}

interface DesktopThreadRow {
  id: string;
  cwd: string;
  title: string;
}

interface DesktopApprovalState {
  callId: string;
  codexThreadId: string;
  turnId?: string;
  toolName?: string;
  summary?: string;
  actionType?: ApprovalActionType;
  waiting: boolean;
  decision?: Extract<ApprovalStatus, 'approved' | 'denied'>;
  approvalId?: string;
  lastSeenLogId: number;
  waitingSinceMs?: number;
}

export interface CodexDesktopStateMonitorOptions {
  codexHome?: string;
  pollIntervalMs?: number;
  bootstrapRows?: number;
  approvalCardGraceMs?: number;
}

export class CodexDesktopStateMonitor {
  private static readonly CHECKPOINT_NAME = 'desktop_logs_last_id';
  private readonly codexHome: string;
  private readonly pollIntervalMs: number;
  private readonly bootstrapRows: number;
  private readonly recoveryWindowMs: number;
  private readonly approvalCardGraceMs: number;

  private timer?: NodeJS.Timeout;
  private logDbPath?: string;
  private stateDbPath?: string;
  private logDb?: DatabaseSync;
  private stateDb?: DatabaseSync;
  private lastProcessedLogId = 0;
  private lastCheckpointedLogId = 0;
  private bootstrapped = false;
  private reconcilePromise?: Promise<void>;
  private readonly approvalsByCallId = new Map<string, DesktopApprovalState>();
  private readonly recentActivityMsByThread = new Map<string, number>();

  constructor(
    private readonly repository: RccRepository,
    private readonly sessionRegistry: SessionRegistryAgent,
    private readonly journal: EventJournal,
    private readonly eventBus: RccEventBus,
    private readonly logger: Logger,
    options: CodexDesktopStateMonitorOptions = {},
  ) {
    const home = options.codexHome ?? (process.env.HOME ? path.join(process.env.HOME, '.codex') : undefined);
    if (!home) {
      throw new Error('HOME is not set; cannot locate Codex desktop state.');
    }
    this.codexHome = home;
    const pollEnv = Number(process.env.RCC_CODEX_DESKTOP_POLL_MS ?? NaN);
    const bootstrapEnv = Number(process.env.RCC_CODEX_DESKTOP_BOOTSTRAP_ROWS ?? NaN);
    const recoveryWindowEnv = Number(process.env.RCC_CODEX_DESKTOP_RECOVERY_WINDOW_MS ?? NaN);
    const approvalGraceEnv = Number(process.env.RCC_CODEX_DESKTOP_APPROVAL_CARD_GRACE_MS ?? NaN);
    this.pollIntervalMs = options.pollIntervalMs ?? (Number.isFinite(pollEnv) ? pollEnv : 2_000);
    this.bootstrapRows = options.bootstrapRows ?? (Number.isFinite(bootstrapEnv) ? bootstrapEnv : 200_000);
    this.recoveryWindowMs = Number.isFinite(recoveryWindowEnv) ? recoveryWindowEnv : 24 * 60 * 60 * 1000;
    this.approvalCardGraceMs =
      options.approvalCardGraceMs ?? (Number.isFinite(approvalGraceEnv) ? approvalGraceEnv : 1_500);

    const checkpoint = this.journal.checkpointEventId(CodexDesktopStateMonitor.CHECKPOINT_NAME);
    if (checkpoint) {
      const parsed = Number(checkpoint);
      if (Number.isFinite(parsed) && parsed > 0) {
        this.lastProcessedLogId = Math.floor(parsed);
        this.lastCheckpointedLogId = this.lastProcessedLogId;
      }
    }
  }

  start(): void {
    void this.reconcileNow();
    this.timer = setInterval(() => {
      void this.reconcileNow();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.closeDbs();
  }

  async reconcileNow(): Promise<void> {
    if (this.reconcilePromise) {
      return this.reconcilePromise;
    }
    this.reconcilePromise = this.reconcileOnce().finally(() => {
      this.reconcilePromise = undefined;
    });
    return this.reconcilePromise;
  }

  private async reconcileOnce(): Promise<void> {
    try {
      const logDb = this.openLogDb();
      if (!logDb) {
        return;
      }

      let isBootstrapPass = false;
      if (!this.bootstrapped) {
        const maxRow = logDb.prepare('SELECT COALESCE(MAX(id), 0) as max_id FROM logs').get() as { max_id: number };
        const maxId = Number(maxRow?.max_id ?? 0);
        // Replay the trailing window on startup, even when a checkpoint exists. This keeps
        // approvals that were still waiting while RCC was down from being missed.
        const startId = Math.max(0, maxId - this.bootstrapRows);
        const rewindTo = Math.max(0, startId - 1);
        this.lastProcessedLogId = this.lastProcessedLogId === 0 ? rewindTo : Math.min(this.lastProcessedLogId, rewindTo);
        this.bootstrapped = true;
        isBootstrapPass = true;
      }

      while (true) {
        const rows = logDb
          .prepare(
            `SELECT id, ts, thread_id, target, feedback_log_body
             FROM logs
             WHERE id > ? AND thread_id IS NOT NULL AND thread_id != ''
             ORDER BY id ASC
             LIMIT 1000`,
          )
          .all(this.lastProcessedLogId) as unknown as DesktopLogRow[];

        if (rows.length === 0) {
          break;
        }

        this.processRows(rows, { allowLiveFlush: !isBootstrapPass });
      }

      this.recoverRecentUnresolvedToolGates(logDb);

      if (this.lastProcessedLogId !== this.lastCheckpointedLogId) {
        this.journal.checkpoint(CodexDesktopStateMonitor.CHECKPOINT_NAME, String(this.lastProcessedLogId));
        this.lastCheckpointedLogId = this.lastProcessedLogId;
      }
    } catch (error) {
      this.logger.warn('desktop-state-monitor-failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getRecentActivity(threadId: string, windowMs: number): { active: boolean; mtimeMs?: number } {
    const mtimeMs = this.recentActivityMsByThread.get(threadId);
    if (!mtimeMs) {
      return { active: false };
    }
    return {
      active: Date.now() - mtimeMs <= windowMs,
      mtimeMs,
    };
  }

  getThreadUpdatedAtMs(threadId: string): number | undefined {
    const stateDb = this.openStateDb();
    if (!stateDb) {
      return undefined;
    }
    try {
      const row = stateDb.prepare('SELECT updated_at_ms FROM threads WHERE id = ? LIMIT 1').get(threadId) as
        | { updated_at_ms: number | null }
        | undefined;
      const value = row?.updated_at_ms;
      if (typeof value !== 'number') {
        return undefined;
      }
      return value;
    } catch {
      return undefined;
    }
  }

  private processRows(rows: DesktopLogRow[], options: { allowLiveFlush: boolean }): void {
    for (const row of rows) {
      this.lastProcessedLogId = Math.max(this.lastProcessedLogId, row.id);

      const codexThreadId = row.thread_id ? String(row.thread_id) : undefined;
      if (codexThreadId) {
        this.recentActivityMsByThread.set(codexThreadId, Number(row.ts) * 1000);
      }

      const target = row.target ? String(row.target) : '';
      const body = row.feedback_log_body ? String(row.feedback_log_body) : '';
      if (!codexThreadId || !body) {
        continue;
      }

      if (target === 'codex_otel.log_only' && body.includes('event.name="codex.tool_result"')) {
        this.recordToolResult(codexThreadId, row.id, body);
        continue;
      }

      if (target === 'codex_core::tools::registry' && body.includes('waiting for tool gate')) {
        this.recordToolGateWaiting(codexThreadId, row.id, body);
        // Persist live gates at once. A matching "tool gate released" row can arrive in the
        // same poll batch, and waiting until the end of the batch would erase the card.
        // Historical rows are handled by the recovery pass, which avoids posting duplicate
        // cards on restart.
        if (options.allowLiveFlush && this.isFreshLiveGate(row.ts)) {
          this.flushPendingApprovals();
        }
        continue;
      }

      if (target === 'codex_core::tools::registry' && body.includes('tool gate released')) {
        this.recordToolGateReleased(codexThreadId, row.id, body);
        continue;
      }

      if (target === 'codex_otel.log_only' && body.includes('event.name="codex.tool_decision"')) {
        this.recordToolDecision(codexThreadId, row.id, body);
      }
    }
  }

  private recordToolResult(codexThreadId: string, logId: number, body: string): void {
    const callId = this.extractCallId(body);
    if (!callId) {
      return;
    }

    const state = this.upsertApprovalState(callId, codexThreadId, logId);
    state.toolName = this.extractToolName(body) ?? state.toolName;
    state.turnId = this.extractTurnId(body) ?? state.turnId;

    const args = this.extractArgumentsJson(body);
    if (args) {
      const action = this.inferActionType(state.toolName, args);
      if (action) {
        state.actionType = action;
      }
      const summary = this.summarizeToolCall(state.toolName, args);
      if (summary) {
        state.summary = summary;
      }
    }
  }

  private recordToolGateWaiting(codexThreadId: string, logId: number, body: string): void {
    const callId = this.extractCallId(body);
    if (!callId) {
      return;
    }

    const state = this.upsertApprovalState(callId, codexThreadId, logId);
    if (!state.waiting) {
      state.waitingSinceMs = Date.now();
    }
    state.waiting = true;
    state.turnId = this.extractTurnId(body) ?? state.turnId;
    state.toolName = this.extractToolName(body) ?? state.toolName;
  }

  private recordToolGateReleased(codexThreadId: string, logId: number, body: string): void {
    const callId = this.extractCallId(body);
    if (!callId) {
      return;
    }

    const state = this.upsertApprovalState(callId, codexThreadId, logId);
    state.waiting = false;
    state.lastSeenLogId = Math.max(state.lastSeenLogId, logId);
    this.resolveReleasedApproval(codexThreadId, state);
    const thread = this.sessionRegistry.findThreadByCodexThreadId(codexThreadId);
    if (thread && thread.status === 'waiting_approval') {
      this.sessionRegistry.setThreadStatus(thread.id, 'running');
    }
  }

  private resolveReleasedApproval(codexThreadId: string, state: DesktopApprovalState): void {
    const thread = this.ensureMappedThread(codexThreadId);
    if (!thread) {
      return;
    }

    const approval = state.approvalId
      ? this.repository.findApprovalById(state.approvalId)
      : this.repository.findApprovalByCodexRequestId(`desktop:${state.callId}`);
    if (!approval || approval.status !== 'pending') {
      return;
    }

    this.repository.updateApprovalStatus(approval.id, 'approved');
    this.publish(
      this.journal.createEnvelope<ApprovalResolutionAckedPayload>(
        'ApprovalResolutionAcked',
        {
          approvalId: approval.id,
          decision: 'approved',
          codexAckId: `desktop-log:${state.callId}`,
        },
        {
          projectId: thread.projectId,
          threadId: thread.id,
          turnId: approval.turnId,
        },
      ),
    );
  }

  private recordToolDecision(codexThreadId: string, logId: number, body: string): void {
    const callId = this.extractCallId(body);
    const decision = this.extractDecision(body);
    if (!callId || !decision) {
      return;
    }

    const state = this.upsertApprovalState(callId, codexThreadId, logId);
    state.waiting = false;
    state.decision = decision;

    const thread = this.ensureMappedThread(codexThreadId);
    if (!thread) {
      return;
    }

    const approval = state.approvalId
      ? this.repository.findApprovalById(state.approvalId)
      : this.repository.findApprovalByCodexRequestId(`desktop:${callId}`);
    if (!approval) {
      return;
    }

    state.approvalId = approval.id;
    if (approval.status !== 'pending') {
      return;
    }

    this.repository.updateApprovalStatus(approval.id, decision);
    this.publish(
      this.journal.createEnvelope<ApprovalResolutionAckedPayload>(
        'ApprovalResolutionAcked',
        {
          approvalId: approval.id,
          decision,
          codexAckId: `desktop-log:${callId}`,
        },
        {
          projectId: thread.projectId,
          threadId: thread.id,
          turnId: approval.turnId,
        },
      ),
    );
    const nextStatus: ThreadStatus = decision === 'approved' ? 'running' : 'interrupted';
    if (thread.status !== nextStatus) {
      this.sessionRegistry.setThreadStatus(thread.id, nextStatus);
    }
  }

  private ensureMappedThread(codexThreadId: string): ThreadRecord | undefined {
    const existing = this.sessionRegistry.findThreadByCodexThreadId(codexThreadId);
    if (existing) {
      return existing;
    }

    const stateDb = this.openStateDb();
    if (!stateDb) {
      return undefined;
    }

    const row = stateDb
      .prepare('SELECT id, cwd, title FROM threads WHERE id = ? LIMIT 1')
      .get(codexThreadId) as DesktopThreadRow | undefined;
    if (!row) {
      return undefined;
    }

    return this.sessionRegistry.ensureThreadForCodexThread({
      codexThreadId,
      cwd: row.cwd,
      threadName: this.compactTitle(row.title),
      status: 'idle',
    });
  }

  private flushPendingApprovals(): void {
    const pendingStates = [...this.approvalsByCallId.values()]
      .filter((state) => state.waiting)
      .sort((a, b) => b.lastSeenLogId - a.lastSeenLogId);

    for (const state of pendingStates) {
      if (!state.waiting) {
        continue;
      }

      if (!this.isReadyToNotifyApproval(state)) {
        continue;
      }

      const thread = this.ensureMappedThread(state.codexThreadId);
      if (!thread) {
        continue;
      }

      if (state.turnId && !thread.activeTurnId) {
        this.sessionRegistry.setActiveTurn(thread.id, state.turnId);
      }
      if (thread.status !== 'waiting_approval') {
        this.sessionRegistry.setThreadStatus(thread.id, 'waiting_approval');
      }

      if (state.approvalId) {
        const existing = this.repository.findApprovalById(state.approvalId);
        if (existing?.status === 'pending') {
          continue;
        }
      }

      const matching = this.repository.findApprovalByCodexRequestId(`desktop:${state.callId}`);
      if (matching && matching.status !== 'expired') {
        state.approvalId = matching.id;
        continue;
      }

      const approvalId = newId();
      state.approvalId = approvalId;
      const summary = state.summary ?? this.defaultSummaryForTool(state.toolName);
      const actionType = state.actionType ?? this.defaultActionTypeForTool(state.toolName);

      this.repository.createApproval({
        id: approvalId,
        threadId: thread.id,
        codexRequestId: `desktop:${state.callId}`,
        turnId: state.turnId,
        actionType,
        summary,
        status: 'pending',
      });

      const supersededIds = this.repository.supersedePendingApprovals(thread.id, approvalId, state.turnId);
      for (const supersededApprovalId of supersededIds) {
        this.publish(
          this.journal.createEnvelope<ApprovalSupersededPayload>(
            'ApprovalSuperseded',
            {
              approvalId: supersededApprovalId,
              supersededByApprovalId: approvalId,
            },
            {
              projectId: thread.projectId,
              threadId: thread.id,
            },
          ),
        );
      }

      this.publish(
        this.journal.createEnvelope<ApprovalAwaitingOperatorPayload>(
          'ApprovalAwaitingOperator',
          {
            approvalId,
            codexRequestId: `desktop:${state.callId}`,
            threadId: thread.id,
            turnId: state.turnId,
            projectId: thread.projectId,
            actionType,
            summary,
            scope: 'once',
          },
          {
            projectId: thread.projectId,
            threadId: thread.id,
            turnId: state.turnId,
          },
        ),
      );
    }
  }

  private recoverRecentUnresolvedToolGates(logDb: DatabaseSync): void {
    if (this.recoveryWindowMs <= 0) {
      return;
    }

    const sinceTs = Math.floor((Date.now() - this.recoveryWindowMs) / 1000);
    const rows = logDb
      .prepare(
        `SELECT id, ts, thread_id, target, feedback_log_body
         FROM logs
         WHERE ts >= ?
           AND target = 'codex_core::tools::registry'
           AND thread_id IS NOT NULL
           AND thread_id != ''
           AND feedback_log_body LIKE '%waiting for tool gate%'
         ORDER BY id DESC
         LIMIT 200`,
      )
      .all(sinceTs) as unknown as DesktopLogRow[];

    for (const row of rows.reverse()) {
      const codexThreadId = row.thread_id ? String(row.thread_id) : undefined;
      const body = row.feedback_log_body ? String(row.feedback_log_body) : '';
      if (!codexThreadId || !body) {
        continue;
      }

      const callId = this.extractCallId(body);
      if (!callId) {
        continue;
      }

      const existing = this.repository.findApprovalByCodexRequestId(`desktop:${callId}`);
      if (existing && existing.status !== 'expired') {
        continue;
      }

      const released = logDb
        .prepare(
          `SELECT id
           FROM logs
           WHERE id > ?
             AND thread_id = ?
             AND target = 'codex_core::tools::registry'
             AND feedback_log_body LIKE '%tool gate released%'
             AND instr(feedback_log_body, ?) > 0
           ORDER BY id ASC
           LIMIT 1`,
        )
        .get(row.id, codexThreadId, callId) as { id: number } | undefined;
      if (released) {
        continue;
      }

      const toolResult = logDb
        .prepare(
          `SELECT feedback_log_body
           FROM logs
           WHERE id <= ?
             AND thread_id = ?
             AND target = 'codex_otel.log_only'
             AND feedback_log_body LIKE '%event.name="codex.tool_result"%'
             AND instr(feedback_log_body, ?) > 0
           ORDER BY id DESC
           LIMIT 1`,
        )
        .get(row.id, codexThreadId, callId) as { feedback_log_body?: string | null } | undefined;

      if (toolResult?.feedback_log_body) {
        this.recordToolResult(codexThreadId, row.id, String(toolResult.feedback_log_body));
      }
      this.recordToolGateWaiting(codexThreadId, row.id, body);
      this.flushPendingApprovals();
    }
  }

  private upsertApprovalState(callId: string, codexThreadId: string, logId: number): DesktopApprovalState {
    const existing = this.approvalsByCallId.get(callId);
    if (existing) {
      existing.codexThreadId = codexThreadId;
      existing.lastSeenLogId = Math.max(existing.lastSeenLogId, logId);
      return existing;
    }

    const state: DesktopApprovalState = {
      callId,
      codexThreadId,
      waiting: false,
      lastSeenLogId: logId,
    };
    this.approvalsByCallId.set(callId, state);
    return state;
  }

  // Waits for the grace period before an approval is posted. A gate released within the
  // period never produces a card.
  private isReadyToNotifyApproval(state: DesktopApprovalState): boolean {
    if (this.approvalCardGraceMs <= 0) {
      return true;
    }
    const waitingSinceMs = state.waitingSinceMs;
    if (!waitingSinceMs) {
      return false;
    }
    return Date.now() - waitingSinceMs >= this.approvalCardGraceMs;
  }

  private openLogDb(): DatabaseSync | undefined {
    const dbPath = this.detectLatestDbPath(/^logs_\d+\.sqlite$/);
    if (!dbPath) {
      return undefined;
    }
    if (this.logDb && this.logDbPath === dbPath) {
      return this.logDb;
    }
    if (this.logDb) {
      this.logDb.close();
    }
    this.logDbPath = dbPath;
    this.logDb = new DatabaseSync(dbPath, { readOnly: true });
    return this.logDb;
  }

  private openStateDb(): DatabaseSync | undefined {
    const dbPath = this.detectLatestDbPath(/^state_\d+\.sqlite$/);
    if (!dbPath) {
      return undefined;
    }
    if (this.stateDb && this.stateDbPath === dbPath) {
      return this.stateDb;
    }
    if (this.stateDb) {
      this.stateDb.close();
    }
    this.stateDbPath = dbPath;
    this.stateDb = new DatabaseSync(dbPath, { readOnly: true });
    return this.stateDb;
  }

  private detectLatestDbPath(pattern: RegExp): string | undefined {
    if (!fs.existsSync(this.codexHome)) {
      return undefined;
    }

    const matches = fs
      .readdirSync(this.codexHome)
      .filter((name) => pattern.test(name))
      .map((name) => path.join(this.codexHome, name));
    if (matches.length === 0) {
      return undefined;
    }

    matches.sort((left, right) => {
      const leftStat = fs.statSync(left);
      const rightStat = fs.statSync(right);
      if (leftStat.mtimeMs !== rightStat.mtimeMs) {
        return rightStat.mtimeMs - leftStat.mtimeMs;
      }
      return right.localeCompare(left);
    });
    return matches[0];
  }

  private closeDbs(): void {
    if (this.logDb) {
      this.logDb.close();
      this.logDb = undefined;
    }
    if (this.stateDb) {
      this.stateDb.close();
      this.stateDb = undefined;
    }
    this.logDbPath = undefined;
    this.stateDbPath = undefined;
  }

  private extractCallId(body: string): string | undefined {
    const match = body.match(/call_id="?([^"\s}]+)"?/);
    return match?.[1];
  }

  private extractToolName(body: string): string | undefined {
    const quoted = body.match(/tool_name="?([A-Za-z0-9_:-]+)"?/);
    return quoted?.[1];
  }

  private extractTurnId(body: string): string | undefined {
    const match = body.match(/turn\.id=([0-9A-Za-z-]+)/);
    return match?.[1];
  }

  private extractDecision(body: string): Extract<ApprovalStatus, 'approved' | 'denied'> | undefined {
    const match = body.match(/decision=([A-Za-z]+)/);
    const raw = match?.[1]?.toLowerCase();
    if (!raw) {
      return undefined;
    }
    if (raw.includes('approved')) {
      return 'approved';
    }
    if (raw.includes('denied') || raw.includes('declined') || raw.includes('rejected')) {
      return 'denied';
    }
    return undefined;
  }

  private extractArgumentsJson(body: string): Record<string, unknown> | undefined {
    const marker = ' arguments=';
    const start = body.indexOf(marker);
    if (start === -1) {
      return undefined;
    }

    const rest = body.slice(start + marker.length);
    const endMarkers = [' duration_ms=', ' success=', ' output=', ' event.timestamp=', ' mcp_server=', ' source='];
    let end = rest.length;
    for (const markerText of endMarkers) {
      const index = rest.indexOf(markerText);
      if (index !== -1 && index < end) {
        end = index;
      }
    }

    const jsonText = rest.slice(0, end).trim();
    if (!jsonText.startsWith('{')) {
      return undefined;
    }

    try {
      return JSON.parse(jsonText) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  private summarizeToolCall(toolName: string | undefined, args: Record<string, unknown>): string | undefined {
    if (toolName === 'exec_command') {
      const cmd = typeof args.cmd === 'string' ? args.cmd.trim() : undefined;
      if (cmd) {
        return `Run command: ${this.compact(cmd, 240)}`;
      }
    }

    if (toolName === 'apply_patch') {
      return 'Apply patch';
    }

    const serialized = JSON.stringify(args);
    if (serialized && serialized !== '{}') {
      return `${toolName ?? 'Tool call'}: ${this.compact(serialized, 240)}`;
    }
    return undefined;
  }

  private inferActionType(toolName: string | undefined, args: Record<string, unknown>): ApprovalActionType | undefined {
    if (toolName === 'exec_command') {
      return 'command';
    }
    if (toolName === 'apply_patch') {
      return 'filesystem';
    }
    // A branch name alone does not show a push. Require a push command or a push action.
    const command = typeof args.cmd === 'string' ? args.cmd : typeof args.command === 'string' ? args.command : '';
    if (/\bgit\s+push\b/.test(command) || args.action === 'push') {
      return 'git_push';
    }
    return undefined;
  }

  private defaultSummaryForTool(toolName: string | undefined): string {
    if (toolName === 'exec_command') {
      return 'Run command requiring approval';
    }
    if (toolName === 'apply_patch') {
      return 'Apply patch requiring approval';
    }
    return 'Tool execution requiring approval';
  }

  private defaultActionTypeForTool(toolName: string | undefined): ApprovalActionType {
    if (toolName === 'exec_command') {
      return 'command';
    }
    if (toolName === 'apply_patch') {
      return 'filesystem';
    }
    return 'other';
  }

  private compactTitle(title: string): string {
    const firstLine = title.split('\n')[0]?.trim() ?? '';
    return this.compact(firstLine || '(unnamed)', 80);
  }

  private compact(value: string, limit: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= limit) {
      return normalized;
    }
    return `${normalized.slice(0, limit - 3)}...`;
  }

  private isFreshLiveGate(tsSeconds: number): boolean {
    const liveWindowMs = 2 * 60 * 1000;
    return Date.now() - Number(tsSeconds) * 1000 <= liveWindowMs;
  }

  private publish(event: RccEventEnvelope): void {
    this.journal.append(event);
    this.eventBus.emit(event);
    this.logger.info('event-published', {
      eventId: event.eventId,
      eventType: event.eventType,
      projectId: event.projectId,
      threadId: event.threadId,
      turnId: event.turnId,
    });
  }
}
