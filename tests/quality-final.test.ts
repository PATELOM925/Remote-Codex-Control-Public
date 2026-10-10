import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MockAppServerClient } from '../src/adapters/codex/mockAppServerClient.js';
import { MockTelegramClient } from '../src/adapters/telegram/mockTelegramClient.js';
import type { RccConfig } from '../src/config.js';
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
