import path from 'node:path';

import type { RccEventEnvelope } from '../contracts/events.js';
import type { ReasoningEffort, ThreadStatus } from '../contracts/states.js';
import type { Logger } from '../logger.js';
import type { RccRepository, ProjectRecord, ThreadRecord } from '../db/repositories.js';
import type { EventJournal } from '../event-journal/eventJournal.js';
import type { RccEventBus } from '../runtime/eventBus.js';
import { newId } from '../utils/ids.js';
import { canonicalPath } from '../utils/paths.js';
import { slugify } from '../utils/slug.js';

export class SessionRegistryAgent {
  // Only the focused thread streams live output to the operator chat.
  // Approvals and lifecycle events are sent for every thread.
  private operatorFocusThreadId?: string;

  constructor(
    private readonly repository: RccRepository,
    private readonly journal: EventJournal,
    private readonly eventBus: RccEventBus,
    private readonly logger: Logger,
  ) {}

  registerProject(input: {
    id?: string;
    name: string;
    rootPath: string;
    isEnabled?: boolean;
    defaultModel?: string;
    defaultEffort?: ReasoningEffort;
  }): ProjectRecord {
    const record = this.repository.insertProject({
      id: input.id ?? newId(),
      name: input.name,
      rootPath: input.rootPath,
      isEnabled: input.isEnabled ?? true,
      defaultModel: input.defaultModel,
      defaultEffort: input.defaultEffort,
    });

    this.publish(
      this.journal.createEnvelope(
        'ProjectRegistered',
        {
          projectId: record.id,
          name: record.name,
          rootPath: record.rootPath,
        },
        { projectId: record.id },
      ),
    );

    return record;
  }

  listProjects(): ProjectRecord[] {
    return this.repository.listProjects();
  }

  /** Includes disabled projects, whose ids and names stay reserved. */
  listAllProjects(): ProjectRecord[] {
    return this.repository.listProjects(true);
  }

  getProjectById(projectId: string): ProjectRecord | undefined {
    return this.repository.getProjectById(projectId);
  }

  renameProject(projectId: string, newName: string): ProjectRecord {
    const existing = this.repository.getProjectById(projectId);
    if (!existing) {
      throw new Error(`Unknown project ${projectId}`);
    }

    const normalizedName = newName.trim();
    if (!normalizedName) {
      throw new Error('Project name cannot be empty');
    }

    if (existing.name === normalizedName) {
      return existing;
    }

    const updated = this.repository.updateProjectName(projectId, normalizedName);

    this.publish(
      this.journal.createEnvelope(
        'ProjectRenamed',
        {
          projectId: updated.id,
          previousName: existing.name,
          name: updated.name,
        },
        { projectId: updated.id },
      ),
    );

    return updated;
  }

  registerThread(input: {
    projectId: string;
    codexThreadId: string;
    threadName?: string;
    cwd: string;
    status: ThreadStatus;
    currentModel?: string;
    currentEffort?: ReasoningEffort;
  }): ThreadRecord {
    const record = this.repository.insertThread({
      id: newId(),
      projectId: input.projectId,
      codexThreadId: input.codexThreadId,
      threadName: input.threadName,
      cwd: input.cwd,
      status: input.status,
      currentModel: input.currentModel,
      currentEffort: input.currentEffort,
    });

    this.publish(
      this.journal.createEnvelope(
        'ThreadRegistered',
        {
          threadId: record.id,
          codexThreadId: record.codexThreadId,
          status: record.status,
        },
        {
          projectId: record.projectId,
          threadId: record.id,
        },
      ),
    );

    return record;
  }

  findThreadById(threadId: string): ThreadRecord | undefined {
    return this.repository.getThreadById(threadId);
  }

  findThreadByCodexThreadId(codexThreadId: string): ThreadRecord | undefined {
    return this.repository.getThreadByCodexThreadId(codexThreadId);
  }

  ensureThreadForCodexThread(input: {
    codexThreadId: string;
    cwd: string;
    threadName?: string;
    status: ThreadStatus;
  }): ThreadRecord {
    const existing = this.findThreadByCodexThreadId(input.codexThreadId);
    if (existing) {
      return existing;
    }

    const rootPath = canonicalPath(input.cwd);
    const projects = this.listProjects();
    let project = projects.find((item) => canonicalPath(item.rootPath) === rootPath);
    if (!project) {
      const baseName = path.basename(rootPath) || 'project';
      project = this.registerProject({
        id: this.nextProjectId(baseName),
        name: this.nextProjectName(baseName),
        rootPath,
      });
    }

    return this.registerThread({
      projectId: project.id,
      codexThreadId: input.codexThreadId,
      threadName: input.threadName,
      cwd: rootPath,
      status: input.status,
    });
  }

  listThreads(projectId?: string): ThreadRecord[] {
    return this.repository.listThreads(projectId);
  }

  setOperatorFocusThread(threadId?: string): void {
    this.operatorFocusThreadId = threadId;
  }

  getOperatorFocusThread(): string | undefined {
    return this.operatorFocusThreadId;
  }

  setThreadStatus(threadId: string, status: ThreadStatus): void {
    const thread = this.mustFindThread(threadId);
    const previousStatus = thread.status;

    this.repository.updateThreadStatus(threadId, status);

    this.publish(
      this.journal.createEnvelope(
        'ThreadStatusChanged',
        {
          previousStatus,
          status,
        },
        {
          projectId: thread.projectId,
          threadId,
        },
      ),
    );
  }

  setActiveTurn(threadId: string, turnId?: string): void {
    const before = this.mustFindThread(threadId);
    const previousTurnId = before.activeTurnId;
    if (previousTurnId === turnId) {
      return;
    }

    this.repository.updateActiveTurn(threadId, turnId);

    const thread = this.mustFindThread(threadId);
    const completedTurnId = turnId ?? previousTurnId;
    if (!turnId && !completedTurnId) {
      return;
    }

    this.publish(
      this.journal.createEnvelope(
        turnId ? 'TurnStarted' : 'TurnCompleted',
        {
          threadId,
          turnId: turnId ?? completedTurnId,
        },
        {
          projectId: thread.projectId,
          threadId,
          turnId: turnId ?? completedTurnId,
        },
      ),
    );
  }

  queueInstruction(threadId: string, message: string): void {
    const thread = this.mustFindThread(threadId);
    this.repository.queueInstruction(threadId, message);

    this.publish(
      this.journal.createEnvelope(
        'OperatorMessageQueued',
        {
          threadId,
          messageText: message,
          deliveryMode: 'queue_next_instruction',
        },
        {
          projectId: thread.projectId,
          threadId,
        },
      ),
    );
  }

  popQueuedInstruction(threadId: string): string | undefined {
    return this.repository.popQueuedInstruction(threadId);
  }

  countRunningThreads(): number {
    return this.repository.countRunningThreads();
  }

  updateCurrentModel(threadId: string, model?: string, effort?: ReasoningEffort): void {
    this.repository.updateThreadModel(threadId, model, effort);
  }

  private nextProjectId(baseName: string): string {
    const base = `auto_${slugify(baseName)}`;
    // Disabled projects keep their ids and names, so the proposal must avoid them too.
    const existing = new Set(this.repository.listProjects(true).map((project) => project.id));
    if (!existing.has(base)) {
      return base;
    }
    let suffix = 2;
    while (existing.has(`${base}_${suffix}`)) {
      suffix += 1;
    }
    return `${base}_${suffix}`;
  }

  private nextProjectName(baseName: string): string {
    const normalized = baseName.trim() || 'project';
    const existing = new Set(this.repository.listProjects(true).map((project) => project.name.toLowerCase()));
    if (!existing.has(normalized.toLowerCase())) {
      return normalized;
    }
    let suffix = 2;
    while (existing.has(`${normalized}-${suffix}`.toLowerCase())) {
      suffix += 1;
    }
    return `${normalized}-${suffix}`;
  }

  private mustFindThread(threadId: string): ThreadRecord {
    const thread = this.repository.getThreadById(threadId);
    if (!thread) {
      throw new Error(`Unknown thread ${threadId}`);
    }
    return thread;
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
