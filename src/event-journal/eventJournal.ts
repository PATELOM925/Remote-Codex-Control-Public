import type { DatabaseSync } from 'node:sqlite';

import type { RccEventEnvelope } from '../contracts/events.js';
import { newId } from '../utils/ids.js';
import { nowIso } from '../utils/time.js';

export interface EventJournalRow {
  sequence: number;
  event_id: string;
  event_type: string;
  occurred_at: string;
  project_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  causation_id: string | null;
  correlation_id: string | null;
  payload_json: string;
  created_at: string;
}

export class EventJournal {
  constructor(private readonly db: DatabaseSync) {}

  append(event: RccEventEnvelope): void {
    this.db.prepare(
      `INSERT INTO event_log (
         event_id, event_type, occurred_at, project_id, thread_id, turn_id, causation_id, correlation_id, payload_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      event.eventId,
      event.eventType,
      event.occurredAt,
      event.projectId ?? null,
      event.threadId ?? null,
      event.turnId ?? null,
      event.causationId ?? null,
      event.correlationId ?? null,
      JSON.stringify(event.payload),
      nowIso(),
    );
  }

  listSinceSequence(sequence: number, limit = 500): RccEventEnvelope[] {
    return this.listSinceSequenceWithSequences(sequence, limit).map(({ sequence: _sequence, ...event }) => event);
  }

  listSinceSequenceWithSequences(sequence: number, limit = 500): Array<RccEventEnvelope & { sequence: number }> {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    const rows = this.db
      .prepare(
        `SELECT sequence, event_id, event_type, occurred_at, project_id, thread_id, turn_id, causation_id, correlation_id, payload_json
         FROM event_log
         WHERE sequence > ?
         ORDER BY sequence ASC
         LIMIT ?`
      )
      .all(sequence, boundedLimit) as unknown as EventJournalRow[];

    return rows.map((row) => ({
      sequence: row.sequence,
      eventId: row.event_id,
      eventType: row.event_type as RccEventEnvelope['eventType'],
      occurredAt: row.occurred_at,
      projectId: row.project_id ?? undefined,
      threadId: row.thread_id ?? undefined,
      turnId: row.turn_id ?? undefined,
      causationId: row.causation_id ?? undefined,
      correlationId: row.correlation_id ?? undefined,
      payload: JSON.parse(row.payload_json) as unknown,
    }));
  }

  listRecentEvents(limit = 50, threadId?: string): Array<RccEventEnvelope & { sequence: number }> {
    const boundedLimit = Math.max(1, Math.min(limit, 200));
    const rows = (threadId
      ? this.db
          .prepare(
            `SELECT sequence, event_id, event_type, occurred_at, project_id, thread_id, turn_id, causation_id, correlation_id, payload_json
             FROM event_log
             WHERE thread_id = ?
             ORDER BY sequence DESC
             LIMIT ?`,
          )
          .all(threadId, boundedLimit)
      : this.db
          .prepare(
            `SELECT sequence, event_id, event_type, occurred_at, project_id, thread_id, turn_id, causation_id, correlation_id, payload_json
             FROM event_log
             ORDER BY sequence DESC
             LIMIT ?`,
          )
          .all(boundedLimit)) as unknown as EventJournalRow[];

    return rows
      .map((row) => ({
        sequence: row.sequence,
        eventId: row.event_id,
        eventType: row.event_type as RccEventEnvelope['eventType'],
        occurredAt: row.occurred_at,
        projectId: row.project_id ?? undefined,
        threadId: row.thread_id ?? undefined,
        turnId: row.turn_id ?? undefined,
        causationId: row.causation_id ?? undefined,
        correlationId: row.correlation_id ?? undefined,
        payload: JSON.parse(row.payload_json) as unknown,
      }))
      .reverse();
  }

  latestSequence(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) as max_sequence FROM event_log').get() as {
      max_sequence: number;
    };
    return row.max_sequence;
  }

  idempotencySeen(source: string, key: string): boolean {
    const row = this.db
      .prepare('SELECT idempotency_key FROM idempotency_keys WHERE idempotency_key = ? AND source = ?')
      .get(key, source) as { idempotency_key: string } | undefined;
    return Boolean(row);
  }

  /** Records a key for a source. Recording a key that already exists has no effect. */
  rememberIdempotency(source: string, key: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO idempotency_keys (idempotency_key, source, created_at) VALUES (?, ?, ?)')
      .run(key, source, nowIso());
  }

  checkpoint(name: string, eventId: string): void {
    this.db
      .prepare(
        `INSERT INTO stream_checkpoints (checkpoint_name, last_event_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(checkpoint_name)
         DO UPDATE SET last_event_id = excluded.last_event_id, updated_at = excluded.updated_at`
      )
      .run(name, eventId, nowIso());
  }

  checkpointEventId(name: string): string | undefined {
    const row = this.db
      .prepare('SELECT last_event_id FROM stream_checkpoints WHERE checkpoint_name = ?')
      .get(name) as { last_event_id: string } | undefined;
    // 'none' is the placeholder written by migrations. It means the checkpoint has no event yet.
    if (!row || row.last_event_id === 'none') {
      return undefined;
    }
    return row.last_event_id;
  }

  createEnvelope<TPayload>(
    eventType: RccEventEnvelope<TPayload>['eventType'],
    payload: TPayload,
    context: Partial<Pick<RccEventEnvelope, 'projectId' | 'threadId' | 'turnId' | 'causationId' | 'correlationId'>> = {},
  ): RccEventEnvelope<TPayload> {
    return {
      eventId: newId(),
      eventType,
      occurredAt: nowIso(),
      projectId: context.projectId,
      threadId: context.threadId,
      turnId: context.turnId,
      causationId: context.causationId,
      correlationId: context.correlationId,
      payload,
    };
  }
}
