import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MockAppServerClient } from '../src/adapters/codex/mockAppServerClient.js';
import { MockTelegramClient } from '../src/adapters/telegram/mockTelegramClient.js';
import type { RccConfig } from '../src/config.js';
import { Logger } from '../src/logger.js';
import { RccDaemon } from '../src/services/rccDaemon.js';

// Same setting as the integration tests, so the desktop approval card does not wait.
process.env.RCC_CODEX_DESKTOP_APPROVAL_CARD_GRACE_MS = '0';

const CHAT_ID = 'demo-chat';
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO_TIME_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const AGE_PATTERN = /\b(Event Age|age): (?:just now|\d+s)/g;

interface TranscriptStep {
  operator: string;
  rcc: string;
}

const makeConfig = (baseDir: string): RccConfig => ({
  dbPath: path.join(baseDir, 'rcc.sqlite'),
  uploadsRoot: path.join(baseDir, 'uploads'),
  artifactsRoot: path.join(baseDir, 'artifacts'),
  artifactExternalBaseUrl: undefined,
  projectAutoDiscoverLimit: 0,
  telegramBotToken: undefined,
  telegramTransport: 'disabled',
  codexConnectionMode: 'mock',
  codexConnectionCommand: undefined,
  codexConnectionUrl: undefined,
  operatorChatId: CHAT_ID,
  allowedChatIds: [CHAT_ID],
  approvalStrategy: 'appserver_then_ui',
  uiAutomationEnabled: false,
  uiAutomationProvider: 'applescript',
  strictSecurityDefaults: true,
  eventFreshnessThresholdMs: 90_000,
  desktopApprovalStaleMs: 24 * 60 * 60 * 1000,
  telegramSendDocumentLimitBytes: 50 * 1024 * 1024,
  telegramDownloadLimitBytes: 20 * 1024 * 1024,
  walAutoCheckpointPages: 1000,
  walGrowthAlertBytes: 1024,
  walPeriodicCheckpointMs: 5000,
  healthSnapshotIntervalMs: 5000,
  localStatusEnabled: false,
  localStatusHost: '127.0.0.1',
  localStatusPort: 0,
  webControlEnabled: false,
  webAuthToken: undefined,
  webAllowedOrigins: [],
  relayEnabled: false,
  relayBaseUrl: 'http://127.0.0.1:4865',
  relayMacId: 'demo-mac',
  relayMacToken: undefined,
  relayPollIntervalMs: 2500,
  relaySnapshotIntervalMs: 10_000,
  reasoningSummaryEnabled: true,
  reasoningTextDeltaEnabled: false,
  reasoningPersistSummary: true,
  reasoningPersistTextDelta: false,
});

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

const indentReply = (text: string): string =>
  text
    .split('\n')
    .map((line, index) => {
      const prefix = index === 0 ? 'rcc> ' : '     ';
      return line ? `${prefix}${line}` : '';
    })
    .join('\n');

const runDemo = async (tmpRoot: string): Promise<TranscriptStep[]> => {
  const tmpRealRoot = fs.realpathSync(tmpRoot);
  const labels = new Map<string, string>();

  // Times, ages, and random UUIDs change on every run, so each one is shown as a stable placeholder.
  const mask = (text: string): string =>
    text
      .split(tmpRealRoot).join('<tmp>')
      .split(tmpRoot).join('<tmp>')
      .replace(ISO_TIME_PATTERN, '<time>')
      .replace(AGE_PATTERN, '$1: <age>')
      .replace(UUID_PATTERN, (id) => {
        const existing = labels.get(id);
        if (existing) {
          return existing;
        }
        const label = `<id-${labels.size + 1}>`;
        labels.set(id, label);
        return label;
      });

  const projectRoot = path.join(tmpRoot, 'demo-app');
  const codexHome = path.join(tmpRoot, '.codex');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });

  const appServerClient = new MockAppServerClient();
  const telegramClient = new MockTelegramClient();
  const daemon = new RccDaemon({
    config: makeConfig(tmpRoot),
    appServerClient,
    telegramClient,
    logger: new Logger('error'),
    codexDesktopStateOptions: {
      codexHome,
      pollIntervalMs: 60_000,
    },
    codexSessionsRoot: path.join(codexHome, 'sessions'),
  });

  const steps: TranscriptStep[] = [];
  let messageNumber = 0;

  try {
    await daemon.start();
    daemon.sessionRegistry.registerProject({
      id: 'p1',
      name: 'demo-app',
      rootPath: projectRoot,
    });

    const run = async (command: string): Promise<string[]> => {
      messageNumber += 1;
      telegramClient.emitUpdate({ chatId: CHAT_ID, messageId: `demo-${messageNumber}`, text: command });
      await settle();
      const replies = telegramClient.sentMessages.splice(0).map((sent) => sent.text);
      steps.push({
        operator: mask(command),
        rcc: replies.length > 0 ? replies.map((reply) => mask(reply)).join('\n') : '(no reply)',
      });
      return replies;
    };

    await run('/status');
    await run('/projects');
    await run('/new 1 Demo thread');

    const demoReplies = await run('/approval_demo');
    const approvalMatch = /Approval ID: (\S+)/.exec(demoReplies.join('\n'));
    if (!approvalMatch?.[1]) {
      throw new Error('The demo approval did not report an approval ID.');
    }
    const approvalId = approvalMatch[1];

    await run('/approvals');
    await run(`/approve ${approvalId}`);
    await run(`/approve ${approvalId}`);
    await run(`/deny ${approvalId}`);
    await run('/approve does-not-exist');
  } finally {
    daemon.stop();
  }

  return steps;
};

const main = async (): Promise<void> => {
  const jsonFlag = process.argv.indexOf('--json');
  const jsonPath = jsonFlag === -1 ? undefined : process.argv[jsonFlag + 1];

  // HOME points at the temp folder, so the Codex thread catalog reads nothing from the real machine.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-demo-'));
  const previousHome = process.env.HOME;
  process.env.HOME = tmpRoot;

  try {
    const steps = await runDemo(tmpRoot);

    for (const step of steps) {
      console.log(`operator> ${step.operator}`);
      console.log(indentReply(step.rcc));
      console.log('');
    }

    console.log('- Approval routing: a demo approval card reaches the operator chat, and /approve or /deny resolves it by ID.');
    console.log('- Idempotent callbacks: a repeated /approve is answered as already processed and does not act twice.');
    console.log('- Stale or unknown approvals are rejected: a resolved request cannot change, and an unknown ID gets an error.');

    if (jsonPath) {
      fs.writeFileSync(path.resolve(jsonPath), `${JSON.stringify(steps, null, 2)}\n`);
    }
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
