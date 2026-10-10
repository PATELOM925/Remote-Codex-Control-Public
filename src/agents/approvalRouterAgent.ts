import type {
  ApprovalAwaitingOperatorPayload,
  ApprovalExpiredPayload,
  ApprovalResolutionAckedPayload,
  ApprovalResolutionFailedPayload,
  ApprovalResolutionForwardedPayload,
  ApprovalSupersededPayload,
  RccEventEnvelope,
} from '../contracts/events.js';
import type { Logger } from '../logger.js';
import type { RccConfig } from '../config.js';
import type { TelegramClient } from '../contracts/telegram.js';
import type { EventJournal } from '../event-journal/eventJournal.js';
import type { RccEventBus } from '../runtime/eventBus.js';
import type { ApprovalRecord, RccRepository } from '../db/repositories.js';
import { newId } from '../utils/ids.js';
import {
  approvalRequestSource,
  buildApprovalDetails,
  formatApprovalDetailsForTelegram,
} from '../services/approvalDetails.js';

import { CodexBridgeAgent } from './codexBridgeAgent.js';
import { SessionRegistryAgent } from './sessionRegistryAgent.js';
import type { UiApprovalAutomationService } from '../services/uiApprovalAutomationService.js';

export class ApprovalRouterAgent {
  private readonly inFlightCallbacks = new Set<string>();

  constructor(
    private readonly telegramClient: TelegramClient,
    private readonly codexBridge: CodexBridgeAgent,
    private readonly sessionRegistry: SessionRegistryAgent,
    private readonly repository: RccRepository,
    private readonly journal: EventJournal,
    private readonly eventBus: RccEventBus,
    private readonly config: RccConfig,
    private readonly logger: Logger,
    private readonly uiApprovalAutomation?: UiApprovalAutomationService,
  ) {}

  registerEventSubscriptions(): void {
    this.eventBus.on('ApprovalAwaitingOperator', (event) => {
      void this.handleApprovalAwaiting(event as unknown as RccEventEnvelope<ApprovalAwaitingOperatorPayload>).catch((error) => {
        this.logger.warn('approval-awaiting-notification-failed', { message: this.errorMessage(error) });
      });
    });

    this.eventBus.on('ApprovalExpired', (event) => {
      const payload = event.payload as { approvalId: string; reason: string };
      void this.telegramClient.sendMessage(
        this.config.operatorChatId,
        `Approval expired\nApproval: ${payload.approvalId}\nReason: ${payload.reason}`,
      ).catch((error) => this.logger.warn('approval-expired-notification-failed', { message: this.errorMessage(error) }));
    });

    this.eventBus.on('ApprovalSuperseded', (event) => {
      const payload = event.payload as { approvalId: string; supersededByApprovalId: string };
      void this.telegramClient.sendMessage(
        this.config.operatorChatId,
        `Approval superseded\nOld: ${payload.approvalId}\nNew: ${payload.supersededByApprovalId}`,
      ).catch((error) => this.logger.warn('approval-superseded-notification-failed', { message: this.errorMessage(error) }));
    });

    this.eventBus.on('ApprovalResolutionAcked', (event) => {
      void this.handleResolutionAcked(event as unknown as RccEventEnvelope<ApprovalResolutionAckedPayload>).catch((error) => {
        this.logger.warn('approval-acked-notification-failed', { message: this.errorMessage(error) });
      });
    });
  }

  /**
   * Handles one Telegram approval callback. The caller must first check that
   * the chat is an allowed operator chat.
   */
  async resolveFromTelegramCallback(callbackData: string): Promise<void> {
    const idempotencyKey = `callback:${callbackData}`;
    // A second copy of a callback that is still running is refused, so a double tap cannot resolve twice.
    if (this.inFlightCallbacks.has(idempotencyKey)) {
      await this.telegramClient.sendMessage(this.config.operatorChatId, `Callback already being processed: ${callbackData}`);
      return;
    }

    this.inFlightCallbacks.add(idempotencyKey);
    try {
    if (this.journal.idempotencySeen('telegram', idempotencyKey)) {
      await this.telegramClient.sendMessage(this.config.operatorChatId, `Callback already processed: ${callbackData}`);
      return;
    }

    const [action, approvalId] = callbackData.split(':');
    if (!approvalId) {
      throw new Error('Invalid callback payload');
    }

    if (action === 'details') {
      const approval = this.repository.findApprovalById(approvalId);
      if (!approval) {
        throw new Error(`Unknown approval ${approvalId}`);
      }
      const thread = this.sessionRegistry.findThreadById(approval.threadId);
      const project = thread ? this.sessionRegistry.getProjectById(thread.projectId) : undefined;
      const details = buildApprovalDetails(approval, thread, project);
      await this.telegramClient.sendMessage(this.config.operatorChatId, formatApprovalDetailsForTelegram(details));
      this.journal.rememberIdempotency('telegram', idempotencyKey);
      return;
    }

    if (action === 'dismiss') {
      const approval = this.repository.findApprovalById(approvalId);
      if (!approval) {
        throw new Error(`Unknown approval ${approvalId}`);
      }
      // Dismiss only mutes repeat notifications. The approval stays pending.
      this.journal.rememberIdempotency('approval', `dismiss:${approvalId}`);
      await this.telegramClient.sendMessage(
        this.config.operatorChatId,
        [
          `Dismissed approval ${approvalId}.`,
          'It is still pending in Codex until you Approve/Deny it.',
          `Use /approve ${approvalId} or /deny ${approvalId} anytime.`,
        ].join('\n'),
      );
      this.journal.rememberIdempotency('telegram', idempotencyKey);
      return;
    }

    if (action === 'approve') {
      const approval = this.repository.findApprovalById(approvalId);
      if (!approval) {
        throw new Error(`Unknown approval ${approvalId}`);
      }
      // A card for a superseded request is stale. Refuse it, so the operator acts on the current request.
      if (approval.status === 'superseded') {
        this.journal.rememberIdempotency('telegram', idempotencyKey);
        const newer = this.repository.findSupersedingApprovalId(approvalId);
        await this.telegramClient.sendMessage(
          this.config.operatorChatId,
          `Request ${approvalId} was superseded${newer ? ` by ${newer}` : ''}. It cannot be approved from an old card. Use /approvals for current requests.`,
        );
        return;
      }
      if (approval.status === 'expired') {
        this.journal.rememberIdempotency('telegram', idempotencyKey);
        await this.telegramClient.sendMessage(this.config.operatorChatId, `Request ${approvalId} expired. Use /approvals for current requests.`);
        return;
      }
      if (this.expireApprovalIfDue(approval)) {
        this.journal.rememberIdempotency('telegram', idempotencyKey);
        await this.telegramClient.sendMessage(this.config.operatorChatId, `Request ${approvalId} expired. Use /approvals for current requests.`);
        return;
      }
      // Desktop-recovered approvals cannot be answered through the App Server, so they use the desktop fallback.
      if (approval.codexRequestId.startsWith('desktop:')) {
        await this.resolveDesktopRecoveredApproval(approvalId, 'approved');
        this.journal.rememberIdempotency('telegram', idempotencyKey);
        return;
      }
      if (approval.status === 'approved') {
        this.journal.rememberIdempotency('telegram', idempotencyKey);
        await this.telegramClient.sendMessage(this.config.operatorChatId, `Approved request ${approvalId} (already resolved)`);
        return;
      }
      if (approval.status !== 'pending') {
        this.journal.rememberIdempotency('telegram', idempotencyKey);
        await this.telegramClient.sendMessage(this.config.operatorChatId, `Request ${approvalId} already ${approval.status}`);
        return;
      }

      await this.resolveApproval(approvalId, 'approved');
      this.journal.rememberIdempotency('telegram', idempotencyKey);
      await this.telegramClient.sendMessage(this.config.operatorChatId, `Approved request ${approvalId}`);
      return;
    }

    if (action === 'deny') {
      const approval = this.repository.findApprovalById(approvalId);
      if (!approval) {
        throw new Error(`Unknown approval ${approvalId}`);
      }
      if (approval.status === 'superseded') {
        this.journal.rememberIdempotency('telegram', idempotencyKey);
        const newer = this.repository.findSupersedingApprovalId(approvalId);
        await this.telegramClient.sendMessage(
          this.config.operatorChatId,
          `Request ${approvalId} was superseded${newer ? ` by ${newer}` : ''}. It cannot be denied from an old card. Use /approvals for current requests.`,
        );
        return;
      }
      if (approval.status === 'expired') {
        this.journal.rememberIdempotency('telegram', idempotencyKey);
        await this.telegramClient.sendMessage(this.config.operatorChatId, `Request ${approvalId} expired. Use /approvals for current requests.`);
        return;
      }
      if (this.expireApprovalIfDue(approval)) {
        this.journal.rememberIdempotency('telegram', idempotencyKey);
        await this.telegramClient.sendMessage(this.config.operatorChatId, `Request ${approvalId} expired. Use /approvals for current requests.`);
        return;
      }
      if (approval.codexRequestId.startsWith('desktop:')) {
        await this.resolveDesktopRecoveredApproval(approvalId, 'denied');
        this.journal.rememberIdempotency('telegram', idempotencyKey);
        return;
      }
      if (approval.status === 'denied') {
        this.journal.rememberIdempotency('telegram', idempotencyKey);
        await this.telegramClient.sendMessage(this.config.operatorChatId, `Denied request ${approvalId} (already resolved)`);
        return;
      }
      if (approval.status !== 'pending') {
        this.journal.rememberIdempotency('telegram', idempotencyKey);
        await this.telegramClient.sendMessage(this.config.operatorChatId, `Request ${approvalId} already ${approval.status}`);
        return;
      }

      await this.resolveApproval(approvalId, 'denied');
      this.journal.rememberIdempotency('telegram', idempotencyKey);
      await this.telegramClient.sendMessage(this.config.operatorChatId, `Denied request ${approvalId}`);
      return;
    }

    if (action === 'interrupt') {
      const approval = this.repository.findApprovalById(approvalId);
      if (!approval) {
        throw new Error(`Unknown approval ${approvalId}`);
      }
      if (approval.status === 'superseded') {
        this.journal.rememberIdempotency('telegram', idempotencyKey);
        const newer = this.repository.findSupersedingApprovalId(approvalId);
        await this.telegramClient.sendMessage(
          this.config.operatorChatId,
          `Request ${approvalId} was superseded${newer ? ` by ${newer}` : ''}. It cannot interrupt from an old card. Use /approvals for current requests.`,
        );
        return;
      }
      if (approval.status === 'expired' || this.expireApprovalIfDue(approval)) {
        this.journal.rememberIdempotency('telegram', idempotencyKey);
        await this.telegramClient.sendMessage(this.config.operatorChatId, `Request ${approvalId} expired. Use /approvals for current requests.`);
        return;
      }
      if (approval.status !== 'pending') {
        this.journal.rememberIdempotency('telegram', idempotencyKey);
        await this.telegramClient.sendMessage(this.config.operatorChatId, `Request ${approvalId} already ${approval.status}`);
        return;
      }

      await this.codexBridge.interruptTurn(approval.threadId);
      this.journal.rememberIdempotency('telegram', idempotencyKey);
      await this.telegramClient.sendMessage(this.config.operatorChatId, `Interrupted thread for request ${approvalId}`);
      return;
    }

    throw new Error(`Unknown callback action ${action}`);
    } finally {
      this.inFlightCallbacks.delete(idempotencyKey);
    }
  }

  /**
   * Creates a demo approval that is resolved locally. It does not contact Codex.
   */
  triggerDemoApproval(input: { threadId: string; summary?: string; actionType?: string }): string {
    const thread = this.sessionRegistry.findThreadById(input.threadId);
    if (!thread) {
      throw new Error(`Unknown thread ${input.threadId}`);
    }

    const approvalId = newId();
    const codexRequestId = `demo:${approvalId}`;
    const summary = input.summary?.trim() || 'Demo approval card: confirm remote approval path.';
    const actionType = input.actionType?.trim() || 'other';

    this.repository.createApproval({
      id: approvalId,
      threadId: thread.id,
      codexRequestId,
      turnId: thread.activeTurnId,
      actionType,
      summary,
      status: 'pending',
    });

    const supersededIds = this.repository.supersedePendingApprovals(thread.id, approvalId, thread.activeTurnId);
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
        codexRequestId,
        threadId: thread.id,
        turnId: thread.activeTurnId,
        projectId: thread.projectId,
        actionType: 'other',
        summary,
        scope: 'once',
      },
      {
        projectId: thread.projectId,
        threadId: thread.id,
        turnId: thread.activeTurnId,
      },
    );
    this.publish(waitingEvent);
    return approvalId;
  }

  private async handleApprovalAwaiting(event: RccEventEnvelope<ApprovalAwaitingOperatorPayload>): Promise<void> {
    const payload = event.payload;
    const thread = this.sessionRegistry.findThreadById(payload.threadId);
    const project = this.sessionRegistry.getProjectById(payload.projectId);

    if (!thread || !project) {
      this.logger.warn('approval-awaiting-missing-context', {
        approvalId: payload.approvalId,
        threadId: payload.threadId,
        projectId: payload.projectId,
      });
      return;
    }

    if (this.journal.idempotencySeen('approval', `dismiss:${payload.approvalId}`)) {
      // The operator dismissed this card, so do not notify again.
      return;
    }
    if (this.journal.idempotencySeen('approval', `notified:${payload.approvalId}`)) {
      return;
    }

    const approval = this.repository.findApprovalById(payload.approvalId);
    const details = approval
      ? buildApprovalDetails(approval, thread, project)
      : buildApprovalDetails(
          {
            id: payload.approvalId,
            threadId: payload.threadId,
            codexRequestId: payload.codexRequestId,
            turnId: payload.turnId,
            actionType: payload.actionType,
            summary: payload.summary,
            status: 'pending',
            expiresAt: payload.expiresAt,
            createdAt: event.occurredAt,
          },
          thread,
          project,
        );

    try {
      await this.telegramClient.sendApprovalCard(this.config.operatorChatId, {
        approvalId: payload.approvalId,
        projectName: project.name,
        threadNameOrId: thread.threadName ?? thread.id,
        turnId: payload.turnId,
        actionSummary: payload.summary,
        scope: payload.scope,
        category: details.category,
        risk: details.risk,
        why: details.why,
        impact: details.impact,
        source: details.source,
        age: details.age,
        expiry: details.expiry,
        cwd: details.cwd,
        commandPreview: details.commandPreview,
        decisionHint: details.decisionHint,
      });

      await this.telegramClient.sendMessage(this.config.operatorChatId, formatApprovalDetailsForTelegram(details));
    } catch (error) {
      this.logger.warn('approval-card-telegram-send-failed', {
        approvalId: payload.approvalId,
        message: this.errorMessage(error),
      });
      return;
    }
    this.journal.rememberIdempotency('approval', `notified:${payload.approvalId}`);

    this.publish(
      this.journal.createEnvelope(
        'PolicyEvaluated',
        {
          policyId: 'approval-card-context-v1',
          action: 'approval-card-render',
          allowed: true,
          reason: 'Approval card contained project + thread + turn context',
        },
        {
          projectId: project.id,
          threadId: thread.id,
          turnId: payload.turnId,
          causationId: event.eventId,
        },
      ),
    );
  }

  private async resolveApproval(approvalId: string, decision: 'approved' | 'denied'): Promise<void> {
    const approval = this.repository.findApprovalById(approvalId);
    if (!approval) {
      throw new Error(`Unknown approval ${approvalId}`);
    }

    if (approval.codexRequestId.startsWith('demo:')) {
      // Demo approvals have no Codex request. Resolve them locally and ignore repeats.
      if (approval.status !== 'pending') {
        return;
      }
      const thread = this.sessionRegistry.findThreadById(approval.threadId);

      const forwarded = this.journal.createEnvelope<ApprovalResolutionForwardedPayload>(
        'ApprovalResolutionForwarded',
        {
          approvalId,
          decision,
        },
        {
          projectId: thread?.projectId,
          threadId: approval.threadId,
          turnId: approval.turnId,
        },
      );
      this.publish(forwarded);

      this.repository.updateApprovalStatus(approvalId, decision);

      const acked = this.journal.createEnvelope<ApprovalResolutionAckedPayload>(
        'ApprovalResolutionAcked',
        {
          approvalId,
          decision,
          codexAckId: `demo-ack:${approvalId}`,
        },
        {
          projectId: thread?.projectId,
          threadId: approval.threadId,
          turnId: approval.turnId,
        },
      );
      this.publish(acked);
      return;
    }

    try {
      await this.codexBridge.resolveApproval(approvalId, decision);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.recordApprovalResolutionFailed(approval, decision, 'app-server', reason);
      await this.telegramClient.sendMessage(
        this.config.operatorChatId,
        [
          `Approval ${approvalId} was not changed in Codex.`,
          `App Server rejected the ${decision} decision: ${reason}`,
          'The approval is still pending. Retry from the current approval card or approve/deny directly in Codex if the request is stale.',
        ].join('\n'),
      );
      return;
    }
  }

  private expireApprovalIfDue(approval: ApprovalRecord): boolean {
    // Only a pending approval with a valid expiry can expire by time.
    if (approval.status !== 'pending' || !approval.expiresAt) {
      return false;
    }

    const expiresAtMs = Date.parse(approval.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs > Date.now()) {
      return false;
    }

    this.repository.updateApprovalStatus(approval.id, 'expired');
    const thread = this.sessionRegistry.findThreadById(approval.threadId);
    const expired = this.journal.createEnvelope<ApprovalExpiredPayload>(
      'ApprovalExpired',
      {
        approvalId: approval.id,
        reason: 'expires_at_passed',
      },
      {
        projectId: thread?.projectId,
        threadId: approval.threadId,
        turnId: approval.turnId,
      },
    );
    this.publish(expired);
    return true;
  }

  private async resolveDesktopRecoveredApproval(
    approvalId: string,
    decision: 'approved' | 'denied',
  ): Promise<void> {
    const approval = this.repository.findApprovalById(approvalId);
    if (!approval) {
      throw new Error(`Unknown approval ${approvalId}`);
    }
    const thread = this.sessionRegistry.findThreadById(approval.threadId);
    if (!thread) {
      throw new Error(`Unknown thread for approval ${approvalId}`);
    }

    if (approval.status !== 'pending') {
      await this.telegramClient.sendMessage(this.config.operatorChatId, `Request ${approvalId} already ${approval.status}`);
      return;
    }

    // Under appserver_only, desktop-recovered approvals are never answered from Telegram.
    if (this.config.approvalStrategy === 'appserver_only') {
      await this.telegramClient.sendMessage(
        this.config.operatorChatId,
        [
          `Approval ${approvalId} is desktop-log recovered.`,
          'Remote approval is disabled by policy (`RCC_APPROVAL_STRATEGY=appserver_only`).',
          'Approve or deny it in the Codex desktop app.',
        ].join('\n'),
      );
      return;
    }

    if (!this.config.uiAutomationEnabled || !this.uiApprovalAutomation) {
      await this.telegramClient.sendMessage(
        this.config.operatorChatId,
        [
          `Approval ${approvalId} is desktop-log recovered.`,
          'Remote approval fallback is not enabled.',
          'Set `RCC_UI_AUTOMATION_ENABLED=true` to allow AppleScript fallback.',
        ].join('\n'),
      );
      return;
    }

    const forwarded = this.journal.createEnvelope<ApprovalResolutionForwardedPayload>(
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
    this.publish(forwarded);

    let ack: { ackId: string };
    try {
      ack = await this.uiApprovalAutomation.resolveInCodexDesktop({
        decision,
        approvalId,
        codexRequestId: approval.codexRequestId,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.recordApprovalResolutionFailed(approval, decision, 'ui-automation', reason);
      await this.telegramClient.sendMessage(
        this.config.operatorChatId,
        [
          `Approval ${approvalId} was not changed in Codex.`,
          `Desktop fallback failed via ${this.config.uiAutomationProvider}: ${reason}`,
          'Keep Codex open/unlocked with the approval card visible, then retry, or approve/deny directly in the Codex desktop app.',
        ].join('\n'),
      );
      return;
    }

    this.repository.updateApprovalStatus(approval.id, decision);
    const acked = this.journal.createEnvelope<ApprovalResolutionAckedPayload>(
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
    this.publish(acked);
    await this.telegramClient.sendMessage(
      this.config.operatorChatId,
      `Resolved ${approvalId} via ui_automation (${this.config.uiAutomationProvider}).`,
    );
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

  private recordApprovalResolutionFailed(
    approval: ApprovalRecord,
    decision: 'approved' | 'denied',
    source: 'app-server' | 'ui-automation',
    reason: string,
  ): void {
    const thread = this.sessionRegistry.findThreadById(approval.threadId);
    const actionableHint =
      source === 'ui-automation'
        ? 'Keep Codex open/unlocked with the approval card visible, then retry, or approve/deny directly in the Codex desktop app.'
        : 'Retry from the current approval card or approve/deny directly in Codex if the request is stale.';
    const failed = this.journal.createEnvelope<ApprovalResolutionFailedPayload>(
      'ApprovalResolutionFailed',
      {
        approvalId: approval.id,
        decision,
        codexRequestId: approval.codexRequestId,
        source,
        requestSource: approvalRequestSource(approval.codexRequestId),
        reason,
        actionableHint,
        retryGuidance: actionableHint,
        provider: source === 'ui-automation' ? this.config.uiAutomationProvider : undefined,
      },
      {
        projectId: thread?.projectId,
        threadId: approval.threadId,
        turnId: approval.turnId,
      },
    );
    this.publish(failed);
    this.logger.warn('approval-resolution-failed', {
      approvalId: approval.id,
      decision,
      source,
      reason,
      status: approval.status,
    });
  }

  private async handleResolutionAcked(event: RccEventEnvelope<ApprovalResolutionAckedPayload>): Promise<void> {
    const payload = event.payload;
    const approval = this.repository.findApprovalById(payload.approvalId);
    if (!approval) {
      return;
    }
    const thread = this.sessionRegistry.findThreadById(approval.threadId);
    if (!thread) {
      return;
    }
    const project = this.sessionRegistry.getProjectById(thread.projectId);
    if (!project) {
      return;
    }

    const source = payload.codexAckId.startsWith('desktop-log:')
      ? 'desktop-log'
      : payload.codexAckId.startsWith('ui-automation:')
        ? 'ui-automation'
        : 'app-server';
    try {
      await this.telegramClient.sendMessage(
        this.config.operatorChatId,
        [
          'Approval resolved',
          `Project: ${project.name}`,
          `Thread: ${thread.threadName ?? thread.id}`,
          `Decision: ${payload.decision}`,
          `Source: ${source}`,
        ].join('\n'),
      );
    } catch (error) {
      this.logger.warn('approval-acked-telegram-send-failed', {
        approvalId: payload.approvalId,
        message: this.errorMessage(error),
      });
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
