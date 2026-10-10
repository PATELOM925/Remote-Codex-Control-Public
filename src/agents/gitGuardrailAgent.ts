import { execFileSync } from 'node:child_process';

import type { RccEventEnvelope } from '../contracts/events.js';
import type { Logger } from '../logger.js';
import type { RccRepository } from '../db/repositories.js';
import type { EventJournal } from '../event-journal/eventJournal.js';
import type { PolicyEngine } from '../policies/policyEngine.js';
import type { RccEventBus } from '../runtime/eventBus.js';

import { SessionRegistryAgent } from './sessionRegistryAgent.js';

export class GitGuardrailAgent {
  constructor(
    private readonly sessionRegistry: SessionRegistryAgent,
    private readonly repository: RccRepository,
    private readonly policyEngine: PolicyEngine,
    private readonly journal: EventJournal,
    private readonly eventBus: RccEventBus,
    private readonly logger: Logger,
  ) {}

  requestDiffReview(threadId: string): string {
    const thread = this.mustFindThread(threadId);
    const branch = this.git(thread.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const status = this.git(thread.cwd, ['status', '--short']);
    const diffStat = this.git(thread.cwd, ['diff', '--stat']);

    return [
      `Thread: ${thread.threadName ?? thread.id}`,
      `Branch: ${branch || '(unknown)'}`,
      'Status:',
      status || '(clean)',
      'Diff Stat:',
      diffStat || '(no diff)',
    ].join('\n');
  }

  requestCommitApproval(threadId: string, summary?: string): { gitActionId: string } {
    this.mustFindThread(threadId);
    const action = this.repository.createGitAction(threadId, 'commit', undefined, summary);

    this.publish(
      this.journal.createEnvelope(
        'GitActionRequested',
        {
          gitActionId: action.id,
          threadId,
          actionType: 'commit',
          status: action.status,
          summary: action.summary,
        },
        {
          threadId,
        },
      ),
    );

    return { gitActionId: action.id };
  }

  /** Stages every change in the thread working tree with git add -A, then commits with the message. */
  approveCommit(gitActionId: string, commitMessage: string): void {
    const action = this.mustFindGitAction(gitActionId);
    if (action.actionType !== 'commit') {
      throw new Error(`Git action ${gitActionId} is not a commit action`);
    }
    if (action.status !== 'pending') {
      throw new Error(`Git action ${gitActionId} is ${action.status}, expected pending`);
    }

    const thread = this.mustFindThread(action.threadId);

    this.git(thread.cwd, ['add', '-A']);
    this.git(thread.cwd, ['commit', '-m', commitMessage]);
    this.repository.updateGitActionStatus(gitActionId, 'completed', 'Commit created');

    this.publish(
      this.journal.createEnvelope(
        'GitActionUpdated',
        {
          gitActionId,
          threadId: thread.id,
          actionType: 'commit',
          status: 'completed',
        },
        {
          projectId: thread.projectId,
          threadId: thread.id,
        },
      ),
    );
  }

  requestPushApproval(threadId: string, targetBranch: string): { gitActionId: string } {
    const thread = this.mustFindThread(threadId);
    const action = this.repository.createGitAction(threadId, 'push', targetBranch, `Push to ${targetBranch}`);
    const decision = this.policyEngine.evaluateBranchPush(targetBranch);

    this.publish(
      this.journal.createEnvelope(
        'PolicyEvaluated',
        {
          policyId: decision.policyId,
          action: 'git-push-request',
          allowed: decision.allowed,
          reason: decision.reason,
        },
        {
          projectId: thread.projectId,
          threadId: thread.id,
        },
      ),
    );

    if (!decision.allowed) {
      this.repository.updateGitActionStatus(action.id, 'denied', decision.reason);
      throw new Error(decision.reason);
    }

    return { gitActionId: action.id };
  }

  approvePush(gitActionId: string, remote = 'origin'): void {
    const action = this.mustFindGitAction(gitActionId);
    if (action.actionType !== 'push') {
      throw new Error(`Git action ${gitActionId} is not a push action`);
    }
    if (action.status !== 'pending') {
      throw new Error(`Git action ${gitActionId} is ${action.status}, expected pending`);
    }
    if (!action.targetBranch) {
      throw new Error(`Git action ${gitActionId} has no target branch`);
    }

    const thread = this.mustFindThread(action.threadId);
    // Check the branch policy again before pushing, not only when the request was made.
    const decision = this.policyEngine.evaluateBranchPush(action.targetBranch);
    if (!decision.allowed) {
      this.repository.updateGitActionStatus(action.id, 'denied', decision.reason);
      throw new Error(decision.reason);
    }

    this.git(thread.cwd, ['push', remote, action.targetBranch]);
    this.repository.updateGitActionStatus(action.id, 'completed', `Pushed ${action.targetBranch} to ${remote}`);

    this.publish(
      this.journal.createEnvelope(
        'GitActionUpdated',
        {
          gitActionId,
          threadId: thread.id,
          actionType: 'push',
          status: 'completed',
          targetBranch: action.targetBranch,
        },
        {
          projectId: thread.projectId,
          threadId: thread.id,
        },
      ),
    );
  }

  private git(cwd: string, args: string[]): string {
    try {
      // Arguments go to git directly, without a shell.
      return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    } catch (error) {
      if (error instanceof Error) {
        return error.message;
      }
      return String(error);
    }
  }

  private mustFindThread(threadId: string) {
    const thread = this.sessionRegistry.findThreadById(threadId);
    if (!thread) {
      throw new Error(`Unknown thread ${threadId}`);
    }
    return thread;
  }

  private mustFindGitAction(gitActionId: string) {
    const action = this.repository.findGitActionById(gitActionId);
    if (!action) {
      throw new Error(`Unknown git action ${gitActionId}`);
    }
    return action;
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
