import fs from 'node:fs';
import path from 'node:path';

import type { RccConfig } from '../config.js';
import type { RccEventEnvelope } from '../contracts/events.js';
import type { TelegramAttachment, TelegramClient } from '../contracts/telegram.js';
import type { Logger } from '../logger.js';
import type { RccRepository } from '../db/repositories.js';
import type { EventJournal } from '../event-journal/eventJournal.js';
import type { PolicyEngine } from '../policies/policyEngine.js';
import type { RccEventBus } from '../runtime/eventBus.js';
import { newId } from '../utils/ids.js';

import { SessionRegistryAgent } from './sessionRegistryAgent.js';
import { SteeringAgent } from './steeringAgent.js';

export class FileIntakeAgent {
  constructor(
    private readonly telegramClient: TelegramClient,
    private readonly sessionRegistry: SessionRegistryAgent,
    private readonly steeringAgent: SteeringAgent,
    private readonly repository: RccRepository,
    private readonly policyEngine: PolicyEngine,
    private readonly journal: EventJournal,
    private readonly eventBus: RccEventBus,
    private readonly config: RccConfig,
    private readonly logger: Logger,
  ) {}

  async ingestAttachment(input: {
    threadId?: string;
    attachment: TelegramAttachment;
  }): Promise<{ attachmentId: string; localPath: string }> {
    if (!input.threadId) {
      throw new Error('Ambiguous or missing thread target. /attach requires an explicit thread id.');
    }

    const thread = this.sessionRegistry.findThreadById(input.threadId);
    if (!thread) {
      throw new Error(`Unknown thread ${input.threadId}`);
    }

    const project = this.sessionRegistry.getProjectById(thread.projectId);
    if (!project) {
      throw new Error(`Unknown project ${thread.projectId} for thread ${thread.id}`);
    }

    if (input.attachment.sizeBytes > this.config.telegramDownloadLimitBytes) {
      throw new Error(
        `Attachment exceeds Telegram download baseline (${this.config.telegramDownloadLimitBytes} bytes).`,
      );
    }

    const attachmentId = newId();
    const threadWorkspace = path.join(this.config.uploadsRoot, thread.id);
    fs.mkdirSync(threadWorkspace, { recursive: true });

    const localPath = path.join(threadWorkspace, this.sanitizeFilename(input.attachment.fileName));

    this.repository.createAttachment({
      id: attachmentId,
      threadId: thread.id,
      telegramFileId: input.attachment.fileId,
      originalName: input.attachment.fileName,
      mimeType: input.attachment.mimeType,
      sizeBytes: input.attachment.sizeBytes,
      localPath,
      status: 'received',
    });

    this.publish(
      this.journal.createEnvelope(
        'AttachmentReceived',
        {
          attachmentId,
          threadId: thread.id,
          fileName: input.attachment.fileName,
          sizeBytes: input.attachment.sizeBytes,
        },
        {
          projectId: project.id,
          threadId: thread.id,
        },
      ),
    );

    const pathDecision = this.policyEngine.evaluateAttachmentPath(localPath, threadWorkspace, project.rootPath);
    this.publish(
      this.journal.createEnvelope(
        'PolicyEvaluated',
        {
          policyId: pathDecision.policyId,
          action: 'attachment-path-check',
          allowed: pathDecision.allowed,
          reason: pathDecision.reason,
        },
        {
          projectId: project.id,
          threadId: thread.id,
        },
      ),
    );

    if (!pathDecision.allowed) {
      this.repository.updateAttachmentStatus(attachmentId, 'failed', localPath);
      throw new Error(pathDecision.reason);
    }

    await this.telegramClient.downloadFile(input.attachment.fileId, localPath);
    this.repository.updateAttachmentStatus(attachmentId, 'downloaded', localPath);
    this.repository.updateAttachmentStatus(attachmentId, 'materialized', localPath);
    this.publish(
      this.journal.createEnvelope(
        'AttachmentMaterialized',
        {
          attachmentId,
          threadId: thread.id,
          localPath,
          status: 'materialized',
        },
        {
          projectId: project.id,
          threadId: thread.id,
        },
      ),
    );

    const followUpInstruction = [
      `A Telegram file was uploaded to this thread.`,
      `Filename: ${input.attachment.fileName}`,
      `Local path: ${localPath}`,
      `Use this file as additional context for the current task.`,
    ].join('\n');
    await this.steeringAgent.steerOrQueue(thread.id, followUpInstruction);

    this.repository.updateAttachmentStatus(attachmentId, 'announced_to_codex', localPath);
    this.publish(
      this.journal.createEnvelope(
        'AttachmentAnnouncedToCodex',
        {
          attachmentId,
          threadId: thread.id,
          localPath,
          status: 'announced_to_codex',
        },
        {
          projectId: project.id,
          threadId: thread.id,
        },
      ),
    );

    return {
      attachmentId,
      localPath,
    };
  }

  async ingestRawAttachment(input: {
    threadId: string;
    fileName: string;
    mimeType?: string;
    sizeBytes: number;
    bytes: Buffer;
    source?: 'web' | 'relay';
  }): Promise<{ attachmentId: string; localPath: string }> {
    const thread = this.sessionRegistry.findThreadById(input.threadId);
    if (!thread) {
      throw new Error(`Unknown thread ${input.threadId}`);
    }
    if (input.sizeBytes > this.config.telegramDownloadLimitBytes) {
      throw new Error(
        `Attachment exceeds the upload limit of ${this.config.telegramDownloadLimitBytes} bytes.`,
      );
    }
    if (input.bytes.byteLength !== input.sizeBytes) {
      throw new Error('Attachment size mismatch.');
    }

    const project = this.sessionRegistry.getProjectById(thread.projectId);
    if (!project) {
      throw new Error(`Unknown project ${thread.projectId} for thread ${thread.id}`);
    }

    const attachmentId = newId();
    const threadWorkspace = path.join(this.config.uploadsRoot, thread.id);
    fs.mkdirSync(threadWorkspace, { recursive: true });
    const localPath = path.join(threadWorkspace, this.sanitizeFilename(input.fileName));

    this.repository.createAttachment({
      id: attachmentId,
      threadId: thread.id,
      telegramFileId: `${input.source ?? 'web'}:${attachmentId}`,
      originalName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      localPath,
      status: 'received',
    });

    this.publish(
      this.journal.createEnvelope(
        'AttachmentReceived',
        {
          attachmentId,
          threadId: thread.id,
          fileName: input.fileName,
          sizeBytes: input.sizeBytes,
          source: input.source ?? 'web',
        },
        {
          projectId: project.id,
          threadId: thread.id,
        },
      ),
    );

    const pathDecision = this.policyEngine.evaluateAttachmentPath(localPath, threadWorkspace, project.rootPath);
    this.publish(
      this.journal.createEnvelope(
        'PolicyEvaluated',
        {
          policyId: pathDecision.policyId,
          action: 'attachment-path-check',
          allowed: pathDecision.allowed,
          reason: pathDecision.reason,
        },
        {
          projectId: project.id,
          threadId: thread.id,
        },
      ),
    );

    if (!pathDecision.allowed) {
      this.repository.updateAttachmentStatus(attachmentId, 'failed', localPath);
      throw new Error(pathDecision.reason);
    }

    fs.writeFileSync(localPath, input.bytes);
    this.repository.updateAttachmentStatus(attachmentId, 'downloaded', localPath);
    this.repository.updateAttachmentStatus(attachmentId, 'materialized', localPath);
    this.publish(
      this.journal.createEnvelope(
        'AttachmentMaterialized',
        {
          attachmentId,
          threadId: thread.id,
          localPath,
          status: 'materialized',
        },
        {
          projectId: project.id,
          threadId: thread.id,
        },
      ),
    );

    const followUpInstruction = [
      `A ${input.source ?? 'web'} file was uploaded to this thread.`,
      `Filename: ${input.fileName}`,
      `Local path: ${localPath}`,
      `Use this file as additional context for the current task.`,
    ].join('\n');
    await this.steeringAgent.steerOrQueue(thread.id, followUpInstruction);

    this.repository.updateAttachmentStatus(attachmentId, 'announced_to_codex', localPath);
    this.publish(
      this.journal.createEnvelope(
        'AttachmentAnnouncedToCodex',
        {
          attachmentId,
          threadId: thread.id,
          localPath,
          status: 'announced_to_codex',
        },
        {
          projectId: project.id,
          threadId: thread.id,
        },
      ),
    );

    return { attachmentId, localPath };
  }

  // Replace path separators and other unsafe characters, so the name stays
  // inside the thread upload directory.
  private sanitizeFilename(fileName: string): string {
    const sanitized = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    return `${Date.now()}_${sanitized}`;
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
