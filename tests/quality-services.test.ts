import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MockAppServerClient } from '../src/adapters/codex/mockAppServerClient.js';
import { MockTelegramClient } from '../src/adapters/telegram/mockTelegramClient.js';
import type { RccConfig } from '../src/config.js';
import { Logger } from '../src/logger.js';
import type { ApprovalRecord } from '../src/db/repositories.js';
import { buildApprovalDetails, formatApprovalDetailsForTelegram } from '../src/services/approvalDetails.js';
import { RccDaemon } from '../src/services/rccDaemon.js';

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

// Builds a daemon without starting it, so the single-instance lock can be checked alone.
const makeUnstartedDaemon = (baseDir: string): RccDaemon => {
  const codexHome = path.join(baseDir, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  return new RccDaemon({
    config: makeConfig(baseDir),
    appServerClient: new MockAppServerClient(),
    telegramClient: new MockTelegramClient(),
    logger: new Logger('error'),
    codexDesktopStateOptions: { codexHome, pollIntervalMs: 60_000 },
    codexSessionsRoot: path.join(codexHome, 'sessions'),
  });
};

const acquireLock = (daemon: RccDaemon): void => {
  (daemon as unknown as { acquireSingleInstanceLock(): void }).acquireSingleInstanceLock();
};

const lockPathFor = (baseDir: string): string => path.join(baseDir, 'rcc.lock.json');

const readLockPid = (baseDir: string): number => {
  const parsed = JSON.parse(fs.readFileSync(lockPathFor(baseDir), 'utf8')) as { pid: number };
  return parsed.pid;
};

// A child process that has already exited, so its PID is no longer alive.
const deadPid = (): number => {
  const child = spawnSync(process.execPath, ['-e', '']);
  assert.equal(typeof child.pid, 'number');
  return child.pid!;
};

test('single-instance lock refuses to start while the lock PID is alive', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-lock-live-'));
  const lockBody = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  fs.writeFileSync(lockPathFor(baseDir), lockBody, 'utf8');
  const daemon = makeUnstartedDaemon(baseDir);

  assert.throws(() => acquireLock(daemon), /RCC is already running \(pid \d+\)/);
  assert.equal(fs.readFileSync(lockPathFor(baseDir), 'utf8'), lockBody);
});

test('single-instance lock replaces a stale lock whose PID is dead', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-lock-dead-'));
  fs.writeFileSync(lockPathFor(baseDir), JSON.stringify({ pid: deadPid() }), 'utf8');
  const daemon = makeUnstartedDaemon(baseDir);

  acquireLock(daemon);

  assert.equal(readLockPid(baseDir), process.pid);
});

test('single-instance lock replaces an unreadable lock file', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-lock-garbage-'));
  fs.writeFileSync(lockPathFor(baseDir), '{not json', 'utf8');
  const daemon = makeUnstartedDaemon(baseDir);

  acquireLock(daemon);

  assert.equal(readLockPid(baseDir), process.pid);
});

test('single-instance lock creates the lock file when none exists', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-lock-fresh-'));
  const daemon = makeUnstartedDaemon(baseDir);
  assert.equal(fs.existsSync(lockPathFor(baseDir)), false);

  acquireLock(daemon);

  assert.equal(readLockPid(baseDir), process.pid);
});

const approvalSample = (actionType: string, summary: string): ApprovalRecord => ({
  id: 'approval-sample',
  threadId: 'thread-sample',
  codexRequestId: 'app-sample',
  actionType,
  summary,
  status: 'pending',
  createdAt: new Date().toISOString(),
});

const RISK_SAMPLES: Array<[actionType: string, summary: string]> = [
  ['command', 'Run command: git status'],
  ['command', 'Run command: git commit -m "wip"'],
  ['command', 'Run command: git push origin main'],
  ['command', 'Run command: git reset --hard HEAD'],
  ['command', 'Run command: sudo ls /var'],
  ['command', 'Run command: rm -rf build'],
  ['command', 'Run command: cat .env'],
  ['command', 'Run command: curl https://example.com'],
  ['command', 'Run command: npm install left-pad'],
  ['command', 'Run command: npm test'],
  ['command', 'Run command: node scripts/x.js'],
  ['command', 'Run command: ls -la'],
  ['filesystem', 'Apply patch requiring approval'],
  ['git_push', 'Push to origin main'],
  ['permissions', 'Permission: network access'],
  ['other', 'Tool execution requiring approval'],
];

test('approval risk label in the list matches the risk in the approval detail view', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-risk-agree-'));
  const { telegramCommandService } = makeUnstartedDaemon(baseDir);

  for (const [actionType, summary] of RISK_SAMPLES) {
    const approval = approvalSample(actionType, summary);
    const detailRisk = formatApprovalDetailsForTelegram(buildApprovalDetails(approval)).match(/^Risk: (\S+)$/m)?.[1];
    assert.equal(telegramCommandService.approvalRiskLabel(approval), detailRisk, summary);
  }
});

test('approval risk label uses the shared classifier levels', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-risk-table-'));
  const { telegramCommandService } = makeUnstartedDaemon(baseDir);
  const expected: Array<[string, string, string]> = [
    ['command', 'Run command: git push origin main', 'critical'],
    ['git_push', 'Push to origin main', 'critical'],
    ['command', 'Run command: git commit -m "wip"', 'high'],
    ['command', 'Run command: git status', 'low'],
    ['command', 'Run command: cat .env', 'low'],
    ['command', 'Run command: npm test', 'medium'],
    ['command', 'Run command: rm -rf build', 'high'],
  ];

  for (const [actionType, summary, risk] of expected) {
    assert.equal(telegramCommandService.approvalRiskLabel(approvalSample(actionType, summary)), risk, summary);
  }
});
