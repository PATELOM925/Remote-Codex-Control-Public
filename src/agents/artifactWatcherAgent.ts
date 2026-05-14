import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import type { RccConfig } from '../config.js';
import type { RccEventEnvelope } from '../contracts/events.js';
import type { TelegramClient } from '../contracts/telegram.js';
import type { Logger } from '../logger.js';
import type { ArtifactRecord, RccRepository } from '../db/repositories.js';
import type { EventJournal } from '../event-journal/eventJournal.js';
import type { PolicyEngine } from '../policies/policyEngine.js';
import type { RccEventBus } from '../runtime/eventBus.js';
import { newId } from '../utils/ids.js';

import { SessionRegistryAgent } from './sessionRegistryAgent.js';

const ARTIFACT_EXTENSIONS = new Set(['.md', '.pdf', '.docx', '.pptx', '.zip', '.png', '.jpg', '.jpeg', '.gif']);
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.dist', 'dist', '.next', '.cache']);

export interface DetectArtifactOptions {
  modifiedAfterMs?: number;
  maxItems?: number;
}

export interface RecentWorkspaceOutput {
  localPath: string;
  sizeBytes: number;
  mtimeMs: number;
}

export class ArtifactWatcherAgent {
  constructor(
    private readonly sessionRegistry: SessionRegistryAgent,
    private readonly repository: RccRepository,
    private readonly policyEngine: PolicyEngine,
    private readonly telegramClient: TelegramClient,
    private readonly journal: EventJournal,
    private readonly eventBus: RccEventBus,
    private readonly config: RccConfig,
    private readonly logger: Logger,
  ) {}

  detectArtifacts(threadId: string, options: DetectArtifactOptions = {}): { count: number } {
    const thread = this.sessionRegistry.findThreadById(threadId);
    if (!thread) {
      throw new Error(`Unknown thread ${threadId}`);
    }

    const project = this.sessionRegistry.getProjectById(thread.projectId);
    if (!project) {
      throw new Error(`Unknown project ${thread.projectId}`);
    }

    // Safety: do not scan the entire project/workspace (it can spam Telegram with unrelated files).
    // v1/v2 default behavior is to only detect artifacts produced into RCC's artifacts root.
    const artifactRoot = path.join(this.config.artifactsRoot, threadId);
    if (!fs.existsSync(artifactRoot)) {
      return { count: 0 };
    }
    const files = this.walkFiles(artifactRoot);
    const existingPaths = new Set(this.repository.listArtifactsByThread(threadId).map((artifact) => artifact.localPath));
    const modifiedAfterMs = options.modifiedAfterMs;
    const maxItems = options.maxItems ?? 25;
    let detectedCount = 0;

    for (const filePath of files) {
      if (detectedCount >= maxItems) {
        break;
      }

      const ext = path.extname(filePath).toLowerCase();
      if (!ARTIFACT_EXTENSIONS.has(ext)) {
        continue;
      }
      if (existingPaths.has(filePath)) {
        continue;
      }

      const stat = fs.statSync(filePath);
      if (modifiedAfterMs && stat.mtimeMs < modifiedAfterMs) {
        continue;
      }

      const artifact = this.repository.createArtifact({
        id: newId(),
        threadId,
        artifactType: ext.slice(1),
        filename: path.basename(filePath),
        localPath: filePath,
        sizeBytes: stat.size,
        status: 'detected',
      });

      this.publish(
        this.journal.createEnvelope(
          'ArtifactDetected',
          {
            artifactId: artifact.id,
            threadId,
            localPath: artifact.localPath,
            artifactType: artifact.artifactType,
            status: artifact.status,
          },
          {
            projectId: project.id,
            threadId,
          },
        ),
      );

      detectedCount += 1;
    }

    return { count: detectedCount };
  }

  listPendingArtifacts(threadId: string): ArtifactRecord[] {
    return this.repository.listPendingArtifactsByThread(threadId);
  }

  listRecentWorkspaceOutputs(threadId: string, options: DetectArtifactOptions = {}): RecentWorkspaceOutput[] {
    const thread = this.sessionRegistry.findThreadById(threadId);
    if (!thread) {
      throw new Error(`Unknown thread ${threadId}`);
    }

    const modifiedAfterMs = options.modifiedAfterMs;
    const maxItems = options.maxItems ?? 5;
    const files = this.walkFiles(thread.cwd);
    const recent: RecentWorkspaceOutput[] = [];

    for (const filePath of files) {
      const ext = path.extname(filePath).toLowerCase();
      if (!ARTIFACT_EXTENSIONS.has(ext)) {
        continue;
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }

      if (modifiedAfterMs && stat.mtimeMs < modifiedAfterMs) {
        continue;
      }

      recent.push({
        localPath: filePath,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }

    return recent
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, maxItems);
  }

  async sendArtifacts(threadId: string, artifactIds?: string[]): Promise<{ sent: number; manifested: number }> {
    const thread = this.sessionRegistry.findThreadById(threadId);
    if (!thread) {
      throw new Error(`Unknown thread ${threadId}`);
    }

    const project = this.sessionRegistry.getProjectById(thread.projectId);
    if (!project) {
      throw new Error(`Unknown project ${thread.projectId}`);
    }

    const pending = this.repository.listPendingArtifactsByThread(threadId);
    const filtered = artifactIds?.length
      ? pending.filter((artifact) => artifactIds.includes(artifact.id))
      : pending;

    let sent = 0;
    let manifested = 0;
    const artifacts = filtered.slice(0, 25);
    for (const artifact of artifacts) {
      const pathDecision = this.evaluateArtifactPath(threadId, artifact.localPath);
      this.publish(
        this.journal.createEnvelope(
          'PolicyEvaluated',
          {
            policyId: pathDecision.policyId,
            action: 'artifact-path-egress',
            allowed: pathDecision.allowed,
            reason: pathDecision.reason,
          },
          {
            projectId: project.id,
            threadId,
          },
        ),
      );

      if (!pathDecision.allowed) {
        this.repository.updateArtifactStatus(artifact.id, 'failed');
        await this.telegramClient.sendMessage(
          this.config.operatorChatId,
          [
            `Artifact blocked by path policy (${artifact.filename}).`,
            pathDecision.reason,
            'RCC only sends artifacts from the thread-scoped artifact directory.',
          ].join('\n'),
        );
        continue;
      }

      const sizeBytes = artifact.sizeBytes ?? (fs.existsSync(artifact.localPath) ? fs.statSync(artifact.localPath).size : 0);

      this.publish(
        this.journal.createEnvelope(
          'ArtifactSendAttempted',
          {
            artifactId: artifact.id,
            threadId,
            localPath: artifact.localPath,
            sizeBytes,
          },
          {
            projectId: project.id,
            threadId,
          },
        ),
      );

      const decision = this.policyEngine.evaluateArtifactSend(sizeBytes, this.config.telegramSendDocumentLimitBytes);
      this.publish(
        this.journal.createEnvelope(
          'PolicyEvaluated',
          {
            policyId: decision.policyId,
            action: 'artifact-send-direct',
            allowed: decision.allowed,
            reason: decision.reason,
          },
          {
            projectId: project.id,
            threadId,
          },
        ),
      );

      if (decision.allowed) {
        await this.telegramClient.sendDocument(this.config.operatorChatId, artifact.localPath, `Artifact: ${artifact.filename}`);
        this.repository.updateArtifactStatus(artifact.id, 'sent');
        sent += 1;
        continue;
      }

      const zippedPath = this.tryZipArtifact(artifact.localPath);
      if (zippedPath && fs.existsSync(zippedPath)) {
        const zippedSize = fs.statSync(zippedPath).size;
        const zipDecision = this.policyEngine.evaluateArtifactSend(zippedSize, this.config.telegramSendDocumentLimitBytes);
        if (zipDecision.allowed) {
          await this.telegramClient.sendDocument(this.config.operatorChatId, zippedPath, `Compressed artifact: ${artifact.filename}`);
          this.repository.updateArtifactStatus(artifact.id, 'sent');
          sent += 1;
          this.publish(
            this.journal.createEnvelope(
              'ArtifactSendFallbackUsed',
              {
                artifactId: artifact.id,
                fallback: 'zip',
                zippedPath,
              },
              {
                projectId: project.id,
                threadId,
              },
            ),
          );
          continue;
        }
      }

      const manifestPath = this.writeManifest(threadId, artifact.localPath);
      this.repository.updateArtifactStatus(artifact.id, 'manifested');
      manifested += 1;
      this.publish(
        this.journal.createEnvelope(
          'ArtifactSendFallbackUsed',
          {
            artifactId: artifact.id,
            fallback: 'manifest',
            manifestPath,
          },
          {
            projectId: project.id,
            threadId,
          },
        ),
      );

      let fallbackMessage = [
        `Artifact too large for direct Telegram delivery (${artifact.filename}).`,
        `Local path: ${artifact.localPath}`,
        `Manifest: ${manifestPath}`,
      ].join('\n');

      if (this.config.artifactExternalBaseUrl) {
        const link = `${this.config.artifactExternalBaseUrl.replace(/\/$/, '')}/${encodeURIComponent(path.basename(artifact.localPath))}`;
        fallbackMessage = `${fallbackMessage}\nExternal link: ${link}`;
      }

      await this.telegramClient.sendMessage(this.config.operatorChatId, fallbackMessage);
    }

    return { sent, manifested };
  }

  private writeManifest(threadId: string, artifactPath: string): string {
    const manifestDir = path.join(this.config.artifactsRoot, threadId);
    fs.mkdirSync(manifestDir, { recursive: true });

    const manifestPath = path.join(manifestDir, `${Date.now()}_artifact_manifest.md`);
    const body = [
      '# Artifact Manifest',
      '',
      `- Thread ID: ${threadId}`,
      `- Artifact Path: ${artifactPath}`,
      `- Generated At: ${new Date().toISOString()}`,
    ].join('\n');
    fs.writeFileSync(manifestPath, body, 'utf8');
    return manifestPath;
  }

  private evaluateArtifactPath(threadId: string, artifactPath: string): { allowed: boolean; reason: string; policyId: string } {
    const resolvedPath = path.resolve(artifactPath);
    const resolvedArtifactRoot = path.resolve(this.config.artifactsRoot, threadId);
    const insideThreadArtifactRoot = resolvedPath.startsWith(`${resolvedArtifactRoot}${path.sep}`);

    if (!insideThreadArtifactRoot) {
      return {
        allowed: false,
        reason: `Artifact path ${resolvedPath} is outside ${resolvedArtifactRoot}`,
        policyId: 'artifact-path-scope-v1',
      };
    }

    return {
      allowed: true,
      reason: 'Artifact path is inside thread-scoped artifact root',
      policyId: 'artifact-path-scope-v1',
    };
  }

  private tryZipArtifact(filePath: string): string | undefined {
    const zipPath = `${filePath}.zip`;
    try {
      execFileSync('zip', ['-j', '-q', zipPath, filePath]);
      return zipPath;
    } catch {
      return undefined;
    }
  }

  private walkFiles(rootDir: string): string[] {
    const output: string[] = [];
    if (!fs.existsSync(rootDir)) {
      return output;
    }

    const stack = [rootDir];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }

      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) {
            continue;
          }
          stack.push(full);
          continue;
        }
        if (entry.isFile()) {
          output.push(full);
        }
      }
    }

    return output;
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
