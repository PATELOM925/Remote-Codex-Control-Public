import fs from 'node:fs';
import path from 'node:path';

import type { CodexSkillRef, CodexThread, CodexThreadMode } from '../contracts/codex.js';
import type { ReasoningEffort, ThreadStatus } from '../contracts/states.js';
import type { TelegramClient, TelegramUpdate } from '../contracts/telegram.js';
import type { ApprovalRecord, ArtifactRecord, ReasoningSummaryRecord, RccRepository } from '../db/repositories.js';
import type { Logger } from '../logger.js';
import type { ApprovalRouterAgent } from '../agents/approvalRouterAgent.js';
import type { ArtifactWatcherAgent } from '../agents/artifactWatcherAgent.js';
import type { CodexBridgeAgent } from '../agents/codexBridgeAgent.js';
import type { FileIntakeAgent } from '../agents/fileIntakeAgent.js';
import type { HealthOpsAgent } from '../agents/healthOpsAgent.js';
import type { ModelPolicyAgent } from '../agents/modelPolicyAgent.js';
import type { SessionRegistryAgent } from '../agents/sessionRegistryAgent.js';
import type { CodexDesktopStateMonitor } from './codexDesktopStateMonitor.js';
import type { SteeringAgent } from '../agents/steeringAgent.js';

import { buildApprovalDetails, type ApprovalRisk } from './approvalDetails.js';
import { CodexSessionService } from './codexSessionService.js';
// Telegram rejects messages longer than 4096 characters, so text is split below that limit.
const TELEGRAM_TEXT_LIMIT = 3900;
const DEFAULT_CODEX_LIST_LIMIT = 30;
export class TelegramCommandService {
    telegramClient: TelegramClient;
    sessionRegistry: SessionRegistryAgent;
    repository: RccRepository;
    codexBridge: CodexBridgeAgent;
    approvalRouter: ApprovalRouterAgent;
    steeringAgent: SteeringAgent;
    fileIntakeAgent: FileIntakeAgent;
    artifactWatcher: ArtifactWatcherAgent;
    modelPolicy: ModelPolicyAgent;
    healthOps: HealthOpsAgent;
    codexSessions: CodexSessionService;
    desktopStateMonitor?: CodexDesktopStateMonitor;
    logger: Logger;
    allowedChatIds: Set<string>;
    lastCodexListByChat = new Map<string, CodexThread[]>();
    lastCodexListAtMsByChat = new Map<string, number>();
    lastProjectListByChat = new Map<string, ReturnType<RccRepository['listProjects']>>();
    selectedCodexThreadByChat = new Map<string, string>();
    lastArtifactListByChat = new Map<string, ArtifactRecord[]>();
    constructor(telegramClient: TelegramClient, sessionRegistry: SessionRegistryAgent, repository: RccRepository, codexBridge: CodexBridgeAgent, approvalRouter: ApprovalRouterAgent, steeringAgent: SteeringAgent, fileIntakeAgent: FileIntakeAgent, artifactWatcher: ArtifactWatcherAgent, modelPolicy: ModelPolicyAgent, healthOps: HealthOpsAgent, codexSessions: CodexSessionService, desktopStateMonitor: CodexDesktopStateMonitor | undefined, logger: Logger, allowedChatIds: string[]) {
        this.telegramClient = telegramClient;
        this.sessionRegistry = sessionRegistry;
        this.repository = repository;
        this.codexBridge = codexBridge;
        this.approvalRouter = approvalRouter;
        this.steeringAgent = steeringAgent;
        this.fileIntakeAgent = fileIntakeAgent;
        this.artifactWatcher = artifactWatcher;
        this.modelPolicy = modelPolicy;
        this.healthOps = healthOps;
        this.codexSessions = codexSessions;
        this.desktopStateMonitor = desktopStateMonitor;
        this.logger = logger;
        this.allowedChatIds = new Set(allowedChatIds);
    }
    start(): void {
        this.telegramClient.onUpdate((update) => {
            void this.handleUpdate(update).catch((error) => {
                this.logger.warn('telegram-update-handler-failed', {
                    message: error instanceof Error ? error.message : String(error),
                    update,
                });
            });
        });
    }
    async handleUpdate(update: TelegramUpdate): Promise<void> {
        try {
            // Only configured operator chats may use the bot. Other chats get a fixed refusal and no command runs.
            if (!this.allowedChatIds.has(update.chatId)) {
                this.logger.warn('telegram-command-unauthorized-chat', { chatId: update.chatId, messageId: update.messageId });
                await this.sendText(update.chatId, 'Unauthorized chat. This bot is restricted to configured operator chat IDs.');
                return;
            }
            if (update.callbackData) {
                await this.approvalRouter.resolveFromTelegramCallback(update.callbackData);
                return;
            }
            const { command, args } = this.extractCommand(update);
            if (!command) {
                return;
            }
            switch (command) {
                case '/help': {
                    await this.sendText(update.chatId, this.helpText());
                    break;
                }
                case '/codex':
                case '/codex-threads':
                case '/codex_threads':
                case '/sync-codex':
                case '/codex-sync':
                case '/sync_codex':
                case '/codex_sync': {
                    await this.sendText(update.chatId, 'Deprecated. Use /threads (RCC reads live Codex threads automatically).');
                    break;
                }
                case '/approval-demo': {
                    await this.sendText(update.chatId, 'Deprecated. Use /approval_demo.');
                    break;
                }
                case '/threads': {
                    const limit = this.parseListLimit(args);
                    const codexThreads = await this.listSortedCodexThreads();
                    const visible = codexThreads.slice(0, limit);
                    this.lastCodexListByChat.set(update.chatId, visible);
                    this.lastCodexListAtMsByChat.set(update.chatId, Date.now());
                    await this.sendText(update.chatId, this.renderCodexThreadsText(visible, codexThreads.length, update.chatId));
                    break;
                }
                case '/pick': {
                    if (args.length === 0) {
                        throw new Error('Usage: /pick <threadRef from /threads>');
                    }
                    const joinedRef = args.join(' ').trim();
                    const firstArg = args[0] ?? '';
                    if ((/^\d+$/.test(firstArg) || this.looksLikeExplicitThreadRef(firstArg)) && args.length !== 1) {
                        throw new Error('Usage: /pick <threadRef from /threads>');
                    }
                    const threadRef = joinedRef;
                    if (!threadRef) {
                        throw new Error('Usage: /pick <threadRef from /threads>');
                    }
                    const codexThread = await this.resolveCodexThreadRef(threadRef, update.chatId);
                    this.selectedCodexThreadByChat.set(update.chatId, codexThread.codexThreadId);
                    const mapped = this.ensureMappedThread(codexThread);
                    this.sessionRegistry.setOperatorFocusThread(mapped.id);
                    try {
                        await this.codexBridge.resumeThread(mapped.id);
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        await this.sendText(update.chatId, `Warning: failed to attach to this thread for live events/approvals.\n${message}`);
                    }
                    await this.sendText(update.chatId, [
                        'Thread selected',
                        `ID: ${codexThread.codexThreadId}`,
                        `Name: ${this.compactName(codexThread.threadName ?? '(unnamed)')}`,
                        `Path: ${this.compactPath(codexThread.cwd)}`,
                        'Live updates: enabled for this thread (background threads are muted).',
                        '',
                        'Now use /run <task> or /say <change request>.',
                    ].join('\n'));
                    break;
                }
                case '/where': {
                    const selected = this.selectedCodexThreadByChat.get(update.chatId);
                    if (!selected) {
                        await this.sendText(update.chatId, 'No thread selected. Use /threads then /pick <ref>.');
                        break;
                    }
                    const codexThread = await this.resolveCodexThreadRef(selected, update.chatId);
                    await this.sendText(update.chatId, [
                        'Current thread',
                        `ID: ${codexThread.codexThreadId}`,
                        `Name: ${this.compactName(codexThread.threadName ?? '(unnamed)')}`,
                        `Status: ${codexThread.status}`,
                        `Path: ${this.compactPath(codexThread.cwd)}`,
                    ].join('\n'));
                    break;
                }
                case '/approvals': {
                    await this.sendText(update.chatId, this.renderApprovalsText());
                    break;
                }
                case '/last': {
                    const override = this.extractThreadOverride(args);
                    const limit = this.parseListLimit(override ? override.args : args);
                    const codexThread = override
                        ? await this.resolveCodexThreadRef(override.threadRef, update.chatId)
                        : await this.resolveSelectedCodexThread(update.chatId);
                    const mapped = this.ensureMappedThread(codexThread);
                    const thread = this.sessionRegistry.findThreadById(mapped.id);
                    const lastMessage = this.repository.listOperatorMessages(mapped.id, 1)[0];
                    const outputs = this.repository.listRecentTurnOutputs(mapped.id, Math.max(1, Math.min(25, limit)));
                    const codexTail = this.codexSessions.readTail(codexThread.codexThreadId);
                    const approvals = this.repository.listApprovals(mapped.id);
                    const pendingApproval = approvals.find((approval) => approval.status === 'pending');
                    const latestResolvedApproval = approvals.find((approval) => approval.status !== 'pending');
                    const sessionActivity = this.codexSessions.isRecentlyActive(codexThread.codexThreadId, 30 * 60_000);
                    const desktopActivity = this.desktopStateMonitor?.getRecentActivity(codexThread.codexThreadId, 30 * 60_000);
                    const rccStatus = thread?.status ?? 'unknown';
                    const activeSignal = ['running', 'waiting_approval', 'waiting_operator'].includes(rccStatus)
                        || sessionActivity.active
                        || Boolean(desktopActivity?.active);
                    const statusMismatch = activeSignal && ['idle', 'completed', 'interrupted', 'failed', 'unknown'].includes(rccStatus);
                    const approvalSource = (codexRequestId?: string): string => {
                        if (!codexRequestId) {
                            return 'n/a';
                        }
                        if (codexRequestId.startsWith('desktop:')) {
                            return 'desktop_log_recovered';
                        }
                        if (codexRequestId.startsWith('demo:')) {
                            return 'demo';
                        }
                        return 'app_server';
                    };
                    const isoAge = (iso?: string): string | undefined => {
                        if (!iso) {
                            return undefined;
                        }
                        const ms = Date.parse(iso);
                        if (!Number.isFinite(ms)) {
                            return undefined;
                        }
                        return this.formatAge(Date.now() - ms);
                    };
                    const body = [
                        `Last for ${this.compactName(codexThread.threadName ?? codexThread.codexThreadId)}`,
                        `Codex ID: ${codexThread.codexThreadId}`,
                        `RCC Status: ${rccStatus}`,
                        `Active Turn: ${thread?.activeTurnId ?? 'n/a'}`,
                        '',
                        'Approval:',
                        pendingApproval
                            ? `Pending: ${pendingApproval.id} | ${isoAge(pendingApproval.createdAt) ?? 'n/a'} ago | ${approvalSource(pendingApproval.codexRequestId)} | ${pendingApproval.summary}`
                            : 'Pending: none',
                        latestResolvedApproval
                            ? `Last resolved: ${latestResolvedApproval.id} | ${latestResolvedApproval.status} | ${isoAge(latestResolvedApproval.resolvedAt) ?? 'n/a'} ago | ${approvalSource(latestResolvedApproval.codexRequestId)}`
                            : 'Last resolved: none',
                        '',
                        'Sync Proof:',
                        `Session recent activity: ${sessionActivity.active ? 'yes' : 'no'}${sessionActivity.mtimeMs ? ` (${Math.round((Date.now() - sessionActivity.mtimeMs) / 1000)}s ago)` : ''}`,
                        `Desktop log activity: ${desktopActivity?.active ? 'yes' : 'no'}${desktopActivity?.mtimeMs ? ` (${Math.round((Date.now() - desktopActivity.mtimeMs) / 1000)}s ago)` : ''}`,
                        `Mismatch: ${statusMismatch ? 'active_signals_but_rcc_not_running' : 'none'}`,
                        '',
                        'Last instruction (via RCC/Telegram):',
                        lastMessage
                            ? `[${lastMessage.createdAt}] (${lastMessage.deliveryMode}) ${lastMessage.messageText}`
                            : '(none recorded; this thread may have been started from the desktop app)',
                        '',
                        'Last instruction (Codex session):',
                        codexTail.lastUserText ? codexTail.lastUserText : '(n/a)',
                        '',
                        `RCC recent output (${outputs.length}):`,
                        ...(outputs.length
                            ? outputs
                                .slice()
                                .reverse()
                                .map((out) => `[${out.occurredAt}] (${out.kind}) ${out.text}`)
                            : ['(none observed yet)']),
                        '',
                        'Codex session tail:',
                        codexTail.sessionFile
                            ? `Session: ${this.compactPath(codexTail.sessionFile)}`
                            : 'Session: (not found)',
                        codexTail.sessionMtimeMs ? `Session mtime: ${Math.round((Date.now() - codexTail.sessionMtimeMs) / 1000)}s ago` : 'Session mtime: n/a',
                        codexTail.lastToolCall ? `Last tool: ${codexTail.lastToolCall.name} | ${codexTail.lastToolCall.summary}` : 'Last tool: (n/a)',
                        codexTail.lastToolOutput ? `Last output: ${codexTail.lastToolOutput.summary}` : 'Last output: (n/a)',
                        codexTail.lastAssistantText ? `Last assistant: ${codexTail.lastAssistantText}` : 'Last assistant: (n/a)',
                    ].join('\n');
                    await this.sendText(update.chatId, body);
                    break;
                }
                case '/thinking': {
                    const override = this.extractThreadOverride(args);
                    const limit = this.parseListLimit(override ? override.args : args);
                    const codexThread = override
                        ? await this.resolveCodexThreadRef(override.threadRef, update.chatId)
                        : await this.resolveSelectedCodexThread(update.chatId);
                    const mapped = this.ensureMappedThread(codexThread);
                    const summaries = this.repository.listRecentReasoningSummaries(mapped.id, Math.max(1, Math.min(10, limit)));
                    await this.sendText(update.chatId, this.renderReasoningSummaryText(codexThread, summaries));
                    break;
                }
                case '/run': {
                    const { codexThread, message, skills } = await this.resolveThreadAndMessageForRun(args, update.chatId);
                    const mapped = this.ensureMappedThread(codexThread);
                    this.selectedCodexThreadByChat.set(update.chatId, codexThread.codexThreadId);
                    this.sessionRegistry.setOperatorFocusThread(mapped.id);
                    if (this.shouldRouteRunAsSteer(codexThread, mapped.id)) {
                        await this.sendText(update.chatId, [
                            'Run request received',
                            `Thread: ${this.compactName(codexThread.threadName ?? codexThread.codexThreadId)}`,
                            `Codex ID: ${codexThread.codexThreadId}`,
                            'Thread is already active or waiting, so RCC will not start a second turn.',
                            'Routing this as steering guidance instead.',
                            skills?.length
                                ? 'Note: selected skills apply only to new turns, not steering messages.'
                                : undefined,
                        ].filter(Boolean).join('\n'));
                        const mode = await this.steeringAgent.steerOrQueue(mapped.id, message);
                        await this.sendText(update.chatId, mode === 'steer_active_turn'
                            ? `Steering sent to active turn on ${this.compactName(codexThread.threadName ?? codexThread.codexThreadId)}`
                            : [
                                'No active turn was attachable from RCC.',
                                'Message queued as the next instruction for this thread.',
                                'If Codex is waiting for approval, use /approvals and resolve that approval first.',
                            ].join('\n'));
                        break;
                    }
                    await this.sendText(update.chatId, [
                        'Run request received',
                        `Thread: ${this.compactName(codexThread.threadName ?? codexThread.codexThreadId)}`,
                        `Codex ID: ${codexThread.codexThreadId}`,
                        'RCC is sending this to Codex now. Live output will stream here when available; /last shows the latest captured result.',
                    ].join('\n'));
                    const started = await this.codexBridge.startTurn(mapped.id, message, { skills });
                    await this.sendText(update.chatId, [
                        'Turn started',
                        `Thread: ${this.compactName(codexThread.threadName ?? codexThread.codexThreadId)}`,
                        `Codex ID: ${codexThread.codexThreadId}`,
                        `Mode: ${this.codexBridge.getThreadMode(mapped.id)}`,
                        `Skills: ${this.renderSkillNames(this.codexBridge.getThreadSkills(mapped.id), skills)}`,
                        `Turn ID: ${started.turnId}`,
                        '',
                        'Use /say <change> while running.',
                    ].join('\n'));
                    break;
                }
                case '/plan': {
                    const { codexThread, message, skills } = await this.resolveThreadAndMessageForRun(args, update.chatId);
                    const mapped = this.ensureMappedThread(codexThread);
                    this.codexBridge.setThreadMode(mapped.id, 'plan');
                    const started = await this.codexBridge.startTurn(mapped.id, message, { mode: 'plan', skills });
                    this.selectedCodexThreadByChat.set(update.chatId, codexThread.codexThreadId);
                    this.sessionRegistry.setOperatorFocusThread(mapped.id);
                    await this.sendText(update.chatId, [
                        'Plan turn started',
                        `Thread: ${this.compactName(codexThread.threadName ?? codexThread.codexThreadId)}`,
                        `Codex ID: ${codexThread.codexThreadId}`,
                        `Mode: ${this.codexBridge.getThreadMode(mapped.id)}`,
                        `Skills: ${this.renderSkillNames(this.codexBridge.getThreadSkills(mapped.id), skills)}`,
                        `Turn ID: ${started.turnId}`,
                    ].join('\n'));
                    break;
                }
                case '/say': {
                    const { codexThread, message } = await this.resolveThreadAndMessageForSay(args, update.chatId);
                    const mapped = this.ensureMappedThread(codexThread);
                    const mode = await this.steeringAgent.steerOrQueue(mapped.id, message);
                    this.selectedCodexThreadByChat.set(update.chatId, codexThread.codexThreadId);
                    this.sessionRegistry.setOperatorFocusThread(mapped.id);
                    await this.sendText(update.chatId, mode === 'steer_active_turn'
                        ? `Steering sent to active turn on ${this.compactName(codexThread.threadName ?? codexThread.codexThreadId)}`
                        : `No active turn. Message queued. Start with /run ${codexThread.codexThreadId}`);
                    break;
                }
                case '/interrupt': {
                    const codexRef = args[0];
                    const codexThread = codexRef
                        ? await this.resolveCodexThreadRef(codexRef, update.chatId)
                        : await this.resolveSelectedCodexThread(update.chatId);
                    const mapped = this.ensureMappedThread(codexThread);
                    await this.codexBridge.interruptTurn(mapped.id);
                    await this.sendText(update.chatId, `Interrupted active turn for ${this.compactName(codexThread.threadName ?? codexThread.codexThreadId)}`);
                    break;
                }
                case '/attach': {
                    if (!update.attachment) {
                        throw new Error('Usage: /attach [threadRef] with file in same message.');
                    }
                    const codexRef = args[0];
                    const codexThread = codexRef
                        ? await this.resolveCodexThreadRef(codexRef, update.chatId)
                        : await this.resolveSelectedCodexThread(update.chatId);
                    const mapped = this.ensureMappedThread(codexThread);
                    const result = await this.fileIntakeAgent.ingestAttachment({
                        threadId: mapped.id,
                        attachment: update.attachment,
                    });
                    await this.sendText(update.chatId, `Attachment ingested for ${this.compactName(codexThread.threadName ?? codexThread.codexThreadId)}\nSaved: ${result.localPath}`);
                    break;
                }
                case '/artifact': {
                    const artifactAction = this.parseArtifactAction(args);
                    const codexRef = artifactAction.threadRef;
                    const codexThread = codexRef
                        ? await this.resolveCodexThreadRef(codexRef, update.chatId)
                        : await this.resolveSelectedCodexThread(update.chatId);
                    const mapped = this.ensureMappedThread(codexThread);
                    const cacheKey = `${update.chatId}:${mapped.id}`;
                    if (artifactAction.mode === 'send') {
                        const cached = this.lastArtifactListByChat.get(cacheKey) ?? [];
                        if (cached.length === 0) {
                            throw new Error('No artifact list cached. Run /artifact first.');
                        }
                        const artifact = artifactAction.selection === 'all'
                            ? cached
                            : [this.resolveArtifactSelection(artifactAction.selection, cached)];
                        await this.artifactWatcher.sendArtifacts(mapped.id, artifact.map((item) => item.id));
                        await this.sendText(update.chatId, `Artifact send attempted for ${this.compactName(codexThread.threadName ?? codexThread.codexThreadId)}`);
                        break;
                    }
                    this.artifactWatcher.detectArtifacts(mapped.id);
                    const pending = this.artifactWatcher.listPendingArtifacts(mapped.id);
                    this.lastArtifactListByChat.set(cacheKey, pending);
                    await this.sendText(update.chatId, this.renderArtifactListText(codexThread, pending));
                    break;
                }
                case '/model': {
                    if (args.length === 0) {
                        throw new Error('Usage: /model <model> after /pick OR /model <threadRef> <model>');
                    }
                    const maybeTwoArg = args.length >= 2;
                    let codexThread;
                    let model;
                    if (maybeTwoArg) {
                        codexThread = await this.resolveCodexThreadRef(args[0] ?? '', update.chatId);
                        model = args.slice(1).join(' ').trim();
                    }
                    else {
                        codexThread = await this.resolveSelectedCodexThread(update.chatId);
                        model = (args[0] ?? '').trim();
                    }
                    if (!model) {
                        throw new Error('Model value cannot be empty.');
                    }
                    const mapped = this.ensureMappedThread(codexThread);
                    this.modelPolicy.requestPolicyUpdate({
                        threadId: mapped.id,
                        model,
                        requestedBySteer: false,
                    });
                    await this.sendText(update.chatId, `Model queued for next turn on ${this.compactName(codexThread.threadName ?? codexThread.codexThreadId)}: ${model}`);
                    break;
                }
                case '/effort': {
                    if (args.length === 0) {
                        throw new Error('Usage: /effort <low|medium|high> after /pick OR /effort <threadRef> <low|medium|high>');
                    }
                    const maybeTwoArg = args.length >= 2;
                    let codexThread;
                    let effortRaw;
                    if (maybeTwoArg) {
                        codexThread = await this.resolveCodexThreadRef(args[0] ?? '', update.chatId);
                        effortRaw = (args[1] ?? '').trim().toLowerCase();
                    }
                    else {
                        codexThread = await this.resolveSelectedCodexThread(update.chatId);
                        effortRaw = (args[0] ?? '').trim().toLowerCase();
                    }
                    if (!['low', 'medium', 'high'].includes(effortRaw)) {
                        throw new Error('Effort must be one of: low, medium, high');
                    }
                    const effort = effortRaw as ReasoningEffort;
                    const mapped = this.ensureMappedThread(codexThread);
                    this.modelPolicy.requestPolicyUpdate({
                        threadId: mapped.id,
                        effort,
                        requestedBySteer: false,
                    });
                    await this.sendText(update.chatId, `Reasoning effort queued for next turn on ${this.compactName(codexThread.threadName ?? codexThread.codexThreadId)}: ${effort}`);
                    break;
                }
                case '/mode': {
                    const modeRaw = args[0]?.trim().toLowerCase();
                    const codexThread = args.length >= 2
                        ? await this.resolveCodexThreadRef(args[0] ?? '', update.chatId)
                        : await this.resolveSelectedCodexThread(update.chatId);
                    const mapped = this.ensureMappedThread(codexThread);
                    if (!modeRaw || (args.length === 1 && !['plan', 'build'].includes(modeRaw))) {
                        await this.sendText(update.chatId, [
                            'Current mode',
                            `Thread: ${this.compactName(codexThread.threadName ?? codexThread.codexThreadId)}`,
                            `Mode: ${this.codexBridge.getThreadMode(mapped.id)}`,
                            '',
                            'Use /mode plan or /mode build.',
                        ].join('\n'));
                        break;
                    }
                    const mode = (args.length >= 2 ? args[1] : modeRaw) as string;
                    const parsedMode = this.requireMode(mode);
                    this.codexBridge.setThreadMode(mapped.id, parsedMode);
                    await this.sendText(update.chatId, `Mode set for ${this.compactName(codexThread.threadName ?? codexThread.codexThreadId)}: ${parsedMode}`);
                    break;
                }
                case '/skills': {
                    const codexThread = args[0] ? await this.resolveCodexThreadRef(args[0], update.chatId) : await this.resolveSelectedCodexThread(update.chatId);
                    const mapped = this.ensureMappedThread(codexThread);
                    const available = await this.codexBridge.listSkillsForThread(mapped.id);
                    const active = this.codexBridge.getThreadSkills(mapped.id);
                    await this.sendText(update.chatId, this.renderSkillsText(codexThread, active, available));
                    break;
                }
                case '/skill': {
                    const action = args[0]?.trim().toLowerCase();
                    if (!action || !['add', 'clear'].includes(action)) {
                        throw new Error('Usage: /skill add <skillName> OR /skill clear');
                    }
                    const codexThread = await this.resolveSelectedCodexThread(update.chatId);
                    const mapped = this.ensureMappedThread(codexThread);
                    if (action === 'clear') {
                        this.codexBridge.clearThreadSkills(mapped.id);
                        await this.sendText(update.chatId, `Skills cleared for ${this.compactName(codexThread.threadName ?? codexThread.codexThreadId)}.`);
                        break;
                    }
                    const skillName = args[1]?.trim();
                    if (!skillName) {
                        throw new Error('Usage: /skill add <skillName>');
                    }
                    const skill = await this.resolveSkillForThread(mapped.id, skillName);
                    const skills = this.codexBridge.addThreadSkill(mapped.id, skill);
                    await this.sendText(update.chatId, `Skill added: ${skill.name}\nActive skills: ${this.renderSkillNames(skills)}`);
                    break;
                }
                case '/approve': {
                    const approvalId = args[0];
                    if (!approvalId) {
                        throw new Error('Usage: /approve <approvalId>');
                    }
                    await this.approvalRouter.resolveFromTelegramCallback(`approve:${approvalId}`);
                    break;
                }
                case '/deny': {
                    const approvalId = args[0];
                    if (!approvalId) {
                        throw new Error('Usage: /deny <approvalId>');
                    }
                    await this.approvalRouter.resolveFromTelegramCallback(`deny:${approvalId}`);
                    break;
                }
                case '/status': {
                    await this.sendText(update.chatId, this.healthOps.statusText());
                    break;
                }
                case '/approval_demo': {
                    const selected = this.selectedCodexThreadByChat.get(update.chatId);
                    if (!selected) {
                        throw new Error('No selected thread. Use /pick <threadRef> first.');
                    }
                    const codexThread = await this.resolveCodexThreadRef(selected, update.chatId);
                    const mapped = this.ensureMappedThread(codexThread);
                    const approvalId = this.approvalRouter.triggerDemoApproval({
                        threadId: mapped.id,
                    });
                    await this.sendText(update.chatId, `Demo approval triggered for ${this.compactName(codexThread.threadName ?? codexThread.codexThreadId)}\nApproval ID: ${approvalId}`);
                    break;
                }
                case '/running': {
                    const limit = this.parseListLimit(args);
                    const codexThreads = await this.listSortedCodexThreads();
                    const windowMs = 30 * 60_000;
                    const active: Array<{ thread: CodexThread; reason: 'app-server' | 'activity'; mtimeMs?: number }> = [];
                    for (const thread of codexThreads) {
                        if (['running', 'waiting_approval', 'waiting_operator'].includes(thread.status)) {
                            active.push({ thread, reason: 'app-server' });
                            continue;
                        }
                        const activity = this.getCombinedRecentActivity(thread.codexThreadId, windowMs);
                        if (activity.active) {
                            active.push({ thread, reason: 'activity', mtimeMs: activity.mtimeMs });
                        }
                    }
                    const visible = active.slice(0, limit);
                    this.lastCodexListByChat.set(update.chatId, visible.map((item) => item.thread));
                    this.lastCodexListAtMsByChat.set(update.chatId, Date.now());
                    if (visible.length === 0) {
                        await this.sendText(update.chatId, 'No running threads detected (app-server + recent session activity).');
                        break;
                    }
                    const lines = [
                        `Running Threads (${visible.length})`,
                        ...visible.map((item, index) => {
                            const suffix = item.reason === 'activity' && item.mtimeMs
                                ? ` | active_recent_io ${Math.round((Date.now() - item.mtimeMs) / 1000)}s ago`
                                : ` | active_via_${item.reason}`;
                            return `${index + 1}. ${item.thread.codexThreadId.slice(0, 12)} | ${this.compactName(item.thread.threadName ?? '(unnamed)')} | ${item.thread.status} | ${this.compactPath(item.thread.cwd)}${suffix}`;
                        }),
                        '',
                        'Tip: /pick <index from this list> then /last to verify sync.',
                    ];
                    await this.sendText(update.chatId, lines.join('\n'));
                    break;
                }
                case '/projects': {
                    const projects = this.sessionRegistry.listProjects();
                    this.lastProjectListByChat.set(update.chatId, projects);
                    await this.sendText(update.chatId, this.renderProjectsText(projects));
                    break;
                }
                case '/new': {
                    const { projectRef, message } = this.parseNewArgs(args);
                    const project = this.resolveProjectRef(projectRef, update.chatId);
                    const threadName = message ? this.compactName(message) : `Telegram ${new Date().toISOString()}`;
                    const created = await this.codexBridge.createThread({
                        projectId: project.id,
                        cwd: project.rootPath,
                        threadName,
                        model: project.defaultModel,
                        effort: project.defaultEffort,
                    });
                    this.selectedCodexThreadByChat.set(update.chatId, created.codexThreadId);
                    this.sessionRegistry.setOperatorFocusThread(created.threadId);
                    const lines = [
                        'Thread created',
                        `Project: ${project.name}`,
                        `Codex ID: ${created.codexThreadId}`,
                        `Path: ${this.compactPath(project.rootPath)}`,
                    ];
                    if (message) {
                        const started = await this.codexBridge.startTurn(created.threadId, message);
                        lines.push(`Turn started: ${started.turnId}`);
                        lines.push('Use /say <change> while running.');
                    }
                    else {
                        lines.push('Use /run <task> to start work.');
                    }
                    await this.sendText(update.chatId, lines.join('\n'));
                    break;
                }
                case '/resume': {
                    const { codexThread, message } = await this.resolveThreadAndMessageForResume(args, update.chatId);
                    const mapped = this.ensureMappedThread(codexThread);
                    await this.codexBridge.resumeThread(mapped.id);
                    this.selectedCodexThreadByChat.set(update.chatId, codexThread.codexThreadId);
                    this.sessionRegistry.setOperatorFocusThread(mapped.id);
                    const lines = [
                        'Thread resumed',
                        `Thread: ${this.compactName(codexThread.threadName ?? codexThread.codexThreadId)}`,
                        `Codex ID: ${codexThread.codexThreadId}`,
                        `Path: ${this.compactPath(codexThread.cwd)}`,
                    ];
                    if (message) {
                        const started = await this.codexBridge.startTurn(mapped.id, message);
                        lines.push(`Turn started: ${started.turnId}`);
                        lines.push('Use /say <change> while running.');
                    }
                    else {
                        lines.push('Use /run <task> or /say <change request>.');
                    }
                    await this.sendText(update.chatId, lines.join('\n'));
                    break;
                }
                case '/project-rename':
                case '/git-review':
                case '/git-commit':
                case '/git-push': {
                    await this.sendText(update.chatId, 'This connector is Codex-thread-first. Use: /threads, /pick, /run, /say, /interrupt, /attach, /artifact, /status.');
                    break;
                }
                default: {
                    await this.sendText(update.chatId, `Unknown command ${command}. Use /help`);
                }
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn('telegram-command-failed', { message, update });
            try {
                await this.sendText(update.chatId, `Command failed: ${message}`);
            }
            catch (sendError) {
                this.logger.warn('telegram-command-failure-notification-failed', {
                    message: sendError instanceof Error ? sendError.message : String(sendError),
                });
            }
        }
    }
    shouldRouteRunAsSteer(codexThread: CodexThread, threadId: string): boolean {
        const activeStatuses: ThreadStatus[] = ['running', 'waiting_approval', 'waiting_operator'];
        const localThread = this.sessionRegistry.findThreadById(threadId);
        return activeStatuses.includes(codexThread.status)
            || Boolean(localThread?.activeTurnId)
            || (localThread ? activeStatuses.includes(localThread.status) : false);
    }
    async resolveThreadAndMessageForRun(args: string[], chatId: string): Promise<{ codexThread: CodexThread; message: string; skills?: CodexSkillRef[] }> {
        if (args.length === 0) {
            throw new Error('Usage: /run <threadRef> <task> OR /run <task> after /pick');
        }
        const modifiers = this.extractRunModifiers(args);
        args = modifiers.args;
        const override = this.extractThreadOverride(args);
        if (override) {
            if (override.args.length === 0) {
                throw new Error('Usage: /run --thread=<threadRef> <task>');
            }
            const codexThread = await this.resolveCodexThreadRef(override.threadRef, chatId);
            const mapped = this.ensureMappedThread(codexThread);
            return {
                codexThread,
                message: override.args.join(' ').trim(),
                skills: await this.resolveSkillsForThread(mapped.id, modifiers.skillNames),
            };
        }
        if (args.length === 1) {
            const selected = this.selectedCodexThreadByChat.get(chatId);
            if (!selected) {
                throw new Error('No selected thread. Use /pick <threadRef> first.');
            }
            const codexThread = await this.resolveCodexThreadRef(selected, chatId);
            const mapped = this.ensureMappedThread(codexThread);
            return {
                codexThread,
                message: args[0] ?? '',
                skills: await this.resolveSkillsForThread(mapped.id, modifiers.skillNames),
            };
        }
        const first = args[0] ?? '';
        const rest = args.slice(1).join(' ').trim();
        const selected = this.selectedCodexThreadByChat.get(chatId);
        // Use the selected thread unless the first token is clearly a thread ref.
        if (selected && !this.looksLikeExplicitThreadRef(first)) {
            const codexThread = await this.resolveCodexThreadRef(selected, chatId);
            const mapped = this.ensureMappedThread(codexThread);
            return {
                codexThread,
                message: args.join(' ').trim(),
                skills: await this.resolveSkillsForThread(mapped.id, modifiers.skillNames),
            };
        }
        try {
            const codexThread = await this.resolveCodexThreadRef(first, chatId);
            if (!rest) {
                throw new Error('Usage: /run <threadRef> <task>');
            }
            const mapped = this.ensureMappedThread(codexThread);
            return { codexThread, message: rest, skills: await this.resolveSkillsForThread(mapped.id, modifiers.skillNames) };
        }
        catch {
            if (!selected) {
                throw new Error('Could not resolve thread ref. Use /pick <threadRef> then /run <task>.');
            }
            const codexThread = await this.resolveCodexThreadRef(selected, chatId);
            const mapped = this.ensureMappedThread(codexThread);
            return {
                codexThread,
                message: args.join(' ').trim(),
                skills: await this.resolveSkillsForThread(mapped.id, modifiers.skillNames),
            };
        }
    }
    async resolveThreadAndMessageForSay(args: string[], chatId: string): Promise<{ codexThread: CodexThread; message: string }> {
        if (args.length === 0) {
            throw new Error('Usage: /say <threadRef> <message> OR /say <message> after /pick');
        }
        if (args.length === 1) {
            return {
                codexThread: await this.resolveSelectedCodexThread(chatId),
                message: args[0] ?? '',
            };
        }
        const first = args[0] ?? '';
        const rest = args.slice(1).join(' ').trim();
        const selected = this.selectedCodexThreadByChat.get(chatId);
        if (selected && !this.looksLikeExplicitThreadRef(first)) {
            return {
                codexThread: await this.resolveCodexThreadRef(selected, chatId),
                message: args.join(' ').trim(),
            };
        }
        try {
            const codexThread = await this.resolveCodexThreadRef(first, chatId);
            if (!rest) {
                throw new Error('Usage: /say <threadRef> <message>');
            }
            return { codexThread, message: rest };
        }
        catch {
            return {
                codexThread: await this.resolveSelectedCodexThread(chatId),
                message: args.join(' ').trim(),
            };
        }
    }
    async resolveThreadAndMessageForResume(args: string[], chatId: string): Promise<{ codexThread: CodexThread; message?: string }> {
        if (args.length === 0) {
            return { codexThread: await this.resolveSelectedCodexThread(chatId) };
        }
        const first = args[0] ?? '';
        if (!this.looksLikeExplicitThreadRef(first)) {
            const selected = this.selectedCodexThreadByChat.get(chatId);
            if (!selected) {
                throw new Error('Usage: /resume <threadRef> [task] OR /resume after /pick');
            }
            return {
                codexThread: await this.resolveCodexThreadRef(selected, chatId),
                message: args.join(' ').trim(),
            };
        }
        const codexThread = await this.resolveCodexThreadRef(first, chatId);
        const message = args.slice(1).join(' ').trim();
        return { codexThread, message: message || undefined };
    }
    parseNewArgs(args: string[]): { projectRef: string; message?: string } {
        if (args.length === 0) {
            throw new Error('Usage: /new <projectRef from /projects> [task]');
        }
        const projectRef = args[0] ?? '';
        const message = args.slice(1).join(' ').trim();
        return { projectRef, message: message || undefined };
    }
    resolveProjectRef(ref: string, chatId: string): ReturnType<RccRepository['listProjects']>[number] {
        const normalized = ref.trim();
        if (!normalized) {
            throw new Error('Project reference cannot be empty');
        }
        const fromLastList = this.lastProjectListByChat.get(chatId) ?? [];
        const projects = this.sessionRegistry.listProjects();
        if (/^\d+$/.test(normalized)) {
            const list = fromLastList.length > 0 ? fromLastList : projects;
            const index = Number(normalized) - 1;
            const project = list[index];
            if (!project) {
                throw new Error(`Unknown project index ${normalized}. Run /projects first.`);
            }
            return project;
        }
        const lower = normalized.toLowerCase();
        const exactMatches = projects.filter((project) => project.id === normalized || project.name.toLowerCase() === lower);
        if (exactMatches.length === 1) {
            return exactMatches[0]!;
        }
        if (exactMatches.length > 1) {
            throw new Error(`Ambiguous project reference "${normalized}". Use project id.`);
        }
        const prefixMatches = projects.filter((project) => project.id.startsWith(normalized) || project.name.toLowerCase().startsWith(lower));
        if (prefixMatches.length === 1) {
            return prefixMatches[0]!;
        }
        if (prefixMatches.length > 1) {
            throw new Error(`Ambiguous project reference "${normalized}". Use a longer id or name prefix.`);
        }
        throw new Error(`Unknown project "${normalized}". Run /projects.`);
    }
    async resolveSelectedCodexThread(chatId: string): Promise<CodexThread> {
        const selected = this.selectedCodexThreadByChat.get(chatId);
        if (!selected) {
            throw new Error('No selected thread. Use /pick <threadRef> first.');
        }
        return this.resolveCodexThreadRef(selected, chatId);
    }
    extractThreadOverride(args: string[]): { threadRef: string; args: string[] } | undefined {
        const threadArg = args.find((arg) => arg.startsWith('--thread='));
        if (!threadArg) {
            return undefined;
        }
        const threadRef = threadArg.slice('--thread='.length).trim();
        if (!threadRef) {
            throw new Error('Thread override cannot be empty.');
        }
        return {
            threadRef,
            args: args.filter((arg) => arg !== threadArg),
        };
    }
    extractRunModifiers(args: string[]): { args: string[]; skillNames: string[] } {
        const remaining: string[] = [];
        const skillNames: string[] = [];
        for (let index = 0; index < args.length; index += 1) {
            const arg = args[index] ?? '';
            if (arg.startsWith('--skill=')) {
                const skillName = arg.slice('--skill='.length).trim();
                if (!skillName) {
                    throw new Error('Skill flag cannot be empty.');
                }
                skillNames.push(skillName);
                continue;
            }
            if (arg === '--skill') {
                const skillName = args[index + 1]?.trim();
                if (!skillName) {
                    throw new Error('Usage: /run --skill <skillName> <task>');
                }
                skillNames.push(skillName);
                index += 1;
                continue;
            }
            remaining.push(arg);
        }
        return { args: remaining, skillNames };
    }
    requireMode(raw: string): CodexThreadMode {
        const mode = raw.trim().toLowerCase();
        if (mode !== 'plan' && mode !== 'build') {
            throw new Error('Mode must be one of: plan, build');
        }
        return mode;
    }
    async resolveSkillsForThread(threadId: string, skillNames: string[]): Promise<CodexSkillRef[] | undefined> {
        if (skillNames.length === 0) {
            return undefined;
        }
        const skills: CodexSkillRef[] = [];
        for (const skillName of skillNames) {
            skills.push(await this.resolveSkillForThread(threadId, skillName));
        }
        return skills;
    }
    async resolveSkillForThread(threadId: string, skillName: string): Promise<CodexSkillRef> {
        const available = await this.codexBridge.listSkillsForThread(threadId);
        const normalized = skillName.trim();
        const lower = normalized.toLowerCase();
        const exact = available.find((skill) => skill.name === normalized || skill.name.toLowerCase() === lower);
        if (exact) {
            return exact;
        }
        const prefixMatches = available.filter((skill) => skill.name.toLowerCase().startsWith(lower));
        if (prefixMatches.length === 1) {
            return prefixMatches[0]!;
        }
        if (prefixMatches.length > 1) {
            throw new Error(`Ambiguous skill "${normalized}". Use the full skill name.`);
        }
        throw new Error(`Unknown skill "${normalized}". Run /skills for the App Server-provided skill list.`);
    }
    async resolveCodexThreadRef(ref: string, chatId: string): Promise<CodexThread> {
        const normalized = ref.trim();
        if (!normalized) {
            throw new Error('Thread reference cannot be empty');
        }
        const fromLastList = this.lastCodexListByChat.get(chatId) ?? [];
        const lastAtMs = this.lastCodexListAtMsByChat.get(chatId) ?? 0;
        const lastFresh = fromLastList.length > 0 && Date.now() - lastAtMs < 10 * 60_000;
        const fromLive = await this.listSortedCodexThreads();
        // A numeric ref is an index into the last /threads or /running list, which is valid for 10 minutes.
        if (/^\d+$/.test(normalized)) {
            if (fromLastList.length > 0 && !lastFresh) {
                throw new Error('Thread list is stale. Run /threads again, then /pick <index>.');
            }
            const threads = lastFresh && fromLastList.length > 0 ? fromLastList : fromLive;
            const index = Number(normalized) - 1;
            if (index < 0 || index >= threads.length) {
                throw new Error(`Unknown thread index ${normalized}`);
            }
            const thread = threads[index];
            if (!thread) {
                throw new Error(`Unknown thread index ${normalized}`);
            }
            return thread;
        }
        const lower = normalized.toLowerCase();
        const exactMatches = fromLive.filter((thread) => thread.codexThreadId === normalized || (thread.threadName ? thread.threadName.toLowerCase() === lower : false));
        if (exactMatches.length === 1) {
            const match = exactMatches[0];
            if (!match) {
                throw new Error(`Unknown thread ${normalized}`);
            }
            return match;
        }
        if (exactMatches.length > 1) {
            throw new Error(`Ambiguous thread reference "${normalized}". Use id.`);
        }
        const prefixMatches = fromLive.filter((thread) => thread.codexThreadId.startsWith(normalized) ||
            (thread.threadName ? thread.threadName.toLowerCase().startsWith(lower) : false));
        if (prefixMatches.length === 1) {
            const match = prefixMatches[0];
            if (!match) {
                throw new Error(`Unknown thread ${normalized}`);
            }
            return match;
        }
        if (prefixMatches.length > 1) {
            throw new Error(`Ambiguous thread reference "${normalized}". Use longer id prefix.`);
        }
        throw new Error(`Unknown thread "${normalized}"`);
    }
    parseArtifactAction(args: string[]): { mode: 'list'; threadRef?: string } | { mode: 'send'; threadRef?: string; selection: number | 'all' } {
        if (args.length === 0) {
            return { mode: 'list' };
        }
        const sendIndex = args.findIndex((arg) => arg === 'send');
        if (sendIndex === -1) {
            return { mode: 'list', threadRef: args[0] };
        }
        const threadRef = sendIndex === 1 ? args[0] : undefined;
        const selectionRaw = args[sendIndex + 1];
        if (!selectionRaw) {
            throw new Error('Usage: /artifact [threadRef] send <index|all>');
        }
        if (selectionRaw === 'all') {
            return { mode: 'send', threadRef, selection: 'all' };
        }
        const selection = Number(selectionRaw);
        if (!Number.isInteger(selection) || selection < 1) {
            throw new Error('Artifact selection must be a positive index or "all".');
        }
        return { mode: 'send', threadRef, selection };
    }
    resolveArtifactSelection(selection: number, artifacts: ArtifactRecord[]): ArtifactRecord {
        const artifact = artifacts[selection - 1];
        if (!artifact) {
            throw new Error(`Unknown artifact index ${selection}`);
        }
        return artifact;
    }
    ensureMappedThread(codexThread: CodexThread): { id: string } {
        const record = this.sessionRegistry.ensureThreadForCodexThread({
            codexThreadId: codexThread.codexThreadId,
            cwd: codexThread.cwd,
            threadName: codexThread.threadName,
            status: codexThread.status,
        });
        return { id: record.id };
    }
    async syncCodexThreads() {
        const beforeProjects = this.sessionRegistry.listProjects().length;
        const beforeThreads = this.sessionRegistry.listThreads().length;
        const codexThreads = await this.listSortedCodexThreads();
        let imported = 0;
        let alreadyMapped = 0;
        for (const codexThread of codexThreads) {
            const existing = this.sessionRegistry.findThreadByCodexThreadId(codexThread.codexThreadId);
            if (existing) {
                alreadyMapped += 1;
                continue;
            }
            imported += 1;
            this.ensureMappedThread(codexThread);
        }
        const afterProjects = this.sessionRegistry.listProjects().length;
        const afterThreads = this.sessionRegistry.listThreads().length;
        return [
            'Codex sync complete',
            `Codex threads discovered: ${codexThreads.length}`,
            `Projects added: ${Math.max(0, afterProjects - beforeProjects)}`,
            `Threads imported: ${imported}`,
            `Threads already mapped: ${alreadyMapped}`,
            `RCC thread registry size: ${afterThreads}`,
            '',
            'Next: /threads and /running',
        ].join('\n');
    }
    async refreshRegistryFromLiveCodex() {
        const codexThreads = await this.listSortedCodexThreads();
        for (const codexThread of codexThreads) {
            const existing = this.sessionRegistry.findThreadByCodexThreadId(codexThread.codexThreadId);
            if (!existing) {
                this.ensureMappedThread(codexThread);
                continue;
            }
            // thread/list status can lag behind active turns. Codex may report a running turn as idle,
            // so listThreads is used for discovery only. Status changes come from turn lifecycle events.
        }
        return codexThreads;
    }
    nextProjectId(baseName: string): string {
        const base = `auto_${this.slugify(baseName)}`;
        const existing = new Set(this.sessionRegistry.listProjects().map((project) => project.id));
        if (!existing.has(base)) {
            return base;
        }
        let suffix = 2;
        while (existing.has(`${base}_${suffix}`)) {
            suffix += 1;
        }
        return `${base}_${suffix}`;
    }
    nextProjectName(baseName: string): string {
        const normalized = baseName.trim() || 'project';
        const existing = new Set(this.sessionRegistry.listProjects().map((project) => project.name.toLowerCase()));
        if (!existing.has(normalized.toLowerCase())) {
            return normalized;
        }
        let suffix = 2;
        while (existing.has(`${normalized}-${suffix}`.toLowerCase())) {
            suffix += 1;
        }
        return `${normalized}-${suffix}`;
    }
    slugify(value: string): string {
        const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        return slug || 'project';
    }
    canonicalPath(rawPath: string): string {
        const resolved = path.resolve(rawPath);
        try {
            return fs.realpathSync.native(resolved);
        }
        catch {
            return resolved;
        }
    }
    compactName(name: string): string {
        if (name.length <= 64) {
            return name;
        }
        return `${name.slice(0, 61)}...`;
    }
    compactPath(projectRoot: string): string {
        const normalized = path.normalize(projectRoot);
        const home = process.env.HOME;
        const display = home && normalized.startsWith(home) ? `~${normalized.slice(home.length)}` : normalized;
        const parts = display.split(path.sep).filter(Boolean);
        if (parts.length <= 4) {
            return display;
        }
        return `...${path.sep}${parts.slice(-4).join(path.sep)}`;
    }
    formatAge(msAgo: number): string {
        const seconds = Math.max(0, Math.round(msAgo / 1000));
        if (seconds < 60) {
            return `${seconds}s`;
        }
        const minutes = Math.round(seconds / 60);
        if (minutes < 60) {
            return `${minutes}m`;
        }
        const hours = Math.round(minutes / 60);
        if (hours < 48) {
            return `${hours}h`;
        }
        const days = Math.round(hours / 24);
        return `${days}d`;
    }
    async listSortedCodexThreads(): Promise<CodexThread[]> {
        const threads = this.dedupeCodexThreads(await this.codexBridge.listCodexThreads()).map((thread) => {
            const mapped = this.sessionRegistry.findThreadByCodexThreadId(thread.codexThreadId);
            return {
                ...thread,
                status: this.overlayThreadStatus(thread.status, mapped?.status),
            };
        });
        const decorated = threads.map((thread) => {
            const activity = this.getCombinedRecentActivity(thread.codexThreadId, 14 * 24 * 60 * 60 * 1000);
            const isRunning = ['running', 'waiting_approval', 'waiting_operator'].includes(thread.status);
            return {
                thread,
                isRunning,
                activityMs: activity.mtimeMs ?? 0,
                hasActivity: activity.active || Boolean(activity.mtimeMs),
            };
        });
        decorated.sort((a, b) => {
            if (a.isRunning !== b.isRunning) {
                return a.isRunning ? -1 : 1;
            }
            if (a.activityMs !== b.activityMs) {
                return b.activityMs - a.activityMs;
            }
            if (a.hasActivity !== b.hasActivity) {
                return a.hasActivity ? -1 : 1;
            }
            return a.thread.codexThreadId.localeCompare(b.thread.codexThreadId);
        });
        return decorated.map((item) => item.thread);
    }
    renderCodexThreadsText(codexThreads: CodexThread[], totalCount: number, chatId: string): string {
        if (codexThreads.length === 0) {
            return 'No Codex threads found.';
        }
        const selected = this.selectedCodexThreadByChat.get(chatId);
        return [
            `Codex Threads (${codexThreads.length}/${totalCount})`,
            ...codexThreads.map((thread, index) => {
                const marker = selected === thread.codexThreadId ? '*' : ' ';
                const activity = this.getCombinedRecentActivity(thread.codexThreadId, 90 * 24 * 60 * 60 * 1000);
                const age = activity.mtimeMs ? this.formatAge(Date.now() - activity.mtimeMs) : undefined;
                const suffix = age && thread.status === 'idle' ? ` | last_run ${age} ago` : age ? ` | last ${age} ago` : '';
                return `${marker}${index + 1}. ${thread.codexThreadId.slice(0, 12)} | ${this.compactName(thread.threadName ?? '(unnamed)')} | ${thread.status}${suffix} | ${this.compactPath(thread.cwd)}`;
            }),
            '',
            'Use /pick <index|id> to set default thread.',
            'Then /run <task> and /say <change>.',
            'Use full id prefix if names collide.',
        ].join('\n');
    }
    overlayThreadStatus(liveStatus: ThreadStatus, mappedStatus?: ThreadStatus): ThreadStatus {
        if (!mappedStatus) {
            return liveStatus;
        }
        if (['waiting_approval', 'waiting_operator', 'running'].includes(mappedStatus)) {
            return mappedStatus;
        }
        if (liveStatus === 'idle' && mappedStatus === 'failed') {
            return mappedStatus;
        }
        return liveStatus;
    }
    getCombinedRecentActivity(codexThreadId: string, windowMs: number): { active: boolean; mtimeMs?: number } {
        const session = this.codexSessions.isRecentlyActive(codexThreadId, windowMs);
        const desktop = this.desktopStateMonitor?.getRecentActivity(codexThreadId, windowMs);
        const desktopUpdatedMs = this.desktopStateMonitor?.getThreadUpdatedAtMs(codexThreadId);
        const sessionMs = session.mtimeMs ?? 0;
        const desktopMs = desktop?.mtimeMs ?? 0;
        const mtimeMs = Math.max(sessionMs, desktopMs, desktopUpdatedMs ?? 0) || undefined;
        return {
            active: Boolean(session.active || desktop?.active),
            mtimeMs,
        };
    }
    renderMappedThreadsText(limit: number, runningOnly = false): string {
        const threads = this.sessionRegistry
            .listThreads()
            .filter((thread) => runningOnly ? ['running', 'waiting_approval', 'waiting_operator'].includes(thread.status) : true)
            .slice(0, limit);
        if (threads.length === 0) {
            return runningOnly ? 'No running RCC threads.' : 'No RCC threads mapped yet. Use /sync_codex first.';
        }
        return [
            runningOnly ? `Running RCC Threads (${threads.length})` : `RCC Threads (${threads.length})`,
            ...threads.map((thread, index) => {
                const project = this.sessionRegistry.getProjectById(thread.projectId);
                const projectName = project?.name ?? thread.projectId;
                return `${index + 1}. ${thread.codexThreadId.slice(0, 12)} | ${this.compactName(thread.threadName ?? '(unnamed)')} | ${thread.status} | project=${projectName}`;
            }),
            '',
            'Use /codex to browse live Codex threads.',
            'Use /pick <index|id from /codex> to select one for /run or /say.',
        ].join('\n');
    }
    renderProjectsText(projects = this.sessionRegistry.listProjects()): string {
        if (projects.length === 0) {
            return 'No RCC projects registered.';
        }
        return [
            `Projects (${projects.length})`,
            ...projects.map((project, index) => `${index + 1}. ${project.name} | ${this.compactPath(project.rootPath)}`),
        ].join('\n');
    }
    renderArtifactListText(codexThread: CodexThread, artifacts: ArtifactRecord[]): string {
        if (artifacts.length === 0) {
            return [
                `Artifacts for ${this.compactName(codexThread.threadName ?? codexThread.codexThreadId)}`,
                'No files are auto-sent. No pending artifacts detected.',
                'RCC only scans its artifacts directory by default.',
                'Tip: have Codex write outputs into .dist/artifacts/<threadId>/ to make /artifact useful.',
            ].join('\n');
        }
        return [
            `Artifacts for ${this.compactName(codexThread.threadName ?? codexThread.codexThreadId)}`,
            ...artifacts.map((artifact, index) => `${index + 1}. ${path.basename(artifact.localPath)} | ${artifact.artifactType} | ${artifact.sizeBytes ?? 0} bytes`),
            '',
            'No files are auto-sent.',
            'Use /artifact send <index|all> to send them.',
        ].join('\n');
    }
    renderApprovalsText(): string {
        const pending = this.repository.listPendingApprovals();
        if (pending.length === 0) {
            return 'Approvals\nNo pending approvals.\n\nUse /running to check active threads.';
        }

        const groups = new Map<string, ApprovalRecord[]>();
        for (const approval of pending) {
            const thread = this.sessionRegistry.findThreadById(approval.threadId);
            const project = thread ? this.sessionRegistry.getProjectById(thread.projectId) : undefined;
            const key = `${project?.name ?? 'unknown'}\u0000${thread?.threadName ?? thread?.codexThreadId ?? approval.threadId}`;
            const list = groups.get(key) ?? [];
            list.push(approval);
            groups.set(key, list);
        }

        const lines = ['Approvals', `Pending actionable: ${pending.length}`];
        let itemIndex = 1;
        for (const approvals of groups.values()) {
            const first = approvals[0];
            if (!first) {
                continue;
            }
            const thread = this.sessionRegistry.findThreadById(first.threadId);
            const project = thread ? this.sessionRegistry.getProjectById(thread.projectId) : undefined;
            lines.push('', `${project?.name ?? 'unknown'} / ${thread?.threadName ?? thread?.codexThreadId ?? first.threadId}`);
            for (const approval of approvals) {
                const age = this.formatAge(Date.now() - Date.parse(approval.createdAt));
                const expiry = approval.expiresAt ? this.formatExpiry(approval.expiresAt) : 'expiry n/a';
                lines.push(
                    `${itemIndex}. ${approval.id}`,
                    `   turn: ${approval.turnId ?? 'n/a'} | action: ${approval.actionType} | risk: ${this.approvalRiskLabel(approval)}`,
                    `   age: ${age} | ${expiry}`,
                    `   ${this.compactName(approval.summary)}`,
                    `   actions: /approve ${approval.id} | /deny ${approval.id} | /interrupt ${thread?.codexThreadId ?? approval.threadId}`,
                );
                itemIndex += 1;
            }
        }
        lines.push('', 'Superseded/expired approvals are hidden here and rejected if tapped from old cards.');
        return lines.join('\n');
    }
    renderSkillsText(codexThread: CodexThread, active: CodexSkillRef[], available: CodexSkillRef[]): string {
        return [
            `Skills for ${this.compactName(codexThread.threadName ?? codexThread.codexThreadId)}`,
            `Active: ${this.renderSkillNames(active)}`,
            '',
            available.length === 0 ? 'Available: none reported by App Server.' : `Available (${available.length}):`,
            ...available.slice(0, 30).map((skill, index) => `${index + 1}. ${skill.name}${skill.enabled === false ? ' (disabled)' : ''}${skill.description ? ` - ${this.compactName(skill.description)}` : ''}`),
            '',
            'Use /skill add <skillName>, /skill clear, or /run --skill <skillName> <task>.',
        ].join('\n');
    }
    renderSkillNames(active: CodexSkillRef[], transient: CodexSkillRef[] = []): string {
        const names = [...active, ...transient].map((skill) => skill.name);
        return names.length > 0 ? [...new Set(names)].join(', ') : 'none';
    }
    renderReasoningSummaryText(codexThread: CodexThread, summaries: ReasoningSummaryRecord[]): string {
        const lines = [
            'Reasoning Summary for selected thread:',
            'This is an App Server-exposed summary, not raw hidden reasoning.',
            '',
            `Thread: ${this.compactName(codexThread.threadName ?? codexThread.codexThreadId)}`,
            `Codex ID: ${codexThread.codexThreadId}`,
            '',
        ];
        if (summaries.length === 0) {
            lines.push('No Reasoning Summary observed yet for this thread.');
            lines.push('If Codex/App Server does not emit reasoning summary events, RCC will not fabricate one.');
            return lines.join('\n');
        }
        lines.push(...summaries
            .slice()
            .reverse()
            .map((summary, index) => [
                `${index + 1}. ${summary.occurredAt}`,
                summary.method ? `Source event: ${summary.method}` : 'Source event: app_server',
                summary.text,
            ].join('\n')));
        return lines.join('\n\n');
    }
    formatExpiry(expiresAt: string): string {
        const ms = Date.parse(expiresAt);
        if (!Number.isFinite(ms)) {
            return 'expiry unknown';
        }
        const delta = ms - Date.now();
        if (delta <= 0) {
            return `expired ${this.formatAge(Math.abs(delta))} ago`;
        }
        return `expires in ${this.formatAge(delta)}`;
    }
    approvalRiskLabel(approval: ApprovalRecord): ApprovalRisk {
        // Same classifier as the approval detail view, so both show one risk level.
        return buildApprovalDetails(approval).risk;
    }
    helpText(): string {
        return [
            'RCC Codex Connector',
            '/threads [n|limit[n]] (Codex threads)',
            '/running [n|limit[n]]',
            '/projects',
            '/new <projectRef> [task]',
            '/resume [threadRef] [task]',
            '/pick <threadRef>',
            '/where',
            '/last [n] (show last command + output)',
            '/thinking [n] (Reasoning Summary, not raw hidden reasoning)',
            '/approvals (pending approvals)',
            '/run <threadRef> <task>  or  /run <task> after /pick',
            '/run --skill <skillName> <task>',
            '/plan <task> (planning-only turn)',
            '/say <threadRef> <change>  or  /say <change> after /pick',
            '/interrupt [threadRef]',
            '/mode [threadRef] <plan|build>',
            '/skills [threadRef]',
            '/skill add <skillName> or /skill clear',
            '/model <model> or /model <threadRef> <model>',
            '/effort <low|medium|high> or /effort <threadRef> <low|medium|high>',
            '/approval_demo',
            '/attach [threadRef] (file in same message)',
            '/artifact [threadRef]',
            '/approve <approvalId>',
            '/deny <approvalId>',
            '/status',
            '',
            'Thread refs for /pick come from the latest /threads or /running list.',
            'Live output streams only for the picked thread; other threads send alerts only.',
        ].join('\n');
    }
    extractCommand(update: TelegramUpdate): { command: string | undefined; args: string[] } {
        if (update.command) {
            return { command: update.command, args: update.args ?? [] };
        }
        const rawText = update.text?.trim();
        if (!rawText || !rawText.startsWith('/')) {
            return { command: undefined, args: [] };
        }
        const normalizedText = rawText.replace(/^\/\s+/, '/');
        const match = normalizedText.match(/^\/([^\s@[]+)(?:\[(\d+)])?(?:@(\S+))?(?:\s+(.+))?$/);
        if (!match) {
            return { command: undefined, args: [] };
        }
        const commandName = match[1];
        const bracketArg = match[2];
        const tail = match[4];
        const command = commandName ? `/${commandName}` : undefined;
        const args = tail ? tail.trim().split(/\s+/) : [];
        if (bracketArg) {
            args.unshift(bracketArg);
        }
        return { command, args };
    }
    parseListLimit(args: string[]): number {
        const raw = (args[0] ?? '').trim();
        if (!raw) {
            return DEFAULT_CODEX_LIST_LIMIT;
        }
        const direct = raw.match(/^(\d+)$/);
        if (direct?.[1]) {
            return Math.max(1, Math.min(100, Number(direct[1])));
        }
        const wrapped = raw.match(/^(?:limit|recent)\[(\d+)\]$/i);
        if (wrapped?.[1]) {
            return Math.max(1, Math.min(100, Number(wrapped[1])));
        }
        const bracketOnly = raw.match(/^\[(\d+)\]$/);
        if (bracketOnly?.[1]) {
            return Math.max(1, Math.min(100, Number(bracketOnly[1])));
        }
        const kv = raw.match(/^(?:limit|recent)=(\d+)$/i);
        if (kv?.[1]) {
            return Math.max(1, Math.min(100, Number(kv[1])));
        }
        return DEFAULT_CODEX_LIST_LIMIT;
    }
    looksLikeExplicitThreadRef(token: string): boolean {
        const value = token.trim();
        if (!value) {
            return false;
        }
        if (/^\d+$/.test(value)) {
            return true;
        }
        // Codex thread IDs and their prefixes use hex digits and hyphens.
        if (/^[0-9a-f-]{6,}$/i.test(value)) {
            return true;
        }
        return false;
    }
    dedupeCodexThreads(threads: CodexThread[]): CodexThread[] {
        const seen = new Set();
        const deduped = [];
        for (const thread of threads) {
            if (seen.has(thread.codexThreadId)) {
                continue;
            }
            seen.add(thread.codexThreadId);
            deduped.push(thread);
        }
        return deduped;
    }
    async sendText(chatId: string, text: string): Promise<void> {
        const chunks = this.chunkText(text, TELEGRAM_TEXT_LIMIT);
        for (const chunk of chunks) {
            await this.telegramClient.sendMessage(chatId, chunk);
        }
    }
    chunkText(text: string, maxChars: number): string[] {
        if (text.length <= maxChars) {
            return [text];
        }
        const lines = text.split('\n');
        const chunks = [];
        let current = '';
        for (const line of lines) {
            const candidate = current ? `${current}\n${line}` : line;
            if (candidate.length <= maxChars) {
                current = candidate;
                continue;
            }
            if (current) {
                chunks.push(current);
            }
            if (line.length <= maxChars) {
                current = line;
                continue;
            }
            let rest = line;
            while (rest.length > maxChars) {
                chunks.push(rest.slice(0, maxChars));
                rest = rest.slice(maxChars);
            }
            current = rest;
        }
        if (current) {
            chunks.push(current);
        }
        return chunks;
    }
}
