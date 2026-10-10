import fs from 'node:fs';
import path from 'node:path';

import { loadConfig, type RccConfig } from '../config.js';
import type { AppServerClient } from '../contracts/codex.js';
import type { ReasoningSummaryObservedPayload, RccEventEnvelope, TurnOutputObservedPayload } from '../contracts/events.js';
import type { TelegramClient } from '../contracts/telegram.js';
import { DatabaseManager } from '../db/database.js';
import { RccRepository } from '../db/repositories.js';
import { EventJournal } from '../event-journal/eventJournal.js';
import { Logger } from '../logger.js';
import { PolicyEngine } from '../policies/policyEngine.js';
import { RccEventBus } from '../runtime/eventBus.js';

import { MockAppServerClient } from '../adapters/codex/mockAppServerClient.js';
import { CodexAppServerClient } from '../adapters/codex/codexAppServerClient.js';
import { MockTelegramClient } from '../adapters/telegram/mockTelegramClient.js';
import { TelegramBotApiClient } from '../adapters/telegram/telegramBotApiClient.js';
import { ApprovalRouterAgent } from '../agents/approvalRouterAgent.js';
import { ArtifactWatcherAgent } from '../agents/artifactWatcherAgent.js';
import { CodexBridgeAgent } from '../agents/codexBridgeAgent.js';
import { DocumentationAgent } from '../agents/documentationAgent.js';
import { FileIntakeAgent } from '../agents/fileIntakeAgent.js';
import { GitGuardrailAgent } from '../agents/gitGuardrailAgent.js';
import { HealthOpsAgent } from '../agents/healthOpsAgent.js';
import { ModelPolicyAgent } from '../agents/modelPolicyAgent.js';
import { SessionRegistryAgent } from '../agents/sessionRegistryAgent.js';
import { SteeringAgent } from '../agents/steeringAgent.js';
import { TelegramCommandService } from './telegramCommandService.js';
import { CodexDesktopStateMonitor, type CodexDesktopStateMonitorOptions } from './codexDesktopStateMonitor.js';
import { CodexDesktopThreadCatalogService } from './codexDesktopThreadCatalogService.js';
import { CodexSessionService } from './codexSessionService.js';
import { LocalStatusServer } from './localStatusServer.js';
import { RelayClientService } from './relayClientService.js';
import { AppleScriptApprovalAutomationService, type UiApprovalAutomationService } from './uiApprovalAutomationService.js';

export interface RccDaemonOptions {
  config?: RccConfig;
  logger?: Logger;
  appServerClient?: AppServerClient;
  telegramClient?: TelegramClient;
  codexDesktopStateOptions?: CodexDesktopStateMonitorOptions;
  codexSessionsRoot?: string;
  codexSessionService?: CodexSessionService;
  uiApprovalAutomation?: UiApprovalAutomationService;
}

export class RccDaemon {
  readonly config: RccConfig;
  readonly logger: Logger;
  readonly dbManager: DatabaseManager;
  readonly repository: RccRepository;
  readonly journal: EventJournal;
  readonly eventBus: RccEventBus;
  readonly policyEngine: PolicyEngine;

  readonly sessionRegistry: SessionRegistryAgent;
  readonly codexBridge: CodexBridgeAgent;
  readonly steeringAgent: SteeringAgent;
  readonly fileIntakeAgent: FileIntakeAgent;
  readonly artifactWatcher: ArtifactWatcherAgent;
  readonly gitGuardrail: GitGuardrailAgent;
  readonly modelPolicy: ModelPolicyAgent;
  readonly healthOps: HealthOpsAgent;
  readonly docsAgent: DocumentationAgent;
  readonly approvalRouter: ApprovalRouterAgent;
  readonly telegramCommandService: TelegramCommandService;
  readonly codexSessions: CodexSessionService;
  readonly desktopThreadCatalog: CodexDesktopThreadCatalogService;
  readonly desktopStateMonitor: CodexDesktopStateMonitor;
  readonly localStatusServer: LocalStatusServer;
  readonly relayClient: RelayClientService;
  readonly uiApprovalAutomation?: UiApprovalAutomationService;

  readonly appServerClient: AppServerClient;
  readonly telegramClient: TelegramClient;

  private lockFilePath?: string;
  private healthTimer?: NodeJS.Timeout;
  private walTimer?: NodeJS.Timeout;
  private telegramCommandsTimer?: NodeJS.Timeout;
  private telegramCommandsInstalled = false;
  private telegramCommandsDisabled = false;
  private readonly seenTurnNotifications = new Set<string>();
  private readonly turnStartedAt = new Map<string, number>();
  private readonly streamFingerprintByThread = new Map<string, { fingerprint: string; atMs: number }>();
  private readonly streamBuffers = new Map<
    string,
    { pieces: string[]; timer?: NodeJS.Timeout; lastFlushAtMs: number }
  >();

  constructor(options: RccDaemonOptions = {}) {
    this.config = options.config ?? loadConfig();
    this.logger = options.logger ?? new Logger((process.env.RCC_LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') ?? 'info');
    this.appServerClient =
      options.appServerClient ??
      (this.config.codexConnectionMode === 'mock'
        ? new MockAppServerClient()
        : new CodexAppServerClient({
            mode: this.config.codexConnectionMode,
            command: this.config.codexConnectionCommand,
            wsUrl: this.config.codexConnectionUrl,
            logger: this.logger,
          }));
    this.telegramClient =
      options.telegramClient ??
      (this.config.telegramBotToken && this.config.telegramTransport === 'long_polling'
        ? new TelegramBotApiClient(this.config.telegramBotToken, this.config.telegramTransport, 1500, this.logger)
        : new MockTelegramClient());

    fs.mkdirSync(this.config.uploadsRoot, { recursive: true });
    fs.mkdirSync(this.config.artifactsRoot, { recursive: true });

    this.dbManager = new DatabaseManager(this.config, this.logger);
    this.dbManager.rebuildProjectionsFromEventLog();
    this.repository = new RccRepository(this.dbManager.db);
    this.journal = new EventJournal(this.dbManager.db);
    this.eventBus = new RccEventBus();
    this.policyEngine = new PolicyEngine();
    this.codexSessions =
      options.codexSessionService ??
      new CodexSessionService(options.codexSessionsRoot ?? CodexSessionService.defaultSessionsRoot());
    this.desktopThreadCatalog = new CodexDesktopThreadCatalogService(
      options.codexDesktopStateOptions?.codexHome ?? CodexDesktopThreadCatalogService.defaultCodexHome(),
    );
    this.uiApprovalAutomation =
      options.uiApprovalAutomation ??
      (this.config.uiAutomationEnabled && this.config.uiAutomationProvider === 'applescript'
        ? new AppleScriptApprovalAutomationService(this.logger)
        : undefined);

    this.sessionRegistry = new SessionRegistryAgent(this.repository, this.journal, this.eventBus, this.logger);
    this.codexBridge = new CodexBridgeAgent(
      this.appServerClient,
      this.repository,
      this.sessionRegistry,
      this.journal,
      this.eventBus,
      this.logger,
      this.config,
      this.desktopThreadCatalog,
    );
    this.steeringAgent = new SteeringAgent(
      this.codexBridge,
      this.sessionRegistry,
      this.repository,
      this.journal,
      this.eventBus,
      this.logger,
    );
    this.fileIntakeAgent = new FileIntakeAgent(
      this.telegramClient,
      this.sessionRegistry,
      this.steeringAgent,
      this.repository,
      this.policyEngine,
      this.journal,
      this.eventBus,
      this.config,
      this.logger,
    );
    this.artifactWatcher = new ArtifactWatcherAgent(
      this.sessionRegistry,
      this.repository,
      this.policyEngine,
      this.telegramClient,
      this.journal,
      this.eventBus,
      this.config,
      this.logger,
    );
    this.gitGuardrail = new GitGuardrailAgent(
      this.sessionRegistry,
      this.repository,
      this.policyEngine,
      this.journal,
      this.eventBus,
      this.logger,
    );
    this.modelPolicy = new ModelPolicyAgent(
      this.sessionRegistry,
      this.repository,
      this.policyEngine,
      this.journal,
      this.eventBus,
      this.logger,
    );
    this.healthOps = new HealthOpsAgent(
      this.codexBridge,
      this.repository,
      this.dbManager,
      this.journal,
      this.eventBus,
      this.config,
      this.logger,
      {
        getTelegramCommandsState: () => this.getTelegramCommandsState(),
      },
    );
    this.docsAgent = new DocumentationAgent();
    this.desktopStateMonitor = new CodexDesktopStateMonitor(
      this.repository,
      this.sessionRegistry,
      this.journal,
      this.eventBus,
      this.logger,
      options.codexDesktopStateOptions,
    );
    this.approvalRouter = new ApprovalRouterAgent(
      this.telegramClient,
      this.codexBridge,
      this.sessionRegistry,
      this.repository,
      this.journal,
      this.eventBus,
      this.config,
      this.logger,
      this.uiApprovalAutomation,
    );
    this.telegramCommandService = new TelegramCommandService(
      this.telegramClient,
      this.sessionRegistry,
      this.repository,
      this.codexBridge,
      this.approvalRouter,
      this.steeringAgent,
      this.fileIntakeAgent,
      this.artifactWatcher,
      this.modelPolicy,
      this.healthOps,
      this.codexSessions,
      this.desktopStateMonitor,
      this.logger,
      this.config.allowedChatIds,
    );
    this.localStatusServer = new LocalStatusServer(
      this.config,
      this.healthOps,
      this.sessionRegistry,
      this.repository,
      this.journal,
      this.eventBus,
      this.codexBridge,
      this.steeringAgent,
      this.approvalRouter,
      this.fileIntakeAgent,
      this.logger,
    );
    this.relayClient = new RelayClientService(
      this.config,
      this.localStatusServer,
      this.codexBridge,
      this.steeringAgent,
      this.approvalRouter,
      this.fileIntakeAgent,
      this.repository,
      this.logger,
    );

    this.eventBus.on('*', (event) => {
      this.journal.checkpoint('projection', event.eventId);
    });
  }

  async start(): Promise<void> {
    this.acquireSingleInstanceLock();
    this.validateSecurityDefaults();
    this.docsAgent.assertCoverage();
    const flushedArtifacts = this.repository.markAllDetectedArtifactsAsSent();
    if (flushedArtifacts > 0) {
      this.logger.info('artifact-backlog-flushed', { flushedArtifacts });
    }
    // Telegram can be unreachable for a while (network, VPN, captive portal). Command setup
    // retries in the background instead of stopping the daemon.
    this.installTelegramCommandsWithRetry();
    this.approvalRouter.registerEventSubscriptions();
    this.registerOperatorNotifications();
    this.telegramCommandService.start();
    this.desktopStateMonitor.start();
    await this.localStatusServer.start();
    try {
      await this.codexBridge.initialize();
    } catch (error) {
      // Keep RCC up so Telegram /status continues to work while Codex is offline.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('codex-initialize-failed', { message });
      try {
        await this.telegramClient.sendMessage(
          this.config.operatorChatId,
          `Codex transport failed to initialize. RCC is still running, but thread commands may fail until Codex is available.\n${message}`,
        );
      } catch (sendError) {
        this.logger.warn('codex-initialize-telegram-notification-failed', { message: this.errorMessage(sendError) });
      }
    }
    await this.bootstrapProjectsIfEmpty();
    this.relayClient.start();

    this.healthTimer = setInterval(() => {
      this.healthOps.captureSnapshot();
    }, this.config.healthSnapshotIntervalMs);

    this.walTimer = setInterval(() => {
      this.healthOps.runWalMaintenance();
    }, this.config.walPeriodicCheckpointMs);

    this.logger.info('rcc-daemon-started', {
      dbPath: this.config.dbPath,
      uploadsRoot: this.config.uploadsRoot,
      artifactsRoot: this.config.artifactsRoot,
      localStatusUrl: this.localStatusServer.url(),
      projectCount: this.sessionRegistry.listProjects().length,
    });
  }

  /** Refuses to start in strict security mode when an allowlist or token setting is missing or does not match. */
  private validateSecurityDefaults(): void {
    if (!this.config.strictSecurityDefaults) {
      return;
    }

    if (this.config.allowedChatIds.length === 0) {
      throw new Error('Strict security mode requires RCC_ALLOWED_CHAT_IDS with at least one chat id.');
    }

    if (this.config.telegramTransport === 'long_polling' && !this.config.telegramBotToken) {
      throw new Error('Strict security mode requires RCC_TELEGRAM_BOT_TOKEN when long_polling is enabled.');
    }

    if (!this.config.allowedChatIds.includes(this.config.operatorChatId)) {
      throw new Error('Strict security mode requires RCC_OPERATOR_CHAT_ID to be included in RCC_ALLOWED_CHAT_IDS.');
    }

    if (this.config.operatorChatId === 'local-operator') {
      throw new Error('Strict security mode requires RCC_OPERATOR_CHAT_ID to be explicitly configured.');
    }

    if (this.config.webControlEnabled && !this.config.webAuthToken) {
      throw new Error('Strict security mode requires RCC_WEB_AUTH_TOKEN when RCC_WEB_CONTROL_ENABLED=true.');
    }

    if (this.config.relayEnabled && !this.config.relayMacToken) {
      throw new Error('Strict security mode requires RCC_RELAY_MAC_TOKEN when RCC_RELAY_ENABLED=true.');
    }
  }

  getTelegramCommandsState(): 'installed' | 'pending' | 'disabled' {
    if (this.telegramCommandsDisabled) {
      return 'disabled';
    }
    if (this.telegramCommandsInstalled) {
      return 'installed';
    }
    return 'pending';
  }

  stop(): void {
    if (this.telegramCommandsTimer) {
      clearInterval(this.telegramCommandsTimer);
      this.telegramCommandsTimer = undefined;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
    if (this.walTimer) {
      clearInterval(this.walTimer);
      this.walTimer = undefined;
    }

    this.codexBridge.stop();
    this.desktopStateMonitor.stop();
    this.relayClient.stop();
    void this.localStatusServer.stop();
    this.dbManager.checkpoint('FULL');
    this.dbManager.close();
    this.releaseSingleInstanceLock();
    this.logger.info('rcc-daemon-stopped');
  }

  private installTelegramCommandsWithRetry(): void {
    const commands = [
      { command: 'help', description: 'Show available commands' },
      { command: 'threads', description: 'List Codex threads' },
      { command: 'running', description: 'Show running threads' },
      { command: 'projects', description: 'List RCC projects' },
      { command: 'new', description: 'Create a new thread in a project' },
      { command: 'resume', description: 'Resume a thread' },
      { command: 'pick', description: 'Select a thread' },
      { command: 'where', description: 'Show selected thread' },
      { command: 'last', description: 'Show last command and output' },
      { command: 'approvals', description: 'List pending approvals' },
      { command: 'run', description: 'Start a turn or task' },
      { command: 'say', description: 'Send a steering message' },
      { command: 'approval_demo', description: 'Send a demo approval card' },
      { command: 'interrupt', description: 'Interrupt a turn' },
      { command: 'attach', description: 'Upload a file to a thread' },
      { command: 'artifact', description: 'List or send artifacts' },
      { command: 'model', description: 'Set model for next turn' },
      { command: 'effort', description: 'Set reasoning effort for next turn' },
      { command: 'approve', description: 'Approve a pending request' },
      { command: 'deny', description: 'Deny a pending request' },
      { command: 'status', description: 'Show RCC health' },
    ];

    const attempt = async (): Promise<void> => {
      if (this.telegramCommandsInstalled || this.telegramCommandsDisabled) {
        return;
      }
      try {
        await this.telegramClient.setCommands(commands);
        this.telegramCommandsInstalled = true;
        this.logger.info('telegram-commands-installed', { count: commands.length });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = (error as { telegram?: { status?: number } })?.telegram?.status;
        if (status === 401 || status === 404) {
          this.telegramCommandsDisabled = true;
          if (this.telegramCommandsTimer) {
            clearInterval(this.telegramCommandsTimer);
            this.telegramCommandsTimer = undefined;
          }
          this.logger.warn('telegram-set-commands-fatal', {
            message,
            status,
            reason: 'Telegram token/config must be fixed; not retrying.',
          });
          return;
        }
        this.logger.warn('telegram-set-commands-failed', { message, status });
      }
    };

    // Try now, then retry every 60 seconds until the commands install or Telegram rejects the token.
    void attempt();
    this.telegramCommandsTimer = setInterval(() => {
      void attempt();
    }, 60_000);
  }

  private registerOperatorNotifications(): void {
    this.eventBus.on('*', (event: RccEventEnvelope) => {
      void this.handleRealtimeEvent(event).catch((error) => {
        this.logger.warn('operator-notification-failed', { message: this.errorMessage(error), eventType: event.eventType });
      });
    });
  }

  private async handleRealtimeEvent(event: RccEventEnvelope): Promise<void> {
    if (!event.threadId) {
      return;
    }

    const thread = this.sessionRegistry.findThreadById(event.threadId);
    if (!thread) {
      return;
    }
    const project = this.sessionRegistry.getProjectById(thread.projectId);
    const threadLabel = thread.threadName ?? thread.codexThreadId ?? thread.id;
    const projectLabel = project?.name ?? thread.projectId;

    switch (event.eventType) {
      case 'ApprovalResolutionAcked': {
        const payload = event.payload as { approvalId: string; decision: string };
        const approval = this.repository.findApprovalById(payload.approvalId);
        const tail = thread.codexThreadId ? this.codexSessions.readTail(thread.codexThreadId) : {};
        const summaryBits: string[] = [];
        if (tail.lastAssistantText) {
          summaryBits.push(`Assistant: ${tail.lastAssistantText}`);
        } else if (tail.lastToolOutput) {
          summaryBits.push(`Output: ${tail.lastToolOutput.summary}`);
        } else if (tail.lastToolCall) {
          summaryBits.push(`Tool: ${tail.lastToolCall.name}`);
        }
        await this.sendText(
          this.config.operatorChatId,
          [
            'After approval',
            `Project: ${projectLabel}`,
            `Thread: ${threadLabel}`,
            `Decision: ${payload.decision}`,
            `Status: ${thread.status}`,
            approval ? `Action: ${approval.summary}` : undefined,
            ...summaryBits,
            'Tip: /last for full context.',
          ]
            .filter(Boolean)
            .join('\n'),
        );
        break;
      }
      case 'TurnStarted': {
        const key = `started:${thread.id}:${event.turnId ?? ''}`;
        if (this.seenTurnNotifications.has(key)) {
          return;
        }
        this.seenTurnNotifications.add(key);
        if (event.turnId) {
          this.turnStartedAt.set(event.turnId, Date.now());
        }
        await this.sendText(
          this.config.operatorChatId,
          `Running\nProject: ${projectLabel}\nThread: ${threadLabel}\nTurn: ${event.turnId ?? 'n/a'}`,
        );
        break;
      }
      case 'TurnCompleted': {
        const key = `completed:${thread.id}:${event.turnId ?? ''}`;
        if (this.seenTurnNotifications.has(key)) {
          return;
        }
        this.seenTurnNotifications.add(key);
        await this.sendText(this.config.operatorChatId, `Completed\nProject: ${projectLabel}\nThread: ${threadLabel}`);
        const focused = this.sessionRegistry.getOperatorFocusThread();
        const turnStartedAtMs = event.turnId ? this.turnStartedAt.get(event.turnId) : undefined;
        if (event.turnId) {
          this.turnStartedAt.delete(event.turnId);
        }
        if (focused === thread.id) {
          const tail = this.codexSessions.readTail(thread.codexThreadId);
          const capturedOutput = this.latestCapturedTurnOutput(thread.id, event.turnId);
          const recentOutputs = this.artifactWatcher.listRecentWorkspaceOutputs(thread.id, {
            modifiedAfterMs: turnStartedAtMs,
            maxItems: 5,
          });
          const resultLines = [
            'Result',
            `Project: ${projectLabel}`,
            `Thread: ${threadLabel}`,
          ];
          if (tail.lastAssistantText) {
            resultLines.push(`Assistant: ${tail.lastAssistantText}`);
          } else if (capturedOutput) {
            resultLines.push(`${capturedOutput.kind === 'assistant_text' ? 'Assistant' : 'Output'}: ${capturedOutput.text}`);
          } else if (tail.lastToolOutput) {
            resultLines.push(`Output: ${tail.lastToolOutput.summary}`);
          } else {
            resultLines.push('Assistant: (no assistant text captured)');
          }
          if (recentOutputs.length > 0) {
            resultLines.push('Recent files:');
            resultLines.push(...recentOutputs.map((item) => `${path.basename(item.localPath)} | ${Math.round(item.sizeBytes / 1024)} KB`));
          }
          await this.sendText(this.config.operatorChatId, resultLines.join('\n'));
        }
        await this.sendText(this.config.operatorChatId, 'Use /artifact to fetch files from this thread.');
        break;
      }
      case 'TurnInterrupted': {
        const key = `interrupted:${thread.id}:${event.turnId ?? ''}`;
        if (this.seenTurnNotifications.has(key)) {
          return;
        }
        this.seenTurnNotifications.add(key);
        if (event.turnId) {
          this.turnStartedAt.delete(event.turnId);
        }
        await this.sendText(this.config.operatorChatId, `Interrupted\nProject: ${projectLabel}\nThread: ${threadLabel}`);
        break;
      }
      case 'TurnOutputObserved': {
        const payload = event.payload as TurnOutputObservedPayload;
        const text = payload.text?.trim();
        if (!text) {
          return;
        }

        // Only forward live stream output for the currently focused thread (set by /pick).
        // Without this, any background thread will spam Telegram with token-sized chunks.
        const focused = this.sessionRegistry.getOperatorFocusThread();
        if (!focused || focused !== thread.id) {
          return;
        }

        if (this.isStreamNoise(text, payload.kind, payload.method)) {
          return;
        }

        const method = payload.method ?? 'stream';
        const fingerprint = `${payload.kind}:${method}:${text}`;
        const last = this.streamFingerprintByThread.get(thread.id);
        const nowMs = Date.now();
        if (last && last.fingerprint === fingerprint && nowMs - last.atMs < 5_000) {
          return;
        }
        this.streamFingerprintByThread.set(thread.id, {
          fingerprint,
          atMs: nowMs,
        });

        this.bufferStreamChunk(thread.id, {
          projectLabel,
          threadLabel,
          text,
        });
        break;
      }
      case 'ReasoningSummaryObserved': {
        const payload = event.payload as ReasoningSummaryObservedPayload;
        const text = payload.text?.trim();
        if (!text) {
          return;
        }

        const focused = this.sessionRegistry.getOperatorFocusThread();
        if (!focused || focused !== thread.id) {
          return;
        }

        await this.sendText(this.config.operatorChatId, [
          'Reasoning Summary for selected thread:',
          'This is an App Server-exposed summary, not raw hidden reasoning.',
          '',
          `Project: ${projectLabel}`,
          `Thread: ${threadLabel}`,
          payload.method ? `Source event: ${payload.method}` : 'Source event: app_server',
          '',
          text,
        ].join('\n'));
        break;
      }
      default:
        break;
    }
  }

  private latestCapturedTurnOutput(threadId: string, turnId?: string): { kind: TurnOutputObservedPayload['kind']; text: string } | undefined {
    const outputs = this.repository.listRecentTurnOutputs(threadId, 10);
    const sameTurn = turnId ? outputs.filter((output) => output.turnId === turnId) : outputs;
    const candidates = sameTurn.length > 0 ? sameTurn : outputs;
    const output =
      candidates.find((item) => item.kind === 'assistant_text')
      ?? candidates.find((item) => item.kind !== 'system')
      ?? candidates[0];
    if (!output?.text?.trim()) {
      return undefined;
    }
    return {
      kind: output.kind,
      text: output.text.trim(),
    };
  }

  private isStreamNoise(text: string, kind: TurnOutputObservedPayload['kind'], method?: string): boolean {
    const normalized = text.trim();
    const methodNorm = (method ?? '').trim();

    // Drop protocol events that carry no operator-facing text.
    const noisyExact = new Set([
      'item/started',
      'item/completed',
      'thread/tokenUsage/updated',
      'turn/diff/updated',
    ]);
    if (noisyExact.has(normalized) || noisyExact.has(methodNorm)) {
      return true;
    }

    // Tool status is chatty. Only lines that look like errors are forwarded.
    if (kind === 'tool_status') {
      if (/error|failed|not found|permission denied/i.test(normalized)) {
        return false;
      }
      return true;
    }

    return false;
  }

  private bufferStreamChunk(
    threadId: string,
    input: { projectLabel: string; threadLabel: string; text: string },
  ): void {
    const nowMs = Date.now();
    const existing = this.streamBuffers.get(threadId) ?? { pieces: [], lastFlushAtMs: 0 };
    existing.pieces.push(input.text);

    // Flush now if the last flush was more than 5 seconds ago, so output is not held back.
    if (existing.lastFlushAtMs && nowMs - existing.lastFlushAtMs > 5_000) {
      void this.flushStreamBuffer(threadId, input.projectLabel, input.threadLabel);
    }

    if (existing.timer) {
      clearTimeout(existing.timer);
    }
    existing.timer = setTimeout(() => {
      void this.flushStreamBuffer(threadId, input.projectLabel, input.threadLabel);
    }, 1200);

    this.streamBuffers.set(threadId, existing);
  }

  private async flushStreamBuffer(threadId: string, projectLabel: string, threadLabel: string): Promise<void> {
    const buf = this.streamBuffers.get(threadId);
    if (!buf || buf.pieces.length === 0) {
      return;
    }

    const combinedRaw = buf.pieces.join('');
    buf.pieces = [];
    buf.lastFlushAtMs = Date.now();
    if (buf.timer) {
      clearTimeout(buf.timer);
      buf.timer = undefined;
    }

    const combined = combinedRaw.replace(/\s+/g, ' ').trim();
    // Drop tiny token fragments (but allow short multi-word human output).
    const hasPunct = /[.!?:]/.test(combined);
    const hasWhitespace = /\s/.test(combined);
    if (!hasPunct && combined.length < 8) {
      return;
    }
    if (!hasPunct && !hasWhitespace && combined.length < 30) {
      return;
    }

    await this.sendText(
      this.config.operatorChatId,
      [
        'Update',
        `Project: ${projectLabel}`,
        `Thread: ${threadLabel}`,
        combined.length > 1300 ? `${combined.slice(0, 1297)}...` : combined,
      ].join('\n'),
    );
  }

  private async sendText(chatId: string, text: string): Promise<void> {
    // Telegram rejects messages longer than 4096 characters, so chunks stay below that limit.
    const chunks = this.chunkText(text, 3900);
    for (const chunk of chunks) {
      try {
        await this.telegramClient.sendMessage(chatId, chunk);
      } catch (error) {
        this.logger.warn('telegram-operator-notification-send-failed', {
          message: this.errorMessage(error),
        });
        return;
      }
    }
  }

  private chunkText(text: string, maxChars: number): string[] {
    if (text.length <= maxChars) {
      return [text];
    }

    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > maxChars) {
      chunks.push(remaining.slice(0, maxChars));
      remaining = remaining.slice(maxChars);
    }
    if (remaining) {
      chunks.push(remaining);
    }
    return chunks;
  }

  private async bootstrapProjectsIfEmpty(): Promise<void> {
    const limit = this.config.projectAutoDiscoverLimit;
    if (limit <= 0) {
      return;
    }

    if (this.sessionRegistry.listProjects().length > 0) {
      return;
    }

    const candidates = new Set<string>();
    const addCandidate = (cwd?: string): void => {
      if (!cwd) {
        return;
      }

      const resolved = path.resolve(cwd);
      if (!fs.existsSync(resolved)) {
        return;
      }
      candidates.add(resolved);
    };

    try {
      const codexThreads = await this.appServerClient.listThreads();
      for (const thread of codexThreads) {
        addCandidate(thread.cwd);
        if (candidates.size >= limit) {
          break;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('project-bootstrap-codex-list-threads-failed', { message });
    }

    if (candidates.size < limit) {
      for (const candidate of this.discoverLocalProjectRoots(limit)) {
        addCandidate(candidate);
        if (candidates.size >= limit) {
          break;
        }
      }
    }

    if (candidates.size === 0) {
      addCandidate(process.cwd());
    }

    let registered = 0;
    for (const rootPath of candidates) {
      if (registered >= limit) {
        break;
      }

      const projectName = this.uniqueProjectName(path.basename(rootPath) || 'project');
      const projectId = this.uniqueProjectId(`auto_${this.slugify(projectName)}`);
      this.sessionRegistry.registerProject({
        id: projectId,
        name: projectName,
        rootPath,
      });
      registered += 1;
    }

    this.logger.info('project-bootstrap-complete', {
      bootstrapSourceOrder: ['codex_threads', 'local_scan', 'cwd_fallback'],
      registeredProjects: registered,
    });
  }

  private discoverLocalProjectRoots(limit: number): string[] {
    const parent = path.dirname(process.cwd());
    if (!fs.existsSync(parent)) {
      return [];
    }

    const roots: string[] = [];
    const entries = fs.readdirSync(parent, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const candidate = path.join(parent, entry.name);
      if (!this.looksLikeProjectRoot(candidate)) {
        continue;
      }

      roots.push(candidate);
      if (roots.length >= limit) {
        break;
      }
    }

    return roots;
  }

  private looksLikeProjectRoot(candidateRoot: string): boolean {
    return (
      fs.existsSync(path.join(candidateRoot, 'src')) ||
      fs.existsSync(path.join(candidateRoot, '.git')) ||
      fs.existsSync(path.join(candidateRoot, 'package.json'))
    );
  }

  private uniqueProjectName(baseName: string): string {
    const existing = new Set(this.sessionRegistry.listProjects().map((project) => project.name));
    if (!existing.has(baseName)) {
      return baseName;
    }

    let suffix = 2;
    while (existing.has(`${baseName}-${suffix}`)) {
      suffix += 1;
    }
    return `${baseName}-${suffix}`;
  }

  private uniqueProjectId(baseId: string): string {
    const existing = new Set(this.sessionRegistry.listProjects().map((project) => project.id));
    if (!existing.has(baseId)) {
      return baseId;
    }

    let suffix = 2;
    while (existing.has(`${baseId}_${suffix}`)) {
      suffix += 1;
    }
    return `${baseId}_${suffix}`;
  }

  private slugify(value: string): string {
    const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return slug || 'project';
  }

  private acquireSingleInstanceLock(): void {
    const lockDir = path.dirname(this.config.dbPath);
    const lockPath = path.join(lockDir, 'rcc.lock.json');
    this.lockFilePath = lockPath;

    const tryCreate = (): void => {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        const payload = {
          pid: process.pid,
          startedAt: new Date().toISOString(),
        };
        fs.writeFileSync(fd, JSON.stringify(payload, null, 2), 'utf8');
      } finally {
        fs.closeSync(fd);
      }
    };

    try {
      tryCreate();
      return;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }
    }

    // Existing lock: stop if its process is alive, otherwise treat it as stale.
    const livePid = this.livePidFromLock(lockPath);
    if (livePid !== undefined) {
      throw new Error(`RCC is already running (pid ${livePid}). Stop it before starting a new instance.`);
    }

    try {
      fs.unlinkSync(lockPath);
    } catch {
      // The lock may already be gone. The retry below reports a failure to create it.
    }

    // Retry once after removing stale lock.
    tryCreate();
  }

  // Returns the PID in the lock file when that process is alive. Unreadable or unknown locks return undefined.
  private livePidFromLock(lockPath: string): number | undefined {
    let pid: unknown;
    try {
      const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid?: unknown };
      pid = parsed.pid;
    } catch {
      return undefined;
    }
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      return undefined;
    }
    try {
      process.kill(pid, 0);
      return pid;
    } catch (err: any) {
      // EPERM means the process exists but belongs to another user, so it is still alive.
      return err?.code === 'EPERM' ? pid : undefined;
    }
  }

  private releaseSingleInstanceLock(): void {
    const lockPath = this.lockFilePath;
    if (!lockPath) {
      return;
    }
    try {
      const raw = fs.readFileSync(lockPath, 'utf8');
      const parsed = JSON.parse(raw) as { pid?: number };
      if (parsed?.pid !== process.pid) {
        return;
      }
    } catch {
      // If the file cannot be read, still try to remove it.
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Removal is best effort. A leftover lock is treated as stale on the next start.
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
