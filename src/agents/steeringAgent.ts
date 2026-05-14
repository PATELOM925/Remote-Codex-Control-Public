import type { RccEventEnvelope } from '../contracts/events.js';
import type { Logger } from '../logger.js';
import type { EventJournal } from '../event-journal/eventJournal.js';
import type { RccEventBus } from '../runtime/eventBus.js';
import type { RccRepository } from '../db/repositories.js';

import { CodexBridgeAgent } from './codexBridgeAgent.js';
import { SessionRegistryAgent } from './sessionRegistryAgent.js';

export class SteeringAgent {
  constructor(
    private readonly codexBridge: CodexBridgeAgent,
    private readonly sessionRegistry: SessionRegistryAgent,
    private readonly repository: RccRepository,
    private readonly journal: EventJournal,
    private readonly eventBus: RccEventBus,
    private readonly logger: Logger,
  ) {}

  async steerOrQueue(threadId: string, message: string): Promise<'steer_active_turn' | 'queue_next_instruction'> {
    const thread = this.sessionRegistry.findThreadById(threadId);
    if (!thread) {
      throw new Error(`Unknown thread ${threadId}`);
    }

    if (thread.activeTurnId) {
      this.repository.addOperatorMessage(threadId, message, 'steer_active_turn');

      this.publish(
        this.journal.createEnvelope(
          'OperatorMessageReceived',
          {
            threadId,
            messageText: message,
            deliveryMode: 'steer_active_turn',
          },
          {
            projectId: thread.projectId,
            threadId,
            turnId: thread.activeTurnId,
          },
        ),
      );

      try {
        await this.codexBridge.steerActiveTurn(threadId, message);
        return 'steer_active_turn';
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (!/thread not found/i.test(errorMessage) && !/\bunknown thread\b/i.test(errorMessage)) {
          throw error;
        }

        this.logger.warn('steer-active-turn-thread-not-found-queued', {
          threadId,
          codexThreadId: thread.codexThreadId,
          activeTurnId: thread.activeTurnId,
          message: errorMessage,
        });
        this.repository.addOperatorMessage(threadId, message, 'queue_next_instruction');
        this.sessionRegistry.queueInstruction(threadId, message);
        return 'queue_next_instruction';
      }
    }

    this.repository.addOperatorMessage(threadId, message, 'queue_next_instruction');
    this.sessionRegistry.queueInstruction(threadId, message);

    this.publish(
      this.journal.createEnvelope(
        'OperatorMessageReceived',
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

    return 'queue_next_instruction';
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
