import { randomUUID, timingSafeEqual } from 'node:crypto';

import { nowIso } from '../utils/time.js';

import type { RelayCommand, RelayCommandInput, RelayCommandResult, RelaySnapshot } from './types.js';

const MAX_COMMANDS = 250;
const MAX_RESULTS = 250;

export class InMemoryRelayStore {
  private readonly commands = new Map<string, RelayCommand>();
  private readonly results = new Map<string, RelayCommandResult>();
  private snapshot?: RelaySnapshot;
  private lastMacPollAt?: string;

  constructor(
    private readonly operatorToken: string,
    private readonly macToken: string,
  ) {}

  authenticate(role: 'operator' | 'mac', token: string | undefined): boolean {
    const expected = role === 'operator' ? this.operatorToken : this.macToken;
    if (!expected || !token) {
      return false;
    }
    return safeEqual(expected, token);
  }

  enqueue(input: RelayCommandInput): RelayCommand {
    const now = nowIso();
    const command: RelayCommand = {
      id: input.clientRequestId?.trim() || randomUUID(),
      action: input.action,
      targetKind: input.targetKind ?? 'daemon',
      targetId: input.targetId,
      message: input.message,
      clientRequestId: input.clientRequestId,
      status: 'pending',
      createdAt: now,
    };
    this.commands.set(command.id, command);
    this.trim(this.commands, MAX_COMMANDS);
    return command;
  }

  poll(macId: string, max = 25): RelayCommand[] {
    const now = nowIso();
    this.lastMacPollAt = now;
    const pending = [...this.commands.values()]
      .filter((command) => command.status === 'pending')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, max);

    for (const command of pending) {
      command.status = 'delivered';
      command.macId = macId;
      command.deliveredAt = now;
      this.commands.set(command.id, command);
    }

    return pending;
  }

  complete(commandId: string, result: Omit<RelayCommandResult, 'commandId' | 'completedAt'>): RelayCommandResult {
    const completedAt = nowIso();
    const command = this.commands.get(commandId);
    if (command) {
      command.status = result.ok ? 'completed' : 'failed';
      command.completedAt = completedAt;
      this.commands.set(command.id, command);
    }

    const record: RelayCommandResult = {
      commandId,
      completedAt,
      ...result,
    };
    this.results.set(commandId, record);
    this.trim(this.results, MAX_RESULTS);
    return record;
  }

  getResult(commandId: string): RelayCommandResult | undefined {
    return this.results.get(commandId);
  }

  getCommand(commandId: string): RelayCommand | undefined {
    return this.commands.get(commandId);
  }

  listResults(limit = 25): RelayCommandResult[] {
    return [...this.results.values()]
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt))
      .slice(0, limit);
  }

  updateSnapshot(macId: string, snapshot: unknown): RelaySnapshot {
    const now = nowIso();
    this.snapshot = {
      macId,
      generatedAt: now,
      snapshot,
      relay: {
        mode: 'short_poll',
        lastMacPollAt: this.lastMacPollAt,
        lastSnapshotAt: now,
        note: 'Commands are delivered when the Mac-side RCC daemon polls this relay outbound.',
      },
    };
    return this.snapshot;
  }

  getSnapshot(): RelaySnapshot | undefined {
    return this.snapshot;
  }

  private trim<T>(map: Map<string, T>, max: number): void {
    while (map.size > max) {
      const oldest = map.keys().next().value as string | undefined;
      if (!oldest) {
        return;
      }
      map.delete(oldest);
    }
  }
}

const safeEqual = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
};
