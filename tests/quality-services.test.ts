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
import { canonicalPath } from '../src/utils/paths.js';
import { latestCodexDbPath, CODEX_STATE_DB_PATTERN } from '../src/utils/codexState.js';
import { slugify } from '../src/utils/slug.js';
import { chunkTextByLines } from '../src/utils/textChunks.js';
import type { MockTelegramClient as MockTelegramClientType } from '../src/adapters/telegram/mockTelegramClient.js';

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
    ['command', 'Run command: cat .env', 'high'],
    ['command', 'Run command: sudo ls /var', 'high'],
    ['command', 'Run command: git reset --hard HEAD', 'high'],
    ['command', 'Run command: git checkout -- src/a.ts', 'high'],
    ['command', `Run command: export ${'TOK' + 'EN'}=${'x'.repeat(6)}`, 'high'],
    ['filesystem', 'Apply patch: delete old.ts', 'high'],
    ['command', 'Run command: ls -la', 'low'],
    ['command', 'Run command: npm test', 'medium'],
    ['command', 'Run command: rm -rf build', 'high'],
  ];

  for (const [actionType, summary, risk] of expected) {
    assert.equal(telegramCommandService.approvalRiskLabel(approvalSample(actionType, summary)), risk, summary);
  }
});

type ActionInferrer = { inferActionType(toolName: string | undefined, args: Record<string, unknown>): string | undefined };

test('desktop monitor labels a tool call as a push only when it carries a push', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-action-type-'));
  const monitor = makeUnstartedDaemon(baseDir).desktopStateMonitor as unknown as ActionInferrer;

  // A branch name, or main in a read-only command, is not a push.
  assert.equal(monitor.inferActionType('update_plan', { branch: 'main' }), undefined);
  assert.equal(monitor.inferActionType('mcp_tool', { branch: 'main', action: 'commit' }), undefined);
  assert.equal(monitor.inferActionType('mcp_tool', { cmd: 'git log main --oneline' }), undefined);

  // A real push is still a push, from a command or from a push action.
  assert.equal(monitor.inferActionType('mcp_tool', { cmd: 'git push origin main' }), 'git_push');
  assert.equal(monitor.inferActionType('mcp_tool', { command: 'git push' }), 'git_push');
  assert.equal(monitor.inferActionType('mcp_tool', { action: 'push', branch: 'main' }), 'git_push');
});

test('slugify keeps lowercase letters and digits and falls back to project', () => {
  assert.equal(slugify('My Project!'), 'my_project');
  assert.equal(slugify('  --Hello  World--  '), 'hello_world');
  assert.equal(slugify('repo-2026'), 'repo_2026');
  assert.equal(slugify('!!!'), 'project');
  assert.equal(slugify(''), 'project');
});

test('canonicalPath resolves symbolic links and keeps missing paths resolved', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-canonical-'));
  const realDir = path.join(baseDir, 'real');
  const linkDir = path.join(baseDir, 'link');
  fs.mkdirSync(realDir);
  fs.symlinkSync(realDir, linkDir, 'dir');

  assert.equal(canonicalPath(linkDir), fs.realpathSync.native(realDir));
  const missing = path.join(baseDir, 'missing', 'child');
  assert.equal(canonicalPath(missing), missing);
  assert.equal(canonicalPath('.'), fs.realpathSync.native(process.cwd()));
});

test('latestCodexDbPath returns the newest matching database file', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-codex-db-'));
  assert.equal(latestCodexDbPath(path.join(codexHome, 'absent'), CODEX_STATE_DB_PATTERN), undefined);
  assert.equal(latestCodexDbPath(codexHome, CODEX_STATE_DB_PATTERN), undefined);

  const older = path.join(codexHome, 'state_1.sqlite');
  const newer = path.join(codexHome, 'state_2.sqlite');
  const logs = path.join(codexHome, 'logs_9.sqlite');
  fs.writeFileSync(older, '');
  fs.writeFileSync(newer, '');
  fs.writeFileSync(logs, '');
  const now = Date.now() / 1000;
  fs.utimesSync(older, now - 120, now - 120);
  fs.utimesSync(newer, now - 60, now - 60);
  fs.utimesSync(logs, now, now);

  assert.equal(latestCodexDbPath(codexHome, CODEX_STATE_DB_PATTERN), newer);
});

// Telegram rejects messages longer than 4096 characters. The services split at 3900.
const CHUNK_LIMIT = 3900;
const TELEGRAM_MAX = 4096;

test('chunkTextByLines keeps short text whole', () => {
  assert.deepEqual(chunkTextByLines('one\ntwo', CHUNK_LIMIT), ['one\ntwo']);
});

test('chunkTextByLines splits multi-line text at line breaks', () => {
  const lines = Array.from({ length: 300 }, (_, index) => `line ${index} ${'x'.repeat(60)}`);
  const text = lines.join('\n');

  const chunks = chunkTextByLines(text, CHUNK_LIMIT);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= CHUNK_LIMIT, `chunk of ${chunk.length} characters`);
  }
  // Joining with a line break gives back the input, so no line was cut.
  assert.equal(chunks.join('\n'), text);
});

test('chunkTextByLines cuts one very long line into pieces under the limit', () => {
  const text = 'a'.repeat(10_000);

  const chunks = chunkTextByLines(text, CHUNK_LIMIT);

  assert.deepEqual(chunks.map((chunk) => chunk.length), [3900, 3900, 2200]);
  assert.equal(chunks.join(''), text);
});

test('chunkTextByLines keeps short lines whole around a very long line', () => {
  const text = ['short-1', 'y'.repeat(9_000), 'short-2'].join('\n');

  const chunks = chunkTextByLines(text, CHUNK_LIMIT);

  for (const chunk of chunks) {
    assert.ok(chunk.length <= CHUNK_LIMIT);
  }
  assert.equal(chunks[0], 'short-1');
  assert.ok(chunks[chunks.length - 1]?.endsWith('\nshort-2'));
});

test('telegram and daemon send paths split the same text the same way', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-chunks-'));
  const daemon = makeUnstartedDaemon(baseDir);
  const telegramClient = daemon.telegramClient as unknown as MockTelegramClientType;
  const text = [
    'header line',
    ...Array.from({ length: 200 }, (_, index) => `row ${index} ${'z'.repeat(50)}`),
    'w'.repeat(9_000),
    'footer line',
  ].join('\n');

  await daemon.telegramCommandService.sendText('chat-1', text);
  const commandPath = telegramClient.sentMessages.splice(0).map((message) => message.text);
  await (daemon as unknown as { sendText(chatId: string, text: string): Promise<void> }).sendText('chat-1', text);
  const daemonPath = telegramClient.sentMessages.splice(0).map((message) => message.text);

  assert.deepEqual(daemonPath, commandPath);
  for (const chunk of commandPath) {
    assert.ok(chunk.length <= TELEGRAM_MAX, `message of ${chunk.length} characters`);
  }
  assert.equal(commandPath[0]?.split('\n')[0], 'header line');
  assert.ok(commandPath[commandPath.length - 1]?.endsWith('\nfooter line'));
});

test('configured project folders with the same basename get distinct names', async () => {
  const { registerConfiguredProjects } = await import('../src/services/configuredProjects.js');
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-cfg-names-'));
  const first = path.join(baseDir, 'a', 'app');
  const second = path.join(baseDir, 'b', 'app');
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(second, { recursive: true });

  const projects: Array<{ id: string; name: string; rootPath: string }> = [
    { id: 'old', name: 'APP', rootPath: path.join(baseDir, 'gone') },
  ];
  const store = {
    listProjects: () => [],
    listAllProjects: () => projects,
    registerProject: (input: { id: string; name: string; rootPath: string }) => {
      if (projects.some((project) => project.name.toLowerCase() === input.name.toLowerCase())) {
        throw new Error('UNIQUE constraint failed: projects.name');
      }
      projects.push(input);
    },
  };

  const result = registerConfiguredProjects(store, `${first},${second}`);
  assert.equal(result.registered.length, 2);
  assert.deepEqual(projects.slice(1).map((project) => project.name), ['app-2', 'app-3']);
  assert.equal(new Set(projects.map((project) => project.id)).size, 3);
  fs.rmSync(baseDir, { recursive: true, force: true });
});

