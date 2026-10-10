import type { RccEventEnvelope } from '../contracts/events.js';
import type { ReasoningEffort } from '../contracts/states.js';
import type { Logger } from '../logger.js';
import type { RccRepository } from '../db/repositories.js';
import type { EventJournal } from '../event-journal/eventJournal.js';
import type { PolicyEngine } from '../policies/policyEngine.js';
import type { RccEventBus } from '../runtime/eventBus.js';

import { SessionRegistryAgent } from './sessionRegistryAgent.js';

export class ModelPolicyAgent {
  constructor(
    private readonly sessionRegistry: SessionRegistryAgent,
    private readonly repository: RccRepository,
    private readonly policyEngine: PolicyEngine,
    private readonly journal: EventJournal,
    private readonly eventBus: RccEventBus,
    private readonly logger: Logger,
  ) {}

  requestPolicyUpdate(input: {
    threadId: string;
    model?: string;
    effort?: ReasoningEffort;
    requestedBySteer: boolean;
  }): void {
    if (!input.model && !input.effort) {
      throw new Error('At least one of model or effort must be provided.');
    }

    const thread = this.sessionRegistry.findThreadById(input.threadId);
    if (!thread) {
      throw new Error(`Unknown thread ${input.threadId}`);
    }

    const decision = this.policyEngine.evaluateModelSwitch(input.requestedBySteer);
    this.publish(
      this.journal.createEnvelope(
        'PolicyEvaluated',
        {
          policyId: decision.policyId,
          action: 'model-policy-update',
          allowed: decision.allowed,
          reason: decision.reason,
        },
        {
          projectId: thread.projectId,
          threadId: thread.id,
          turnId: thread.activeTurnId,
        },
      ),
    );

    if (!decision.allowed) {
      throw new Error(decision.reason);
    }

    // The change is stored as an override and applied on the next turn.
    this.repository.saveModelOverride(input.threadId, input.model, input.effort);
  }

  applyPendingOverride(threadId: string): { model?: string; effort?: ReasoningEffort } {
    const thread = this.sessionRegistry.findThreadById(threadId);
    if (!thread) {
      throw new Error(`Unknown thread ${threadId}`);
    }

    const override = this.repository.getModelOverride(threadId);
    if (!override) {
      return {
        model: thread.currentModel,
        effort: thread.currentEffort,
      };
    }

    const model = override.nextModel ?? thread.currentModel;
    const effort = override.nextEffort ?? thread.currentEffort;
    this.sessionRegistry.updateCurrentModel(threadId, model, effort);
    this.repository.clearModelOverride(threadId);

    return { model, effort };
  }

  getPendingOverride(threadId: string): { nextModel?: string; nextEffort?: ReasoningEffort } | undefined {
    return this.repository.getModelOverride(threadId);
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
