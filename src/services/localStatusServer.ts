import http, { type Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

import type { RccConfig } from '../config.js';
import type { RccEventEnvelope } from '../contracts/events.js';
import type { ApprovalRecord, ArtifactRecord, RccRepository, ThreadRecord, TurnOutputRecord } from '../db/repositories.js';
import type { EventJournal } from '../event-journal/eventJournal.js';
import type { Logger } from '../logger.js';
import type { RccEventBus } from '../runtime/eventBus.js';
import type { CodexSkillRef, CodexThread, CodexThreadMode } from '../contracts/codex.js';
import type { ApprovalStatus, ReasoningEffort, ThreadStatus } from '../contracts/states.js';
import { buildApprovalDetails, redactApprovalText } from './approvalDetails.js';

import type { HealthOpsAgent } from '../agents/healthOpsAgent.js';
import type { SessionRegistryAgent } from '../agents/sessionRegistryAgent.js';
import type { CodexBridgeAgent } from '../agents/codexBridgeAgent.js';
import type { SteeringAgent } from '../agents/steeringAgent.js';
import type { ApprovalRouterAgent } from '../agents/approvalRouterAgent.js';
import type { FileIntakeAgent } from '../agents/fileIntakeAgent.js';
import { redactSensitiveText } from '../utils/redaction.js';

interface DashboardEvent {
  sequence?: number;
  eventId: string;
  eventType: string;
  occurredAt: string;
  projectId?: string;
  threadId?: string;
  turnId?: string;
  summary: string;
}

export class LocalStatusServer {
  private server?: Server;

  constructor(
    private readonly config: RccConfig,
    private readonly healthOps: HealthOpsAgent,
    private readonly sessionRegistry: SessionRegistryAgent,
    private readonly repository: RccRepository,
    private readonly journal: EventJournal,
    private readonly eventBus: RccEventBus,
    private readonly codexBridge: CodexBridgeAgent,
    private readonly steeringAgent: SteeringAgent,
    private readonly approvalRouter: ApprovalRouterAgent,
    private readonly fileIntakeAgent: FileIntakeAgent | undefined,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    if (!this.config.localStatusEnabled || this.server) {
      return;
    }
    if (!['127.0.0.1', '::1', 'localhost'].includes(this.config.localStatusHost)) {
      throw new Error('Local status server must bind to localhost unless authenticated exposure is implemented.');
    }

    this.server = http.createServer((request, response) => {
      this.handleRequest(request, response).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.sendJson(response, 500, { error: message });
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.config.localStatusPort, this.config.localStatusHost, () => {
        this.server?.off('error', reject);
        resolve();
      });
    });

    const address = this.server.address();
    const port = typeof address === 'object' && address ? address.port : this.config.localStatusPort;
    this.logger.info('local-status-server-started', {
      url: `http://${this.config.localStatusHost}:${port}`,
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  url(): string | undefined {
    if (!this.server) {
      return undefined;
    }
    const address = this.server.address();
    const port = typeof address === 'object' && address ? address.port : this.config.localStatusPort;
    return `http://${this.config.localStatusHost}:${port}`;
  }

  snapshot(): object {
    return this.buildDashboardSnapshot();
  }

  threadDetailSnapshot(threadId: string): object {
    return this.buildThreadDetail(threadId);
  }

  threadLastOutputSnapshot(threadId: string): object {
    const thread = this.sessionRegistry.findThreadById(threadId);
    if (!thread) {
      return { error: 'thread_not_found', threadId, output: null };
    }
    const output = this.latestDisplayOutput(thread.id);
    return {
      thread: this.describeThread(thread),
      output,
    };
  }

  async liveThreadCatalogSnapshot(limit = 50): Promise<object> {
    return this.buildLiveThreadCatalog(limit);
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    this.applyCorsHeaders(request, response);

    if (request.method === 'OPTIONS') {
      if (this.isCorsOriginAllowed(request.headers.origin)) {
        response.writeHead(204);
      } else {
        response.writeHead(403);
      }
      response.end();
      return;
    }

    if (request.method === 'POST') {
      await this.handlePostRequest(request, response, url);
      return;
    }

    if (request.method !== 'GET') {
      this.sendJson(response, 405, { error: 'method_not_allowed' });
      return;
    }

    if (url.pathname === '/') {
      this.sendHtml(response, this.renderHome());
      return;
    }
    if (url.pathname === '/manifest.webmanifest') {
      this.sendJson(response, 200, this.renderManifest());
      return;
    }
    if (url.pathname === '/service-worker.js') {
      this.sendJavascript(response, this.renderServiceWorker());
      return;
    }
    if (url.pathname === '/api/events/stream') {
      this.streamEvents(request, response);
      return;
    }
    if (url.pathname === '/api/session') {
      this.sendJson(response, 200, this.buildSessionPayload(request));
      return;
    }
    if (url.pathname === '/api/threads/catalog') {
      this.sendJson(response, 200, await this.buildLiveThreadCatalog(this.parseLimit(url, 50, 200)));
      return;
    }

    const threadStreamMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/stream$/);
    if (threadStreamMatch?.[1]) {
      this.streamThreadEvents(request, response, decodeURIComponent(threadStreamMatch[1]));
      return;
    }

    const threadSkillsMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/skills$/);
    if (threadSkillsMatch?.[1]) {
      const threadId = decodeURIComponent(threadSkillsMatch[1]);
      const thread = this.sessionRegistry.findThreadById(threadId);
      if (!thread) {
        this.sendJson(response, 404, { error: 'thread_not_found', threadId });
        return;
      }
      this.sendJson(response, 200, {
        threadId,
        activeSkills: this.codexBridge.getThreadSkills(thread.id),
        skills: await this.codexBridge.listSkillsForThread(thread.id),
        note: 'Skills are operator-selected context for the next turn only. They do not bypass project allowlists, approval policy, artifact policy, or Git guardrails.',
      });
      return;
    }

    const threadLastOutputMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/last-output$/);
    if (threadLastOutputMatch?.[1]) {
      this.sendJson(response, 200, this.threadLastOutputSnapshot(decodeURIComponent(threadLastOutputMatch[1])));
      return;
    }

    const threadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)(?:\/(outputs))?$/);
    if (threadMatch?.[1]) {
      const threadId = decodeURIComponent(threadMatch[1]);
      if (threadMatch[2] === 'outputs') {
        this.sendJson(response, 200, {
          outputs: this.repository.listRecentTurnOutputs(threadId, this.parseLimit(url, 25, 100)),
        });
        return;
      }
      this.sendJson(response, 200, this.buildThreadDetail(threadId));
      return;
    }

    const artifactDownloadMatch = url.pathname.match(/^\/api\/artifacts\/([^/]+)\/download$/);
    if (artifactDownloadMatch?.[1]) {
      await this.sendArtifactDownload(request, response, decodeURIComponent(artifactDownloadMatch[1]));
      return;
    }

    switch (url.pathname) {
      case '/api/status':
        this.sendJson(response, 200, {
          statusText: this.healthOps.statusText(),
          generatedAt: new Date().toISOString(),
        });
        return;
      case '/api/health':
        this.sendJson(response, 200, this.buildHealthPayload());
        return;
      case '/api/dashboard':
        this.sendJson(response, 200, this.buildDashboardSnapshot());
        return;
      case '/api/projects':
        this.sendJson(response, 200, { projects: this.sessionRegistry.listProjects() });
        return;
      case '/api/threads':
        this.sendJson(response, 200, { threads: this.describeThreads(this.sessionRegistry.listThreads()) });
        return;
      case '/api/approvals':
        this.sendJson(response, 200, { approvals: this.describeApprovals(this.repository.listPendingApprovals()) });
        return;
      case '/api/approvals/history':
        this.sendJson(response, 200, { approvals: this.describeApprovals(this.approvalHistory()) });
        return;
      case '/api/artifacts':
        this.sendJson(response, 200, { artifacts: this.describeArtifacts() });
        return;
      case '/api/events':
        this.sendJson(response, 200, this.buildEventsPayload(url));
        return;
      default:
        this.sendJson(response, 404, { error: 'not_found' });
    }
  }

  private async handlePostRequest(request: http.IncomingMessage, response: http.ServerResponse, url: URL): Promise<void> {
    if (url.pathname === '/api/session/login') {
      const body = await this.readJsonBody(request);
      const token = typeof body.token === 'string' ? body.token : '';
      if (this.config.webAuthToken && token === this.config.webAuthToken) {
        this.sendJson(response, 200, this.buildSessionPayload(request, true));
        return;
      }
      this.sendJson(response, 401, { error: 'invalid_web_token' });
      return;
    }

    if (!this.requireWebControl(request, response)) {
      return;
    }

    const attachmentMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/attachments$/);
    if (attachmentMatch?.[1]) {
      const threadId = decodeURIComponent(attachmentMatch[1]);
      const thread = this.sessionRegistry.findThreadById(threadId);
      if (!thread) {
        this.sendJson(response, 404, { error: 'thread_not_found', threadId });
        return;
      }
      if (!this.fileIntakeAgent) {
        this.sendJson(response, 503, { error: 'file_intake_unavailable' });
        return;
      }
      const body = await this.readJsonBody(request);
      const files = this.requireAttachmentFiles(body);
      const results = [];
      for (const file of files) {
        results.push(await this.fileIntakeAgent.ingestRawAttachment({
          threadId: thread.id,
          fileName: file.name,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          bytes: Buffer.from(file.base64, 'base64'),
          source: 'web',
        }));
      }
      this.sendJson(response, 200, { ok: true, threadId: thread.id, attachments: results });
      return;
    }

    const threadActionMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/(run|say|interrupt|mode|skills)$/);
    if (threadActionMatch?.[1] && threadActionMatch[2]) {
      const threadId = decodeURIComponent(threadActionMatch[1]);
      const action = threadActionMatch[2];
      const body = action === 'interrupt' ? {} : await this.readJsonBody(request);
      const thread = this.sessionRegistry.findThreadById(threadId);
      if (!thread) {
        this.sendJson(response, 404, { error: 'thread_not_found', threadId });
        return;
      }

      if (action === 'run') {
        const message = this.requireMessage(body);
        const started = await this.codexBridge.startTurn(thread.id, message, {
          mode: this.parseOptionalMode(body.mode),
          skills: await this.resolveRequestedSkills(thread.id, body.skills),
          model: this.parseOptionalModel(body.model),
          reasoningEffort: this.parseOptionalReasoningEffort(body.reasoningEffort),
        });
        this.sendJson(response, 200, { ok: true, mode: 'turn_start', threadId: thread.id, ...started });
        return;
      }

      if (action === 'say') {
        const message = this.requireMessage(body);
        const mode = await this.steeringAgent.steerOrQueue(thread.id, message);
        this.sendJson(response, 200, { ok: true, mode, threadId: thread.id });
        return;
      }

      if (action === 'interrupt') {
        await this.codexBridge.interruptTurn(thread.id);
        this.sendJson(response, 200, { ok: true, mode: 'interrupt', threadId: thread.id });
        return;
      }

      if (action === 'mode') {
        const mode = this.requireMode(body.mode);
        this.codexBridge.setThreadMode(thread.id, mode);
        this.sendJson(response, 200, { ok: true, threadId: thread.id, mode });
        return;
      }

      if (action === 'skills') {
        const skillAction = typeof body.action === 'string' ? body.action : 'add';
        if (skillAction === 'clear') {
          this.codexBridge.clearThreadSkills(thread.id);
          this.sendJson(response, 200, { ok: true, threadId: thread.id, skills: [] });
          return;
        }
        const skill = await this.resolveRequestedSkill(thread.id, body);
        const skills = this.codexBridge.addThreadSkill(thread.id, skill);
        this.sendJson(response, 200, { ok: true, threadId: thread.id, skills });
        return;
      }
    }

    const approvalActionMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/(approve|deny|respond|dismiss)$/);
    if (approvalActionMatch?.[1] && approvalActionMatch[2]) {
      const approvalId = decodeURIComponent(approvalActionMatch[1]);
      const action = approvalActionMatch[2];
      const body = action === 'respond' ? await this.readJsonBody(request) : {};
      const result = await this.handleWebApprovalAction(approvalId, action, body);
      this.sendJson(response, 200, { ok: true, ...result });
      return;
    }

    this.sendJson(response, 404, { error: 'not_found' });
  }

  private async handleWebApprovalAction(
    approvalId: string,
    action: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const approval = this.repository.findApprovalById(approvalId);
    if (!approval) {
      throw new Error(`Unknown approval ${approvalId}`);
    }

    if (action === 'dismiss') {
      this.repository.updateApprovalStatus(approvalId, 'dismissed');
      return { approvalId, action: 'dismiss', status: 'dismissed' };
    }

    if (action === 'approve' || action === 'deny') {
      await this.approvalRouter.resolveFromTelegramCallback(`${action}:${approvalId}`);
      return { approvalId, action, status: action === 'approve' ? 'approved' : 'denied' };
    }

    const guidance = this.parseOptionalGuidance(body.guidance);
    const decision = this.parseOptionalApprovalDecision(body.decision);
    if (!guidance && !decision) {
      throw new Error('respond requires guidance text, a decision, or both.');
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
      action: 'respond',
      decision,
      guidanceSent: Boolean(guidance),
      deliveryMode,
      status: this.repository.findApprovalById(approvalId)?.status,
    };
  }

  private buildHealthPayload(): object {
    const statusText = this.healthOps.statusText();
    return {
      generatedAt: new Date().toISOString(),
      statusText,
      snapshot: this.repository.latestHealthSnapshot(),
    };
  }

  private buildDashboardSnapshot(): object {
    const statusText = this.healthOps.statusText();
    const projects = this.sessionRegistry.listProjects();
    const threads = this.sessionRegistry.listThreads();
    const approvals = this.repository.listPendingApprovals();
    const artifacts = this.describeArtifacts(threads);
    const events = this.journal.listRecentEvents(50).map((event) => this.sanitizeEvent(event));

    return {
      generatedAt: new Date().toISOString(),
      statusText,
      health: this.repository.latestHealthSnapshot(),
      counts: {
        projects: projects.length,
        threads: threads.length,
        pendingApprovals: approvals.length,
        artifacts: artifacts.length,
      },
      projects,
      threads: this.describeThreads(threads),
      approvals: this.describeApprovals(approvals),
      approvalHistory: this.describeApprovals(this.approvalHistory()),
      artifacts,
      events,
      webSession: this.buildSessionPayload(),
    };
  }

  private buildSessionPayload(request?: http.IncomingMessage, forceAuthenticated = false): object {
    const health = this.repository.latestHealthSnapshot();
    const authenticated = forceAuthenticated || this.isRequestAuthenticated(request);
    return {
      generatedAt: new Date().toISOString(),
      authenticated,
      web: {
        controlEnabled: this.config.webControlEnabled,
        authRequired: this.config.webControlEnabled,
        allowedOrigins: this.config.webAllowedOrigins,
      },
      codexAccount: {
        source: 'local_codex_app_server',
        status: health?.codexTransportStatus ?? 'unknown',
        note: 'RCC does not hold an OpenAI web OAuth session. It uses the Codex account already authenticated in the local Codex app/CLI through Codex App Server.',
      },
    };
  }

  private buildThreadDetail(threadId: string): object {
    const thread = this.sessionRegistry.findThreadById(threadId);
    if (!thread) {
      return { error: 'thread_not_found', threadId };
    }

    return {
      thread: this.describeThread(thread),
      approvals: this.describeApprovals(this.repository.listApprovals(thread.id)),
      artifacts: this.repository.listArtifactsByThread(thread.id).map((artifact) => this.describeArtifact(artifact, thread)),
      outputs: this.repository.listRecentTurnOutputs(thread.id, 25),
      reasoningSummaries: this.repository.listRecentReasoningSummaries(thread.id, 10),
      events: this.journal.listRecentEvents(50, thread.id).map((event) => this.sanitizeEvent(event)),
    };
  }

  private async buildLiveThreadCatalog(limit: number): Promise<object> {
    const codexThreads = await this.codexBridge.listCodexThreads();
    const ordered = [...codexThreads]
      .map((thread, index) => ({ thread, index }))
      .sort((left, right) => {
        const leftRunning = this.isActiveStatus(left.thread.status);
        const rightRunning = this.isActiveStatus(right.thread.status);
        if (leftRunning !== rightRunning) {
          return leftRunning ? -1 : 1;
        }
        const leftUpdated = left.thread.updatedAtMs ?? 0;
        const rightUpdated = right.thread.updatedAtMs ?? 0;
        if (leftUpdated !== rightUpdated) {
          return rightUpdated - leftUpdated;
        }
        return left.index - right.index;
      })
      .slice(0, limit);

    const threads = ordered.map(({ thread, index }) => {
      const existing = this.sessionRegistry.findThreadByCodexThreadId(thread.codexThreadId);
      const record = existing ?? this.sessionRegistry.ensureThreadForCodexThread(thread);
      const project = this.sessionRegistry.getProjectById(record.projectId);
      const lastAccessAt = this.threadLastAccessAt(thread, record.lastSeenAt ?? record.createdAt);
      const status = this.overlayThreadStatus(thread.status, record.status);
      return {
        id: record.id,
        projectId: record.projectId,
        projectName: project?.name ?? 'unknown',
        codexThreadId: thread.codexThreadId,
        threadName: thread.threadName ?? record.threadName,
        cwd: thread.cwd || record.cwd,
        status,
        activeTurnId: record.activeTurnId,
        lastSeenAt: record.lastSeenAt,
        lastAccessAt,
        mode: this.codexBridge.getThreadMode(record.id),
        skills: this.codexBridge.getThreadSkills(record.id),
        catalogOrder: index + 1,
        source: existing ? 'rcc_registry+codex_catalog' : 'codex_catalog_imported',
      };
    });

    return {
      generatedAt: new Date().toISOString(),
      totalCount: codexThreads.length,
      count: threads.length,
      threads,
      projects: this.sessionRegistry.listProjects(),
      threadListHealth: this.codexBridge.getThreadListHealth(),
      note: 'Live Codex catalog is fetched on demand. Threads are imported into RCC only when shown so web run/say actions have a stable RCC thread id.',
    };
  }

  private buildEventsPayload(url: URL): object {
    const since = Number(url.searchParams.get('since') ?? 'NaN');
    const limit = this.parseLimit(url, 50, 200);
    const threadId = url.searchParams.get('threadId') ?? undefined;
    const events =
      Number.isFinite(since) && since >= 0
        ? this.journal.listSinceSequenceWithSequences(since, limit).filter((event) => !threadId || event.threadId === threadId)
        : this.journal.listRecentEvents(limit, threadId);

    return {
      latestSequence: this.journal.latestSequence(),
      events: events.map((event) => this.sanitizeEvent(event)),
    };
  }

  private streamEvents(request: http.IncomingMessage, response: http.ServerResponse): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    response.write(': RCC local event stream. Payloads are redacted by design.\\n\\n');

    const listener = (event: RccEventEnvelope): void => {
      const sequence = this.journal.latestSequence();
      response.write(`event: rcc-event\\n`);
      response.write(`data: ${JSON.stringify(this.sanitizeEvent({ ...event, sequence }))}\\n\\n`);
    };
    const heartbeat = setInterval(() => {
      response.write(': heartbeat\\n\\n');
    }, 15_000);

    this.eventBus.on('*', listener);
    request.on('close', () => {
      clearInterval(heartbeat);
      this.eventBus.off('*', listener);
    });
  }

  private streamThreadEvents(request: http.IncomingMessage, response: http.ServerResponse, threadId: string): void {
    const thread = this.sessionRegistry.findThreadById(threadId);
    if (!thread) {
      this.sendJson(response, 404, { error: 'thread_not_found', threadId });
      return;
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    response.write(': RCC selected-thread stream. Only App Server-exposed output/events are sent; hidden/raw reasoning is not exposed.\\n\\n');

    for (const output of this.repository.listRecentTurnOutputs(threadId, 25).reverse()) {
      response.write('event: thread-output\\n');
      response.write(`data: ${JSON.stringify(output)}\\n\\n`);
    }
    for (const summary of this.repository.listRecentReasoningSummaries(threadId, 10).reverse()) {
      response.write('event: reasoning-summary\\n');
      response.write(`data: ${JSON.stringify(summary)}\\n\\n`);
    }

    const listener = (event: RccEventEnvelope): void => {
      if (event.threadId !== threadId) {
        return;
      }
      const payload = this.asRecord(event.payload);
      response.write('event: thread-event\\n');
      response.write(`data: ${JSON.stringify(this.sanitizeEvent(event))}\\n\\n`);
      if (event.eventType === 'TurnOutputObserved' && typeof payload.text === 'string') {
        response.write('event: thread-output\\n');
        response.write(`data: ${JSON.stringify({
          occurredAt: event.occurredAt,
          threadId,
          turnId: event.turnId,
          kind: typeof payload.kind === 'string' ? payload.kind : 'system',
          text: payload.text,
          method: typeof payload.method === 'string' ? payload.method : undefined,
        })}\\n\\n`);
      }
      if (event.eventType === 'ReasoningSummaryObserved' && typeof payload.text === 'string') {
        response.write('event: reasoning-summary\\n');
        response.write(`data: ${JSON.stringify({
          occurredAt: event.occurredAt,
          threadId,
          turnId: event.turnId,
          text: redactSensitiveText(payload.text),
          method: typeof payload.method === 'string' ? payload.method : undefined,
          source: 'app_server',
        })}\\n\\n`);
      }
      if (event.eventType === 'ReasoningTextDeltaObserved' && typeof payload.text === 'string') {
        response.write('event: reasoning-text-delta\\n');
        response.write(`data: ${JSON.stringify({
          occurredAt: event.occurredAt,
          threadId,
          turnId: event.turnId,
          text: redactSensitiveText(payload.text),
          method: typeof payload.method === 'string' ? payload.method : undefined,
          source: 'app_server',
          experimental: true,
        })}\\n\\n`);
      }
    };
    const heartbeat = setInterval(() => {
      response.write(': heartbeat\\n\\n');
    }, 15_000);

    this.eventBus.on('*', listener);
    request.on('close', () => {
      clearInterval(heartbeat);
      this.eventBus.off('*', listener);
    });
  }

  private describeThreads(threads: ThreadRecord[]): Array<object> {
    return threads.map((thread) => this.describeThread(thread));
  }

  private approvalHistory(): ApprovalRecord[] {
    return this.repository
      .listApprovals()
      .filter((approval) => approval.status !== 'pending')
      .slice(0, 50);
  }

  private describeThread(thread: ThreadRecord): object {
    const project = this.sessionRegistry.getProjectById(thread.projectId);
    return {
      id: thread.id,
      projectId: thread.projectId,
      projectName: project?.name ?? 'unknown',
      codexThreadId: thread.codexThreadId,
      threadName: thread.threadName,
      cwd: thread.cwd,
      status: thread.status,
      activeTurnId: thread.activeTurnId,
      lastSeenAt: thread.lastSeenAt,
      createdAt: thread.createdAt,
      mode: this.codexBridge.getThreadMode(thread.id),
      skills: this.codexBridge.getThreadSkills(thread.id),
    };
  }

  private latestDisplayOutput(threadId: string): TurnOutputRecord | null {
    const outputs = this.repository.listRecentTurnOutputs(threadId, 50);
    const latestAssistant = outputs.find((output) => output.kind === 'assistant_text' && output.text.trim());
    if (!latestAssistant) {
      return outputs.find((output) => output.text.trim()) ?? null;
    }

    const sameMessageChunks = outputs
      .filter((output) =>
        output.kind === 'assistant_text'
        && output.turnId === latestAssistant.turnId
        && output.method === latestAssistant.method
        && output.sequence <= latestAssistant.sequence,
      )
      .sort((left, right) => left.sequence - right.sequence);

    if (sameMessageChunks.length <= 1) {
      return latestAssistant;
    }

    return {
      ...latestAssistant,
      sequence: sameMessageChunks[0]?.sequence ?? latestAssistant.sequence,
      occurredAt: latestAssistant.occurredAt,
      text: sameMessageChunks.map((output) => output.text).join(''),
    };
  }

  private isActiveStatus(status?: ThreadStatus): boolean {
    return status === 'running' || status === 'waiting_approval' || status === 'waiting_operator';
  }

  private overlayThreadStatus(liveStatus: ThreadStatus, mappedStatus?: ThreadStatus): ThreadStatus {
    if (!mappedStatus) {
      return liveStatus;
    }
    if (this.isActiveStatus(mappedStatus)) {
      return mappedStatus;
    }
    if (liveStatus === 'idle' && mappedStatus === 'failed') {
      return mappedStatus;
    }
    return liveStatus;
  }

  private threadLastAccessAt(codexThread: CodexThread, fallbackIso: string): string {
    if (typeof codexThread.updatedAtMs === 'number' && Number.isFinite(codexThread.updatedAtMs) && codexThread.updatedAtMs > 0) {
      return new Date(codexThread.updatedAtMs).toISOString();
    }
    return fallbackIso;
  }

  private describeApprovals(approvals: ApprovalRecord[]): Array<object> {
    return approvals.map((approval) => {
      const thread = this.sessionRegistry.findThreadById(approval.threadId);
      const project = thread ? this.sessionRegistry.getProjectById(thread.projectId) : undefined;
      const details = buildApprovalDetails(approval, thread, project);
      return {
        id: approval.id,
        threadId: approval.threadId,
        projectName: project?.name ?? 'unknown',
        threadName: thread?.threadName ?? thread?.codexThreadId ?? approval.threadId,
        turnId: approval.turnId,
        actionType: approval.actionType,
        summary: this.truncate(redactApprovalText(approval.summary), 180),
        category: details.category,
        risk: details.risk,
        why: details.why,
        impact: details.impact,
        source: details.source,
        cwd: details.cwd,
        commandPreview: details.commandPreview,
        fileSummary: details.fileSummary,
        diffSummary: details.diffSummary,
        networkAccess: details.networkAccess,
        gitAccess: details.gitAccess,
        destructive: details.destructive,
        decisionHint: details.decisionHint,
        age: details.age,
        status: approval.status,
        expiresAt: approval.expiresAt,
        createdAt: approval.createdAt,
        actions: {
          approve: `/approve ${approval.id}`,
          deny: `/deny ${approval.id}`,
          interrupt: `/interrupt ${thread?.codexThreadId ?? approval.threadId}`,
        },
      };
    });
  }

  private describeArtifacts(threads = this.sessionRegistry.listThreads()): Array<object> {
    return threads.flatMap((thread) =>
      this.repository.listArtifactsByThread(thread.id).map((artifact) => this.describeArtifact(artifact, thread)),
    );
  }

  private describeArtifact(artifact: ArtifactRecord, thread: ThreadRecord): object {
    const project = this.sessionRegistry.getProjectById(thread.projectId);
    return {
      id: artifact.id,
      threadId: artifact.threadId,
      projectName: project?.name ?? 'unknown',
      threadName: thread.threadName ?? thread.codexThreadId,
      artifactType: artifact.artifactType,
      filename: artifact.filename,
      localPath: artifact.localPath,
      sizeBytes: artifact.sizeBytes,
      status: artifact.status,
      createdAt: artifact.createdAt,
    };
  }

  private sanitizeEvent(event: RccEventEnvelope & { sequence?: number }): DashboardEvent {
    return {
      sequence: event.sequence,
      eventId: event.eventId,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      projectId: event.projectId,
      threadId: event.threadId,
      turnId: event.turnId,
      summary: this.eventSummary(event),
    };
  }

  private eventSummary(event: RccEventEnvelope): string {
    const payload = this.asRecord(event.payload);
    switch (event.eventType) {
      case 'TurnOutputObserved': {
        const kind = typeof payload.kind === 'string' ? payload.kind : 'output';
        const text = typeof payload.text === 'string' ? payload.text : '';
        return `${kind} observed (${text.length} chars, body redacted)`;
      }
      case 'ReasoningSummaryObserved': {
        const text = typeof payload.text === 'string' ? payload.text : '';
        return `reasoning summary observed (${text.length} chars, body redacted)`;
      }
      case 'ReasoningTextDeltaObserved': {
        const text = typeof payload.text === 'string' ? payload.text : '';
        return `experimental reasoning text delta observed (${text.length} chars, body redacted)`;
      }
      case 'OperatorMessageReceived':
      case 'OperatorMessageQueued': {
        const text = typeof payload.messageText === 'string' ? payload.messageText : '';
        return `operator message recorded (${text.length} chars, body redacted)`;
      }
      case 'ApprovalAwaitingOperator':
        return `approval waiting (${typeof payload.actionType === 'string' ? payload.actionType : 'unknown action'})`;
      case 'ApprovalResolutionAcked':
      case 'ApprovalResolutionForwarded':
        return `approval ${typeof payload.decision === 'string' ? payload.decision : 'resolution updated'}`;
      case 'ApprovalResolutionFailed':
        return `approval resolution failed: ${typeof payload.reason === 'string' ? this.truncate(payload.reason, 160) : 'reason unknown'}`;
      case 'ApprovalExpired':
        return `approval expired (${typeof payload.reason === 'string' ? payload.reason : 'reason unknown'})`;
      case 'ApprovalSuperseded':
        return 'approval superseded';
      case 'AttachmentMaterialized':
        return `attachment materialized: ${this.safeBasename(payload.localPath)}`;
      case 'ArtifactDetected':
        return `artifact detected: ${this.safeBasename(payload.localPath)}`;
      case 'ArtifactSendAttempted':
        return `artifact send attempted: ${this.safeBasename(payload.localPath)}`;
      case 'ArtifactSendFallbackUsed':
        return `artifact fallback used: ${typeof payload.fallback === 'string' ? payload.fallback : 'unknown'}`;
      case 'PolicyEvaluated': {
        const allowed = payload.allowed === true ? 'allowed' : 'blocked';
        return `policy ${allowed}: ${typeof payload.policyId === 'string' ? payload.policyId : 'unknown'}`;
      }
      case 'ThreadStatusChanged':
        return `thread status: ${typeof payload.status === 'string' ? payload.status : 'unknown'}`;
      default:
        return event.eventType;
    }
  }

  private renderHome(): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#0e1f1b" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <title>RCC Local Control Panel</title>
  <style>
    :root {
      --bg: #0b1714;
      --panel: rgba(244, 234, 204, 0.08);
      --line: rgba(244, 234, 204, 0.18);
      --text: #f8f0d2;
      --muted: #aebcae;
      --accent: #f3b450;
      --danger: #ff7b72;
      --ok: #73d19b;
      font-family: Avenir Next, Charter, Georgia, serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text);
      background:
        radial-gradient(circle at 20% 0%, rgba(243, 180, 80, 0.24), transparent 28rem),
        radial-gradient(circle at 90% 10%, rgba(115, 209, 155, 0.18), transparent 24rem),
        linear-gradient(145deg, #07100e, var(--bg));
      min-height: 100vh;
    }
    main { max-width: 1180px; margin: 0 auto; padding: 28px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; flex-wrap: wrap; margin-bottom: 18px; }
    h1 { margin: 0; font-size: clamp(2rem, 7vw, 4.7rem); letter-spacing: -0.08em; line-height: 0.92; }
    h2 { margin: 0 0 12px; font-size: 1.05rem; text-transform: uppercase; letter-spacing: 0.12em; color: var(--accent); }
    .muted { color: var(--muted); }
    .pill { border: 1px solid var(--line); border-radius: 999px; padding: 8px 12px; background: rgba(0, 0, 0, 0.22); }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 20px 0; }
    .panel { border: 1px solid var(--line); border-radius: 20px; padding: 16px; background: var(--panel); box-shadow: 0 18px 50px rgba(0, 0, 0, 0.22); backdrop-filter: blur(10px); }
    .number { font-size: 2.2rem; font-weight: 800; color: var(--accent); }
    .layout { display: grid; grid-template-columns: 1.15fr 0.85fr; gap: 14px; align-items: start; }
    .list { display: grid; gap: 10px; }
    .item { border: 1px solid var(--line); border-radius: 14px; padding: 12px; background: rgba(0, 0, 0, 0.18); }
    .item strong { color: #fff8dc; }
    .tag { display: inline-block; margin-left: 6px; padding: 2px 8px; border-radius: 999px; font-size: 0.78rem; background: rgba(243, 180, 80, 0.16); color: var(--accent); }
    .tag.running, .tag.waiting_approval, .tag.waiting_operator { background: rgba(115, 209, 155, 0.16); color: var(--ok); }
    .tag.failed { background: rgba(255, 123, 114, 0.16); color: var(--danger); }
    pre { white-space: pre-wrap; overflow-x: auto; margin: 0; font: 0.9rem ui-monospace, SFMono-Regular, Menlo, monospace; color: #dbe7d6; }
    a { color: var(--accent); }
    footer { margin-top: 24px; color: var(--muted); font-size: 0.92rem; }
    @media (max-width: 780px) {
      main { padding: 18px; }
      .grid, .layout { grid-template-columns: 1fr; }
      header { display: block; }
      .pill { margin-top: 12px; display: inline-block; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>RCC Local<br />Control Panel</h1>
        <p class="muted">Read-only localhost dashboard. Telegram remains the approval and control channel.</p>
      </div>
      <div class="pill" id="freshness">Loading...</div>
    </header>
    <section class="grid" id="counts"></section>
    <section class="layout">
      <div class="panel">
        <h2>Threads</h2>
        <div class="list" id="threads"></div>
      </div>
      <div class="panel">
        <h2>Approvals</h2>
        <div class="list" id="approvals"></div>
      </div>
      <div class="panel">
        <h2>Artifacts</h2>
        <div class="list" id="artifacts"></div>
      </div>
      <div class="panel">
        <h2>Recent Events</h2>
        <div class="list" id="events"></div>
      </div>
    </section>
    <section class="panel" style="margin-top: 14px;">
      <h2>Status</h2>
      <pre id="statusText">Loading...</pre>
    </section>
    <footer>
      JSON: <a href="/api/dashboard">dashboard</a> | <a href="/api/health">health</a> | <a href="/api/events">events</a> | <a href="/api/events/stream">event stream</a>
    </footer>
  </main>
  <script>
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const byId = (id) => document.getElementById(id);
    const item = (html) => '<div class="item">' + html + '</div>';
    const empty = (text) => '<div class="item muted">' + esc(text) + '</div>';

    async function refresh() {
      const response = await fetch('/api/dashboard', { cache: 'no-store' });
      const data = await response.json();
      byId('freshness').textContent = data.health ? data.health.freshnessState + ' | ' + data.health.codexTransportStatus : 'health unknown';
      byId('statusText').textContent = data.statusText || '';
      byId('counts').innerHTML = Object.entries(data.counts || {}).map(([key, value]) =>
        '<div class="panel"><div class="number">' + esc(value) + '</div><div class="muted">' + esc(key) + '</div></div>'
      ).join('');
      byId('threads').innerHTML = (data.threads || []).slice(0, 12).map((thread) =>
        item('<strong>' + esc(thread.threadName || thread.codexThreadId) + '</strong><span class="tag ' + esc(thread.status) + '">' + esc(thread.status) + '</span><br><span class="muted">' + esc(thread.projectName) + ' | ' + esc(thread.cwd) + '</span>')
      ).join('') || empty('No threads recorded.');
      byId('approvals').innerHTML = (data.approvals || []).map((approval) =>
        item('<strong>' + esc(approval.summary) + '</strong><br><span class="muted">' + esc(approval.projectName) + ' / ' + esc(approval.threadName) + '</span><br><code>' + esc(approval.actions.approve) + '</code> | <code>' + esc(approval.actions.deny) + '</code>')
      ).join('') || empty('No pending approvals.');
      byId('artifacts').innerHTML = (data.artifacts || []).slice(0, 12).map((artifact) =>
        item('<strong>' + esc(artifact.filename) + '</strong><span class="tag">' + esc(artifact.status) + '</span><br><span class="muted">' + esc(artifact.projectName) + ' / ' + esc(artifact.threadName) + ' | ' + esc(artifact.sizeBytes || 0) + ' bytes</span>')
      ).join('') || empty('No artifacts detected.');
      byId('events').innerHTML = (data.events || []).slice(-16).reverse().map((event) =>
        item('<strong>' + esc(event.eventType) + '</strong><br><span class="muted">' + esc(event.occurredAt) + '</span><br>' + esc(event.summary))
      ).join('') || empty('No events recorded.');
    }

    refresh().catch((error) => { byId('statusText').textContent = String(error); });
    setInterval(() => { refresh().catch(() => {}); }, 2500);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/service-worker.js').catch(() => {});
    }
  </script>
</body>
</html>`;
  }

  private renderManifest(): object {
    return {
      name: 'RCC Local Control Panel',
      short_name: 'RCC',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#0b1714',
      theme_color: '#0e1f1b',
      description: 'Read-only local dashboard for RCC alpha supervision.',
      icons: [],
    };
  }

  private renderServiceWorker(): string {
    return [
      "self.addEventListener('install', (event) => { self.skipWaiting(); });",
      "self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });",
      "// No caching in alpha: RCC data can contain sensitive local project metadata.",
    ].join('\n');
  }

  private parseLimit(url: URL, fallback: number, max: number): number {
    const raw = Number(url.searchParams.get('limit') ?? fallback);
    if (!Number.isFinite(raw)) {
      return fallback;
    }
    return Math.max(1, Math.min(Math.floor(raw), max));
  }

  private sendHtml(response: http.ServerResponse, body: string): void {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(body);
  }

  private sendJavascript(response: http.ServerResponse, body: string): void {
    response.writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(body);
  }

  private sendJson(response: http.ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify(value, null, 2));
  }

  private async sendArtifactDownload(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    artifactId: string,
  ): Promise<void> {
    if (!this.requireWebControl(request, response)) {
      return;
    }

    const artifact = this.findArtifactById(artifactId);
    if (!artifact) {
      this.sendJson(response, 404, { error: 'artifact_not_found', artifactId });
      return;
    }

    const artifactRoot = path.resolve(this.config.artifactsRoot, artifact.threadId);
    const localPath = path.resolve(artifact.localPath);
    if (!localPath.startsWith(`${artifactRoot}${path.sep}`)) {
      this.sendJson(response, 403, { error: 'artifact_path_blocked', reason: 'artifact outside thread-scoped artifact root' });
      return;
    }
    if (!fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) {
      this.sendJson(response, 404, { error: 'artifact_file_missing', artifactId });
      return;
    }

    response.writeHead(200, {
      'content-type': this.contentTypeForPath(localPath),
      'cache-control': 'no-store',
      'content-disposition': `attachment; filename="${path.basename(localPath).replace(/"/g, '')}"`,
    });
    fs.createReadStream(localPath).pipe(response);
  }

  private findArtifactById(artifactId: string): ArtifactRecord | undefined {
    for (const thread of this.sessionRegistry.listThreads()) {
      const artifact = this.repository.listArtifactsByThread(thread.id).find((item) => item.id === artifactId);
      if (artifact) {
        return artifact;
      }
    }
    return undefined;
  }

  private applyCorsHeaders(request: http.IncomingMessage, response: http.ServerResponse): void {
    const origin = request.headers.origin;
    if (!this.isCorsOriginAllowed(origin)) {
      return;
    }
    if (!origin) {
      return;
    }
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('vary', 'Origin');
    response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    response.setHeader('access-control-allow-headers', 'authorization,content-type');
    response.setHeader('access-control-max-age', '600');
  }

  private isCorsOriginAllowed(origin: string | undefined): origin is string {
    if (!origin) {
      return true;
    }
    return this.config.webAllowedOrigins.includes(origin);
  }

  private requireWebControl(request: http.IncomingMessage, response: http.ServerResponse): boolean {
    if (!this.config.webControlEnabled) {
      this.sendJson(response, 403, {
        error: 'web_control_disabled',
        nextStep: 'Set RCC_WEB_CONTROL_ENABLED=true and RCC_WEB_AUTH_TOKEN in setup.md to enable website control.',
      });
      return false;
    }
    if (!this.config.webAuthToken) {
      this.sendJson(response, 401, { error: 'web_auth_token_required' });
      return false;
    }
    if (!this.isRequestAuthenticated(request)) {
      this.sendJson(response, 401, { error: 'unauthorized_web_session' });
      return false;
    }
    return true;
  }

  private isRequestAuthenticated(request?: http.IncomingMessage): boolean {
    if (!request || !this.config.webAuthToken) {
      return false;
    }
    const authorization = request.headers.authorization ?? '';
    return authorization === `Bearer ${this.config.webAuthToken}`;
  }

  private async readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const bytes = chunks.reduce((sum, item) => sum + item.byteLength, 0);
      const maxBodyBytes = Math.max(128 * 1024, this.config.telegramDownloadLimitBytes * 2);
      if (bytes > maxBodyBytes) {
        throw new Error('Request body too large.');
      }
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  }

  private requireMessage(body: Record<string, unknown>): string {
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) {
      throw new Error('Missing required message.');
    }
    if (message.length > 20_000) {
      throw new Error('Message too large.');
    }
    return message;
  }

  private requireMode(value: unknown): CodexThreadMode {
    const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (mode !== 'plan' && mode !== 'build') {
      throw new Error('Mode must be one of: plan, build.');
    }
    return mode;
  }

  private parseOptionalMode(value: unknown): CodexThreadMode | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    return this.requireMode(value);
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

  private async resolveRequestedSkills(threadId: string, value: unknown): Promise<CodexSkillRef[] | undefined> {
    if (value === undefined) {
      return undefined;
    }
    if (!Array.isArray(value)) {
      throw new Error('skills must be an array.');
    }
    const resolved: CodexSkillRef[] = [];
    for (const item of value) {
      resolved.push(await this.resolveRequestedSkill(threadId, this.asRecord(item)));
    }
    return resolved;
  }

  private async resolveRequestedSkill(threadId: string, body: Record<string, unknown>): Promise<CodexSkillRef> {
    if (typeof body.path === 'string' && body.path.trim()) {
      throw new Error('Do not send arbitrary skill paths. Select a skill by name from GET /api/threads/:threadId/skills.');
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      throw new Error('Skill name is required.');
    }
    const available = await this.codexBridge.listSkillsForThread(threadId);
    const lower = name.toLowerCase();
    const match = available.find((skill) => skill.name === name || skill.name.toLowerCase() === lower);
    if (!match) {
      throw new Error(`Unknown skill "${name}". Load GET /api/threads/${encodeURIComponent(threadId)}/skills and select one of the returned skills.`);
    }
    if (!match.path) {
      throw new Error(`Skill "${match.name}" did not include an App Server-provided path and cannot be invoked safely.`);
    }
    return match;
  }

  private requireAttachmentFiles(body: Record<string, unknown>): Array<{
    name: string;
    mimeType?: string;
    sizeBytes: number;
    base64: string;
  }> {
    if (!Array.isArray(body.files) || body.files.length === 0) {
      throw new Error('attachments endpoint requires files array.');
    }
    if (body.files.length > 5) {
      throw new Error('At most 5 files may be uploaded in one request.');
    }
    return body.files.map((item) => {
      const record = this.asRecord(item);
      const name = typeof record.name === 'string' ? path.basename(record.name.trim()) : '';
      const base64 = typeof record.base64 === 'string' ? record.base64.trim() : '';
      const sizeBytes = typeof record.sizeBytes === 'number' ? record.sizeBytes : Number(record.sizeBytes);
      if (!name) {
        throw new Error('Each attachment requires name.');
      }
      if (!base64 || /[^A-Za-z0-9+/=]/.test(base64)) {
        throw new Error(`Attachment ${name} has invalid base64 content.`);
      }
      if (!Number.isFinite(sizeBytes) || sizeBytes < 0 || sizeBytes > this.config.telegramDownloadLimitBytes) {
        throw new Error(`Attachment ${name} has invalid or too-large size.`);
      }
      return {
        name,
        mimeType: typeof record.mimeType === 'string' && record.mimeType.trim() ? record.mimeType.trim() : undefined,
        sizeBytes,
        base64,
      };
    });
  }

  private contentTypeForPath(localPath: string): string {
    switch (path.extname(localPath).toLowerCase()) {
      case '.md':
      case '.txt':
        return 'text/plain; charset=utf-8';
      case '.pdf':
        return 'application/pdf';
      case '.png':
        return 'image/png';
      case '.jpg':
      case '.jpeg':
        return 'image/jpeg';
      case '.zip':
        return 'application/zip';
      default:
        return 'application/octet-stream';
    }
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  }

  private safeBasename(value: unknown): string {
    return typeof value === 'string' ? path.basename(value) : 'unknown';
  }

  private truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, maxLength - 1)}...`;
  }
}
