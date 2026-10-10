import fs from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type {
  AppServerApprovalRequest,
  AppServerClient,
  AppServerEvent,
  CodexSkillRef,
  CodexThread,
  StartThreadInput,
  StartTurnInput,
  SteerTurnInput,
} from '../../contracts/codex.js';
import type { ThreadStatus } from '../../contracts/states.js';
import type { Logger } from '../../logger.js';
import { newId } from '../../utils/ids.js';
import { nowIso } from '../../utils/time.js';

type JsonRpcId = string | number;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc?: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcSuccessResponse {
  jsonrpc?: '2.0';
  id: JsonRpcId;
  result: unknown;
}

interface JsonRpcErrorResponse {
  jsonrpc?: '2.0';
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

type JsonRpcInbound = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccessResponse | JsonRpcErrorResponse;

const DEFAULT_MAX_JSONRPC_LINE_CHARS = 64 * 1024 * 1024;
const MIN_JSONRPC_LINE_CHARS = 1024 * 1024;

const parseMaxJsonRpcLineChars = (): number => {
  const raw = process.env.RCC_CODEX_JSONRPC_MAX_LINE_CHARS;
  if (!raw) {
    return DEFAULT_MAX_JSONRPC_LINE_CHARS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < MIN_JSONRPC_LINE_CHARS) {
    return DEFAULT_MAX_JSONRPC_LINE_CHARS;
  }
  return Math.floor(parsed);
};

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
}

interface PendingApprovalRequest {
  method: string;
  params: Record<string, unknown>;
}

interface CodexAppServerClientOptions {
  mode: 'stdio' | 'websocket';
  command?: string;
  wsUrl?: string;
  logger: Logger;
}

export class CodexAppServerClient implements AppServerClient {
  private readonly listeners = new Set<(event: AppServerEvent) => void>();
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly pendingApprovals = new Map<string, PendingApprovalRequest>();

  private requestIdCounter = 1;
  private lineBuffer = '';
  private initialized = false;
  private heartbeatTimer?: NodeJS.Timeout;
  private readonly maxJsonRpcLineChars: number;

  private stdioProcess?: ChildProcessWithoutNullStreams;
  private websocket?: WebSocket;

  constructor(private readonly options: CodexAppServerClientOptions) {
    this.maxJsonRpcLineChars = parseMaxJsonRpcLineChars();
  }

  async initialize(): Promise<void> {
    await this.connect();
    await this.sendRequest('initialize', {
      clientInfo: {
        name: 'rcc',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    });

    this.initialized = true;
    this.emit({
      type: 'transport_connected',
      timestamp: nowIso(),
    });

    this.heartbeatTimer = setInterval(() => {
      this.emit({
        type: 'heartbeat',
        timestamp: nowIso(),
      });
    }, 15_000);
  }

  onEvent(listener: (event: AppServerEvent) => void): void {
    this.listeners.add(listener);
  }

  /** Stops the heartbeat, fails pending requests and ends the transport. */
  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(new Error(`Codex app-server closed before ${pending.method} completed`));
    }
    this.pendingApprovals.clear();
    this.websocket?.close();
    this.websocket = undefined;
    this.stdioProcess?.kill();
    this.stdioProcess = undefined;
    this.initialized = false;
  }

  async startThread(input: StartThreadInput): Promise<CodexThread> {
    this.assertInitialized();

    // Writes are confined to the workspace. Actions that need more access wait for
    // an approval request, which RCC answers.
    const result = (await this.sendRequest('thread/start', {
      cwd: input.cwd,
      model: input.model ?? null,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    })) as { thread: Record<string, unknown> };

    const thread = this.mapThread(result.thread);

    if (input.threadName) {
      await this.sendRequest('thread/name/set', {
        threadId: thread.codexThreadId,
        name: input.threadName,
      });
      thread.threadName = input.threadName;
    }

    return thread;
  }

  async resumeThread(codexThreadId: string): Promise<CodexThread> {
    this.assertInitialized();
    const result = (await this.sendRequest('thread/resume', {
      threadId: codexThreadId,
      // Resuming historical threads can emit very large history payloads. RCC
      // only needs the App Server to attach the thread before a new turn.
      persistExtendedHistory: false,
    })) as { thread: Record<string, unknown> };
    return this.mapThread(result.thread);
  }

  async startTurn(input: StartTurnInput): Promise<{ turnId: string }> {
    this.assertInitialized();
    const result = (await this.sendRequest('turn/start', this.buildTurnStartParams(input))) as { turn: { id: string } };
    return { turnId: result.turn.id };
  }

  async listSkills(cwd: string): Promise<CodexSkillRef[]> {
    this.assertInitialized();
    const result = (await this.sendRequest('skills/list', {
      cwds: [cwd],
      forceReload: false,
    })) as { data?: Array<{ cwd?: string; skills?: Array<Record<string, unknown>> }> };
    const match = (result.data ?? []).find((item) => item.cwd === cwd) ?? result.data?.[0];
    return (match?.skills ?? []).map((skill) => ({
      name: String(skill.name ?? ''),
      path: skill.path ? String(skill.path) : undefined,
      description: skill.description ? String(skill.description) : undefined,
      enabled: skill.enabled === undefined ? undefined : skill.enabled === true,
    })).filter((skill) => skill.name);
  }

  async steerTurn(input: SteerTurnInput): Promise<void> {
    this.assertInitialized();
    await this.sendRequest('turn/steer', {
      threadId: input.codexThreadId,
      input: [this.textInput(input.message)],
      expectedTurnId: input.turnId,
    });
  }

  async interruptTurn(codexThreadId: string, turnId: string): Promise<void> {
    this.assertInitialized();
    await this.sendRequest('turn/interrupt', {
      threadId: codexThreadId,
      turnId,
    });
  }

  async listThreads(): Promise<CodexThread[]> {
    this.assertInitialized();
    const result = (await this.sendRequest('thread/list', {
      archived: false,
      limit: 100,
    })) as { data: Array<Record<string, unknown>> };
    return result.data.map((thread) => this.mapThread(thread));
  }

  /**
   * Answers a pending server approval request. Unknown or already answered requests throw.
   */
  async resolveApproval(requestId: string, decision: 'approved' | 'denied'): Promise<{ ackId: string }> {
    this.assertInitialized();
    const pendingApproval = this.pendingApprovals.get(requestId);
    if (!pendingApproval) {
      throw new Error(`Unknown approval request ${requestId}`);
    }

    const responsePayload = this.buildApprovalResponse(pendingApproval.method, pendingApproval.params, decision);
    this.sendResponse(requestId, responsePayload);
    this.pendingApprovals.delete(requestId);
    return { ackId: newId() };
  }

  private async connect(): Promise<void> {
    if (this.options.mode === 'stdio') {
      await this.connectStdio();
      return;
    }
    await this.connectWebSocket();
  }

  private async connectStdio(): Promise<void> {
    let command = this.options.command ?? 'codex app-server --listen stdio://';
    // Prefer the binary bundled with the Codex desktop app when it is installed.
    // A bare `codex` command may not be on PATH.
    if (command.trim().startsWith('codex ')) {
      const appBin = '/Applications/Codex.app/Contents/Resources/codex';
      if (fs.existsSync(appBin)) {
        command = command.replace(/^codex\b/, appBin);
      }
    }
    this.stdioProcess = spawn('/bin/zsh', ['-lc', command], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    this.stdioProcess.stdout.on('data', (chunk) => this.handleStreamData(chunk.toString('utf8')));
    this.stdioProcess.stderr.on('data', (chunk) => {
      this.options.logger.warn('codex-app-server-stderr', {
        output: chunk.toString('utf8').trim(),
      });
    });
    this.stdioProcess.on('exit', (code, signal) => {
      this.options.logger.warn('codex-app-server-exit', { code, signal });
      this.emit({
        type: 'transport_disconnected',
        timestamp: nowIso(),
      });
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timed out waiting for codex app-server stdio process start.'));
      }, 5_000);

      this.stdioProcess?.once('spawn', () => {
        clearTimeout(timeout);
        resolve();
      });
      this.stdioProcess?.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  private async connectWebSocket(): Promise<void> {
    const wsUrl = this.options.wsUrl;
    if (!wsUrl) {
      throw new Error('Websocket mode requires wsUrl');
    }

    this.websocket = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      const ws = this.websocket;
      if (!ws) {
        reject(new Error('Failed to create websocket'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error(`Timed out connecting to Codex app-server websocket at ${wsUrl}`));
      }, 8_000);

      ws.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error(`Websocket connection error for ${wsUrl}`));
      };

      ws.onclose = () => {
        this.emit({
          type: 'transport_disconnected',
          timestamp: nowIso(),
        });
      };

      ws.onmessage = (event) => {
        const data = typeof event.data === 'string' ? event.data : String(event.data);
        this.handleIncomingMessage(data);
      };
    });
  }

  private sendMessage(message: JsonRpcRequest | JsonRpcSuccessResponse | JsonRpcErrorResponse): void {
    const wire = `${JSON.stringify(message)}\n`;

    if (this.options.mode === 'stdio') {
      if (!this.stdioProcess || this.stdioProcess.stdin.destroyed) {
        throw new Error('Codex stdio transport is not writable');
      }
      this.stdioProcess.stdin.write(wire);
      return;
    }

    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
      throw new Error('Codex websocket transport is not open');
    }

    this.websocket.send(JSON.stringify(message));
  }

  private handleStreamData(chunk: string): void {
    if (!this.lineBuffer && chunk.length > this.maxJsonRpcLineChars && !chunk.includes('\n')) {
      this.options.logger.warn('codex-app-server-line-buffer-overflow', {
        bufferChars: chunk.length,
        maxChars: this.maxJsonRpcLineChars,
        action: 'dropped_unframed_chunk',
      });
      return;
    }

    this.lineBuffer += chunk;

    while (true) {
      const index = this.lineBuffer.indexOf('\n');
      if (index === -1) {
        if (this.lineBuffer.length > this.maxJsonRpcLineChars) {
          this.options.logger.warn('codex-app-server-line-buffer-overflow', {
            bufferChars: this.lineBuffer.length,
            maxChars: this.maxJsonRpcLineChars,
            action: 'reset_buffer',
          });
          this.lineBuffer = '';
        }
        break;
      }

      if (index > this.maxJsonRpcLineChars) {
        this.options.logger.warn('codex-app-server-line-too-large', {
          lineChars: index,
          maxChars: this.maxJsonRpcLineChars,
          action: 'dropped_line',
        });
        this.lineBuffer = this.lineBuffer.slice(index + 1);
        continue;
      }

      const line = this.lineBuffer.slice(0, index).trim();
      this.lineBuffer = this.lineBuffer.slice(index + 1);
      if (!line) {
        continue;
      }

      this.handleIncomingMessage(line);
    }
  }

  private handleIncomingMessage(raw: string): void {
    let message: JsonRpcInbound;
    try {
      message = JSON.parse(raw) as JsonRpcInbound;
    } catch {
      this.options.logger.warn('codex-app-server-invalid-json', { rawChars: raw.length });
      return;
    }

    if ('method' in message && 'id' in message) {
      this.handleServerRequest(message as JsonRpcRequest);
      return;
    }

    if ('method' in message) {
      this.handleNotification(message as JsonRpcNotification);
      return;
    }

    this.handleResponse(message as JsonRpcSuccessResponse | JsonRpcErrorResponse);
  }

  private handleResponse(message: JsonRpcSuccessResponse | JsonRpcErrorResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);

    if ('error' in message) {
      pending.reject(new Error(`[${pending.method}] ${message.error.message}`));
      return;
    }

    pending.resolve(message.result);
  }

  private handleNotification(notification: JsonRpcNotification): void {
    const params = (notification.params ?? {}) as Record<string, unknown>;
    const timestamp = nowIso();

    switch (notification.method) {
      case 'thread/started': {
        const thread = this.mapThread(params.thread as Record<string, unknown>);
        this.emit({
          type: 'thread_started',
          timestamp,
          codexThreadId: thread.codexThreadId,
          threadName: thread.threadName,
          cwd: thread.cwd,
          status: thread.status,
        });
        break;
      }
      case 'thread/status/changed': {
        const codexThreadId = String(params.threadId ?? '');
        if (!codexThreadId) {
          break;
        }
        this.emit({
          type: 'thread_started',
          timestamp,
          codexThreadId,
          status: this.mapThreadStatus(params.status as Record<string, unknown>),
        });
        break;
      }
      case 'turn/started': {
        const turn = (params.turn ?? {}) as Record<string, unknown>;
        this.emit({
          type: 'turn_started',
          timestamp,
          codexThreadId: String(params.threadId ?? ''),
          turnId: String(turn.id ?? ''),
          status: 'running',
        });
        break;
      }
      case 'turn/completed': {
        const turn = (params.turn ?? {}) as Record<string, unknown>;
        const turnStatus = String(turn.status ?? '');
        this.emit({
          type: turnStatus === 'interrupted' ? 'turn_interrupted' : 'turn_completed',
          timestamp,
          codexThreadId: String(params.threadId ?? ''),
          turnId: String(turn.id ?? ''),
          status: turnStatus === 'failed' ? 'failed' : turnStatus === 'interrupted' ? 'interrupted' : 'completed',
        });
        break;
      }
      case 'serverRequest/resolved': {
        const requestId = String(params.requestId ?? '');
        if (requestId) {
          this.pendingApprovals.delete(requestId);
        }
        break;
      }
      default:
        {
          const reasoning = this.buildReasoningNotification(notification.method, params, timestamp);
          if (reasoning) {
            this.emit(reasoning);
            break;
          }
        }
        if (this.shouldEmitStreamNotification(notification.method)) {
          const stream = this.buildStreamNotification(notification.method, params, timestamp);
          if (stream) {
            this.emit(stream);
          }
        }
        break;
    }
  }

  private handleServerRequest(request: JsonRpcRequest): void {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const requestId = String(request.id);

    const approval = this.normalizeApprovalRequest(request.method, requestId, params);
    if (approval) {
      this.pendingApprovals.set(requestId, {
        method: request.method,
        params,
      });

      this.emit({
        type: 'approval_requested',
        timestamp: nowIso(),
        codexThreadId: approval.codexThreadId,
        turnId: approval.turnId,
        approval,
      });
      return;
    }

    // Reply with an error so the App Server does not wait for an answer that will never come.
    this.sendErrorResponse(request.id, -32601, `Unsupported server request method: ${request.method}`);
  }

  private normalizeApprovalRequest(
    method: string,
    requestId: string,
    params: Record<string, unknown>,
  ): AppServerApprovalRequest | undefined {
    if (method === 'item/commandExecution/requestApproval') {
      const command = params.command ? String(params.command) : undefined;
      const reason = params.reason ? String(params.reason) : undefined;
      return {
        requestId,
        codexThreadId: String(params.threadId ?? ''),
        turnId: params.turnId ? String(params.turnId) : undefined,
        actionType: 'command',
        summary: reason ?? command ?? 'Command execution approval required',
        scope: 'once',
      };
    }

    if (method === 'item/fileChange/requestApproval') {
      const reason = params.reason ? String(params.reason) : 'File change approval required';
      return {
        requestId,
        codexThreadId: String(params.threadId ?? ''),
        turnId: params.turnId ? String(params.turnId) : undefined,
        actionType: 'filesystem',
        summary: reason,
        scope: 'once',
      };
    }

    if (method === 'item/permissions/requestApproval') {
      const reason = params.reason ? String(params.reason) : 'Permissions approval required';
      return {
        requestId,
        codexThreadId: String(params.threadId ?? ''),
        turnId: params.turnId ? String(params.turnId) : undefined,
        actionType: 'other',
        summary: reason,
        scope: 'once',
      };
    }

    if (method === 'execCommandApproval') {
      const commandParts = Array.isArray(params.command) ? (params.command as unknown[]).map(String) : [];
      return {
        requestId,
        codexThreadId: String(params.conversationId ?? ''),
        turnId: undefined,
        actionType: 'command',
        summary: commandParts.join(' ') || 'Exec command approval required',
        scope: 'once',
      };
    }

    if (method === 'applyPatchApproval') {
      const fileChanges = params.fileChanges && typeof params.fileChanges === 'object'
        ? Object.keys(params.fileChanges as Record<string, unknown>).length
        : 0;
      return {
        requestId,
        codexThreadId: String(params.conversationId ?? ''),
        turnId: undefined,
        actionType: 'filesystem',
        summary: `Patch apply approval required (${fileChanges} file changes)`,
        scope: 'once',
      };
    }

    return undefined;
  }

  private buildApprovalResponse(
    method: string,
    params: Record<string, unknown>,
    decision: 'approved' | 'denied',
  ): unknown {
    switch (method) {
      case 'item/commandExecution/requestApproval':
        return { decision: decision === 'approved' ? 'accept' : 'decline' };
      case 'item/fileChange/requestApproval':
        return { decision: decision === 'approved' ? 'accept' : 'decline' };
      case 'execCommandApproval':
        return { decision: decision === 'approved' ? 'approved' : 'denied' };
      case 'applyPatchApproval':
        return { decision: decision === 'approved' ? 'approved' : 'denied' };
      case 'item/permissions/requestApproval': {
        // Grant only the network and file system access the server asked for, and only when approved.
        if (decision === 'approved') {
          const requestedPermissions = (params.permissions ?? {}) as Record<string, unknown>;
          return {
            permissions: {
              network: requestedPermissions.network ?? null,
              fileSystem: requestedPermissions.fileSystem ?? null,
            },
            scope: 'turn',
          };
        }
        return {
          permissions: {},
          scope: 'turn',
        };
      }
      default:
        return { decision: decision === 'approved' ? 'accept' : 'decline' };
    }
  }

  private async sendRequest(method: string, params?: unknown): Promise<unknown> {
    const id = this.requestIdCounter++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timed out: ${method}`));
      }, 30_000);

      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      try {
        this.sendMessage(request);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private sendResponse(id: JsonRpcId, result: unknown): void {
    this.sendMessage({
      jsonrpc: '2.0',
      id,
      result,
    });
  }

  private sendErrorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): void {
    this.sendMessage({
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
        data,
      },
    });
  }

  private textInput(text: string): { type: 'text'; text: string; text_elements: [] } {
    return {
      type: 'text',
      text,
      text_elements: [],
    };
  }

  private skillInput(skill: CodexSkillRef): { type: 'skill'; name: string; path: string } {
    if (!skill.path) {
      throw new Error(`Skill ${skill.name} is missing an App Server-provided path.`);
    }
    return {
      type: 'skill',
      name: skill.name,
      path: skill.path,
    };
  }

  private buildTurnStartParams(input: StartTurnInput): Record<string, unknown> {
    const params: Record<string, unknown> = {
      threadId: input.codexThreadId,
      input: [this.textInput(input.message), ...(input.skills ?? []).map((skill) => this.skillInput(skill))],
      model: input.model ?? null,
      effort: input.reasoningEffort ?? null,
      summary: input.reasoningSummary ?? null,
    };

    return params;
  }

  private shouldEmitStreamNotification(method: string): boolean {
    if (method.startsWith('item/')) {
      return true;
    }
    if (method.startsWith('turn/')) {
      return method !== 'turn/started' && method !== 'turn/completed';
    }
    if (method.startsWith('thread/')) {
      return method !== 'thread/started' && method !== 'thread/status/changed';
    }
    return false;
  }

  private buildStreamNotification(
    method: string,
    params: Record<string, unknown>,
    timestamp: string,
  ): AppServerEvent | undefined {
    const codexThreadId = String(params.threadId ?? params.conversationId ?? '');
    if (!codexThreadId) {
      return undefined;
    }

    const turnId = params.turnId ? String(params.turnId) : undefined;
    const fragments = this.extractTextCandidates(params);
    if (fragments.length === 0) {
      return {
        type: 'turn_stream',
        timestamp,
        codexThreadId,
        turnId,
        streamKind: 'system',
        streamMethod: method,
        streamText: method,
      };
    }

    const text = this.toOneLine(fragments.join(' | '), 1200);
    const streamKind = method.includes('tool') || method.includes('command') ? 'tool_status' : 'assistant_text';
    return {
      type: 'turn_stream',
      timestamp,
      codexThreadId,
      turnId,
      streamKind,
      streamMethod: method,
      streamText: text,
    };
  }

  private buildReasoningNotification(
    method: string,
    params: Record<string, unknown>,
    timestamp: string,
  ): AppServerEvent | undefined {
    const codexThreadId = String(params.threadId ?? params.conversationId ?? '');
    if (!codexThreadId) {
      return undefined;
    }
    const isSummary =
      method === 'item/reasoning/summaryTextDelta'
      || method === 'item/reasoning/summaryPartAdded';
    const isTextDelta = method === 'item/reasoning/textDelta';
    if (!isSummary && !isTextDelta) {
      return undefined;
    }

    const fragments = this.extractTextCandidates(params);
    if (fragments.length === 0) {
      return undefined;
    }

    return {
      type: isSummary ? 'reasoning_summary' : 'reasoning_text_delta',
      timestamp,
      codexThreadId,
      turnId: params.turnId ? String(params.turnId) : undefined,
      reasoningMethod: method,
      reasoningText: this.toOneLine(fragments.join(' | '), 1200),
    };
  }

  private extractTextCandidates(root: unknown): string[] {
    const out: string[] = [];
    const seen = new Set<unknown>();
    // Only these keys are read, so unrelated payload fields are not forwarded to the operator.
    const keys = new Set([
      'text',
      'delta',
      'message',
      'content',
      'output',
      'outputText',
      'summary',
      'status',
      'stderr',
      'stdout',
      'command',
      'reason',
      'explanation',
      'plan',
      'step',
      'title',
      'name',
      'tool',
      'toolName',
    ]);

    const walk = (value: unknown): void => {
      if (value === null || value === undefined) {
        return;
      }
      if (typeof value === 'string') {
        const normalized = this.toOneLine(value, 240).trim();
        if (normalized) {
          out.push(normalized);
        }
        return;
      }
      if (typeof value !== 'object') {
        return;
      }
      if (seen.has(value)) {
        return;
      }
      seen.add(value);
      if (Array.isArray(value)) {
        for (const item of value) {
          walk(item);
          if (out.length >= 6) {
            return;
          }
        }
        return;
      }

      const obj = value as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        if (!keys.has(k)) {
          continue;
        }
        walk(v);
        if (out.length >= 6) {
          return;
        }
      }
    };

    walk(root);
    return out.slice(0, 6);
  }

  private toOneLine(input: string, max = 1200): string {
    const oneLine = input.replace(/\s+/g, ' ').trim();
    if (oneLine.length <= max) {
      return oneLine;
    }
    return `${oneLine.slice(0, max - 3)}...`;
  }

  private mapThread(thread: Record<string, unknown>): CodexThread {
    return {
      codexThreadId: String(thread.id ?? ''),
      threadName: thread.name ? String(thread.name) : undefined,
      cwd: String(thread.cwd ?? process.cwd()),
      status: this.mapThreadStatus(thread.status as Record<string, unknown> | undefined),
    };
  }

  private mapThreadStatus(status: Record<string, unknown> | undefined): ThreadStatus {
    const type = String(status?.type ?? '');
    if (type === 'idle' || type === 'notLoaded') {
      return 'idle';
    }
    if (type === 'systemError') {
      return 'failed';
    }
    if (type === 'active') {
      const flags = Array.isArray(status?.activeFlags) ? (status.activeFlags as string[]) : [];
      if (flags.includes('waitingOnApproval')) {
        return 'waiting_approval';
      }
      if (flags.includes('waitingOnUserInput')) {
        return 'waiting_operator';
      }
      return 'running';
    }
    return 'running';
  }

  private emit(event: AppServerEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error('Codex app-server client not initialized.');
    }
  }
}
