import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { TelegramApprovalCard, TelegramClient, TelegramUpdate } from '../../contracts/telegram.js';
import type { Logger } from '../../logger.js';

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
}

interface TelegramGetUpdatesResult {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: {
      id: number;
    };
    document?: {
      file_id: string;
      file_name?: string;
      mime_type?: string;
      file_size?: number;
    };
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: {
      message_id: number;
      chat?: {
        id: number;
      };
    };
  };
}

interface TelegramFileResult {
  file_id: string;
  file_path?: string;
}

export class TelegramBotApiClient implements TelegramClient {
  private readonly baseUrl: string;
  private readonly fileBaseUrl: string;
  private readonly listeners = new Set<(update: TelegramUpdate) => void>();
  private pollOffset = 0;
  private pollingActive = false;
  private pollingInitialized = false;

  constructor(
    token: string,
    private readonly transport: 'long_polling' | 'disabled' = 'long_polling',
    private readonly pollingIntervalMs = 1500,
    private readonly logger?: Logger,
    private readonly dropPendingUpdatesOnStart = process.env.RCC_TELEGRAM_DROP_PENDING_UPDATES_ON_START !== 'false',
  ) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.fileBaseUrl = `https://api.telegram.org/file/bot${token}`;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    await this.postJson('/sendMessage', {
      chat_id: chatId,
      text,
    });
  }

  async sendApprovalCard(chatId: string, card: TelegramApprovalCard): Promise<void> {
    const text = [
      'Approval needed',
      card.category ? `Category: ${card.category}` : undefined,
      card.risk ? `Risk: ${card.risk}` : undefined,
      card.why ? `Why: ${card.why}` : undefined,
      card.impact ? `Impact: ${card.impact}` : undefined,
      `Project: ${card.projectName}`,
      `Thread: ${card.threadNameOrId}`,
      `Turn: ${card.turnId ?? 'n/a'}`,
      card.cwd ? `cwd: ${card.cwd}` : undefined,
      card.source ? `Source: ${card.source}` : undefined,
      `Action: ${card.actionSummary}`,
      `Scope: ${card.scope}`,
      `Approval ID: ${card.approvalId}`,
      card.age ? `Age: ${card.age}${card.expiry ? ` | Expiry: ${card.expiry}` : ''}` : undefined,
      card.commandPreview ? `Command: ${this.truncate(card.commandPreview, 360)}` : undefined,
      card.decisionHint ? `Decision hint: ${card.decisionHint}` : undefined,
    ].filter(Boolean).join('\n');

    await this.postJson('/sendMessage', {
      chat_id: chatId,
      text,
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Approve once', callback_data: `approve:${card.approvalId}` }],
          [{ text: 'Deny', callback_data: `deny:${card.approvalId}` }],
          [
            { text: 'Details', callback_data: `details:${card.approvalId}` },
            { text: 'Dismiss', callback_data: `dismiss:${card.approvalId}` },
          ],
          [{ text: 'Interrupt', callback_data: `interrupt:${card.approvalId}` }],
        ],
      },
    });
  }

  private truncate(value: string, max: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
  }

  async sendDocument(chatId: string, filePath: string, caption?: string): Promise<void> {
    const form = new FormData();
    form.set('chat_id', chatId);
    const buffer = await fsp.readFile(filePath);
    form.set('document', new Blob([buffer]), path.basename(filePath) || 'artifact.bin');
    if (caption) {
      form.set('caption', caption);
    }

    const response = await fetch(`${this.baseUrl}/sendDocument`, {
      method: 'POST',
      body: form,
    });

    if (!response.ok) {
      throw new Error(`Telegram sendDocument failed with status ${response.status}`);
    }
  }

  async setCommands(commands: Array<{ command: string; description: string }>): Promise<void> {
    await this.postJson('/setMyCommands', {
      commands,
    });
  }

  async downloadFile(fileId: string, destinationPath: string): Promise<void> {
    const fileInfo = await this.postJson<TelegramFileResult>('/getFile', { file_id: fileId });
    if (!fileInfo.file_path) {
      throw new Error(`Telegram getFile returned no file path for ${fileId}`);
    }

    const response = await fetch(`${this.fileBaseUrl}/${fileInfo.file_path}`);
    if (!response.ok) {
      throw new Error(`Telegram file download failed with status ${response.status}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.writeFileSync(destinationPath, bytes);
  }

  onUpdate(listener: (update: TelegramUpdate) => void): void {
    this.listeners.add(listener);
    if (this.transport === 'long_polling' && !this.pollingActive) {
      this.pollingActive = true;
      void this.pollLoop();
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.pollingActive) {
      try {
        if (!this.pollingInitialized) {
          await this.initializePollingOffset();
          this.pollingInitialized = true;
        }
        const updates = await this.getUpdates();
        for (const update of updates) {
          this.pollOffset = Math.max(this.pollOffset, update.update_id);
          const normalized = this.normalizeUpdate(update);
          if (normalized) {
            for (const listener of this.listeners) {
              listener(normalized);
            }
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger?.warn('telegram-polling-error', { message });
      }

      await new Promise((resolve) => setTimeout(resolve, this.pollingIntervalMs));
    }
  }

  private async initializePollingOffset(): Promise<void> {
    if (!this.dropPendingUpdatesOnStart) {
      return;
    }

    // Telegram returns only the newest pending update for offset -1. Using it moves
    // the offset past everything queued while RCC was not running.
    const updates = await this.postJson<TelegramGetUpdatesResult[]>('/getUpdates', {
      timeout: 0,
      offset: -1,
    });
    for (const update of updates) {
      this.pollOffset = Math.max(this.pollOffset, update.update_id);
    }
    if (this.pollOffset > 0) {
      this.logger?.info('telegram-pending-updates-dropped', { throughUpdateId: this.pollOffset });
    }
  }

  private async getUpdates(): Promise<TelegramGetUpdatesResult[]> {
    // Telegram treats offset as an acknowledgement, so updates below it are not returned again.
    const response = await this.postJson<TelegramGetUpdatesResult[]>('/getUpdates', {
      timeout: 30,
      offset: this.pollOffset + 1,
    });
    return response;
  }

  private normalizeUpdate(update: TelegramGetUpdatesResult): TelegramUpdate | undefined {
    if (update.callback_query) {
      return {
        chatId: String(update.callback_query.message?.chat?.id ?? 'callback-chat'),
        messageId: String(update.callback_query.message?.message_id ?? update.callback_query.id),
        callbackData: update.callback_query.data,
      };
    }

    if (update.message) {
      const text = update.message.text;
      const parsed = this.parseCommand(text);
      return {
        chatId: String(update.message.chat.id),
        messageId: String(update.message.message_id),
        text,
        command: parsed.command,
        args: parsed.args,
        attachment: update.message.document
          ? {
              fileId: update.message.document.file_id,
              fileName: update.message.document.file_name ?? 'attachment.bin',
              mimeType: update.message.document.mime_type,
              sizeBytes: update.message.document.file_size ?? 0,
            }
          : undefined,
      };
    }

    return undefined;
  }

  private parseCommand(text?: string): { command?: string; args?: string[] } {
    if (!text || !text.startsWith('/')) {
      return {};
    }
    const [command, ...args] = text.trim().split(/\s+/);
    return { command, args };
  }

  private async postJson<TResponse>(endpoint: string, body: Record<string, unknown>): Promise<TResponse> {
    const timeoutMs = Number(process.env.RCC_TELEGRAM_HTTP_TIMEOUT_MS ?? 30_000);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        // Bound each request, so a stalled call fails and the polling loop can retry.
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Telegram API call ${endpoint} failed: ${message}`);
    }

    if (!response.ok) {
      let description: string | undefined;
      try {
        const raw = await response.text();
        try {
          const parsed = JSON.parse(raw) as { description?: string };
          description = parsed.description;
        } catch {
          description = raw.trim().slice(0, 180) || undefined;
        }
      } catch {
        // Reading the body is best-effort. The status code is reported either way.
      }
      const hint =
        response.status === 404
          ? ' (Telegram 404 often means the bot token is invalid or placeholder)'
          : response.status === 401
            ? ' (Telegram 401 unauthorized: check the bot token)'
            : '';
      const err = new Error(
        `Telegram API call ${endpoint} failed with status ${response.status}${hint}${description ? `: ${description}` : ''}`,
      );
      (err as unknown as { telegram?: { endpoint: string; status: number; description?: string } }).telegram = {
        endpoint,
        status: response.status,
        description,
      };
      throw err;
    }

    const payload = (await response.json()) as TelegramApiResponse<TResponse>;
    if (!payload.ok) {
      throw new Error(`Telegram API call ${endpoint} returned ok=false`);
    }

    return payload.result;
  }
}
