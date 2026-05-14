import fs from 'node:fs';
import path from 'node:path';

export interface RccConfig {
  dbPath: string;
  uploadsRoot: string;
  artifactsRoot: string;
  artifactExternalBaseUrl?: string;
  projectAutoDiscoverLimit: number;
  telegramBotToken?: string;
  telegramTransport: 'long_polling' | 'disabled';
  codexConnectionMode: 'mock' | 'stdio' | 'websocket';
  codexConnectionCommand?: string;
  codexConnectionUrl?: string;
  operatorChatId: string;
  allowedChatIds: string[];
  approvalStrategy: 'appserver_then_ui' | 'appserver_only';
  uiAutomationEnabled: boolean;
  uiAutomationProvider: 'applescript';
  strictSecurityDefaults: boolean;
  eventFreshnessThresholdMs: number;
  desktopApprovalStaleMs: number;
  telegramSendDocumentLimitBytes: number;
  telegramDownloadLimitBytes: number;
  walAutoCheckpointPages: number;
  walGrowthAlertBytes: number;
  walPeriodicCheckpointMs: number;
  healthSnapshotIntervalMs: number;
  localStatusEnabled: boolean;
  localStatusHost: string;
  localStatusPort: number;
  webControlEnabled: boolean;
  webAuthToken?: string;
  webAllowedOrigins: string[];
  relayEnabled: boolean;
  relayBaseUrl: string;
  relayMacId: string;
  relayMacToken?: string;
  relayPollIntervalMs: number;
  relaySnapshotIntervalMs: number;
  reasoningSummaryEnabled: boolean;
  reasoningTextDeltaEnabled: boolean;
  reasoningPersistSummary: boolean;
  reasoningPersistTextDelta: boolean;
}

const MB = 1024 * 1024;

const detectCodexCli = (): string | undefined => {
  const env = process.env.RCC_CODEX_BIN ?? process.env.CODEX_BIN;
  if (env && fs.existsSync(env)) {
    return env;
  }

  // Default Codex desktop install ships a `codex` binary here, but it is not
  // always on PATH when RCC is launched from a shell/launchd.
  const appBin = '/Applications/Codex.app/Contents/Resources/codex';
  if (fs.existsSync(appBin)) {
    return appBin;
  }

  return undefined;
};

const parseCsv = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

export const loadConfig = (): RccConfig => {
  const cwd = process.cwd();
  const codexCli = detectCodexCli();
  const defaultCodexCommand = codexCli ? `${codexCli} app-server --listen stdio://` : 'codex app-server --listen stdio://';
  const operatorChatId = process.env.RCC_OPERATOR_CHAT_ID ?? 'local-operator';
  const allowedChatIds = parseCsv(process.env.RCC_ALLOWED_CHAT_IDS);
  if (!allowedChatIds.includes(operatorChatId)) {
    allowedChatIds.push(operatorChatId);
  }

  return {
    dbPath: process.env.RCC_DB_PATH ?? path.join(cwd, '.dist', 'rcc.sqlite'),
    uploadsRoot: process.env.RCC_UPLOADS_ROOT ?? path.join(cwd, '.dist', 'uploads'),
    artifactsRoot: process.env.RCC_ARTIFACTS_ROOT ?? path.join(cwd, '.dist', 'artifacts'),
    artifactExternalBaseUrl: process.env.RCC_ARTIFACT_EXTERNAL_BASE_URL,
    projectAutoDiscoverLimit: Number(process.env.RCC_PROJECT_AUTODISCOVER_LIMIT ?? 3),
    telegramBotToken: process.env.RCC_TELEGRAM_BOT_TOKEN,
    telegramTransport: (process.env.RCC_TELEGRAM_TRANSPORT as 'long_polling' | 'disabled') ?? 'disabled',
    codexConnectionMode: (process.env.RCC_CODEX_CONNECTION_MODE as 'mock' | 'stdio' | 'websocket') ?? 'stdio',
    codexConnectionCommand: process.env.RCC_CODEX_CONNECTION_COMMAND ?? defaultCodexCommand,
    codexConnectionUrl: process.env.RCC_CODEX_CONNECTION_URL ?? 'ws://127.0.0.1:4500',
    operatorChatId,
    allowedChatIds,
    approvalStrategy: (process.env.RCC_APPROVAL_STRATEGY as 'appserver_then_ui' | 'appserver_only') ?? 'appserver_then_ui',
    uiAutomationEnabled: (process.env.RCC_UI_AUTOMATION_ENABLED ?? 'false').toLowerCase() === 'true',
    uiAutomationProvider: (process.env.RCC_UI_AUTOMATION_PROVIDER as 'applescript' | undefined) ?? 'applescript',
    strictSecurityDefaults: (process.env.RCC_STRICT_SECURITY_DEFAULTS ?? 'true').toLowerCase() !== 'false',
    eventFreshnessThresholdMs: Number(process.env.RCC_EVENT_FRESHNESS_MS ?? 90_000),
    desktopApprovalStaleMs: Number(process.env.RCC_DESKTOP_APPROVAL_STALE_MS ?? 24 * 60 * 60 * 1000),
    telegramSendDocumentLimitBytes: Number(process.env.RCC_TELEGRAM_SEND_LIMIT ?? 50 * MB),
    telegramDownloadLimitBytes: Number(process.env.RCC_TELEGRAM_DOWNLOAD_LIMIT ?? 20 * MB),
    walAutoCheckpointPages: Number(process.env.RCC_WAL_AUTOCHECKPOINT_PAGES ?? 1000),
    walGrowthAlertBytes: Number(process.env.RCC_WAL_GROWTH_ALERT_BYTES ?? 128 * MB),
    walPeriodicCheckpointMs: Number(process.env.RCC_WAL_CHECKPOINT_INTERVAL_MS ?? 60_000),
    healthSnapshotIntervalMs: Number(process.env.RCC_HEALTH_SNAPSHOT_INTERVAL_MS ?? 30_000),
    localStatusEnabled: (process.env.RCC_LOCAL_STATUS_ENABLED ?? 'true').toLowerCase() !== 'false',
    localStatusHost: process.env.RCC_LOCAL_STATUS_HOST ?? '127.0.0.1',
    localStatusPort: Number(process.env.RCC_LOCAL_STATUS_PORT ?? 4765),
    webControlEnabled: (process.env.RCC_WEB_CONTROL_ENABLED ?? 'false').toLowerCase() === 'true',
    webAuthToken: process.env.RCC_WEB_AUTH_TOKEN,
    webAllowedOrigins: parseCsv(process.env.RCC_WEB_ALLOWED_ORIGINS),
    relayEnabled: (process.env.RCC_RELAY_ENABLED ?? 'false').toLowerCase() === 'true',
    relayBaseUrl: process.env.RCC_RELAY_BASE_URL ?? 'https://rcc-magnus-alpha.vercel.app',
    relayMacId: process.env.RCC_RELAY_MAC_ID ?? 'default-mac',
    relayMacToken: process.env.RCC_RELAY_MAC_TOKEN,
    relayPollIntervalMs: Number(process.env.RCC_RELAY_POLL_INTERVAL_MS ?? 15_000),
    relaySnapshotIntervalMs: Number(process.env.RCC_RELAY_SNAPSHOT_INTERVAL_MS ?? 60_000),
    reasoningSummaryEnabled: (process.env.RCC_REASONING_SUMMARY_ENABLED ?? 'true').toLowerCase() !== 'false',
    reasoningTextDeltaEnabled: (process.env.RCC_REASONING_TEXT_DELTA_ENABLED ?? 'false').toLowerCase() === 'true',
    reasoningPersistSummary: (process.env.RCC_REASONING_PERSIST_SUMMARY ?? 'true').toLowerCase() !== 'false',
    reasoningPersistTextDelta: (process.env.RCC_REASONING_PERSIST_TEXT_DELTA ?? 'false').toLowerCase() === 'true',
  };
};
