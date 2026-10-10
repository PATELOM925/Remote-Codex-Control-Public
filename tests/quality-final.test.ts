import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodexAppServerClient } from '../src/adapters/codex/codexAppServerClient.js';
import { MockAppServerClient } from '../src/adapters/codex/mockAppServerClient.js';
import { TelegramBotApiClient } from '../src/adapters/telegram/telegramBotApiClient.js';
import { MockTelegramClient } from '../src/adapters/telegram/mockTelegramClient.js';
import type { RccConfig } from '../src/config.js';
import type { AppServerEvent } from '../src/contracts/codex.js';
import type { ApprovalRecord } from '../src/db/repositories.js';
import { runWizard, type WizardDeps } from '../scripts/setup-wizard.js';
import { buildApprovalDetails, formatApprovalDetailsForTelegram } from '../src/services/approvalDetails.js';
import { Logger } from '../src/logger.js';
import { RccDaemon } from '../src/services/rccDaemon.js';
import type { UiApprovalAutomationService } from '../src/services/uiApprovalAutomationService.js';

const makeDaemonConfig = (baseDir: string): RccConfig => ({
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
  operatorChatId: 'test-chat',
  allowedChatIds: ['test-chat'],
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
  relayMacId: 'test-mac',
  relayMacToken: undefined,
  relayPollIntervalMs: 2500,
  relaySnapshotIntervalMs: 10_000,
  reasoningSummaryEnabled: true,
  reasoningTextDeltaEnabled: false,
  reasoningPersistSummary: true,
  reasoningPersistTextDelta: false,
});

const startDaemon = async (options: {
  appServerClient?: MockAppServerClient;
  uiApprovalAutomation?: UiApprovalAutomationService;
  configOverride?: Partial<RccConfig>;
  telegramClient?: MockTelegramClient;
}) => {
  const telegramClient = options.telegramClient ?? new MockTelegramClient();
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-final-'));
  const codexHome = path.join(baseDir, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const daemon = new RccDaemon({
    config: { ...makeDaemonConfig(baseDir), ...options.configOverride },
    appServerClient: options.appServerClient ?? new MockAppServerClient(),
    telegramClient,
    logger: new Logger('error'),
    codexDesktopStateOptions: { codexHome, pollIntervalMs: 60_000 },
    codexSessionsRoot: path.join(codexHome, 'sessions'),
    uiApprovalAutomation: options.uiApprovalAutomation,
  });
  await daemon.start();
  return { daemon, baseDir, telegramClient };
};

const waitForAsyncHandlers = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

const countEvents = (daemon: RccDaemon, eventType: string): number =>
  (
    daemon.dbManager.db.prepare('SELECT COUNT(*) AS total FROM event_log WHERE event_type = ?').get(eventType) as {
      total: number;
    }
  ).total;

test('a failed desktop UI approval call leaves the approval pending and publishes no forwarded event', async () => {
  const failingAutomation: UiApprovalAutomationService = {
    async resolveInCodexDesktop() {
      throw new Error('no accessible Codex window');
    },
  };
  const { daemon, baseDir } = await startDaemon({
    uiApprovalAutomation: failingAutomation,
    configOverride: { uiAutomationEnabled: true },
  });
  try {
    const thread = daemon.sessionRegistry.ensureThreadForCodexThread({
      codexThreadId: 'codex-ui-failure',
      cwd: baseDir,
      threadName: 'UI failure thread',
      status: 'idle',
    });
    daemon.repository.createApproval({
      id: 'approval-ui-failure',
      threadId: thread.id,
      codexRequestId: 'desktop:ui-failure:1',
      turnId: undefined,
      actionType: 'command',
      summary: 'git status --short',
      status: 'pending',
    });

    await daemon.approvalRouter.resolveFromTelegramCallback('approve:approval-ui-failure');

    assert.equal(daemon.repository.findApprovalById('approval-ui-failure')?.status, 'pending');
    assert.equal(countEvents(daemon, 'ApprovalResolutionForwarded'), 0);
  } finally {
    daemon.stop();
  }
});

test('a successful desktop UI approval call publishes the forwarded event once', async () => {
  const succeedingAutomation: UiApprovalAutomationService = {
    async resolveInCodexDesktop(input) {
      return { ackId: `ui-automation:${input.codexRequestId}` };
    },
  };
  const { daemon, baseDir } = await startDaemon({
    uiApprovalAutomation: succeedingAutomation,
    configOverride: { uiAutomationEnabled: true },
  });
  try {
    const thread = daemon.sessionRegistry.ensureThreadForCodexThread({
      codexThreadId: 'codex-ui-success',
      cwd: baseDir,
      threadName: 'UI success thread',
      status: 'idle',
    });
    daemon.repository.createApproval({
      id: 'approval-ui-success',
      threadId: thread.id,
      codexRequestId: 'desktop:ui-success:1',
      turnId: undefined,
      actionType: 'command',
      summary: 'git status --short',
      status: 'pending',
    });

    await daemon.approvalRouter.resolveFromTelegramCallback('approve:approval-ui-success');

    assert.equal(daemon.repository.findApprovalById('approval-ui-success')?.status, 'approved');
    assert.equal(countEvents(daemon, 'ApprovalResolutionForwarded'), 1);
  } finally {
    daemon.stop();
  }
});

test('stopping the daemon closes the App Server client exactly once', async () => {
  class ClosableAppServerClient extends MockAppServerClient {
    closeCalls = 0;

    close(): void {
      this.closeCalls += 1;
    }
  }

  const appServerClient = new ClosableAppServerClient();
  const { daemon } = await startDaemon({ appServerClient });

  daemon.stop();

  assert.equal(appServerClient.closeCalls, 1);
});

test('thread/status/changed is reported as a status change, not a thread start', () => {
  const client = new CodexAppServerClient({ mode: 'stdio', command: 'unused', logger: new Logger('error') });
  const events: AppServerEvent[] = [];
  client.onEvent((event) => events.push(event));
  const handleNotification = (
    client as unknown as { handleNotification(notification: { method: string; params: unknown }): void }
  ).handleNotification.bind(client);

  handleNotification({ method: 'thread/status/changed', params: { threadId: 'codex-status', status: { type: 'idle' } } });
  handleNotification({
    method: 'thread/started',
    params: { thread: { id: 'codex-new', cwd: '/tmp/project', name: 'New', status: { type: 'idle' } } },
  });

  assert.deepEqual(
    events.map((event) => [event.type, event.codexThreadId, event.status]),
    [
      ['thread_status_changed', 'codex-status', 'idle'],
      ['thread_started', 'codex-new', 'idle'],
    ],
  );
});

test('a status change updates the thread status the same way a thread start does', async () => {
  class CapturingAppServerClient extends MockAppServerClient {
    readonly listeners: Array<(event: AppServerEvent) => void> = [];

    override onEvent(listener: (event: AppServerEvent) => void): void {
      this.listeners.push(listener);
      super.onEvent(listener);
    }

    deliver(event: AppServerEvent): void {
      for (const listener of this.listeners) {
        listener(event);
      }
    }
  }

  const appServerClient = new CapturingAppServerClient();
  const { daemon, baseDir } = await startDaemon({ appServerClient });
  try {
    const thread = daemon.sessionRegistry.ensureThreadForCodexThread({
      codexThreadId: 'codex-status-bridge',
      cwd: baseDir,
      threadName: 'Status thread',
      status: 'idle',
    });

    appServerClient.deliver({
      type: 'thread_status_changed',
      timestamp: new Date().toISOString(),
      codexThreadId: 'codex-status-bridge',
      status: 'running',
    });
    await waitForAsyncHandlers();

    assert.equal(daemon.sessionRegistry.findThreadById(thread.id)?.status, 'running');
  } finally {
    daemon.stop();
  }
});

test('approval details for a file change list the files and no diff line', () => {
  const approval: ApprovalRecord = {
    id: 'approval-file-change',
    threadId: 'thread-file-change',
    codexRequestId: 'codex-request-file-change',
    turnId: undefined,
    actionType: 'filesystem',
    summary: 'Apply patch requiring approval',
    status: 'pending',
    createdAt: new Date().toISOString(),
    resolvedAt: undefined,
  };

  const text = formatApprovalDetailsForTelegram(buildApprovalDetails(approval));

  assert.doesNotMatch(text, /^Diff:/m);
});

test('every command listed on an approval card is one the bot handles', async () => {
  const { daemon, baseDir, telegramClient } = await startDaemon({});
  try {
    const thread = daemon.sessionRegistry.ensureThreadForCodexThread({
      codexThreadId: 'codex-actions',
      cwd: baseDir,
      threadName: 'Actions thread',
      status: 'idle',
    });
    daemon.repository.createApproval({
      id: 'approval-actions',
      threadId: thread.id,
      codexRequestId: 'codex-request-actions',
      turnId: undefined,
      actionType: 'command',
      summary: 'Run command: npm test',
      status: 'pending',
    });
    const approval = daemon.repository.findApprovalById('approval-actions');
    assert.ok(approval);

    const card = formatApprovalDetailsForTelegram(buildApprovalDetails(approval, thread));
    const actions = card.match(/^Actions: (.*)$/m)?.[1] ?? '';
    const commands = actions.split(' | ').map((action) => action.split(' ')[0]);
    assert.deepEqual(commands, ['/approve', '/deny']);

    for (const command of commands) {
      telegramClient.sentMessages.splice(0);
      telegramClient.emitUpdate({ chatId: 'test-chat', messageId: `m-${command}`, text: `${command} approval-actions` });
      await waitForAsyncHandlers();
      assert.doesNotMatch(telegramClient.sentMessages.map((message) => message.text).join('\n'), /Unknown command/);
    }
  } finally {
    daemon.stop();
  }
});

test('setup states the Node requirement it read from package.json', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-node-range-'));
  fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({ engines: { node: '>=24.1.0' } }));
  const logs: string[] = [];
  const deps: WizardDeps = {
    io: {
      ask: async () => '',
      askSecret: async () => '',
      log: (line) => {
        logs.push(line);
      },
    },
    fetch: (async () => {
      throw new Error('fetch must not run');
    }) as typeof fetch,
    fs,
    env: {},
    clock: { now: () => Date.now() },
    home: rootDir,
    startDir: rootDir,
    rootDir,
    setupPath: path.join(rootDir, 'setup.md'),
    nodeVersion: '22.22.2',
    now: () => new Date(),
    checkCodex: async () => undefined,
    isGitIgnored: async () => true,
    startRcc: async () => 0,
  };

  const code = await runWizard([], deps);

  assert.equal(code, 1);
  assert.deepEqual(logs, ['Node 22.22.2 is too old for RCC. Install Node >=24.1.0, then run npm run setup again.']);
});

test('a symlinked cwd maps to the same project with a slugged id', async () => {
  const { daemon, baseDir } = await startDaemon({});
  try {
    const repoDir = path.join(baseDir, 'My Repo!');
    const linkDir = path.join(baseDir, 'repo-link');
    fs.mkdirSync(repoDir);
    fs.symlinkSync(repoDir, linkDir);

    const first = daemon.sessionRegistry.ensureThreadForCodexThread({
      codexThreadId: 'codex-slug-first',
      cwd: repoDir,
      status: 'idle',
    });
    const second = daemon.sessionRegistry.ensureThreadForCodexThread({
      codexThreadId: 'codex-slug-second',
      cwd: linkDir,
      status: 'idle',
    });

    assert.equal(first.projectId, 'auto_my_repo');
    assert.equal(second.projectId, first.projectId);
  } finally {
    daemon.stop();
  }
});

test('sendDocument names the upload after the file base name', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-send-doc-'));
  const filePath = path.join(dir, 'reports', 'summary.txt');
  fs.mkdirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, 'summary');
  const bodies: FormData[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    bodies.push(init?.body as FormData);
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const client = new TelegramBotApiClient('000000000:test-token', 'disabled', 1500, new Logger('error'));

  await client.sendDocument('test-chat', filePath);

  const document = bodies[0]?.get('document');
  assert.ok(document instanceof File);
  assert.equal(document.name, 'summary.txt');
});
