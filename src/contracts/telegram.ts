export interface TelegramApprovalCard {
  approvalId: string;
  projectName: string;
  threadNameOrId: string;
  turnId?: string;
  actionSummary: string;
  scope: 'once' | 'session' | 'blocked';
  category?: string;
  risk?: string;
  why?: string;
  impact?: string;
  source?: string;
  age?: string;
  expiry?: string;
  cwd?: string;
  commandPreview?: string;
  decisionHint?: string;
}

export interface TelegramAttachment {
  fileId: string;
  fileName: string;
  mimeType?: string;
  sizeBytes: number;
}

export interface TelegramUpdate {
  chatId: string;
  messageId: string;
  command?: string;
  args?: string[];
  text?: string;
  callbackData?: string;
  attachment?: TelegramAttachment;
}

export interface TelegramClient {
  sendMessage(chatId: string, text: string): Promise<void>;
  sendApprovalCard(chatId: string, card: TelegramApprovalCard): Promise<void>;
  sendDocument(chatId: string, filePath: string, caption?: string): Promise<void>;
  downloadFile(fileId: string, destinationPath: string): Promise<void>;
  setCommands(commands: Array<{ command: string; description: string }>): Promise<void>;
  onUpdate(listener: (update: TelegramUpdate) => void): void;
}
