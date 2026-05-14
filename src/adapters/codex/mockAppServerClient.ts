import { EventEmitter } from 'node:events';

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
import { newId } from '../../utils/ids.js';
import { nowIso } from '../../utils/time.js';

interface InternalThread extends CodexThread {
  activeTurnId?: string;
}

export class MockAppServerClient implements AppServerClient {
  private readonly emitter = new EventEmitter();
  private readonly threads = new Map<string, InternalThread>();
  private listThreadsError?: Error;
  private transientListFailures = 0;
  private skills: CodexSkillRef[] = [];
  private nextSteerError?: Error;
  private nextResumeError?: Error;
  readonly startedTurns: StartTurnInput[] = [];
  listThreadsCallCount = 0;

  async initialize(): Promise<void> {
    this.emitter.emit('event', { type: 'transport_connected', timestamp: nowIso() } satisfies AppServerEvent);
  }

  onEvent(listener: (event: AppServerEvent) => void): void {
    this.emitter.on('event', listener);
  }

  async startThread(input: StartThreadInput): Promise<CodexThread> {
    const thread: InternalThread = {
      codexThreadId: newId(),
      threadName: input.threadName,
      cwd: input.cwd,
      status: 'idle',
    };
    this.threads.set(thread.codexThreadId, thread);
    this.emitter.emit('event', {
      type: 'thread_started',
      timestamp: nowIso(),
      codexThreadId: thread.codexThreadId,
      threadName: thread.threadName,
      cwd: thread.cwd,
      status: thread.status,
    } satisfies AppServerEvent);
    return thread;
  }

  async resumeThread(codexThreadId: string): Promise<CodexThread> {
    if (this.nextResumeError) {
      const error = this.nextResumeError;
      this.nextResumeError = undefined;
      throw error;
    }
    const thread = this.threads.get(codexThreadId);
    if (!thread) {
      throw new Error(`Unknown thread ${codexThreadId}`);
    }
    this.emitter.emit('event', {
      type: 'thread_started',
      timestamp: nowIso(),
      codexThreadId: thread.codexThreadId,
      threadName: thread.threadName,
      cwd: thread.cwd,
      status: thread.status,
    } satisfies AppServerEvent);
    return thread;
  }

  async startTurn(input: StartTurnInput): Promise<{ turnId: string }> {
    const thread = this.threads.get(input.codexThreadId);
    if (!thread) {
      throw new Error(`Unknown thread ${input.codexThreadId}`);
    }

    this.startedTurns.push({
      ...input,
      skills: input.skills ? [...input.skills] : undefined,
    });

    thread.status = 'running';
    thread.activeTurnId = newId();

    this.emitter.emit('event', {
      type: 'turn_started',
      timestamp: nowIso(),
      codexThreadId: input.codexThreadId,
      turnId: thread.activeTurnId,
      status: thread.status,
    } satisfies AppServerEvent);

    return { turnId: thread.activeTurnId };
  }

  async steerTurn(input: SteerTurnInput): Promise<void> {
    if (this.nextSteerError) {
      const error = this.nextSteerError;
      this.nextSteerError = undefined;
      throw error;
    }
    const thread = this.threads.get(input.codexThreadId);
    if (!thread || thread.activeTurnId !== input.turnId) {
      throw new Error('No matching active turn to steer');
    }
  }

  async interruptTurn(codexThreadId: string, turnId: string): Promise<void> {
    const thread = this.threads.get(codexThreadId);
    if (!thread || thread.activeTurnId !== turnId) {
      throw new Error('No matching active turn to interrupt');
    }

    thread.status = 'interrupted';
    thread.activeTurnId = undefined;

    this.emitter.emit('event', {
      type: 'turn_interrupted',
      timestamp: nowIso(),
      codexThreadId,
      turnId,
      status: 'interrupted',
    } satisfies AppServerEvent);
  }

  async listThreads(): Promise<CodexThread[]> {
    this.listThreadsCallCount += 1;
    if (this.transientListFailures > 0) {
      this.transientListFailures -= 1;
      throw new Error('[thread/list] Server overloaded; retry later.');
    }
    if (this.listThreadsError) {
      throw this.listThreadsError;
    }
    return [...this.threads.values()].map(({ activeTurnId: _ignored, ...thread }) => thread);
  }

  async resolveApproval(_requestId: string, _decision: 'approved' | 'denied'): Promise<{ ackId: string }> {
    return { ackId: newId() };
  }

  async listSkills(_cwd: string): Promise<CodexSkillRef[]> {
    return [...this.skills];
  }

  emitApprovalRequest(approval: AppServerApprovalRequest): void {
    this.emitter.emit('event', {
      type: 'approval_requested',
      timestamp: nowIso(),
      codexThreadId: approval.codexThreadId,
      turnId: approval.turnId,
      approval,
    } satisfies AppServerEvent);
  }

  emitTurnCompleted(codexThreadId: string, turnId: string): void {
    const thread = this.threads.get(codexThreadId);
    if (!thread) {
      throw new Error(`Unknown thread ${codexThreadId}`);
    }

    thread.status = 'completed';
    thread.activeTurnId = undefined;

    this.emitter.emit('event', {
      type: 'turn_completed',
      timestamp: nowIso(),
      codexThreadId,
      turnId,
      status: 'completed',
    } satisfies AppServerEvent);
  }

  emitTurnStream(codexThreadId: string, turnId: string, text: string, options?: {
    kind?: AppServerEvent['streamKind'];
    method?: string;
  }): void {
    this.emitter.emit('event', {
      type: 'turn_stream',
      timestamp: nowIso(),
      codexThreadId,
      turnId,
      streamKind: options?.kind ?? 'assistant_text',
      streamMethod: options?.method ?? 'item/updated',
      streamText: text,
    } satisfies AppServerEvent);
  }

  emitReasoningSummary(codexThreadId: string, turnId: string, text: string): void {
    this.emitter.emit('event', {
      type: 'reasoning_summary',
      timestamp: nowIso(),
      codexThreadId,
      turnId,
      reasoningMethod: 'item/reasoning/summaryTextDelta',
      reasoningText: text,
    } satisfies AppServerEvent);
  }

  emitReasoningTextDelta(codexThreadId: string, turnId: string, text: string): void {
    this.emitter.emit('event', {
      type: 'reasoning_text_delta',
      timestamp: nowIso(),
      codexThreadId,
      turnId,
      reasoningMethod: 'item/reasoning/textDelta',
      reasoningText: text,
    } satisfies AppServerEvent);
  }

  emitHeartbeat(): void {
    this.emitter.emit('event', {
      type: 'heartbeat',
      timestamp: nowIso(),
    } satisfies AppServerEvent);
  }

  emitTransportDisconnected(): void {
    this.emitter.emit('event', {
      type: 'transport_disconnected',
      timestamp: nowIso(),
    } satisfies AppServerEvent);
  }

  setListThreadsError(message?: string): void {
    this.listThreadsError = message ? new Error(message) : undefined;
  }

  setTransientListFailures(count: number): void {
    this.transientListFailures = count;
  }

  setSkills(skills: CodexSkillRef[]): void {
    this.skills = [...skills];
  }

  failNextSteer(message: string): void {
    this.nextSteerError = new Error(message);
  }

  failNextResume(message: string): void {
    this.nextResumeError = new Error(message);
  }
}
