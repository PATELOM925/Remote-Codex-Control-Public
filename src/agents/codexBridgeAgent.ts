import type {
  ApprovalAwaitingOperatorPayload,
  ApprovalExpiredPayload,
  ApprovalResolutionAckedPayload,
  ApprovalResolutionForwardedPayload,
  ApprovalSupersededPayload,
  ReasoningSummaryObservedPayload,
  ReasoningTextDeltaObservedPayload,
  RccEventEnvelope,
  TurnOutputObservedPayload,
} from '../contracts/events.js';
import type {
  AppServerClient,
  AppServerCompatibilityResult,
  AppServerEvent,
  CodexSkillRef,
  CodexThread,
  CodexThreadMode,
  ThreadListHealth,
} from '../contracts/codex.js';
import type { ApprovalStatus, ReasoningEffort, TransportStatus } from '../contracts/states.js';
import type { Logger } from '../logger.js';
import type { RccRepository, ThreadRecord } from '../db/repositories.js';
import type { EventJournal } from '../event-journal/eventJournal.js';
import type { RccEventBus } from '../runtime/eventBus.js';
import type { RccConfig } from '../config.js';
import { newId } from '../utils/ids.js';
import { ageMs } from '../utils/time.js';
import { redactSensitiveText } from '../utils/redaction.js';
import type { CodexDesktopThreadCatalogService } from '../services/codexDesktopThreadCatalogService.js';

import { SessionRegistryAgent } from './sessionRegistryAgent.js';

export class CodexBridgeAgent {
  private transportStatus: TransportStatus = 'disconnected';
  private lastEventAt?: string;
  private stopped = false;
  private threadListCache?: { threads: CodexThread[]; fetchedAt: string };
  private listThreadsInFlight?: Promise<CodexThread[]>;
  private readonly threadModes = new Map<string, CodexThreadMode>();
  private readonly threadSkills = new Map<string, CodexSkillRef[]>();
  private readonly mapRetryBackoffUntilMs = new Map<string, number>();
  private readonly pendingApprovalRequests = new Set<string>();
  private compatibility: AppServerCompatibilityResult = {
    status: 'unknown',
    requiredMethods: ['thread/list', 'thread/start', 'thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt', 'approval/response', 'event/stream'],
    missingMethods: [],
  };
  private threadListHealth: ThreadListHealth = {
    status: 'unknown',
    lastRetryCount: 0,
    inFlight: false,
  };

  constructor(
    private readonly appServerClient: AppServerClient,
    private readonly repository: RccRepository,
    private readonly sessionRegistry: SessionRegistryAgent,
    private readonly journal: EventJournal,
    private readonly eventBus: RccEventBus,
    private readonly logger: Logger,
    private readonly config: RccConfig,
    private readonly desktopThreadCatalog?: CodexDesktopThreadCatalogService,
  ) {}

  async initialize(): Promise<void> {
    this.appServerClient.onEvent((event) => {
      void this.handleAppEvent(event);
    });
    await this.appServerClient.initialize();
    await this.checkCompatibility();
  }

  stop(): void {
    this.stopped = true;
  }

  async createThread(input: {
    projectId: string;
    cwd: string;
    threadName?: string;
    model?: string;
    effort?: ReasoningEffort;
  }): Promise<{ threadId: string; codexThreadId: string }> {
    const codexThread = await this.appServerClient.startThread({
      cwd: input.cwd,
      threadName: input.threadName,
      model: input.model,
      reasoningEffort: input.effort,
    });

    const threadRecord = this.sessionRegistry.registerThread({
      projectId: input.projectId,
      codexThreadId: codexThread.codexThreadId,
      threadName: codexThread.threadName,
      cwd: codexThread.cwd,
      status: codexThread.status,
      currentModel: input.model,
      currentEffort: input.effort,
    });

    this.upsertThreadCache(codexThread);

    return {
      threadId: threadRecord.id,
      codexThreadId: threadRecord.codexThreadId,
    };
  }

  async resumeThread(threadId: string): Promise<void> {
    const thread = this.mustFindThread(threadId);
    const resumed = await this.appServerClient.resumeThread(thread.codexThreadId);
    this.upsertThreadCache(resumed);
  }

  private async tryResumeThreadBeforeTurn(thread: ReturnType<SessionRegistryAgent['findThreadById']>): Promise<void> {
    if (!thread) {
      return;
    }
    try {
      const resumed = await this.appServerClient.resumeThread(thread.codexThreadId);
      this.upsertThreadCache(resumed);
    } catch (error) {
      this.logger.warn('codex-resume-before-turn-failed-continuing', {
        threadId: thread.id,
        codexThreadId: thread.codexThreadId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async startTurn(threadId: string, message: string, options?: {
    mode?: CodexThreadMode;
    skills?: CodexSkillRef[];
    model?: string;
    reasoningEffort?: ReasoningEffort;
  }): Promise<{ turnId: string }> {
    const thread = this.mustFindThread(threadId);
    if (options?.model !== undefined || options?.reasoningEffort !== undefined) {
      this.sessionRegistry.updateCurrentModel(
        threadId,
        options.model ?? thread.currentModel,
        options.reasoningEffort ?? thread.currentEffort,
      );
    }
    let updatedThread = this.mustFindThread(threadId);

    // Threads discovered from the App Server may need a resume before turn/start is accepted.
    // A failed resume is logged and skipped, because turn/start is the authoritative result.
    await this.tryResumeThreadBeforeTurn(thread);
    updatedThread = this.mustFindThread(threadId);

    this.repository.addOperatorMessage(threadId, message, 'turn_start');
    this.publish(
      this.journal.createEnvelope(
        'OperatorMessageReceived',
        {
          threadId,
          messageText: message,
          deliveryMode: 'turn_start',
        },
        {
          projectId: thread.projectId,
          threadId,
        },
      ),
    );

    const mode = options?.mode ?? this.getThreadMode(threadId);
    const skills = this.normalizeSkills([...(this.getThreadSkills(threadId)), ...(options?.skills ?? [])]);
    const messageWithSkills = this.withSkillMarkers(message, skills);
    const turnMessage = mode === 'plan' ? this.withPlanFallbackPrompt(messageWithSkills) : messageWithSkills;

    const turn = await this.appServerClient.startTurn({
      codexThreadId: updatedThread.codexThreadId,
      message: turnMessage,
      model: updatedThread.currentModel,
      reasoningEffort: updatedThread.currentEffort,
      skills,
      reasoningSummary: this.config.reasoningSummaryEnabled ? 'auto' : undefined,
    });

    this.sessionRegistry.setActiveTurn(threadId, turn.turnId);
    this.sessionRegistry.setThreadStatus(threadId, 'running');
    this.updateCachedThreadStatus(thread.codexThreadId, 'running');

    return turn;
  }

  getThreadMode(threadId: string): CodexThreadMode {
    return this.threadModes.get(threadId) ?? 'build';
  }

  setThreadMode(threadId: string, mode: CodexThreadMode): void {
    this.mustFindThread(threadId);
    this.threadModes.set(threadId, mode);
  }

  getThreadSkills(threadId: string): CodexSkillRef[] {
    this.mustFindThread(threadId);
    return [...(this.threadSkills.get(threadId) ?? [])];
  }

  addThreadSkill(threadId: string, skill: CodexSkillRef): CodexSkillRef[] {
    this.mustFindThread(threadId);
    const next = this.normalizeSkills([...(this.threadSkills.get(threadId) ?? []), skill]);
    this.threadSkills.set(threadId, next);
    return [...next];
  }

  clearThreadSkills(threadId: string): void {
    this.mustFindThread(threadId);
    this.threadSkills.delete(threadId);
  }

  async listSkillsForThread(threadId: string): Promise<CodexSkillRef[]> {
    const thread = this.mustFindThread(threadId);
    return this.listSkillsForCwd(thread.cwd);
  }

  async listSkillsForCwd(cwd: string): Promise<CodexSkillRef[]> {
    if (!this.appServerClient.listSkills) {
      return [];
    }
    try {
      return this.normalizeSkills(await this.appServerClient.listSkills(cwd));
    } catch (error) {
      this.logger.warn('codex-list-skills-failed', {
        cwd,
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  async steerActiveTurn(threadId: string, message: string): Promise<void> {
    const thread = this.mustFindThread(threadId);
    if (!thread.activeTurnId) {
      throw new Error('No active turn to steer');
    }

    let forwardedTurnId = thread.activeTurnId;
    let recoveredAs: 'steer' | 'turn_start_after_resume' = 'steer';
    try {
      await this.appServerClient.steerTurn({
        codexThreadId: thread.codexThreadId,
        turnId: thread.activeTurnId,
        message,
      });
    } catch (error) {
      if (!this.isThreadNotFoundError(error)) {
        throw error;
      }

      // The App Server lost track of the thread. Resume it and send the message as a new turn.
      this.logger.warn('codex-steer-thread-not-found-recovering', {
        threadId,
        codexThreadId: thread.codexThreadId,
        activeTurnId: thread.activeTurnId,
        message: error instanceof Error ? error.message : String(error),
      });

      try {
        const resumed = await this.appServerClient.resumeThread(thread.codexThreadId);
        this.upsertThreadCache(resumed);
        const mode = this.getThreadMode(threadId);
        const skills = this.getThreadSkills(threadId);
        const messageWithSkills = this.withSkillMarkers(message, skills);
        const turnMessage = mode === 'plan' ? this.withPlanFallbackPrompt(messageWithSkills) : messageWithSkills;
        const turn = await this.appServerClient.startTurn({
          codexThreadId: thread.codexThreadId,
          message: turnMessage,
          model: thread.currentModel,
          reasoningEffort: thread.currentEffort,
          skills,
          reasoningSummary: this.config.reasoningSummaryEnabled ? 'auto' : undefined,
        });
        forwardedTurnId = turn.turnId;
        recoveredAs = 'turn_start_after_resume';
        this.sessionRegistry.setActiveTurn(threadId, turn.turnId);
        this.sessionRegistry.setThreadStatus(threadId, 'running');
        this.updateCachedThreadStatus(thread.codexThreadId, 'running');
      } catch (resumeError) {
        throw new Error([
          `Codex could not find or resume thread ${thread.codexThreadId}.`,
          'This usually means the web console selected a historical Codex catalog entry that this App Server process cannot reopen.',
          'Open the thread in Codex on the Mac, then refresh RCC and try again.',
          `Original error: ${error instanceof Error ? error.message : String(error)}`,
          `Resume error: ${resumeError instanceof Error ? resumeError.message : String(resumeError)}`,
        ].join(' '));
      }
    }

    this.publish(
      this.journal.createEnvelope(
        'SteerForwarded',
        {
          threadId,
          turnId: forwardedTurnId,
          messageText: message,
          recoveredAs,
        },
        {
          projectId: thread.projectId,
          threadId,
          turnId: forwardedTurnId,
        },
      ),
    );
  }

  async interruptTurn(threadId: string): Promise<void> {
    const thread = this.mustFindThread(threadId);
    if (!thread.activeTurnId) {
      throw new Error('No active turn to interrupt');
    }

    await this.appServerClient.interruptTurn(thread.codexThreadId, thread.activeTurnId);
    this.sessionRegistry.setThreadStatus(threadId, 'interrupted');
    this.sessionRegistry.setActiveTurn(threadId, undefined);
    this.updateCachedThreadStatus(thread.codexThreadId, 'interrupted');

    this.publish(
      this.journal.createEnvelope(
        'TurnInterrupted',
        {
          threadId,
          turnId: thread.activeTurnId,
        },
        {
          projectId: thread.projectId,
          threadId,
          turnId: thread.activeTurnId,
        },
      ),
    );
  }

  async resolveApproval(approvalId: string, decision: 'approved' | 'denied'): Promise<void> {
    const approval = this.repository.findApprovalById(approvalId);
    if (!approval) {
      throw new Error(`Unknown approval ${approvalId}`);
    }

    // Only a pending approval can be forwarded. This blocks a second decision for the same request.
    if (approval.status !== 'pending') {
      throw new Error(`Cannot resolve approval ${approvalId} with status ${approval.status}`);
    }

    const thread = this.mustFindThread(approval.threadId);

    const forwardedEvent = this.journal.createEnvelope<ApprovalResolutionForwardedPayload>(
      'ApprovalResolutionForwarded',
      {
        approvalId,
        decision,
      },
      {
        projectId: thread.projectId,
        threadId: thread.id,
        turnId: approval.turnId,
      },
    );
    this.publish(forwardedEvent);

    const ack = await this.appServerClient.resolveApproval(approval.codexRequestId, decision);
    this.repository.updateApprovalStatus(approvalId, decision as ApprovalStatus);

    const ackEvent = this.journal.createEnvelope<ApprovalResolutionAckedPayload>(
      'ApprovalResolutionAcked',
      {
        approvalId,
        decision,
        codexAckId: ack.ackId,
      },
      {
        projectId: thread.projectId,
        threadId: thread.id,
        turnId: approval.turnId,
      },
    );
    this.publish(ackEvent);

    this.sessionRegistry.setThreadStatus(thread.id, 'running');
  }

  async listCodexThreads(): Promise<CodexThread[]> {
    return this.fetchCodexThreads({ allowCachedOnError: true });
  }

  getCompatibility(): AppServerCompatibilityResult {
    return this.compatibility;
  }

  getThreadListHealth(): ThreadListHealth {
    return {
      ...this.threadListHealth,
      inFlight: Boolean(this.listThreadsInFlight),
    };
  }

  async checkCompatibility(): Promise<AppServerCompatibilityResult> {
    const requiredClientMethods: Array<keyof AppServerClient> = [
      'initialize',
      'onEvent',
      'startThread',
      'resumeThread',
      'startTurn',
      'steerTurn',
      'interruptTurn',
      'listThreads',
      'resolveApproval',
    ];
    const missingMethods = requiredClientMethods.filter((method) => typeof this.appServerClient[method] !== 'function');
    if (missingMethods.length > 0) {
      this.compatibility = {
        ...this.compatibility,
        status: 'incompatible',
        checkedAt: new Date().toISOString(),
        missingMethods: missingMethods.map(String),
        lastError: `Missing App Server client methods: ${missingMethods.join(', ')}`,
      };
      this.logger.warn('codex-app-server-compatibility-failed', { ...this.compatibility });
      return this.compatibility;
    }

    try {
      await this.fetchCodexThreads({ allowCachedOnError: false });
      this.compatibility = {
        ...this.compatibility,
        status: 'compatible',
        checkedAt: new Date().toISOString(),
        missingMethods: [],
        lastError: undefined,
      };
      this.logger.info('codex-app-server-compatible', { ...this.compatibility });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.compatibility = {
        ...this.compatibility,
        status: 'degraded',
        checkedAt: new Date().toISOString(),
        missingMethods: [],
        lastError: message,
      };
      this.logger.warn('codex-app-server-compatibility-degraded', { ...this.compatibility });
    }
    return this.compatibility;
  }

  expireApproval(approvalId: string, reason: string): void {
    const approval = this.repository.findApprovalById(approvalId);
    if (!approval || approval.status !== 'pending') {
      return;
    }

    this.repository.updateApprovalStatus(approvalId, 'expired');
    const thread = this.mustFindThread(approval.threadId);

    const event = this.journal.createEnvelope<ApprovalExpiredPayload>(
      'ApprovalExpired',
      {
        approvalId,
        reason,
      },
      {
        projectId: thread.projectId,
        threadId: thread.id,
        turnId: approval.turnId,
      },
    );
    this.publish(event);
  }

  getTransportStatus(): TransportStatus {
    return this.transportStatus;
  }

  getLastEventAt(): string | undefined {
    return this.lastEventAt;
  }

  private isThreadNotFoundError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /thread not found/i.test(message)
      || /\bunknown thread\b/i.test(message)
      || /\bthread .*not.*found\b/i.test(message);
  }

  private async handleAppEvent(event: AppServerEvent): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.lastEventAt = event.timestamp;

    try {
      switch (event.type) {
        case 'transport_connected': {
          this.transportStatus = 'connected';
          this.publish(this.journal.createEnvelope('CodexTransportConnected', { transportStatus: 'connected' }));
          break;
        }
        case 'transport_disconnected': {
          this.transportStatus = 'disconnected';
          this.publish(this.journal.createEnvelope('CodexTransportDisconnected', { transportStatus: 'disconnected' }));
          break;
        }
        case 'heartbeat': {
          this.publish(this.journal.createEnvelope('HeartbeatObserved', { at: event.timestamp }));
          break;
        }
        case 'turn_started': {
          if (!event.codexThreadId || !event.turnId) {
            return;
          }

          const thread = await this.ensureMappedThread(event.codexThreadId);
          if (!thread) {
            return;
          }

          this.sessionRegistry.setActiveTurn(thread.id, event.turnId);
          this.sessionRegistry.setThreadStatus(thread.id, 'running');
          this.updateCachedThreadStatus(event.codexThreadId, 'running');
          break;
        }
        case 'turn_completed': {
          if (!event.codexThreadId) {
            return;
          }

          const thread = await this.ensureMappedThread(event.codexThreadId);
          if (!thread) {
            return;
          }

          this.sessionRegistry.setActiveTurn(thread.id, undefined);
          this.sessionRegistry.setThreadStatus(thread.id, 'completed');
          this.updateCachedThreadStatus(event.codexThreadId, 'completed');
          break;
        }
        case 'turn_interrupted': {
          if (!event.codexThreadId) {
            return;
          }

          const thread = await this.ensureMappedThread(event.codexThreadId);
          if (!thread) {
            return;
          }

          this.sessionRegistry.setActiveTurn(thread.id, undefined);
          this.sessionRegistry.setThreadStatus(thread.id, 'interrupted');
          this.updateCachedThreadStatus(event.codexThreadId, 'interrupted');
          break;
        }
        case 'turn_stream': {
          if (!event.codexThreadId) {
            return;
          }

          const thread = await this.ensureMappedThread(event.codexThreadId);
          if (!thread) {
            return;
          }

          const text = event.streamText?.trim();
          if (!text) {
            return;
          }

          // Some thread listings report idle during an active turn, so a stream event
          // counts as evidence that a turn is running.
          if (event.turnId && !thread.activeTurnId) {
            this.sessionRegistry.setActiveTurn(thread.id, event.turnId);
          }
          if (thread.status !== 'running') {
            this.sessionRegistry.setThreadStatus(thread.id, 'running');
          }

          const payload: TurnOutputObservedPayload = {
            threadId: thread.id,
            turnId: event.turnId ?? thread.activeTurnId,
            kind: event.streamKind ?? 'system',
            text,
            method: event.streamMethod,
          };

          this.publish(
            this.journal.createEnvelope<TurnOutputObservedPayload>(
              'TurnOutputObserved',
              payload,
              {
                projectId: thread.projectId,
                threadId: thread.id,
                turnId: payload.turnId,
              },
            ),
          );
          break;
        }
        case 'reasoning_summary': {
          if (!this.config.reasoningSummaryEnabled || !event.codexThreadId) {
            return;
          }

          const thread = await this.ensureMappedThread(event.codexThreadId);
          if (!thread) {
            return;
          }

          // Reasoning text can echo secrets, so redact it before it is stored or sent.
          const text = redactSensitiveText(event.reasoningText?.trim() ?? '');
          if (!text) {
            return;
          }

          const payload: ReasoningSummaryObservedPayload = {
            threadId: thread.id,
            turnId: event.turnId ?? thread.activeTurnId,
            text,
            method: event.reasoningMethod,
            source: 'app_server',
          };
          const envelope = this.journal.createEnvelope<ReasoningSummaryObservedPayload>(
            'ReasoningSummaryObserved',
            payload,
            {
              projectId: thread.projectId,
              threadId: thread.id,
              turnId: payload.turnId,
            },
          );

          // Events that are not persisted reach live listeners only. They are not written to the event journal.
          if (this.config.reasoningPersistSummary) {
            this.publish(envelope);
          } else {
            this.publishEphemeral(envelope);
          }
          break;
        }
        case 'reasoning_text_delta': {
          if (!this.config.reasoningTextDeltaEnabled || !event.codexThreadId) {
            return;
          }

          const thread = await this.ensureMappedThread(event.codexThreadId);
          if (!thread) {
            return;
          }

          const text = redactSensitiveText(event.reasoningText?.trim() ?? '');
          if (!text) {
            return;
          }

          const payload: ReasoningTextDeltaObservedPayload = {
            threadId: thread.id,
            turnId: event.turnId ?? thread.activeTurnId,
            text,
            method: event.reasoningMethod,
            source: 'app_server',
            experimental: true,
          };
          const envelope = this.journal.createEnvelope<ReasoningTextDeltaObservedPayload>(
            'ReasoningTextDeltaObserved',
            payload,
            {
              projectId: thread.projectId,
              threadId: thread.id,
              turnId: payload.turnId,
            },
          );

          if (this.config.reasoningPersistTextDelta) {
            this.publish(envelope);
          } else {
            this.publishEphemeral(envelope);
          }
          break;
        }
        case 'approval_requested': {
          if (!event.approval || !event.codexThreadId) {
            return;
          }

          // Codex can resend the same request. Only the first copy creates an approval.
          const idempotencyKey = `approval-request:${event.approval.requestId}`;
          if (this.journal.idempotencySeen('app-server', idempotencyKey) || this.pendingApprovalRequests.has(idempotencyKey)) {
            this.logger.info('deduped-approval-request', {
              requestId: event.approval.requestId,
            });
            return;
          }

          // Mapping can wait on the App Server, so a copy that arrives meanwhile is also skipped.
          this.pendingApprovalRequests.add(idempotencyKey);
          let thread: ThreadRecord | undefined;
          try {
            thread = await this.ensureMappedThread(event.codexThreadId);
          } finally {
            this.pendingApprovalRequests.delete(idempotencyKey);
          }
          if (!thread) {
            this.logger.warn('approval-requested-without-mapped-thread', {
              codexThreadId: event.codexThreadId,
              requestId: event.approval.requestId,
            });
            return;
          }
          // Recorded only after mapping, so a copy dropped above can still be processed on a repeat.
          this.journal.rememberIdempotency('app-server', idempotencyKey);

          const approvalId = newId();
          this.repository.createApproval({
            id: approvalId,
            threadId: thread.id,
            codexRequestId: event.approval.requestId,
            turnId: event.approval.turnId,
            actionType: event.approval.actionType,
            summary: event.approval.summary,
            status: 'pending',
            expiresAt: event.approval.expiresAt,
          });

          // A newer request supersedes older pending requests in the same turn,
          // or in the thread when the turn is unknown.
          const supersededIds = this.repository.supersedePendingApprovals(thread.id, approvalId, event.approval.turnId);
          for (const supersededApprovalId of supersededIds) {
            const supersededEvent = this.journal.createEnvelope<ApprovalSupersededPayload>(
              'ApprovalSuperseded',
              {
                approvalId: supersededApprovalId,
                supersededByApprovalId: approvalId,
              },
              {
                projectId: thread.projectId,
                threadId: thread.id,
              },
            );
            this.publish(supersededEvent);
          }

          const waitingEvent = this.journal.createEnvelope<ApprovalAwaitingOperatorPayload>(
            'ApprovalAwaitingOperator',
            {
              approvalId,
              codexRequestId: event.approval.requestId,
              threadId: thread.id,
              turnId: event.approval.turnId,
              projectId: thread.projectId,
              actionType: event.approval.actionType,
              summary: event.approval.summary,
              scope: event.approval.scope,
              expiresAt: event.approval.expiresAt,
            },
            {
              projectId: thread.projectId,
              threadId: thread.id,
              turnId: event.approval.turnId,
            },
          );
          this.publish(waitingEvent);
          this.sessionRegistry.setThreadStatus(thread.id, 'waiting_approval');
          break;
        }
        case 'thread_started': {
          if (!event.codexThreadId) {
            return;
          }

          if (event.cwd) {
            this.upsertThreadCache({
              codexThreadId: event.codexThreadId,
              threadName: event.threadName,
              cwd: event.cwd,
              status: event.status ?? 'idle',
            });
          }

          const thread = event.cwd
            ? this.sessionRegistry.ensureThreadForCodexThread({
                codexThreadId: event.codexThreadId,
                threadName: event.threadName,
                cwd: event.cwd,
                status: event.status ?? 'idle',
              })
            : await this.ensureMappedThread(event.codexThreadId);
          if (thread && event.status) {
            this.sessionRegistry.setThreadStatus(thread.id, event.status);
            this.updateCachedThreadStatus(event.codexThreadId, event.status);
          }
          break;
        }
        default:
          break;
      }
    } catch (error) {
      if (this.stopped) {
        return;
      }
      this.logger.warn('codex-bridge-handle-event-failed', {
        type: event.type,
        codexThreadId: event.codexThreadId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async ensureMappedThread(codexThreadId: string) {
    if (this.stopped) {
      return undefined;
    }
    const existing = this.sessionRegistry.findThreadByCodexThreadId(codexThreadId);
    if (existing) {
      return existing;
    }

    // After a failed lookup, wait 10 seconds before asking the App Server about this thread again.
    const blockedUntilMs = this.mapRetryBackoffUntilMs.get(codexThreadId) ?? 0;
    if (blockedUntilMs > Date.now()) {
      const local = this.desktopThreadCatalog?.getThread(codexThreadId);
      return local ? this.sessionRegistry.ensureThreadForCodexThread(local) : undefined;
    }

    // Map threads created or resumed directly in the Codex app that RCC has not seen yet.
    try {
      const threads = await this.fetchCodexThreads({ allowCachedOnError: true });
      if (this.stopped) {
        return undefined;
      }
      const match = threads.find((thread) => thread.codexThreadId === codexThreadId);
      if (match) {
        this.mapRetryBackoffUntilMs.delete(codexThreadId);
        return this.sessionRegistry.ensureThreadForCodexThread(match);
      }

      const local = this.desktopThreadCatalog?.getThread(codexThreadId);
      if (local) {
        this.mapRetryBackoffUntilMs.delete(codexThreadId);
        return this.sessionRegistry.ensureThreadForCodexThread(local);
      }

      this.mapRetryBackoffUntilMs.set(codexThreadId, Date.now() + 10_000);
      return undefined;
    } catch (error) {
      const local = this.desktopThreadCatalog?.getThread(codexThreadId);
      if (local) {
        return this.sessionRegistry.ensureThreadForCodexThread(local);
      }
      this.mapRetryBackoffUntilMs.set(codexThreadId, Date.now() + 10_000);
      this.logger.warn('ensure-mapped-thread-failed', {
        codexThreadId,
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private async fetchCodexThreads(options: { allowCachedOnError: boolean }): Promise<CodexThread[]> {
    const cacheFreshMs = 5_000;
    if (this.threadListCache && ageMs(this.threadListCache.fetchedAt) <= cacheFreshMs) {
      const threads = this.mergeDesktopCatalogThreads(this.threadListCache.threads);
      this.setThreadListCache(threads);
      return threads;
    }

    if (this.listThreadsInFlight) {
      return this.listThreadsInFlight;
    }

    this.listThreadsInFlight = (async () => {
      try {
        const threads = this.mergeDesktopCatalogThreads(await this.listThreadsWithRetry());
        this.setThreadListCache(threads);
        this.threadListHealth = {
          ...this.threadListHealth,
          status: 'ok',
          lastSuccessAt: new Date().toISOString(),
          lastError: undefined,
          inFlight: false,
        };
        return threads;
      } catch (error) {
        if (options.allowCachedOnError && this.threadListCache?.threads?.length) {
          this.threadListHealth = {
            ...this.threadListHealth,
            status: 'cache',
            lastFailureAt: new Date().toISOString(),
            lastError: error instanceof Error ? error.message : String(error),
            inFlight: false,
          };
          this.logger.warn('list-codex-threads-falling-back-to-cache', {
            message: error instanceof Error ? error.message : String(error),
            cachedCount: this.threadListCache.threads.length,
          });
          return this.threadListCache.threads;
        }

        const localThreads = this.desktopThreadCatalog?.listThreads() ?? [];
        if (localThreads.length > 0) {
          this.threadListHealth = {
            ...this.threadListHealth,
            status: 'local_fallback',
            lastFailureAt: new Date().toISOString(),
            lastError: error instanceof Error ? error.message : String(error),
            inFlight: false,
          };
          this.logger.warn('list-codex-threads-falling-back-to-local-state', {
            message: error instanceof Error ? error.message : String(error),
            localCount: localThreads.length,
          });
          return localThreads;
        }
        this.threadListHealth = {
          ...this.threadListHealth,
          status: 'failed',
          lastFailureAt: new Date().toISOString(),
          lastError: error instanceof Error ? error.message : String(error),
          inFlight: false,
        };
        throw error;
      } finally {
        this.listThreadsInFlight = undefined;
      }
    })();

    return this.listThreadsInFlight;
  }

  private async listThreadsWithRetry(): Promise<CodexThread[]> {
    const maxAttempts = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.threadListHealth = {
        ...this.threadListHealth,
        lastRetryCount: attempt - 1,
        inFlight: true,
      };
      try {
        const threads = await this.appServerClient.listThreads();
        this.threadListHealth = {
          ...this.threadListHealth,
          lastRetryCount: attempt - 1,
        };
        return threads;
      } catch (error) {
        lastError = error;
        const retryable = this.isRetryableThreadListError(error);
        if (!retryable || attempt === maxAttempts) {
          break;
        }
        const baseDelayMs = 200 * 2 ** (attempt - 1);
        const jitterMs = Math.floor(Math.random() * 120);
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs + jitterMs));
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`thread/list failed after ${maxAttempts} attempts: ${message}`);
  }

  private isRetryableThreadListError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /timeout|timed out|overload|retry|temporar|ECONNRESET|EPIPE|busy/i.test(message);
  }

  private mergeDesktopCatalogThreads(appServerThreads: CodexThread[]): CodexThread[] {
    const localThreads = this.desktopThreadCatalog?.listThreads() ?? [];
    if (localThreads.length === 0) {
      return appServerThreads;
    }

    const merged = new Map<string, CodexThread>();
    for (const thread of localThreads) {
      merged.set(thread.codexThreadId, thread);
    }
    for (const thread of appServerThreads) {
      // Prefer App Server status for threads it knows about, but include
      // desktop-only threads so Telegram can pick recently created Codex UI sessions.
      merged.set(thread.codexThreadId, {
        ...merged.get(thread.codexThreadId),
        ...thread,
      });
    }
    return [...merged.values()];
  }

  private setThreadListCache(threads: CodexThread[]): void {
    this.threadListCache = {
      threads,
      fetchedAt: new Date().toISOString(),
    };
  }

  private upsertThreadCache(thread: CodexThread): void {
    const existing = this.threadListCache?.threads ?? [];
    const next = [...existing];
    const index = next.findIndex((item) => item.codexThreadId === thread.codexThreadId);
    if (index === -1) {
      next.push(thread);
    } else {
      next[index] = {
        ...next[index],
        ...thread,
      };
    }
    this.setThreadListCache(next);
  }

  private updateCachedThreadStatus(codexThreadId: string, status: CodexThread['status']): void {
    const existing = this.threadListCache?.threads;
    if (!existing) {
      return;
    }
    const next = existing.map((thread) =>
      thread.codexThreadId === codexThreadId
        ? {
            ...thread,
            status,
          }
        : thread,
    );
    this.setThreadListCache(next);
  }

  private mustFindThread(threadId: string) {
    const thread = this.sessionRegistry.findThreadById(threadId);
    if (!thread) {
      throw new Error(`Unknown thread ${threadId}`);
    }
    return thread;
  }

  private withPlanFallbackPrompt(message: string): string {
    return [
      'Plan mode requested through RCC.',
      'Operate in a safe planning-only mode: inspect and reason, propose a concise implementation plan, and do not edit files, run destructive commands, deploy, or commit unless the operator explicitly asks to switch to build mode.',
      '',
      message,
    ].join('\n');
  }

  private withSkillMarkers(message: string, skills: CodexSkillRef[]): string {
    const missingMarkers = skills
      .map((skill) => `$${skill.name}`)
      .filter((marker) => !message.includes(marker));
    if (missingMarkers.length === 0) {
      return message;
    }
    return `${missingMarkers.join(' ')} ${message}`;
  }

  private normalizeSkills(skills: CodexSkillRef[]): CodexSkillRef[] {
    const byName = new Map<string, CodexSkillRef>();
    for (const skill of skills) {
      const name = skill.name.trim();
      if (!name) {
        continue;
      }
      byName.set(name, {
        ...skill,
        name,
      });
    }
    return [...byName.values()].filter((skill) => skill.enabled !== false);
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

  private publishEphemeral(event: RccEventEnvelope): void {
    this.eventBus.emit(event);
    this.logger.info('event-published-ephemeral', {
      eventId: event.eventId,
      eventType: event.eventType,
      projectId: event.projectId,
      threadId: event.threadId,
      turnId: event.turnId,
    });
  }
}
