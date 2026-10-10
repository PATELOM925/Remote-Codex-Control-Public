import { isAllowedRelayBaseUrl, type RccConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { ApprovalRouterAgent } from '../agents/approvalRouterAgent.js';
import type { CodexBridgeAgent } from '../agents/codexBridgeAgent.js';
import type { FileIntakeAgent } from '../agents/fileIntakeAgent.js';
import type { SteeringAgent } from '../agents/steeringAgent.js';
import type { LocalStatusServer } from './localStatusServer.js';
import type { RelayCommand, RelayCommandResult, RelayPollResponse } from '../relay/types.js';
import type { RccRepository } from '../db/repositories.js';
import type { ApprovalStatus, ReasoningEffort } from '../contracts/states.js';

// Max size of one relay upload file.
const RELAY_FILE_UPLOAD_LIMIT_BYTES = 512 * 1024;
// Max files in one relay upload command.
const RELAY_FILE_UPLOAD_LIMIT_COUNT = 3;
const RELAY_DEPLOYMENT_DISABLED_BACKOFF_MS = 60_000;
const RELAY_TRANSIENT_HTTP_BACKOFF_MS = 30_000;

class RelayHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly responseText: string,
  ) {
    super(`relay HTTP ${status}: ${message}`);
    this.name = 'RelayHttpError';
  }
}

export class RelayClientService {
  private pollTimer?: NodeJS.Timeout;
  private snapshotTimer?: NodeJS.Timeout;
  private stopped = false;
  private pollInFlight = false;
  private watchedThreadId?: string;
  private relayBackoffUntilMs = 0;

  constructor(
    private readonly config: RccConfig,
    private readonly localStatusServer: LocalStatusServer,
    private readonly codexBridge: CodexBridgeAgent,
    private readonly steeringAgent: SteeringAgent,
    private readonly approvalRouter: ApprovalRouterAgent,
    private readonly fileIntakeAgent: FileIntakeAgent,
    private readonly repository: RccRepository,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (!this.config.relayEnabled) {
      return;
    }
    // The Mac relay token is only sent to https or loopback http URLs.
    if (!isAllowedRelayBaseUrl(this.config.relayBaseUrl)) {
      this.logger.warn('relay-disabled', {
        reason: 'RCC_RELAY_BASE_URL is missing or not https',
      });
      return;
    }
    this.stopped = false;
    void this.postSnapshot();
    void this.pollOnce();
    this.pollTimer = setInterval(() => void this.pollOnce(), this.config.relayPollIntervalMs);
    this.snapshotTimer = setInterval(() => void this.postSnapshot(), this.config.relaySnapshotIntervalMs);
    this.logger.info('relay-client-started', {
      relayBaseUrl: this.redactUrl(this.config.relayBaseUrl),
      macId: this.config.relayMacId,
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = undefined;
    }
  }

  async pollOnce(): Promise<void> {
    if (!this.config.relayEnabled || this.stopped || this.pollInFlight || this.isRelayBackoffActive()) {
      return;
    }
    this.pollInFlight = true;
    try {
      const response = await this.fetchJson<RelayPollResponse>(
        `/api/relay/commands/poll?macId=${encodeURIComponent(this.config.relayMacId)}`,
        { method: 'GET' },
      );
      for (const command of response.commands) {
        await this.executeAndReport(command);
      }
    } catch (error) {
      this.handleRelayFailure('poll', error);
    } finally {
      this.pollInFlight = false;
    }
  }

  async postSnapshot(): Promise<void> {
    if (!this.config.relayEnabled || this.stopped || this.isRelayBackoffActive()) {
      return;
    }
    try {
      await this.fetchJson('/api/relay/snapshot', {
        method: 'POST',
        body: JSON.stringify({
          macId: this.config.relayMacId,
          snapshot: this.buildRelaySnapshot(),
        }),
      });
    } catch (error) {
      this.handleRelayFailure('snapshot', error);
    }
  }

  private async executeAndReport(command: RelayCommand): Promise<void> {
    const startedAt = Date.now();
    try {
      const data = await this.execute(command);
      await this.postResult(command.id, {
        commandId: command.id,
        ok: true,
        message: `Executed ${command.action}`,
        completedAt: new Date().toISOString(),
        data: {
          ...data,
          elapsedMs: Date.now() - startedAt,
        },
      });
      await this.postSnapshot();
    } catch (error) {
      await this.postResult(command.id, {
        commandId: command.id,
        ok: false,
        message: this.errorMessage(error),
        completedAt: new Date().toISOString(),
      });
    }
  }

  private async execute(command: RelayCommand): Promise<Record<string, unknown>> {
    switch (command.action) {
      case 'refresh':
        return { refreshed: true };
      case 'thread_detail': {
        const threadId = this.requireTarget(command, 'thread');
        return { threadId, detail: this.localStatusServer.threadDetailSnapshot(threadId) };
      }
      case 'watch_thread': {
        const threadId = this.requireTarget(command, 'thread');
        this.watchedThreadId = threadId;
        return { threadId, detail: this.localStatusServer.threadDetailSnapshot(threadId), watched: true };
      }
      case 'last_output': {
        const threadId = this.requireTarget(command, 'thread');
        return { threadId, ...this.localStatusServer.threadLastOutputSnapshot(threadId) };
      }
      case 'list_threads': {
        const limit = this.parseCommandLimit(command.message, 50, 200);
        return { catalog: await this.localStatusServer.liveThreadCatalogSnapshot(limit) };
      }
      case 'list_skills': {
        const threadId = this.requireTarget(command, 'thread');
        return { threadId, skills: await this.codexBridge.listSkillsForThread(threadId) };
      }
      case 'set_mode': {
        const threadId = this.requireTarget(command, 'thread');
        const mode = this.requireMode(command.message);
        this.codexBridge.setThreadMode(threadId, mode);
        return { threadId, mode };
      }
      case 'plan': {
        const threadId = this.requireTarget(command, 'thread');
        const payload = this.parseTurnPayload(command.message);
        this.codexBridge.setThreadMode(threadId, 'plan');
        const turn = await this.codexBridge.startTurn(threadId, payload.message, {
          mode: 'plan',
          model: payload.model,
          reasoningEffort: payload.reasoningEffort,
        });
        return { threadId, mode: 'plan', ...turn };
      }
      case 'start_with_skills': {
        const threadId = this.requireTarget(command, 'thread');
        const parsed = this.parseSkillsMessage(command.message);
        const skills = await this.resolveSkillsForThread(threadId, parsed.skillNames);
        const turn = await this.codexBridge.startTurn(threadId, parsed.message, {
          skills,
          model: parsed.model,
          reasoningEffort: parsed.reasoningEffort,
        });
        return { threadId, skills, ...turn };
      }
      case 'attach_file': {
        const threadId = this.requireTarget(command, 'thread');
        const files = this.parseAttachmentMessage(command.message);
        const attachments = [];
        for (const file of files) {
          attachments.push(await this.fileIntakeAgent.ingestRawAttachment({
            threadId,
            fileName: file.name,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
            bytes: Buffer.from(file.base64, 'base64'),
            source: 'relay',
          }));
        }
        return {
          threadId,
          attachmentCount: attachments.length,
          attachments,
          note: 'Files were materialized on the Mac under the selected thread workspace.',
        };
      }
      case 'run': {
        const threadId = this.requireTarget(command, 'thread');
        const payload = this.parseTurnPayload(command.message);
        const turn = await this.codexBridge.startTurn(threadId, payload.message, {
          model: payload.model,
          reasoningEffort: payload.reasoningEffort,
        });
        return { threadId, ...turn };
      }
      case 'say': {
        const threadId = this.requireTarget(command, 'thread');
        const message = this.requireMessage(command);
        const mode = await this.steeringAgent.steerOrQueue(threadId, message);
        return { threadId, mode };
      }
      case 'interrupt': {
        const threadId = this.requireTarget(command, 'thread');
        await this.codexBridge.interruptTurn(threadId);
        return { threadId, mode: 'interrupt' };
      }
      case 'approve':
      case 'deny': {
        const approvalId = this.requireTarget(command, 'approval');
        await this.approvalRouter.resolveFromTelegramCallback(`${command.action}:${approvalId}`);
        return { approvalId, decision: command.action };
      }
      case 'approval_response': {
        const approvalId = this.requireTarget(command, 'approval');
        return this.handleApprovalResponse(approvalId, command.message);
      }
      case 'dismiss_approval': {
        const approvalId = this.requireTarget(command, 'approval');
        const approval = this.repository.findApprovalById(approvalId);
        if (!approval) {
          throw new Error(`Unknown approval ${approvalId}`);
        }
        this.repository.updateApprovalStatus(approvalId, 'dismissed');
        return { approvalId, status: 'dismissed' };
      }
      default:
        throw new Error(`unsupported relay command ${(command as { action: string }).action}`);
    }
  }

  private buildRelaySnapshot(): Record<string, unknown> {
    const snapshot = this.localStatusServer.snapshot() as Record<string, unknown>;
    if (!this.watchedThreadId) {
      return snapshot;
    }
    const detail = this.localStatusServer.threadDetailSnapshot(this.watchedThreadId) as Record<string, unknown>;
    const outputs = Array.isArray(detail.outputs) ? detail.outputs as Array<{ occurredAt?: string }> : [];
    return {
      ...snapshot,
      watchedThreadId: this.watchedThreadId,
      watchedThreadDetail: detail,
      lastOutputAt: outputs[0]?.occurredAt,
    };
  }

  private async postResult(commandId: string, result: RelayCommandResult): Promise<void> {
    await this.fetchJson(`/api/relay/commands/${encodeURIComponent(commandId)}/result`, {
      method: 'POST',
      body: JSON.stringify(result),
    });
  }

  private requireTarget(command: RelayCommand, expectedKind: 'thread' | 'approval'): string {
    if (command.targetKind !== expectedKind || !command.targetId) {
      throw new Error(`${command.action} requires targetKind=${expectedKind} and targetId`);
    }
    return command.targetId;
  }

  private requireMessage(command: RelayCommand): string {
    const message = command.message?.trim();
    if (!message) {
      throw new Error(`${command.action} requires a message`);
    }
    return message;
  }

  private requireMode(value: string | undefined): 'plan' | 'build' {
    const mode = value?.trim().toLowerCase();
    if (mode !== 'plan' && mode !== 'build') {
      throw new Error('set_mode requires message=plan or message=build');
    }
    return mode;
  }

  private parseTurnPayload(value: string | undefined): { message: string; model?: string; reasoningEffort?: ReasoningEffort } {
    const raw = value?.trim();
    if (!raw) {
      throw new Error('turn command requires a message');
    }
    if (!raw.startsWith('{')) {
      return { message: raw };
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
    if (!message) {
      throw new Error('turn command JSON payload requires message.');
    }
    return {
      message,
      model: this.parseOptionalModel(parsed.model),
      reasoningEffort: this.parseOptionalReasoningEffort(parsed.reasoningEffort),
    };
  }

  private parseSkillsMessage(value: string | undefined): { message: string; skillNames: string[]; model?: string; reasoningEffort?: ReasoningEffort } {
    const raw = value?.trim();
    if (!raw) {
      throw new Error('start_with_skills requires a JSON message payload.');
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
    if (!message) {
      throw new Error('start_with_skills payload requires message.');
    }
    if (!Array.isArray(parsed.skills)) {
      throw new Error('start_with_skills payload requires skills array.');
    }
    const skillNames = parsed.skills.map((item) => {
      const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      if (typeof record.path === 'string' && record.path.trim()) {
        throw new Error('Relay skill invocation does not accept arbitrary skill paths; send names returned by list_skills.');
      }
      const name = typeof record.name === 'string' ? record.name.trim() : '';
      if (!name) {
        throw new Error('Each skill requires name.');
      }
      return name;
    });
    return {
      message,
      skillNames,
      model: this.parseOptionalModel(parsed.model),
      reasoningEffort: this.parseOptionalReasoningEffort(parsed.reasoningEffort),
    };
  }

  private async handleApprovalResponse(approvalId: string, value: string | undefined): Promise<Record<string, unknown>> {
    const approval = this.repository.findApprovalById(approvalId);
    if (!approval) {
      throw new Error(`Unknown approval ${approvalId}`);
    }
    const raw = value?.trim();
    if (!raw) {
      throw new Error('approval_response requires a JSON payload.');
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const decision = this.parseOptionalApprovalDecision(parsed.decision);
    const guidance = this.parseOptionalGuidance(parsed.guidance);
    if (!decision && !guidance) {
      throw new Error('approval_response requires guidance text, a decision, or both.');
    }
    let deliveryMode: string | undefined;
    if (decision) {
      await this.approvalRouter.resolveFromTelegramCallback(`${decision === 'approved' ? 'approve' : 'deny'}:${approvalId}`);
    }
    if (guidance) {
      deliveryMode = await this.steeringAgent.steerOrQueue(approval.threadId, guidance);
    }
    return {
      approvalId,
      decision,
      guidanceSent: Boolean(guidance),
      deliveryMode,
      status: this.repository.findApprovalById(approvalId)?.status,
    };
  }

  private parseOptionalApprovalDecision(value: unknown): Extract<ApprovalStatus, 'approved' | 'denied'> | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    const decision = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (decision === 'approve' || decision === 'approved') {
      return 'approved';
    }
    if (decision === 'deny' || decision === 'denied') {
      return 'denied';
    }
    throw new Error('decision must be approved or denied.');
  }

  private parseOptionalGuidance(value: unknown): string | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    if (typeof value !== 'string') {
      throw new Error('guidance must be a string.');
    }
    const guidance = value.trim();
    if (!guidance) {
      return undefined;
    }
    if (guidance.length > 20_000) {
      throw new Error('Guidance too large.');
    }
    return guidance;
  }

  private parseOptionalModel(value: unknown): string | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    if (typeof value !== 'string') {
      throw new Error('model must be a string when provided.');
    }
    const model = value.trim();
    if (!model) {
      return undefined;
    }
    if (model.length > 80 || !/^[A-Za-z0-9._:-]+$/.test(model)) {
      throw new Error('model contains unsupported characters.');
    }
    return model;
  }

  private parseOptionalReasoningEffort(value: unknown): ReasoningEffort | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    const effort = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (effort !== 'low' && effort !== 'medium' && effort !== 'high') {
      throw new Error('reasoningEffort must be one of: low, medium, high.');
    }
    return effort;
  }

  // Every file is validated before any is ingested, so a bad payload stores nothing.
  private parseAttachmentMessage(value: string | undefined): Array<{
    name: string;
    mimeType?: string;
    sizeBytes: number;
    base64: string;
  }> {
    const raw = value?.trim();
    if (!raw) {
      throw new Error('attach_file requires a JSON payload.');
    }
    const parsed = JSON.parse(raw) as { files?: unknown };
    if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
      throw new Error('attach_file payload requires at least one file.');
    }
    if (parsed.files.length > RELAY_FILE_UPLOAD_LIMIT_COUNT) {
      throw new Error(`Relay upload accepts at most ${RELAY_FILE_UPLOAD_LIMIT_COUNT} files per command.`);
    }
    return parsed.files.map((item) => {
      const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const name = typeof record.name === 'string' ? record.name.trim() : '';
      const base64 = typeof record.base64 === 'string' ? record.base64.trim() : '';
      const mimeType = typeof record.mimeType === 'string' ? record.mimeType : undefined;
      const sizeBytes = typeof record.sizeBytes === 'number' ? record.sizeBytes : Number(record.sizeBytes);
      if (!name) {
        throw new Error('Each relay upload file requires name.');
      }
      if (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
        throw new Error(`Relay upload file ${name} has invalid base64 payload.`);
      }
      if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > RELAY_FILE_UPLOAD_LIMIT_BYTES) {
        throw new Error(`Relay upload file ${name} exceeds the ${RELAY_FILE_UPLOAD_LIMIT_BYTES} byte alpha limit.`);
      }
      const decodedBytes = Buffer.from(base64, 'base64');
      if (decodedBytes.byteLength !== sizeBytes) {
        throw new Error(`Relay upload file ${name} size mismatch.`);
      }
      return { name, mimeType, sizeBytes, base64 };
    });
  }

  private async resolveSkillsForThread(threadId: string, skillNames: string[]): Promise<Array<{ name: string; path?: string; description?: string; enabled?: boolean }>> {
    const available = await this.codexBridge.listSkillsForThread(threadId);
    return skillNames.map((name) => {
      const lower = name.toLowerCase();
      const match = available.find((skill) => skill.name === name || skill.name.toLowerCase() === lower);
      if (!match) {
        throw new Error(`Unknown skill "${name}". Queue list_skills first and select one of the returned skills.`);
      }
      if (!match.path) {
        throw new Error(`Skill "${match.name}" did not include an App Server-provided path and cannot be invoked safely.`);
      }
      return match;
    });
  }

  private parseCommandLimit(value: string | undefined, fallback: number, max: number): number {
    const raw = Number(value ?? fallback);
    if (!Number.isFinite(raw)) {
      return fallback;
    }
    return Math.max(1, Math.min(Math.floor(raw), max));
  }

  private async fetchJson<T = unknown>(path: string, init: RequestInit): Promise<T> {
    const baseUrl = this.config.relayBaseUrl.replace(/\/$/, '');
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${this.config.relayMacToken ?? ''}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
    const body = (await response.text()).trim();
    const parsed = this.parseRelayBody(body);
    if (!response.ok) {
      throw new RelayHttpError(response.status, this.extractRelayError(parsed, body, response.statusText), body);
    }
    return parsed as T;
  }

  private parseRelayBody(body: string): unknown {
    if (!body) {
      return {};
    }
    try {
      return JSON.parse(body);
    } catch {
      return undefined;
    }
  }

  private extractRelayError(parsed: unknown, body: string, fallback: string): string {
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      if (typeof record.error === 'string') {
        return record.error;
      }
      if (record.error && typeof record.error === 'object') {
        const nested = record.error as Record<string, unknown>;
        const code = typeof nested.code === 'string' ? nested.code : undefined;
        const message = typeof nested.message === 'string' ? nested.message : undefined;
        if (code && message) {
          return `${code} ${message}`;
        }
        if (message) {
          return message;
        }
      }
    }
    return body || fallback;
  }

  private isRelayBackoffActive(): boolean {
    return Date.now() < this.relayBackoffUntilMs;
  }

  private handleRelayFailure(operation: 'poll' | 'snapshot', error: unknown): void {
    if (error instanceof RelayHttpError && this.shouldBackOffRelay(error.status)) {
      const backoffMs = error.status === 402
        ? RELAY_DEPLOYMENT_DISABLED_BACKOFF_MS
        : RELAY_TRANSIENT_HTTP_BACKOFF_MS;
      this.relayBackoffUntilMs = Date.now() + backoffMs;
      this.logger.warn(error.status === 402 ? 'relay-deployment-disabled' : 'relay-temporarily-unavailable', {
        operation,
        status: error.status,
        errorMessage: error.message,
        retryAfterMs: backoffMs,
      });
      return;
    }
    this.logger.warn(operation === 'poll' ? 'relay-poll-failed' : 'relay-snapshot-post-failed', {
      message: this.errorMessage(error),
    });
  }

  private shouldBackOffRelay(status: number): boolean {
    return status === 402 || status === 429 || status >= 500;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  // Removes any user name and password from the URL before it is logged.
  private redactUrl(url: string): string {
    try {
      const parsed = new URL(url);
      parsed.username = '';
      parsed.password = '';
      return parsed.toString();
    } catch {
      return '(invalid relay url)';
    }
  }
}
