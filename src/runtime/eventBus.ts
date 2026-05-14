import { EventEmitter } from 'node:events';

import type { RccEventEnvelope } from '../contracts/events.js';

export class RccEventBus {
  private readonly emitter = new EventEmitter();

  emit(event: RccEventEnvelope): void {
    this.emitter.emit(event.eventType, event);
    this.emitter.emit('*', event);
  }

  on(eventType: RccEventEnvelope['eventType'] | '*', listener: (event: RccEventEnvelope) => void): void {
    this.emitter.on(eventType, listener);
  }

  off(eventType: RccEventEnvelope['eventType'] | '*', listener: (event: RccEventEnvelope) => void): void {
    this.emitter.off(eventType, listener);
  }
}
