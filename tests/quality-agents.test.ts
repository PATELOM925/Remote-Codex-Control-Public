import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { CodexAppServerClient } from '../src/adapters/codex/codexAppServerClient.js';
import { MockAppServerClient } from '../src/adapters/codex/mockAppServerClient.js';
import { MockTelegramClient } from '../src/adapters/telegram/mockTelegramClient.js';
import { TelegramBotApiClient } from '../src/adapters/telegram/telegramBotApiClient.js';
import { DocumentationAgent } from '../src/agents/documentationAgent.js';
import { FileIntakeAgent } from '../src/agents/fileIntakeAgent.js';
import { GitGuardrailAgent } from '../src/agents/gitGuardrailAgent.js';
import type { RccConfig } from '../src/config.js';
import { DatabaseManager } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { RccRepository } from '../src/db/repositories.js';
import type { EventJournal } from '../src/event-journal/eventJournal.js';
import { Logger } from '../src/logger.js';
import { PolicyEngine } from '../src/policies/policyEngine.js';
import { RccEventBus } from '../src/runtime/eventBus.js';
import { RccDaemon } from '../src/services/rccDaemon.js';

// Lists every file under a directory, so a test can prove that nothing was written.
const listFiles = (dir: string): string[] => {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  });
};

const makeFileIntake = (options: { baseDir: string; policyAllowed: boolean; telegramClient: MockTelegramClient }) => {
  const thread = { id: 'thread-1', projectId: 'project-1' };
  const project = { id: 'project-1', rootPath: path.join(options.baseDir, 'project') };
  const statuses: string[] = [];
  const repository = {
    createAttachment: () => undefined,
    updateAttachmentStatus: (_id: string, status: string) => {
      statuses.push(status);
    },
  };
  const sessionRegistry = {
    findThreadById: (id: string) => (id === thread.id ? thread : undefined),
    getProjectById: (id: string) => (id === project.id ? project : undefined),
  };
  const steeringAgent = { steerOrQueue: async () => undefined };
  const policyEngine = {
    evaluateAttachmentPath: (localPath: string) => ({
      allowed: options.policyAllowed,
      reason: options.policyAllowed
        ? 'Attachment path is inside allowed workspace scope'
        : `Attachment path ${localPath} is outside thread or project scope`,
      policyId: 'attachment-path-scope-v1',
    }),
  };
  const journal = {
    createEnvelope: (eventType: string, payload: unknown, context: Record<string, unknown>) => ({
      eventId: 'event',
      eventType,
      payload,
      ...context,
    }),
    append: () => undefined,
  };
  const config = {
    uploadsRoot: path.join(options.baseDir, 'uploads'),
    telegramDownloadLimitBytes: 1024 * 1024,
  } as RccConfig;

  const agent = new FileIntakeAgent(
    options.telegramClient,
    sessionRegistry as never,
    steeringAgent as never,
    repository as never,
    policyEngine as unknown as PolicyEngine,
    journal as unknown as EventJournal,
    new RccEventBus(),
    config,
    new Logger('error'),
  );
  return { agent, statuses, thread };
};

test('ingestAttachment does not download a file whose path is rejected', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-intake-'));
  const sourcePath = path.join(baseDir, 'source.txt');
  fs.writeFileSync(sourcePath, 'payload');
  const telegramClient = new MockTelegramClient();
  telegramClient.seedFile('file-1', sourcePath);
  const { agent, statuses } = makeFileIntake({ baseDir, policyAllowed: false, telegramClient });

  await assert.rejects(
    agent.ingestAttachment({
      threadId: 'thread-1',
      attachment: { fileId: 'file-1', fileName: '../../escape.txt', mimeType: 'text/plain', sizeBytes: 7 },
    }),
    /outside thread or project scope/,
  );

  assert.deepEqual(
    listFiles(baseDir).filter((file) => file !== sourcePath),
    [],
    'a rejected attachment must not create any file',
  );
  assert.deepEqual(statuses, ['failed']);
});

test('ingestRawAttachment does not write bytes whose path is rejected', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-intake-'));
  const { agent, statuses, thread } = makeFileIntake({
    baseDir,
    policyAllowed: false,
    telegramClient: new MockTelegramClient(),
  });

  await assert.rejects(
    agent.ingestRawAttachment({
      threadId: thread.id,
      fileName: '../../escape.txt',
      sizeBytes: 7,
      bytes: Buffer.from('payload'),
    }),
    /outside thread or project scope/,
  );

  assert.deepEqual(listFiles(baseDir), [], 'a rejected upload must not create any file');
  assert.deepEqual(statuses, ['failed']);
});

type FakeGitAction = {
  id: string;
  threadId: string;
  actionType: string;
  targetBranch?: string;
  status: string;
  summary?: string;
};

const makeGitGuardrail = (options: { cwd: string; actionType: 'commit' | 'push'; targetBranch?: string }) => {
  const action: FakeGitAction = {
    id: 'action-1',
    threadId: 'thread-git',
    actionType: options.actionType,
    targetBranch: options.targetBranch,
    status: 'pending',
  };
  const events: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const created: Array<{ actionType: string; summary?: string }> = [];
  const sessionRegistry = {
    findThreadById: (id: string) => (id === 'thread-git' ? { id, projectId: 'project-1', cwd: options.cwd } : undefined),
  };
  const repository = {
    createGitAction: (_threadId: string, actionType: string, _targetBranch?: string, summary?: string) => {
      created.push({ actionType, summary });
      return { ...action, id: `created-${created.length}`, summary, status: 'pending' };
    },
    findGitActionById: (id: string) => (id === action.id ? action : undefined),
    updateGitActionStatus: (_id: string, status: string, summary?: string) => {
      action.status = status;
      action.summary = summary;
    },
  };
  const journal = {
    createEnvelope: (eventType: string, payload: Record<string, unknown>, context: Record<string, unknown>) => ({
      eventId: 'event',
      eventType,
      payload,
      ...context,
    }),
    append: (event: { eventType: string; payload: Record<string, unknown> }) => {
      events.push(event);
    },
  };
  const agent = new GitGuardrailAgent(
    sessionRegistry as never,
    repository as never,
    new PolicyEngine(),
    journal as unknown as EventJournal,
    new RccEventBus(),
    new Logger('error'),
  );
  return { agent, action, events, created };
};

test('approveCommit ends in a failed state when git cannot commit', () => {
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-git-'));
  const { agent, action, events } = makeGitGuardrail({ cwd: notARepo, actionType: 'commit' });

  assert.throws(() => agent.approveCommit(action.id, 'Test commit'), /not a git repository/);

  assert.equal(action.status, 'failed');
  assert.match(action.summary ?? '', /not a git repository/);
  assert.equal(events.at(-1)?.payload.status, 'failed');
});

test('approveCommit reports a commit with nothing to commit as failed', () => {
  const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-git-'));
  spawnSync('git', ['init', '-q', emptyRepo]);
  const { agent, action } = makeGitGuardrail({ cwd: emptyRepo, actionType: 'commit' });

  assert.throws(() => agent.approveCommit(action.id, 'Nothing here'), /nothing to commit/);

  assert.equal(action.status, 'failed');
  assert.match(action.summary ?? '', /nothing to commit/);
});

test('approvePush ends in a failed state when the push fails', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-git-'));
  // A branch with one commit, so the only reason the push can fail is the missing remote.
  spawnSync('git', ['init', '-q', repo]);
  spawnSync('git', ['-c', 'user.name=RCC Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
  spawnSync('git', ['checkout', '-q', '-b', 'feature-x'], { cwd: repo });
  const { agent, action } = makeGitGuardrail({ cwd: repo, actionType: 'push', targetBranch: 'feature-x' });

  assert.throws(() => agent.approvePush(action.id), /'origin' does not appear to be a git repository/);

  assert.equal(action.status, 'failed');
  assert.match(action.summary ?? '', /'origin' does not appear to be a git repository/);
});

test('requestCommitApproval tells the operator that every working-tree change is committed', () => {
  const { agent, created } = makeGitGuardrail({ cwd: os.tmpdir(), actionType: 'commit' });

  agent.requestCommitApproval('thread-git', 'Fix login');

  assert.equal(created.length, 1);
  assert.match(created[0]?.summary ?? '', /Fix login/);
  assert.match(created[0]?.summary ?? '', /All changes in the working tree will be committed/);
});

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

const startDaemon = async (appServerClient: MockAppServerClient) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-quality-'));
  const codexHome = path.join(baseDir, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const daemon = new RccDaemon({
    config: makeDaemonConfig(baseDir),
    appServerClient,
    telegramClient: new MockTelegramClient(),
    logger: new Logger('error'),
    codexDesktopStateOptions: { codexHome, pollIntervalMs: 60_000 },
    codexSessionsRoot: path.join(codexHome, 'sessions'),
  });
  await daemon.start();
  return { daemon, baseDir };
};

const waitForAsyncHandlers = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

test('approval request dropped before its thread is mapped is processed on a repeat', async () => {
  const appServerClient = new MockAppServerClient();
  const { daemon, baseDir } = await startDaemon(appServerClient);
  try {
    const request = {
      requestId: 'req-late',
      codexThreadId: 'codex-late',
      actionType: 'command' as const,
      summary: 'run tests',
      scope: 'once' as const,
    };
    const countApprovals = () =>
      (daemon.dbManager.db.prepare('SELECT COUNT(*) AS total FROM approvals').get() as { total: number }).total;

    // The first copy arrives before RCC knows the thread, so it is dropped.
    appServerClient.emitApprovalRequest(request);
    await waitForAsyncHandlers();
    assert.equal(countApprovals(), 0);

    // The thread becomes known, then Codex resends the same request.
    daemon.sessionRegistry.ensureThreadForCodexThread({
      codexThreadId: 'codex-late',
      cwd: baseDir,
      threadName: 'Late thread',
      status: 'idle',
    });
    appServerClient.emitApprovalRequest(request);
    await waitForAsyncHandlers();

    assert.equal(countApprovals(), 1);
  } finally {
    daemon.stop();
  }
});

test('a failed App Server approval call leaves the approval pending and publishes no forwarded event', async () => {
  class UnavailableApprovalClient extends MockAppServerClient {
    override async resolveApproval(): Promise<{ ackId: string }> {
      throw new Error('app server unavailable');
    }
  }

  const appServerClient = new UnavailableApprovalClient();
  const { daemon, baseDir } = await startDaemon(appServerClient);
  try {
    const thread = daemon.sessionRegistry.ensureThreadForCodexThread({
      codexThreadId: 'codex-approval',
      cwd: baseDir,
      threadName: 'Approval thread',
      status: 'idle',
    });
    appServerClient.emitApprovalRequest({
      requestId: 'req-unavailable',
      codexThreadId: 'codex-approval',
      actionType: 'command' as const,
      summary: 'run tests',
      scope: 'once' as const,
    });
    await waitForAsyncHandlers();
    const [approval] = daemon.repository.listApprovals(thread.id);
    assert.ok(approval);

    await assert.rejects(daemon.codexBridge.resolveApproval(approval.id, 'approved'), /app server unavailable/);

    assert.equal(daemon.repository.findApprovalById(approval.id)?.status, 'pending');
    const forwarded = daemon.dbManager.db
      .prepare("SELECT COUNT(*) AS total FROM event_log WHERE event_type = 'ApprovalResolutionForwarded'")
      .get() as { total: number };
    assert.equal(forwarded.total, 0);
  } finally {
    daemon.stop();
  }
});

test('close() stops the heartbeat and ends the app-server process', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-app-server-'));
  const scriptPath = path.join(scriptDir, 'fake-app-server.mjs');
  // Answers only the initialize request, which is all this test needs.
  fs.writeFileSync(
    scriptPath,
    [
      "import readline from 'node:readline';",
      "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
      '  const message = JSON.parse(line);',
      "  if (message.method === 'initialize') {",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n');",
      '  }',
      '});',
      '',
    ].join('\n'),
  );
  const client = new CodexAppServerClient({
    mode: 'stdio',
    command: `node ${scriptPath}`,
    logger: new Logger('error'),
  });
  const heartbeats: string[] = [];
  client.onEvent((event) => {
    if (event.type === 'heartbeat') {
      heartbeats.push(event.timestamp);
    }
  });

  await client.initialize();
  t.mock.timers.tick(15_000);
  assert.equal(heartbeats.length, 1);

  client.close();
  t.mock.timers.tick(60_000);
  assert.equal(heartbeats.length, 1, 'no heartbeat may be emitted after close()');
});

const makeRepository = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  return { db, repository: new RccRepository(db) };
};

const makeThreadWithPendingApprovals = (repository: RccRepository, approvalIds: string[]) => {
  repository.insertProject({ id: 'project-1', name: 'app', rootPath: '/work/app', isEnabled: true });
  repository.insertThread({
    id: 'thread-1',
    projectId: 'project-1',
    codexThreadId: 'codex-1',
    cwd: '/work/app',
    status: 'idle',
  });
  for (const id of approvalIds) {
    repository.createApproval({
      id,
      threadId: 'thread-1',
      codexRequestId: `request-${id}`,
      actionType: 'command',
      summary: id,
      status: 'pending',
    });
  }
};

test('a project name clash raises an error instead of deleting the existing project', () => {
  const { repository } = makeRepository();
  repository.insertProject({ id: 'project-a', name: 'app', rootPath: '/work/a', isEnabled: true });

  assert.throws(
    () => repository.insertProject({ id: 'project-b', name: 'app', rootPath: '/work/b', isEnabled: true }),
    /UNIQUE constraint failed: projects\.name/,
  );

  assert.equal(repository.getProjectById('project-a')?.rootPath, '/work/a');
});

test('a proposed project name avoids the name of a disabled project', async () => {
  const { daemon, baseDir } = await startDaemon(new MockAppServerClient());
  try {
    const cwd = path.join(baseDir, 'app');
    fs.mkdirSync(cwd);
    daemon.sessionRegistry.registerProject({
      id: 'disabled-app',
      name: 'app',
      rootPath: path.join(baseDir, 'elsewhere'),
      isEnabled: false,
    });

    const thread = daemon.sessionRegistry.ensureThreadForCodexThread({
      codexThreadId: 'codex-app',
      cwd,
      status: 'idle',
    });

    const project = daemon.repository.getProjectById(thread.projectId);
    assert.equal(project?.name, 'app-2');
    assert.equal(daemon.repository.getProjectById('disabled-app')?.name, 'app');
  } finally {
    daemon.stop();
  }
});

test('superseding pending approvals is all or nothing', () => {
  const { db, repository } = makeRepository();
  makeThreadWithPendingApprovals(repository, ['approval-a', 'approval-b']);
  // Fails the second update, after the first one has run.
  db.exec("CREATE TRIGGER fail_second BEFORE UPDATE ON approvals WHEN NEW.id = 'approval-b' BEGIN SELECT RAISE(ABORT, 'forced failure'); END;");

  assert.throws(() => repository.supersedePendingApprovals('thread-1', 'approval-new'), /forced failure/);

  assert.equal(repository.findApprovalById('approval-a')?.status, 'pending');
  assert.equal(repository.findApprovalById('approval-b')?.status, 'pending');
});

test('findSupersedingApprovalId finds an old superseded event beyond the newest 200', () => {
  const { db, repository } = makeRepository();
  const insertEvent = db.prepare(
    `INSERT INTO event_log (event_id, event_type, occurred_at, payload_json, created_at)
     VALUES (?, 'ApprovalSuperseded', ?, ?, ?)`,
  );
  const occurredAt = new Date(0).toISOString();
  insertEvent.run('event-old', occurredAt, JSON.stringify({ approvalId: 'approval-old', supersededByApprovalId: 'approval-newer' }), occurredAt);
  for (let index = 0; index < 250; index += 1) {
    insertEvent.run(`event-${index}`, occurredAt, JSON.stringify({ approvalId: `other-${index}`, supersededByApprovalId: 'approval-x' }), occurredAt);
  }

  assert.equal(repository.findSupersedingApprovalId('approval-old'), 'approval-newer');
});

test('an open error that only mentions the database does not trigger recovery', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-db-'));
  // A directory at the database path fails to open with "unable to open database file", which is not corruption.
  const dbPath = path.join(baseDir, 'rcc.sqlite');
  fs.mkdirSync(dbPath);

  assert.throws(
    () => new DatabaseManager({ ...makeDaemonConfig(baseDir), dbPath }, new Logger('error')),
    /unable to open database file/,
  );

  assert.equal(fs.existsSync(path.join(baseDir, 'recovery-backups')), false, 'no backup may be made');
});

test('an oversized upload gets a finished sentence that does not use internal branding', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-intake-'));
  const { agent, thread } = makeFileIntake({
    baseDir,
    policyAllowed: true,
    telegramClient: new MockTelegramClient(),
  });
  const sizeBytes = 2 * 1024 * 1024;

  await assert.rejects(
    agent.ingestRawAttachment({ threadId: thread.id, fileName: 'big.bin', sizeBytes, bytes: Buffer.alloc(sizeBytes) }),
    /Attachment exceeds the upload limit of 1048576 bytes\.$/,
  );
});

test('documentation coverage reads required docs under a folder path with a trailing slash', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-docs-'));
  const agent = new DocumentationAgent();
  for (const relativePath of agent.requiredDocs) {
    fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(root, relativePath), '# doc\n');
  }
  assert.deepEqual(agent.missingDocs(`${root}/`), []);

  fs.rmSync(path.join(root, 'docs/THREAT_MODEL.md'));
  assert.deepEqual(agent.missingDocs(`${root}/`), ['docs/THREAT_MODEL.md']);
});

test('downloadFile saves a bare file name into the current folder', async (t) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-download-'));
  const previousDir = process.cwd();
  process.chdir(workDir);
  t.after(() => process.chdir(previousDir));
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    if (String(input).endsWith('/getFile')) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: 'documents/file.txt' } }));
    }
    return new Response('payload');
  });
  const client = new TelegramBotApiClient('123:test-token', 'disabled');

  await client.downloadFile('file-1', 'download.txt');

  assert.equal(fs.readFileSync(path.join(workDir, 'download.txt'), 'utf8'), 'payload');
});
