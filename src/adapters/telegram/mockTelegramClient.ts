import fs from 'node:fs';

import { EventEmitter } from 'node:events';

import type { TelegramApprovalCard, TelegramClient, TelegramUpdate } from '../../contracts/telegram.js';

export interface SentMessage {
  chatId: string;
  text: string;
}

export interface SentDocument {
  chatId: string;
  filePath: string;
  caption?: string;
}

/**
 * In-memory Telegram double. It records outgoing calls so tests can assert on them.
 */
export class MockTelegramClient implements TelegramClient {
  private readonly emitter = new EventEmitter();
  private readonly fileSeeds = new Map<string, string>();

  readonly sentMessages: SentMessage[] = [];
  readonly sentCards: TelegramApprovalCard[] = [];
  readonly sentDocuments: SentDocument[] = [];
  readonly commandSets: Array<Array<{ command: string; description: string }>> = [];

  async sendMessage(chatId: string, text: string): Promise<void> {
    this.sentMessages.push({ chatId, text });
  }

  async sendApprovalCard(_chatId: string, card: TelegramApprovalCard): Promise<void> {
    this.sentCards.push(card);
  }

  async sendDocument(chatId: string, filePath: string, caption?: string): Promise<void> {
    this.sentDocuments.push({ chatId, filePath, caption });
  }

  async setCommands(commands: Array<{ command: string; description: string }>): Promise<void> {
    this.commandSets.push(commands);
    return;
  }

  async downloadFile(fileId: string, destinationPath: string): Promise<void> {
    const seededPath = this.fileSeeds.get(fileId);
    if (!seededPath) {
      throw new Error(`No seeded file for telegram file id ${fileId}`);
    }

    fs.copyFileSync(seededPath, destinationPath);
  }

  onUpdate(listener: (update: TelegramUpdate) => void): void {
    this.emitter.on('update', listener);
  }

  emitUpdate(update: TelegramUpdate): void {
    this.emitter.emit('update', update);
  }

  seedFile(fileId: string, localPath: string): void {
    this.fileSeeds.set(fileId, localPath);
  }
}
