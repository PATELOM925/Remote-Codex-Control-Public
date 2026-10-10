import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CodexAppServerClient } from '../src/adapters/codex/codexAppServerClient.js';
import { MockAppServerClient } from '../src/adapters/codex/mockAppServerClient.js';
import { MockTelegramClient } from '../src/adapters/telegram/mockTelegramClient.js';
import { Logger } from '../src/logger.js';
import { RelayHttpServer } from '../src/relay/relayHttpServer.js';
import { registerConfiguredProjects } from '../src/services/configuredProjects.js';
import { RelayClientService } from '../src/services/relayClientService.js';
import { RccDaemon } from '../src/services/rccDaemon.js';
import {
  captureOperatorChat,
  fetchBotIdentity,
  isBotTokenShape,
  isNodeVersionSupported,
  parseArgs,
  renderSetupMd,
  runWizard,
  WizardError,
  type ChatCandidate,
  type WizardDeps,
} from '../scripts/setup-wizard.js';
import { redactSensitiveText } from '../src/utils/redaction.js';
import { loadConfig, type RccConfig } from '../src/config.js';
import {
  AppleScriptApprovalAutomationService,
  type UiApprovalAutomationService,
} from '../src/services/uiApprovalAutomationService.js';

process.env.RCC_CODEX_DESKTOP_APPROVAL_CARD_GRACE_MS = '0';

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

const createDaemon = async (options?: {
  codexHome?: string;
  configOverride?: Partial<RccConfig>;
  uiApprovalAutomation?: UiApprovalAutomationService;
  appServerClient?: MockAppServerClient;
}) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-test-'));
  const appServerClient = options?.appServerClient ?? new MockAppServerClient();
  const telegramClient = new MockTelegramClient();
  const config = {
    ...makeConfig(baseDir),
    ...(options?.configOverride ?? {}),
  };
  const codexHome = options?.codexHome ?? path.join(baseDir, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });

  const daemon = new RccDaemon({
    config,
    appServerClient,
    telegramClient,
    logger: new Logger('error'),
    codexDesktopStateOptions: {
      codexHome,
      pollIntervalMs: 60_000,
    },
    codexSessionsRoot: path.join(codexHome, 'sessions'),
    uiApprovalAutomation: options?.uiApprovalAutomation,
  });
  await daemon.start();

  const projectRoot = path.join(baseDir, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  const project = daemon.sessionRegistry.registerProject({
    id: 'p1',
    name: 'project-one',
    rootPath: projectRoot,
  });

  return { daemon, appServerClient, telegramClient, project, baseDir };
};

const createDesktopMirror = (baseDir: string) => {
  const codexHome = path.join(baseDir, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });

  const stateDbPath = path.join(codexHome, 'state_5.sqlite');
  const logsDbPath = path.join(codexHome, 'logs_1.sqlite');

  const stateDb = new DatabaseSync(stateDbPath);
  stateDb.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      rollout_path TEXT,
      updated_at_ms INTEGER
    );
  `);

  const logsDb = new DatabaseSync(logsDbPath);
  logsDb.exec(`
    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      ts_nanos INTEGER NOT NULL DEFAULT 0,
      level TEXT NOT NULL,
      target TEXT NOT NULL,
      feedback_log_body TEXT,
      thread_id TEXT,
      estimated_bytes INTEGER NOT NULL DEFAULT 0
    );
  `);

  const insertThread = (input: {
    codexThreadId: string;
    cwd: string;
    title: string;
    rolloutPath?: string;
    updatedAtMs?: number;
  }): void => {
    stateDb
      .prepare('INSERT INTO threads (id, cwd, title, rollout_path, updated_at_ms) VALUES (?, ?, ?, ?, ?)')
      .run(input.codexThreadId, input.cwd, input.title, input.rolloutPath ?? null, input.updatedAtMs ?? null);
  };

  const insertLog = (input: { ts: number; level?: string; target: string; threadId: string; body: string }): void => {
    logsDb
      .prepare(
        'INSERT INTO logs (ts, ts_nanos, level, target, feedback_log_body, thread_id, estimated_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(input.ts, 0, input.level ?? 'INFO', input.target, input.body, input.threadId, input.body.length);
  };

  const close = (): void => {
    logsDb.close();
    stateDb.close();
  };

  return { codexHome, insertThread, insertLog, close };
};

test('relay defaults are conservative enough for free-plan hosting', () => {
  const keys = ['RCC_RELAY_POLL_INTERVAL_MS', 'RCC_RELAY_SNAPSHOT_INTERVAL_MS'] as const;
  const previous = new Map<string, string | undefined>();
  for (const key of keys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    const config = loadConfig();
    assert.equal(config.relayPollIntervalMs, 15_000);
    assert.equal(config.relaySnapshotIntervalMs, 60_000);
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

const waitForAsyncHandlers = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 25));
};

const waitForTelegramText = async (
  telegramClient: MockTelegramClient,
  predicate: (text: string) => boolean,
  timeoutMs = 3_000,
): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  let latest = '';
  while (Date.now() < deadline) {
    latest = telegramClient.sentMessages.at(-1)?.text ?? '';
    if (predicate(latest)) return latest;
    await waitForAsyncHandlers();
  }
  return latest;
};

test('approval lifecycle emits durable events and resolves with ack', async () => {
  const { daemon, appServerClient, project } = await createDaemon();
  try {
    const thread = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Approval Test',
    });

    appServerClient.emitApprovalRequest({
      requestId: 'req-1',
      codexThreadId: thread.codexThreadId,
      actionType: 'command',
      summary: 'run tests',
      scope: 'once',
    });
    await waitForAsyncHandlers();

    const [approval] = daemon.repository.listApprovals(thread.threadId);
    assert.ok(approval);
    assert.equal(approval.status, 'pending');

    await daemon.approvalRouter.resolveFromTelegramCallback(`approve:${approval.id}`);
    const resolved = daemon.repository.findApprovalById(approval.id);
    assert.equal(resolved?.status, 'approved');

    await daemon.approvalRouter.resolveFromTelegramCallback(`approve:${approval.id}`);

    const eventTypes = daemon.dbManager.db
      .prepare('SELECT event_type FROM event_log ORDER BY sequence ASC')
      .all() as Array<{ event_type: string }>;

    assert.ok(eventTypes.some((row) => row.event_type === 'ApprovalAwaitingOperator'));
    assert.ok(eventTypes.some((row) => row.event_type === 'ApprovalResolutionForwarded'));
    assert.ok(eventTypes.some((row) => row.event_type === 'ApprovalResolutionAcked'));
    assert.equal(eventTypes.filter((row) => row.event_type === 'ApprovalResolutionAcked').length, 1);
  } finally {
    daemon.stop();
  }
});

test('attachment intake rejects ambiguous target and materializes explicit target', async () => {
  const { daemon, telegramClient, project, baseDir } = await createDaemon();
  try {
    const thread = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Attachment Test',
    });

    const sourceFile = path.join(baseDir, 'incoming.txt');
    fs.writeFileSync(sourceFile, 'attachment data', 'utf8');
    telegramClient.seedFile('file-1', sourceFile);

    await assert.rejects(
      async () =>
        daemon.fileIntakeAgent.ingestAttachment({
          threadId: undefined,
          attachment: {
            fileId: 'file-1',
            fileName: 'incoming.txt',
            sizeBytes: 16,
          },
        }),
      /Ambiguous or missing thread target/,
    );

    const result = await daemon.fileIntakeAgent.ingestAttachment({
      threadId: thread.threadId,
      attachment: {
        fileId: 'file-1',
        fileName: 'incoming.txt',
        sizeBytes: 16,
      },
    });

    assert.ok(fs.existsSync(result.localPath));
    assert.ok(result.localPath.includes(path.join('uploads', thread.threadId)));
  } finally {
    daemon.stop();
  }
});

test('attachment filenames with traversal characters stay confined to thread workspace', async () => {
  const { daemon, telegramClient, project, baseDir } = await createDaemon();
  try {
    const thread = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Attachment Traversal Test',
    });

    const sourceFile = path.join(baseDir, 'hostile-upload.txt');
    fs.writeFileSync(sourceFile, 'hostile attachment data', 'utf8');
    telegramClient.seedFile('file-traversal', sourceFile);

    const result = await daemon.fileIntakeAgent.ingestAttachment({
      threadId: thread.threadId,
      attachment: {
        fileId: 'file-traversal',
        fileName: '../.env/../../escape.txt',
        sizeBytes: 24,
      },
    });

    const workspace = path.resolve(daemon.config.uploadsRoot, thread.threadId);
    const resolved = path.resolve(result.localPath);
    assert.ok(resolved.startsWith(`${workspace}${path.sep}`));
    assert.equal(path.dirname(resolved), workspace);
    assert.doesNotMatch(path.relative(workspace, resolved), /^\.\.(?:[/\\]|$)/);
    assert.doesNotMatch(path.basename(resolved), /[/\\]/);
    assert.ok(fs.existsSync(resolved));
  } finally {
    daemon.stop();
  }
});

test('/status freshness distinguishes healthy_quiet vs stalled_active_no_events', async () => {
  const { daemon, project } = await createDaemon();
  try {
    const snapshotQuiet = daemon.healthOps.captureSnapshot();
    assert.equal(snapshotQuiet.freshnessState, 'healthy_quiet');

    const thread = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Health Test',
    });
    daemon.sessionRegistry.setThreadStatus(thread.threadId, 'running');

    const bridgeMutable = daemon.codexBridge as unknown as {
      transportStatus: 'connected' | 'disconnected';
      lastEventAt?: string;
    };

    bridgeMutable.transportStatus = 'connected';
    bridgeMutable.lastEventAt = new Date(Date.now() - 120_000).toISOString();
    const stalled = daemon.healthOps.captureSnapshot();
    assert.equal(stalled.freshnessState, 'stalled_active_no_events');

    bridgeMutable.lastEventAt = new Date().toISOString();
    const healthyActive = daemon.healthOps.captureSnapshot();
    assert.equal(healthyActive.freshnessState, 'healthy_active');

    bridgeMutable.transportStatus = 'disconnected';
    const disconnected = daemon.healthOps.captureSnapshot();
    assert.equal(disconnected.freshnessState, 'stalled_disconnected');
  } finally {
    daemon.stop();
  }
});

test('/status reports remote control mode and telegram command registration health', async () => {
  const { daemon, telegramClient } = await createDaemon();
  try {
    await waitForAsyncHandlers();

    assert.ok(telegramClient.commandSets.length >= 1);
    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-status-1',
      text: '/status',
    });
    await waitForAsyncHandlers();

    const last = telegramClient.sentMessages.at(-1)?.text ?? '';
    assert.match(last, /Remote Mode: focused_thread_stream \+ background_alerts/);
    assert.match(last, /Remote Approval Mode: app_server_then_manual_desktop/);
    assert.match(last, /Desktop Approval Fallback: disabled \(desktop-only approvals must be handled on the Mac\)/);
    assert.match(last, /Telegram Commands: installed/);
  } finally {
    daemon.stop();
  }
});

test('local status server exposes localhost read-only status panel', async () => {
  const { daemon } = await createDaemon({
    configOverride: {
      localStatusEnabled: true,
      localStatusHost: '127.0.0.1',
      localStatusPort: 0,
    },
  });
  try {
    const url = daemon.localStatusServer.url();
    assert.ok(url);
    const statusResponse = await fetch(`${url}/api/status`);
    assert.equal(statusResponse.status, 200);
    const statusBody = await statusResponse.json() as { statusText?: string };
    assert.match(statusBody.statusText ?? '', /RCC Status/);

    const homeResponse = await fetch(url);
    assert.equal(homeResponse.status, 200);
    assert.match(await homeResponse.text(), /RCC Local Control Panel/);
  } finally {
    daemon.stop();
  }
});

test('local dashboard API exposes structured health, events, and PWA shell without leaking stream text', async () => {
  const { daemon, appServerClient, project } = await createDaemon({
    configOverride: {
      localStatusEnabled: true,
      localStatusHost: '127.0.0.1',
      localStatusPort: 0,
    },
  });
  try {
    const url = daemon.localStatusServer.url();
    assert.ok(url);

    const created = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Dashboard Event Thread',
    });
    const started = await daemon.codexBridge.startTurn(created.threadId, 'dashboard event task');
    appServerClient.emitTurnStream(created.codexThreadId, started.turnId, 'secret stream body should not appear');
    await waitForAsyncHandlers();

    const dashboardResponse = await fetch(`${url}/api/dashboard`);
    assert.equal(dashboardResponse.status, 200);
    const dashboardText = await dashboardResponse.text();
    assert.match(dashboardText, /Dashboard Event Thread/);
    assert.match(dashboardText, /TurnOutputObserved/);
    assert.doesNotMatch(dashboardText, /secret stream body should not appear/);

    const catalogResponse = await fetch(`${url}/api/threads/catalog?limit=5`);
    assert.equal(catalogResponse.status, 200);
    const catalogText = await catalogResponse.text();
    assert.match(catalogText, /Dashboard Event Thread/);
    assert.match(catalogText, /threadListHealth/);

    const eventsResponse = await fetch(`${url}/api/events?limit=20`);
    assert.equal(eventsResponse.status, 200);
    const eventsText = await eventsResponse.text();
    assert.match(eventsText, /body redacted/);
    assert.doesNotMatch(eventsText, /secret stream body should not appear/);

    const outputsResponse = await fetch(`${url}/api/threads/${encodeURIComponent(created.threadId)}/outputs`);
    assert.equal(outputsResponse.status, 200);
    assert.match(await outputsResponse.text(), /secret stream body should not appear/);

    const healthResponse = await fetch(`${url}/api/health`);
    assert.equal(healthResponse.status, 200);
    assert.match(await healthResponse.text(), /freshnessState/);

    const manifestResponse = await fetch(`${url}/manifest.webmanifest`);
    assert.equal(manifestResponse.status, 200);
    assert.match(await manifestResponse.text(), /RCC Local Control Panel/);

    const swResponse = await fetch(`${url}/service-worker.js`);
    assert.equal(swResponse.status, 200);
    assert.match(await swResponse.text(), /No caching in alpha/);
  } finally {
    daemon.stop();
  }
});

test('web control API signs in with RCC token and mirrors Telegram actions safely', async () => {
  const webToken = 'test-web-token';
  const { daemon, project, baseDir, appServerClient } = await createDaemon({
    configOverride: {
      localStatusEnabled: true,
      localStatusHost: '127.0.0.1',
      localStatusPort: 0,
      webControlEnabled: true,
      webAuthToken: webToken,
      webAllowedOrigins: ['https://rcc-magnus-alpha.vercel.app'],
    },
  });
  try {
    const url = daemon.localStatusServer.url();
    assert.ok(url);

    const created = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Web Control Thread',
    });
    appServerClient.setSkills([
      {
        name: 'web-skill',
        path: path.join(baseDir, 'web-skill', 'SKILL.md'),
        description: 'Web requested skill',
        enabled: true,
      },
      {
        name: 'local-skill',
        path: path.join(baseDir, 'local-skill', 'SKILL.md'),
        description: 'Local selected skill',
        enabled: true,
      },
    ]);

    const preflight = await fetch(`${url}/api/threads/${encodeURIComponent(created.threadId)}/run`, {
      method: 'OPTIONS',
      headers: { origin: 'https://rcc-magnus-alpha.vercel.app' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://rcc-magnus-alpha.vercel.app');

    const sessionLogin = await fetch(`${url}/api/session/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: webToken }),
    });
    assert.equal(sessionLogin.status, 200);
    assert.match(await sessionLogin.text(), /local_codex_app_server/);

    const unauthorized = await fetch(`${url}/api/threads/${encodeURIComponent(created.threadId)}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'should be blocked' }),
    });
    assert.equal(unauthorized.status, 401);

    const authorizedHeaders = {
      authorization: `Bearer ${webToken}`,
      'content-type': 'application/json',
    };
    const run = await fetch(`${url}/api/threads/${encodeURIComponent(created.threadId)}/run`, {
      method: 'POST',
      headers: authorizedHeaders,
      body: JSON.stringify({
        message: 'start from web',
        mode: 'plan',
        skills: [{ name: 'web-skill' }],
      }),
    });
    assert.equal(run.status, 200);
    assert.match(await run.text(), /turn_start/);
    assert.match(appServerClient.startedTurns.at(-1)?.message ?? '', /Plan mode requested through RCC/);
    assert.equal(appServerClient.startedTurns.at(-1)?.skills?.[0]?.name, 'web-skill');

    const skillsList = await fetch(`${url}/api/threads/${encodeURIComponent(created.threadId)}/skills`);
    assert.equal(skillsList.status, 200);
    assert.match(await skillsList.text(), /web-skill/);

    const setMode = await fetch(`${url}/api/threads/${encodeURIComponent(created.threadId)}/mode`, {
      method: 'POST',
      headers: authorizedHeaders,
      body: JSON.stringify({ mode: 'build' }),
    });
    assert.equal(setMode.status, 200);

    const addSkill = await fetch(`${url}/api/threads/${encodeURIComponent(created.threadId)}/skills`, {
      method: 'POST',
      headers: authorizedHeaders,
      body: JSON.stringify({ action: 'add', name: 'local-skill' }),
    });
    assert.equal(addSkill.status, 200);

    const detailWithMode = await fetch(`${url}/api/threads/${encodeURIComponent(created.threadId)}`, {
      headers: { authorization: `Bearer ${webToken}` },
    });
    assert.equal(detailWithMode.status, 200);
    const detailWithModeText = await detailWithMode.text();
    assert.match(detailWithModeText, /"mode": "build"/);
    assert.match(detailWithModeText, /local-skill/);

    const say = await fetch(`${url}/api/threads/${encodeURIComponent(created.threadId)}/say`, {
      method: 'POST',
      headers: authorizedHeaders,
      body: JSON.stringify({ message: 'steer from web' }),
    });
    assert.equal(say.status, 200);
    assert.match(await say.text(), /steer_active_turn/);

    const approvalId = daemon.approvalRouter.triggerDemoApproval({
      threadId: created.threadId,
      summary: 'web approval',
    });
    const approve = await fetch(`${url}/api/approvals/${encodeURIComponent(approvalId)}/approve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${webToken}` },
    });
    assert.equal(approve.status, 200);
    assert.equal(daemon.repository.findApprovalById(approvalId)?.status, 'approved');

    const artifactRoot = path.join(baseDir, 'artifacts', created.threadId);
    fs.mkdirSync(artifactRoot, { recursive: true });
    const artifactPath = path.join(artifactRoot, 'web-control.md');
    fs.writeFileSync(artifactPath, 'web artifact');
    daemon.repository.createArtifact({
      id: 'artifact-web-control',
      threadId: created.threadId,
      artifactType: 'md',
      filename: 'web-control.md',
      localPath: artifactPath,
      sizeBytes: fs.statSync(artifactPath).size,
      status: 'detected',
    });

    const download = await fetch(`${url}/api/artifacts/artifact-web-control/download`, {
      headers: { authorization: `Bearer ${webToken}` },
    });
    assert.equal(download.status, 200);
    assert.equal(await download.text(), 'web artifact');

    const interrupt = await fetch(`${url}/api/threads/${encodeURIComponent(created.threadId)}/interrupt`, {
      method: 'POST',
      headers: { authorization: `Bearer ${webToken}` },
    });
    assert.equal(interrupt.status, 200);
    assert.equal(daemon.sessionRegistry.findThreadById(created.threadId)?.status, 'interrupted');
  } finally {
    daemon.stop();
  }
});

test('relay HTTP server enforces tokens and supports command/snapshot lifecycle', async () => {
  const relay = new RelayHttpServer({
    operatorToken: 'operator-relay-token',
    macToken: 'mac-relay-token',
    port: 0,
    logger: new Logger('error'),
  });
  await relay.start();
  try {
    const url = relay.url();
    assert.ok(url);

    const unauthorized = await fetch(`${url}/api/relay/snapshot`);
    assert.equal(unauthorized.status, 401);

    const enqueue = await fetch(`${url}/api/relay/commands`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer operator-relay-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'say',
        targetKind: 'thread',
        targetId: 'thread-1',
        message: 'relay hello',
      }),
    });
    assert.equal(enqueue.status, 202);
    const enqueued = (await enqueue.json()) as { command: { id: string; status: string } };
    assert.equal(enqueued.command.status, 'pending');

    const poll = await fetch(`${url}/api/relay/commands/poll?macId=macbook-air`, {
      headers: { authorization: 'Bearer mac-relay-token' },
    });
    assert.equal(poll.status, 200);
    const polled = (await poll.json()) as { commands: Array<{ id: string; status: string; macId: string }> };
    assert.equal(polled.commands.length, 1);
    assert.equal(polled.commands[0]?.id, enqueued.command.id);
    assert.equal(polled.commands[0]?.status, 'delivered');
    assert.equal(polled.commands[0]?.macId, 'macbook-air');

    const pendingResult = await fetch(`${url}/api/relay/commands/${encodeURIComponent(enqueued.command.id)}/result`, {
      headers: { authorization: 'Bearer operator-relay-token' },
    });
    assert.equal(pendingResult.status, 202);
    const pendingPayload = (await pendingResult.json()) as { status: string; command: { id: string; status: string } };
    assert.equal(pendingPayload.status, 'pending');
    assert.equal(pendingPayload.command.id, enqueued.command.id);
    assert.equal(pendingPayload.command.status, 'delivered');

    const result = await fetch(`${url}/api/relay/commands/${encodeURIComponent(enqueued.command.id)}/result`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer mac-relay-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ok: true, message: 'done' }),
    });
    assert.equal(result.status, 200);

    const completedResult = await fetch(`${url}/api/relay/commands/${encodeURIComponent(enqueued.command.id)}/result`, {
      headers: { authorization: 'Bearer operator-relay-token' },
    });
    assert.equal(completedResult.status, 200);
    const completedPayload = (await completedResult.json()) as { status: string; result: { ok: boolean } };
    assert.equal(completedPayload.status, 'completed');
    assert.equal(completedPayload.result.ok, true);

    const snapshotPost = await fetch(`${url}/api/relay/snapshot`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer mac-relay-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        macId: 'macbook-air',
        snapshot: {
          statusText: 'healthy',
          counts: { threads: 1 },
        },
      }),
    });
    assert.equal(snapshotPost.status, 200);

    const snapshotGet = await fetch(`${url}/api/relay/snapshot`, {
      headers: { authorization: 'Bearer operator-relay-token' },
    });
    assert.equal(snapshotGet.status, 200);
    assert.match(await snapshotGet.text(), /healthy/);
  } finally {
    await relay.stop();
  }
});

test('relay client backs off after relay host returns deployment-disabled 402', async () => {
  let requestCount = 0;
  const server = http.createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(402, { 'content-type': 'text/plain' });
    response.end('Payment required\n\nDEPLOYMENT_DISABLED');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const { daemon } = await createDaemon();
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const relayClient = new RelayClientService(
    {
      ...daemon.config,
      relayEnabled: true,
      relayBaseUrl: `http://127.0.0.1:${address.port}`,
      relayMacToken: 'mac-relay-token',
    },
    daemon.localStatusServer,
    daemon.codexBridge,
    daemon.steeringAgent,
    daemon.approvalRouter,
    daemon.fileIntakeAgent,
    daemon.repository,
    new Logger('error'),
  );

  try {
    await relayClient.pollOnce();
    assert.equal(requestCount, 1);

    await relayClient.pollOnce();
    await relayClient.postSnapshot();
    assert.equal(requestCount, 1);
  } finally {
    relayClient.stop();
    daemon.stop();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test('relay HTTP server rejects disallowed browser origins when configured', async () => {
  const relay = new RelayHttpServer({
    operatorToken: 'operator-relay-token',
    macToken: 'mac-relay-token',
    allowedOrigins: ['https://rcc.example.test'],
    port: 0,
    logger: new Logger('error'),
  });
  await relay.start();
  try {
    const url = relay.url();
    assert.ok(url);

    const disallowedPreflight = await fetch(`${url}/api/relay/commands`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://evil.example.test',
        'access-control-request-method': 'POST',
      },
    });
    assert.equal(disallowedPreflight.status, 403);

    const disallowedCommand = await fetch(`${url}/api/relay/commands`, {
      method: 'POST',
      headers: {
        origin: 'https://evil.example.test',
        authorization: 'Bearer operator-relay-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'say',
        targetKind: 'thread',
        targetId: 'thread-1',
        message: 'relay hello',
      }),
    });
    assert.equal(disallowedCommand.status, 403);

    const allowedCommand = await fetch(`${url}/api/relay/commands`, {
      method: 'POST',
      headers: {
        origin: 'https://rcc.example.test',
        authorization: 'Bearer operator-relay-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'say',
        targetKind: 'thread',
        targetId: 'thread-1',
        message: 'relay hello',
      }),
    });
    assert.equal(allowedCommand.status, 202);
    assert.equal(allowedCommand.headers.get('access-control-allow-origin'), 'https://rcc.example.test');
  } finally {
    await relay.stop();
  }
});

test('relay HTTP server redacts upload payloads from operator polling responses', async () => {
  const relay = new RelayHttpServer({
    operatorToken: 'operator-relay-token',
    macToken: 'mac-relay-token',
    port: 0,
    logger: new Logger('error'),
  });
  await relay.start();
  try {
    const url = relay.url();
    assert.ok(url);
    const encoded = Buffer.from('secret-ish attachment body').toString('base64');

    const enqueue = await fetch(`${url}/api/relay/commands`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer operator-relay-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'attach_file',
        targetKind: 'thread',
        targetId: 'thread-1',
        message: JSON.stringify({
          files: [{ name: 'context.txt', sizeBytes: 27, mimeType: 'text/plain', base64: encoded }],
        }),
      }),
    });
    assert.equal(enqueue.status, 202);
    const enqueueText = await enqueue.text();
    assert.match(enqueueText, /payloadRedacted/);
    assert.equal(enqueueText.includes(encoded), false);
    const enqueued = JSON.parse(enqueueText) as { command: { id: string } };

    const poll = await fetch(`${url}/api/relay/commands/poll?macId=macbook-air`, {
      headers: { authorization: 'Bearer mac-relay-token' },
    });
    assert.equal(poll.status, 200);
    assert.equal((await poll.text()).includes(encoded), true);

    const pendingResult = await fetch(`${url}/api/relay/commands/${encodeURIComponent(enqueued.command.id)}/result`, {
      headers: { authorization: 'Bearer operator-relay-token' },
    });
    assert.equal(pendingResult.status, 202);
    const pendingText = await pendingResult.text();
    assert.match(pendingText, /payloadRedacted/);
    assert.equal(pendingText.includes(encoded), false);
  } finally {
    await relay.stop();
  }
});

test('Mac relay client executes queued thread and approval commands through RCC', async () => {
  const relay = new RelayHttpServer({
    operatorToken: 'operator-relay-token',
    macToken: 'mac-relay-token',
    port: 0,
    logger: new Logger('error'),
  });
  await relay.start();
  const relayUrl = relay.url();
  assert.ok(relayUrl);

  const { daemon, project, appServerClient } = await createDaemon({
    configOverride: {
      relayEnabled: true,
      relayBaseUrl: relayUrl,
      relayMacId: 'test-mac',
      relayMacToken: 'mac-relay-token',
      relayPollIntervalMs: 60_000,
      relaySnapshotIntervalMs: 60_000,
    },
  });
  try {
    const created = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Relay Control Thread',
    });

    const enqueue = async (body: object): Promise<string> => {
      const response = await fetch(`${relayUrl}/api/relay/commands`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer operator-relay-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 202);
      const parsed = (await response.json()) as { command: { id: string } };
      return parsed.command.id;
    };

    const runId = await enqueue({
      action: 'run',
      targetKind: 'thread',
      targetId: created.threadId,
      message: 'start from relay',
    });
    await daemon.relayClient.pollOnce();
    assert.equal(daemon.sessionRegistry.findThreadById(created.threadId)?.status, 'running');
    appServerClient.emitTurnStream(created.codexThreadId, 'relay-turn-detail', 'relay live output visible only after explicit thread open');

    const runResult = await fetch(`${relayUrl}/api/relay/commands/${encodeURIComponent(runId)}/result`, {
      headers: { authorization: 'Bearer operator-relay-token' },
    });
    assert.equal(runResult.status, 200);
    assert.match(await runResult.text(), /Executed run/);

    const listId = await enqueue({
      action: 'list_threads',
      targetKind: 'daemon',
      message: '10',
    });
    await daemon.relayClient.pollOnce();
    const listResult = await fetch(`${relayUrl}/api/relay/commands/${encodeURIComponent(listId)}/result`, {
      headers: { authorization: 'Bearer operator-relay-token' },
    });
    assert.equal(listResult.status, 200);
    const listText = await listResult.text();
    assert.match(listText, /Relay Control Thread/);
    assert.match(listText, /threadListHealth/);

    const detailId = await enqueue({
      action: 'thread_detail',
      targetKind: 'thread',
      targetId: created.threadId,
    });
    await daemon.relayClient.pollOnce();
    const detailResult = await fetch(`${relayUrl}/api/relay/commands/${encodeURIComponent(detailId)}/result`, {
      headers: { authorization: 'Bearer operator-relay-token' },
    });
    assert.equal(detailResult.status, 200);
    const detailText = await detailResult.text();
    assert.match(detailText, /Relay Control Thread/);
    assert.match(detailText, /relay live output visible only after explicit thread open/);

    const attachId = await enqueue({
      action: 'attach_file',
      targetKind: 'thread',
      targetId: created.threadId,
      message: JSON.stringify({
        files: [{
          name: '../relay-context.txt',
          mimeType: 'text/plain',
          sizeBytes: Buffer.byteLength('relay attachment data'),
          base64: Buffer.from('relay attachment data').toString('base64'),
        }],
      }),
    });
    await daemon.relayClient.pollOnce();
    const attachResult = await fetch(`${relayUrl}/api/relay/commands/${encodeURIComponent(attachId)}/result`, {
      headers: { authorization: 'Bearer operator-relay-token' },
    });
    assert.equal(attachResult.status, 200);
    const attachPayload = (await attachResult.json()) as {
      result: {
        ok: boolean;
        data?: { attachmentCount?: number; attachments?: Array<{ localPath: string }> };
      };
    };
    assert.equal(attachPayload.result.ok, true);
    assert.equal(attachPayload.result.data?.attachmentCount, 1);
    const localPath = attachPayload.result.data?.attachments?.[0]?.localPath;
    assert.ok(localPath);
    assert.match(path.basename(localPath), /relay-context\.txt$/);
    assert.equal(fs.readFileSync(localPath, 'utf8'), 'relay attachment data');

    const approvalId = daemon.approvalRouter.triggerDemoApproval({
      threadId: created.threadId,
      summary: 'relay approval',
    });
    await enqueue({
      action: 'approve',
      targetKind: 'approval',
      targetId: approvalId,
    });
    await daemon.relayClient.pollOnce();
    assert.equal(daemon.repository.findApprovalById(approvalId)?.status, 'approved');

    await daemon.relayClient.postSnapshot();
    const snapshot = await fetch(`${relayUrl}/api/relay/snapshot`, {
      headers: { authorization: 'Bearer operator-relay-token' },
    });
    assert.equal(snapshot.status, 200);
    assert.match(await snapshot.text(), /Relay Control Thread/);
  } finally {
    daemon.stop();
    await relay.stop();
  }
});

test('local status server rejects non-local bind hosts', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-status-bind-'));
  const daemon = new RccDaemon({
    config: {
      ...makeConfig(baseDir),
      localStatusEnabled: true,
      localStatusHost: '0.0.0.0',
      localStatusPort: 0,
    },
    appServerClient: new MockAppServerClient(),
    telegramClient: new MockTelegramClient(),
    logger: new Logger('error'),
    codexSessionsRoot: path.join(baseDir, '.codex', 'sessions'),
  });

  try {
    await assert.rejects(() => daemon.start(), /must bind to localhost/);
  } finally {
    daemon.stop();
  }
});

test('git guardrail blocks push to main', async () => {
  const { daemon, project } = await createDaemon();
  try {
    const thread = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Git Test',
    });

    assert.throws(
      () => daemon.gitGuardrail.requestPushApproval(thread.threadId, 'main'),
      /Push to main is blocked in v1/,
    );
  } finally {
    daemon.stop();
  }
});

test('git guardrail rechecks persisted main push before approval', async () => {
  const { daemon, project } = await createDaemon();
  try {
    const thread = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Git Persisted Main Test',
    });
    const action = daemon.repository.createGitAction(thread.threadId, 'push', 'MAIN', 'Persisted push to main');

    assert.throws(
      () => daemon.gitGuardrail.approvePush(action.id),
      /Push to main is blocked in v1/,
    );

    const updated = daemon.repository.findGitActionById(action.id);
    assert.equal(updated?.status, 'denied');
  } finally {
    daemon.stop();
  }
});

test('startup bootstraps projects from Codex thread cwd when registry is empty', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-bootstrap-test-'));
  const discoveredRoot = path.join(baseDir, 'seeded-project');
  fs.mkdirSync(discoveredRoot, { recursive: true });

  const appServerClient = new MockAppServerClient();
  await appServerClient.startThread({
    cwd: discoveredRoot,
  });

  const daemon = new RccDaemon({
    config: {
      ...makeConfig(baseDir),
      projectAutoDiscoverLimit: 3,
    },
    appServerClient,
    telegramClient: new MockTelegramClient(),
    logger: new Logger('error'),
    codexDesktopStateOptions: {
      codexHome: path.join(baseDir, '.codex'),
      pollIntervalMs: 60_000,
    },
  });
  await daemon.start();

  try {
    const projects = daemon.sessionRegistry.listProjects();
    assert.ok(projects.length > 0);
    assert.ok(projects.some((project) => project.rootPath === discoveredRoot));
  } finally {
    daemon.stop();
  }
});

test('/projects lists registered allowlisted projects', async () => {
  const { daemon, telegramClient, project } = await createDaemon();
  try {
    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-projects-1',
      text: '/projects',
    });
    await waitForAsyncHandlers();

    const last = telegramClient.sentMessages.at(-1)?.text ?? '';
    assert.match(last, /Projects \(1\)/);
    assert.match(last, /project-one/);
    assert.match(last, new RegExp(project.rootPath.split(path.sep).at(-1) ?? 'project'));
  } finally {
    daemon.stop();
  }
});

test('/new and /resume reject missing or unresolved targets', async () => {
  const { daemon, telegramClient } = await createDaemon();
  try {
    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-new-missing-target',
      text: '/new',
    });
    await waitForAsyncHandlers();
    assert.match(telegramClient.sentMessages.at(-1)?.text ?? '', /Usage: \/new <projectRef from \/projects> \[task\]/);

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-new-unknown-project',
      text: '/new 999 draft release notes',
    });
    await waitForAsyncHandlers();
    assert.match(telegramClient.sentMessages.at(-1)?.text ?? '', /Unknown project index 999/);

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-resume-missing-selection',
      text: '/resume',
    });
    await waitForAsyncHandlers();
    assert.match(telegramClient.sentMessages.at(-1)?.text ?? '', /No selected thread\. Use \/pick <threadRef> first\./);

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-resume-unknown-thread',
      text: '/resume abcdef continue implementation',
    });
    await waitForAsyncHandlers();
    assert.match(telegramClient.sentMessages.at(-1)?.text ?? '', /Unknown thread "abcdef"/);
  } finally {
    daemon.stop();
  }
});

test('/help exposes available command list', async () => {
  const { daemon, telegramClient } = await createDaemon();
  try {
    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm1',
      text: '/help',
    });
    await waitForAsyncHandlers();

    const last = telegramClient.sentMessages.at(-1)?.text ?? '';
    assert.match(last, /RCC Codex Connector/);
    assert.match(last, /\/threads/);
    assert.match(last, /\/pick/);
    assert.match(last, /\/run/);
  } finally {
    daemon.stop();
  }
});

test('unauthorized chat is rejected by allowlist', async () => {
  const { daemon, telegramClient } = await createDaemon({
    configOverride: {
      allowedChatIds: ['test-chat'],
    },
  });
  try {
    telegramClient.emitUpdate({
      chatId: 'unauthorized-chat',
      messageId: 'm-unauth-1',
      text: '/help',
    });
    await waitForAsyncHandlers();

    const last = telegramClient.sentMessages.at(-1)?.text ?? '';
    assert.match(last, /Unauthorized chat/);
    assert.doesNotMatch(last, /RCC Codex Connector/);
  } finally {
    daemon.stop();
  }
});

test('/run starts a turn from /threads index and /pick selects thread', async () => {
  const { daemon, telegramClient, project, appServerClient } = await createDaemon();
  try {
    await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Run Command Test',
    });
    await appServerClient.startThread({
      cwd: project.rootPath,
      threadName: 'Existing Codex Thread',
    });

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-codex-list',
      text: '/threads',
    });
    await waitForAsyncHandlers();

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm2',
      text: '/pick 1',
    });
    await waitForAsyncHandlers();

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm3',
      text: '/run write a short plan',
    });
    await waitForAsyncHandlers();

    const runningThreads = daemon
      .sessionRegistry
      .listThreads()
      .filter((thread) => thread.status === 'running');
    assert.ok(runningThreads.length > 0);
    assert.ok(telegramClient.sentMessages.some((message) => message.text.includes('Turn started')));
  } finally {
    daemon.stop();
  }
});

test('/run acknowledges selected-thread work even when historical resume times out', async () => {
  const { daemon, telegramClient, project, appServerClient } = await createDaemon();
  try {
    const created = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Historical Timeout Thread',
    });

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'timeout-pick',
      text: `/pick ${created.codexThreadId.slice(0, 12)}`,
    });
    await waitForAsyncHandlers();

    appServerClient.failNextResume('Request timed out: thread/resume');
    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'timeout-run',
      text: '/run summarize the latest result',
    });
    await waitForAsyncHandlers();

    const messages = telegramClient.sentMessages.map((message) => message.text);
    const ackIndex = messages.findIndex((text) => text.includes('Run request received'));
    const startedIndex = messages.findIndex((text) => text.includes('Turn started'));
    assert.ok(ackIndex >= 0, messages.join('\n---\n'));
    assert.ok(startedIndex >= 0, messages.join('\n---\n'));
    assert.ok(ackIndex < startedIndex, messages.join('\n---\n'));
    assert.equal(daemon.sessionRegistry.findThreadById(created.threadId)?.status, 'running');
  } finally {
    daemon.stop();
  }
});

test('codex bridge starts a turn after best-effort resume timeout', async () => {
  const { daemon, project, appServerClient } = await createDaemon();
  try {
    const created = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Best Effort Resume Thread',
    });

    appServerClient.failNextResume('Request timed out: thread/resume');
    const started = await daemon.codexBridge.startTurn(created.threadId, 'continue after timeout');

    assert.ok(started.turnId);
    assert.equal(appServerClient.startedTurns.at(-1)?.message, 'continue after timeout');
    assert.equal(daemon.sessionRegistry.findThreadById(created.threadId)?.status, 'running');
  } finally {
    daemon.stop();
  }
});

test('codex app-server parser accepts large JSON-RPC lines from historical threads', () => {
  const client = new CodexAppServerClient({
    mode: 'stdio',
    logger: new Logger('error'),
  });
  const observed: string[] = [];
  client.onEvent((event) => {
    if (event.type === 'turn_stream' && event.streamText) {
      observed.push(event.streamText);
    }
  });

  const wire = `${JSON.stringify({
    jsonrpc: '2.0',
    method: 'item/updated',
    params: {
      threadId: 'thread-large-json',
      turnId: 'turn-large-json',
      text: 'large historical stream event accepted',
      padding: 'x'.repeat(9 * 1024 * 1024),
    },
  })}\n`;

  (client as unknown as { handleStreamData(chunk: string): void }).handleStreamData(wire);

  assert.deepEqual(observed, ['large historical stream event accepted']);
});

test('/mode, /plan, /skills, /skill add/clear, and /run --skill work from Telegram command path', async () => {
  const appServerClient = new MockAppServerClient();
  appServerClient.setSkills([
    {
      name: 'reviewer',
      path: '/tmp/reviewer/SKILL.md',
      description: 'Review code changes',
      enabled: true,
    },
  ]);
  const { daemon, telegramClient, project } = await createDaemon({ appServerClient });
  try {
    const created = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Mode Skills Thread',
    });

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'mode-pick',
      text: `/pick ${created.codexThreadId.slice(0, 12)}`,
    });
    await waitForAsyncHandlers();

    telegramClient.emitUpdate({ chatId: 'test-chat', messageId: 'mode-1', text: '/mode plan' });
    await waitForAsyncHandlers();
    assert.equal(daemon.codexBridge.getThreadMode(created.threadId), 'plan');

    telegramClient.emitUpdate({ chatId: 'test-chat', messageId: 'skills-1', text: '/skills' });
    await waitForAsyncHandlers();
    assert.match(telegramClient.sentMessages.at(-1)?.text ?? '', /reviewer/);

    telegramClient.emitUpdate({ chatId: 'test-chat', messageId: 'skill-add-1', text: '/skill add reviewer' });
    await waitForAsyncHandlers();
    assert.deepEqual(daemon.codexBridge.getThreadSkills(created.threadId).map((skill) => skill.name), ['reviewer']);

    telegramClient.emitUpdate({ chatId: 'test-chat', messageId: 'run-skill-1', text: '/run --skill reviewer inspect the diff' });
    await waitForAsyncHandlers();
    assert.equal(appServerClient.startedTurns.at(-1)?.skills?.[0]?.name, 'reviewer');
    assert.match(appServerClient.startedTurns.at(-1)?.message ?? '', /Plan mode requested through RCC/);
    assert.match(appServerClient.startedTurns.at(-1)?.message ?? '', /\$reviewer inspect the diff/);

    telegramClient.emitUpdate({ chatId: 'test-chat', messageId: 'skill-clear-1', text: '/skill clear' });
    await waitForAsyncHandlers();
    assert.equal(daemon.codexBridge.getThreadSkills(created.threadId).length, 0);

    telegramClient.emitUpdate({ chatId: 'test-chat', messageId: 'plan-1', text: '/plan outline the implementation' });
    await waitForAsyncHandlers();
    assert.match(appServerClient.startedTurns.at(-1)?.message ?? '', /Plan mode requested through RCC/);
    assert.match(telegramClient.sentMessages.at(-1)?.text ?? '', /Plan turn started/);
  } finally {
    daemon.stop();
  }
});

test('plan mode always uses safe fallback prompt unless a verified App Server mode method is added', async () => {
  const appServerClient = new MockAppServerClient();
  const { daemon, project } = await createDaemon({ appServerClient });
  try {
    const created = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Fallback Plan Thread',
    });

    await daemon.codexBridge.startTurn(created.threadId, 'draft a plan', { mode: 'plan' });

    const started = appServerClient.startedTurns.at(-1);
    assert.match(started?.message ?? '', /safe planning-only mode/);
    assert.match(started?.message ?? '', /draft a plan/);
  } finally {
    daemon.stop();
  }
});

test('/new creates an allowlisted project thread and can start first turn', async () => {
  const { daemon, telegramClient, project } = await createDaemon();
  try {
    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'projects-for-new',
      text: '/projects',
    });
    await waitForAsyncHandlers();

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'new-1',
      text: '/new 1 draft alpha release notes',
    });
    await waitForAsyncHandlers();

    const threads = daemon.sessionRegistry.listThreads(project.id);
    const created = threads.find((thread) => thread.threadName?.includes('draft alpha release notes'));
    assert.ok(created);
    assert.equal(created.cwd, project.rootPath);
    assert.equal(daemon.sessionRegistry.getOperatorFocusThread(), created.id);
    assert.equal(daemon.sessionRegistry.findThreadById(created.id)?.status, 'running');
    assert.ok(telegramClient.sentMessages.some((message) => message.text.includes('Thread created')));
    assert.ok(telegramClient.sentMessages.some((message) => message.text.includes('Turn started')));
  } finally {
    daemon.stop();
  }
});

test('/resume attaches to an existing thread and can start a turn', async () => {
  const { daemon, telegramClient, project } = await createDaemon();
  try {
    const created = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Resume Test',
    });

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'threads-for-resume',
      text: '/threads',
    });
    await waitForAsyncHandlers();

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'resume-1',
      text: `/resume ${created.codexThreadId.slice(0, 12)} continue implementation`,
    });
    await waitForAsyncHandlers();

    assert.equal(daemon.sessionRegistry.getOperatorFocusThread(), created.threadId);
    assert.equal(daemon.sessionRegistry.findThreadById(created.threadId)?.status, 'running');
    assert.ok(telegramClient.sentMessages.some((message) => message.text.includes('Thread resumed')));
    assert.ok(telegramClient.sentMessages.some((message) => message.text.includes('Turn started')));
  } finally {
    daemon.stop();
  }
});

test('/say steers an active selected thread from Telegram command path', async () => {
  const { daemon, telegramClient, project } = await createDaemon();
  try {
    const created = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Say Command Test',
    });

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'say-pick',
      text: `/pick ${created.codexThreadId.slice(0, 12)}`,
    });
    await waitForAsyncHandlers();

    await daemon.codexBridge.startTurn(created.threadId, 'active task');

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'say-1',
      text: '/say tighten the summary',
    });
    await waitForAsyncHandlers();

    assert.ok(telegramClient.sentMessages.some((message) => message.text.includes('Steering sent to active turn')));
  } finally {
    daemon.stop();
  }
});

test('/run on an active selected thread routes as steering guidance instead of starting another turn', async () => {
  const { daemon, telegramClient, project, appServerClient } = await createDaemon();
  try {
    const created = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Run Active Thread Test',
    });

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'run-active-pick',
      text: `/pick ${created.codexThreadId.slice(0, 12)}`,
    });
    await waitForAsyncHandlers();

    await daemon.codexBridge.startTurn(created.threadId, 'active task');
    const startsBeforeRun = appServerClient.startedTurns.length;

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'run-active',
      text: '/run add this as steering context',
    });
    await waitForAsyncHandlers();

    const messages = telegramClient.sentMessages.map((message) => message.text).join('\n---\n');
    assert.equal(appServerClient.startedTurns.length, startsBeforeRun);
    assert.match(messages, /Thread is already active or waiting/);
    assert.match(messages, /Steering sent to active turn/);
  } finally {
    daemon.stop();
  }
});

test('stale web steering resumes historical thread and starts a new turn instead of surfacing thread not found', async () => {
  const { daemon, appServerClient, project } = await createDaemon();
  try {
    const created = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Historical Thread Recovery',
    });

    await daemon.codexBridge.startTurn(created.threadId, 'active historical task');
    appServerClient.failNextSteer(`[turn/steer] thread not found: ${created.codexThreadId}`);

    const mode = await daemon.steeringAgent.steerOrQueue(created.threadId, 'continue from web relay');

    assert.equal(mode, 'steer_active_turn');
    assert.equal(appServerClient.startedTurns.at(-1)?.message, 'continue from web relay');
    const recovered = daemon.sessionRegistry.findThreadById(created.threadId);
    assert.ok(recovered?.activeTurnId);

    const row = daemon.dbManager.db
      .prepare("SELECT payload_json FROM event_log WHERE event_type = 'SteerForwarded' ORDER BY sequence DESC LIMIT 1")
      .get() as { payload_json: string } | undefined;
    assert.ok(row);
    assert.equal(JSON.parse(row.payload_json).recoveredAs, 'turn_start_after_resume');
  } finally {
    daemon.stop();
  }
});

test('/approve and /deny resolve demo approvals through direct Telegram commands', async () => {
  const { daemon, telegramClient, project } = await createDaemon();
  try {
    const created = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Approval Command Test',
    });

    const approveId = daemon.approvalRouter.triggerDemoApproval({
      threadId: created.threadId,
      summary: 'approve from command',
    });
    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'approve-command',
      text: `/approve ${approveId}`,
    });
    await waitForAsyncHandlers();
    assert.equal(daemon.repository.findApprovalById(approveId)?.status, 'approved');

    const denyId = daemon.approvalRouter.triggerDemoApproval({
      threadId: created.threadId,
      summary: 'deny from command',
    });
    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'deny-command',
      text: `/deny ${denyId}`,
    });
    await waitForAsyncHandlers();
    assert.equal(daemon.repository.findApprovalById(denyId)?.status, 'denied');
  } finally {
    daemon.stop();
  }
});

test('approval callback expires stale request synchronously before resolution', async () => {
  const { daemon, telegramClient, project } = await createDaemon();
  try {
    const created = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Expired Approval Callback Test',
    });

    const approval = daemon.repository.createApproval({
      id: 'approval-expired-callback',
      threadId: created.threadId,
      codexRequestId: 'req-expired-callback',
      turnId: undefined,
      actionType: 'command',
      summary: 'stale approval command',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'expired-callback',
      callbackData: `approve:${approval.id}`,
    });
    await waitForAsyncHandlers();

    assert.equal(daemon.repository.findApprovalById(approval.id)?.status, 'expired');
    assert.match(telegramClient.sentMessages.map((message) => message.text).join('\n'), /expired/);
  } finally {
    daemon.stop();
  }
});

test('app-server approval rejection leaves local approval pending', async () => {
  class RejectingApprovalClient extends MockAppServerClient {
    override async resolveApproval(): Promise<{ ackId: string }> {
      throw new Error('codex rejected stale approval');
    }
  }

  const appServerClient = new RejectingApprovalClient();
  const { daemon, telegramClient, project } = await createDaemon({ appServerClient });
  try {
    const created = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Ack Failure Approval Test',
    });

    appServerClient.emitApprovalRequest({
      requestId: 'req-ack-failure',
      codexThreadId: created.codexThreadId,
      actionType: 'command',
      summary: 'approval should remain pending on ack failure',
      scope: 'once',
    });
    await waitForAsyncHandlers();

    const approval = daemon.repository.listApprovals(created.threadId)[0];
    assert.ok(approval);

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'ack-failure-callback',
      callbackData: `approve:${approval.id}`,
    });
    await waitForAsyncHandlers();

    assert.equal(daemon.repository.findApprovalById(approval.id)?.status, 'pending');
    assert.match(telegramClient.sentMessages.map((message) => message.text).join('\n'), /codex rejected stale approval/);
  } finally {
    daemon.stop();
  }
});

test('/interrupt interrupts an active turn through Telegram command path', async () => {
  const { daemon, telegramClient, project } = await createDaemon();
  try {
    const created = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Interrupt Command Test',
    });
    await daemon.codexBridge.startTurn(created.threadId, 'interruptible task');

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'interrupt-command',
      text: `/interrupt ${created.codexThreadId.slice(0, 12)}`,
    });
    await waitForAsyncHandlers();

    assert.equal(daemon.sessionRegistry.findThreadById(created.threadId)?.status, 'interrupted');
    assert.ok(telegramClient.sentMessages.some((message) => message.text.includes('Interrupted active turn')));
  } finally {
    daemon.stop();
  }
});

test('/attach with selected thread ingests a Telegram file through command path', async () => {
  const { daemon, telegramClient, project, baseDir } = await createDaemon();
  try {
    const created = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Attach Command Test',
    });
    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'attach-pick',
      text: `/pick ${created.codexThreadId.slice(0, 12)}`,
    });
    await waitForAsyncHandlers();

    const sourceFile = path.join(baseDir, 'attach-command.md');
    fs.writeFileSync(sourceFile, '# attach command\n', 'utf8');
    telegramClient.seedFile('attach-command-file', sourceFile);
    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'attach-command',
      text: '/attach',
      attachment: {
        fileId: 'attach-command-file',
        fileName: 'attach-command.md',
        mimeType: 'text/markdown',
        sizeBytes: fs.statSync(sourceFile).size,
      },
    });
    await waitForAsyncHandlers();

    const message = telegramClient.sentMessages.at(-1)?.text ?? '';
    assert.match(message, /Attachment ingested/);
    assert.match(message, /attach-command/);
  } finally {
    daemon.stop();
  }
});

test('desktop approval recovery sends Telegram approval and marks thread waiting_approval', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-desktop-approval-'));
  const desktop = createDesktopMirror(baseDir);
  const appServerClient = new MockAppServerClient();
  const telegramClient = new MockTelegramClient();
  const config = makeConfig(baseDir);

  const daemon = new RccDaemon({
    config,
    appServerClient,
    telegramClient,
    logger: new Logger('error'),
    codexDesktopStateOptions: {
      codexHome: desktop.codexHome,
      pollIntervalMs: 60_000,
    },
  });
  await daemon.start();

  try {
    const projectRoot = path.join(baseDir, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });
    const project = daemon.sessionRegistry.registerProject({
      id: 'p1',
      name: 'project-one',
      rootPath: projectRoot,
    });

    const thread = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Desktop Approval Test',
    });

    desktop.insertThread({
      codexThreadId: thread.codexThreadId,
      cwd: project.rootPath,
      title: 'Desktop Approval Test',
    });

    const nowTs = Math.floor(Date.now() / 1000);
    const turnId = 'turn-desktop-1';
    const callId = 'call_desktop_approval_1';
    const prefix = `session_loop{thread_id=${thread.codexThreadId}}:turn{thread.id=${thread.codexThreadId} turn.id=${turnId}}`;
    desktop.insertLog({
      ts: nowTs,
      target: 'codex_otel.log_only',
      threadId: thread.codexThreadId,
      body: `${prefix}:dispatch_tool_call_with_code_mode_result: event.name="codex.tool_result" tool_name=exec_command call_id=${callId} arguments={"cmd":"cat /etc/hosts","workdir":"${project.rootPath}","sandbox_permissions":"require_escalated"} duration_ms=1 success=true`,
    });
    desktop.insertLog({
      ts: nowTs + 1,
      target: 'codex_core::tools::registry',
      threadId: thread.codexThreadId,
      body: `${prefix}:dispatch_tool_call_with_code_mode_result{otel.name="exec_command" tool_name="exec_command" call_id="${callId}" aborted=false}:dispatch_tool_call_with_code_mode_result: waiting for tool gate`,
    });

    await daemon.desktopStateMonitor.reconcileNow();
    await waitForAsyncHandlers();

    const [approval] = daemon.repository.listApprovals(thread.threadId);
    assert.ok(approval);
    assert.equal(approval.status, 'pending');
    assert.match(approval.summary, /cat \/etc\/hosts/);
    assert.equal(daemon.sessionRegistry.findThreadById(thread.threadId)?.status, 'waiting_approval');
    assert.equal(telegramClient.sentCards.length, 1);
    assert.match(telegramClient.sentMessages.some((message) => /Approval needed/.test(message.text)) ? 'yes' : 'no', /yes/);

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'run-1',
      text: '/running',
    });
    await waitForAsyncHandlers();

    const runningMessage = [...telegramClient.sentMessages].reverse().find((message) => message.text.startsWith('Running Threads'));
    assert.ok(runningMessage);
    assert.match(runningMessage.text, /waiting_approval/);
    assert.match(runningMessage.text, new RegExp(thread.codexThreadId.slice(0, 12)));

    desktop.insertLog({
      ts: nowTs + 2,
      target: 'codex_core::tools::registry',
      threadId: thread.codexThreadId,
      body: `${prefix}:dispatch_tool_call_with_code_mode_result{otel.name="exec_command" tool_name="exec_command" call_id="${callId}" aborted=false}:dispatch_tool_call_with_code_mode_result: tool gate released`,
    });
    desktop.insertLog({
      ts: nowTs + 3,
      target: 'codex_otel.log_only',
      threadId: thread.codexThreadId,
      body: `${prefix}:dispatch_tool_call_with_code_mode_result{otel.name="exec_command" tool_name="exec_command" call_id="${callId}" aborted=false}:dispatch_tool_call_with_code_mode_result: event.name="codex.tool_decision" tool_name=exec_command call_id=${callId} decision=approved source=Config`,
    });

    await daemon.desktopStateMonitor.reconcileNow();
    await waitForAsyncHandlers();

    const resolved = daemon.repository.findApprovalById(approval.id);
    assert.equal(resolved?.status, 'approved');
    assert.match(
      telegramClient.sentMessages.some((message) => /Approval resolved/.test(message.text) && /desktop-log/.test(message.text))
        ? 'yes'
        : 'no',
      /yes/,
    );
  } finally {
    daemon.stop();
    desktop.close();
  }
});

test('desktop approval recovery does not replay a released same-batch gate on startup', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-desktop-approval-same-batch-'));
  const desktop = createDesktopMirror(baseDir);
  const appServerClient = new MockAppServerClient();
  const telegramClient = new MockTelegramClient();
  const config = makeConfig(baseDir);

  const projectRoot = path.join(baseDir, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  const codexThreadId = 'codex-thread-released-same-batch';
  const nowTs = Math.floor(Date.now() / 1000);
  const turnId = 'turn-desktop-same-batch';
  const callId = 'call_desktop_same_batch';
  const prefix = `session_loop{thread_id=${codexThreadId}}:turn{thread.id=${codexThreadId} turn.id=${turnId}}`;
  desktop.insertThread({
    codexThreadId,
    cwd: projectRoot,
    title: 'Desktop Approval Same Batch',
  });
  desktop.insertLog({
    ts: nowTs,
    target: 'codex_core::tools::registry',
    threadId: codexThreadId,
    body: `${prefix}:dispatch_tool_call_with_code_mode_result{otel.name="exec_command" tool_name="exec_command" call_id="${callId}" aborted=false}:dispatch_tool_call_with_code_mode_result: waiting for tool gate`,
  });
  desktop.insertLog({
    ts: nowTs,
    target: 'codex_core::tools::registry',
    threadId: codexThreadId,
    body: `${prefix}:dispatch_tool_call_with_code_mode_result{otel.name="exec_command" tool_name="exec_command" call_id="${callId}" aborted=false}:dispatch_tool_call_with_code_mode_result: tool gate released`,
  });

  const daemon = new RccDaemon({
    config,
    appServerClient,
    telegramClient,
    logger: new Logger('error'),
    codexDesktopStateOptions: {
      codexHome: desktop.codexHome,
      pollIntervalMs: 60_000,
    },
  });
  await daemon.start();
  try {
    await daemon.desktopStateMonitor.reconcileNow();
    await waitForAsyncHandlers();

    const thread = daemon.sessionRegistry.findThreadByCodexThreadId(codexThreadId);
    assert.ok(thread);
    const approvals = daemon.repository.listApprovals(thread.id);
    assert.equal(approvals.length, 0);
    assert.equal(telegramClient.sentCards.length, 0);
    assert.ok(!telegramClient.sentMessages.some((message) => /Approval needed/.test(message.text)));
    assert.ok(!telegramClient.sentMessages.some((message) => /Approval resolved/.test(message.text)));
  } finally {
    daemon.stop();
    desktop.close();
  }
});

test('desktop approval recovery rescans recent unresolved gates beyond checkpoint window', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-desktop-approval-rescan-'));
  const desktop = createDesktopMirror(baseDir);
  const appServerClient = new MockAppServerClient();
  const telegramClient = new MockTelegramClient();
  const config = makeConfig(baseDir);
  const projectRoot = path.join(baseDir, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  const codexThreadId = 'codex-thread-rescan';
  const turnId = 'turn-desktop-rescan';
  const callId = 'call_desktop_rescan';
  const nowTs = Math.floor(Date.now() / 1000);
  const prefix = `session_loop{thread_id=${codexThreadId}}:turn{thread.id=${codexThreadId} turn.id=${turnId}}`;

  desktop.insertThread({
    codexThreadId,
    cwd: projectRoot,
    title: 'Desktop Approval Rescan',
  });
  desktop.insertLog({
    ts: nowTs,
    target: 'codex_core::tools::registry',
    threadId: codexThreadId,
    body: `${prefix}:dispatch_tool_call_with_code_mode_result{otel.name="exec_command" tool_name="exec_command" call_id="${callId}" aborted=false}:dispatch_tool_call_with_code_mode_result: waiting for tool gate`,
  });

  const daemon = new RccDaemon({
    config,
    appServerClient,
    telegramClient,
    logger: new Logger('error'),
    codexDesktopStateOptions: {
      codexHome: desktop.codexHome,
      pollIntervalMs: 60_000,
      bootstrapRows: 0,
    },
  });
  await daemon.start();

  try {
    await daemon.desktopStateMonitor.reconcileNow();
    await waitForAsyncHandlers();

    const approval = daemon.repository.findApprovalByCodexRequestId(`desktop:${callId}`);
    assert.ok(approval);
    assert.equal(approval.status, 'pending');
    const thread = daemon.sessionRegistry.findThreadByCodexThreadId(codexThreadId);
    assert.ok(thread);
    assert.equal(thread.status, 'waiting_approval');
    assert.equal(telegramClient.sentCards.length, 1);
  } finally {
    daemon.stop();
    desktop.close();
  }
});

test('desktop approval recovery does not replay a superseded approval for the same call', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-desktop-approval-no-replay-'));
  const desktop = createDesktopMirror(baseDir);
  const appServerClient = new MockAppServerClient();
  const telegramClient = new MockTelegramClient();
  const config = makeConfig(baseDir);
  const projectRoot = path.join(baseDir, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  const codexThreadId = 'codex-thread-no-replay';
  const turnId = 'turn-desktop-no-replay';
  const callId = 'call_desktop_no_replay';
  const nowTs = Math.floor(Date.now() / 1000);
  const prefix = `session_loop{thread_id=${codexThreadId}}:turn{thread.id=${codexThreadId} turn.id=${turnId}}`;

  desktop.insertThread({
    codexThreadId,
    cwd: projectRoot,
    title: 'Desktop Approval No Replay',
  });
  desktop.insertLog({
    ts: nowTs,
    target: 'codex_core::tools::registry',
    threadId: codexThreadId,
    body: `${prefix}:dispatch_tool_call_with_code_mode_result{otel.name="exec_command" tool_name="exec_command" call_id="${callId}" aborted=false}:dispatch_tool_call_with_code_mode_result: waiting for tool gate`,
  });

  const daemon = new RccDaemon({
    config,
    appServerClient,
    telegramClient,
    logger: new Logger('error'),
    codexDesktopStateOptions: {
      codexHome: desktop.codexHome,
      pollIntervalMs: 60_000,
      bootstrapRows: 0,
    },
  });
  await daemon.start();

  try {
    await daemon.desktopStateMonitor.reconcileNow();
    await waitForAsyncHandlers();

    const approval = daemon.repository.findApprovalByCodexRequestId(`desktop:${callId}`);
    assert.ok(approval);
    assert.equal(approval.status, 'pending');
    assert.equal(telegramClient.sentCards.length, 1);

    daemon.repository.updateApprovalStatus(approval.id, 'superseded');
    await daemon.desktopStateMonitor.reconcileNow();
    await waitForAsyncHandlers();

    const approvals = daemon.repository
      .listApprovals()
      .filter((item) => item.codexRequestId === `desktop:${callId}`);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]?.status, 'superseded');
    assert.equal(telegramClient.sentCards.length, 1);
  } finally {
    daemon.stop();
    desktop.close();
  }
});

test('/threads falls back to local desktop state when app-server thread/list is overloaded', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-desktop-fallback-list-'));
  const desktop = createDesktopMirror(baseDir);
  const appServerClient = new MockAppServerClient();
  const telegramClient = new MockTelegramClient();
  const config = makeConfig(baseDir);

  const daemon = new RccDaemon({
    config,
    appServerClient,
    telegramClient,
    logger: new Logger('error'),
    codexDesktopStateOptions: {
      codexHome: desktop.codexHome,
      pollIntervalMs: 60_000,
    },
    codexSessionsRoot: path.join(desktop.codexHome, 'sessions'),
  });
  await daemon.start();

  try {
    const projectRoot = path.join(baseDir, 'demo-app');
    fs.mkdirSync(projectRoot, { recursive: true });
    desktop.insertThread({
      codexThreadId: '019dc24b-7e7c-70c2-a389-0ed243129875',
      cwd: projectRoot,
      title: 'List relevant docs',
      updatedAtMs: Date.now(),
    });
    appServerClient.setListThreadsError('[thread/list] Server overloaded; retry later.');

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-fallback-threads',
      text: '/threads',
    });
    await waitForAsyncHandlers();

    const last = telegramClient.sentMessages.at(-1)?.text ?? '';
    assert.match(last, /Codex Threads/);
    assert.match(last, /List relevant docs/);
  } finally {
    daemon.stop();
    desktop.close();
  }
});

test('/threads merges desktop catalog threads even when app-server list succeeds', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-desktop-merge-list-'));
  const desktop = createDesktopMirror(baseDir);
  const appServerClient = new MockAppServerClient();
  const telegramClient = new MockTelegramClient();
  const config = makeConfig(baseDir);

  const daemon = new RccDaemon({
    config,
    appServerClient,
    telegramClient,
    logger: new Logger('error'),
    codexDesktopStateOptions: {
      codexHome: desktop.codexHome,
      pollIntervalMs: 60_000,
    },
    codexSessionsRoot: path.join(desktop.codexHome, 'sessions'),
  });
  await daemon.start();

  try {
    const projectRoot = path.join(baseDir, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });
    const project = daemon.sessionRegistry.registerProject({
      id: 'p1',
      name: 'project-one',
      rootPath: projectRoot,
    });

    await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'App Server Thread',
    });

    desktop.insertThread({
      codexThreadId: 'desktop-only-thread',
      cwd: path.join(baseDir, 'scratch'),
      title: 'Desktop Only Scratch',
      updatedAtMs: Date.now(),
    });

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'threads-merge',
      text: '/threads 10',
    });
    await waitForAsyncHandlers();

    const last = telegramClient.sentMessages.at(-1)?.text ?? '';
    assert.match(last, /App Server Thread/);
    assert.match(last, /Desktop Only Scratch/);
  } finally {
    daemon.stop();
    desktop.close();
  }
});

test('approval request for unmapped thread falls back to local desktop state when thread/list is overloaded', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-desktop-fallback-approval-'));
  const desktop = createDesktopMirror(baseDir);
  const appServerClient = new MockAppServerClient();
  const telegramClient = new MockTelegramClient();
  const config = makeConfig(baseDir);

  const daemon = new RccDaemon({
    config,
    appServerClient,
    telegramClient,
    logger: new Logger('error'),
    codexDesktopStateOptions: {
      codexHome: desktop.codexHome,
      pollIntervalMs: 60_000,
    },
    codexSessionsRoot: path.join(desktop.codexHome, 'sessions'),
  });
  await daemon.start();

  try {
    const projectRoot = path.join(baseDir, 'demo-app');
    fs.mkdirSync(projectRoot, { recursive: true });
    const codexThreadId = '019dc24b-7e7c-70c2-a389-0ed243129875';
    desktop.insertThread({
      codexThreadId,
      cwd: projectRoot,
      title: 'List relevant docs',
      updatedAtMs: Date.now(),
    });
    appServerClient.setListThreadsError('Request timed out: thread/list');

    appServerClient.emitApprovalRequest({
      requestId: 'req-demo-app-approval',
      codexThreadId,
      actionType: 'command',
      summary: 'Plan mode approval',
      scope: 'once',
    });
    await waitForAsyncHandlers();

    assert.equal(telegramClient.sentCards.length, 1);
    assert.match(telegramClient.sentCards[0]?.threadNameOrId ?? '', /List relevant docs/);
    const joined = telegramClient.sentMessages.map((message) => message.text).join('\n');
    assert.match(joined, /Approval needed/);
    assert.match(joined, /Thread: List relevant docs/);
  } finally {
    daemon.stop();
    desktop.close();
  }
});

test('/threads[n] bracket syntax is accepted', async () => {
  const { daemon, telegramClient, appServerClient, project } = await createDaemon();
  try {
    await appServerClient.startThread({
      cwd: project.rootPath,
      threadName: 'Bracket Syntax Thread',
    });

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm3',
      text: '/threads[3]',
    });
    await waitForAsyncHandlers();

    const last = telegramClient.sentMessages.at(-1)?.text ?? '';
    assert.match(last, /Codex Threads/);
  } finally {
    daemon.stop();
  }
});

test('/threads limit[2] limits results', async () => {
  const { daemon, telegramClient, appServerClient, project } = await createDaemon();
  try {
    await appServerClient.startThread({
      cwd: project.rootPath,
      threadName: 'Alias Thread One',
    });
    await appServerClient.startThread({
      cwd: project.rootPath,
      threadName: 'Alias Thread Two',
    });
    await appServerClient.startThread({
      cwd: project.rootPath,
      threadName: 'Alias Thread Three',
    });

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm4',
      text: '/threads limit[2]',
    });
    await waitForAsyncHandlers();

    const last = telegramClient.sentMessages.at(-1)?.text ?? '';
    assert.match(last, /Codex Threads \(2\//);
  } finally {
    daemon.stop();
  }
});

test('/sync_codex is deprecated (threads are live)', async () => {
  const { daemon, telegramClient, appServerClient, project } = await createDaemon();
  try {
    await appServerClient.startThread({
      cwd: project.rootPath,
      threadName: 'Sync Thread One',
    });
    await appServerClient.startThread({
      cwd: project.rootPath,
      threadName: 'Sync Thread Two',
    });

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-sync',
      text: '/sync_codex',
    });
    await waitForAsyncHandlers();

    const last = telegramClient.sentMessages.at(-1)?.text ?? '';
    assert.match(last, /Deprecated\. Use \/threads/);
  } finally {
    daemon.stop();
  }
});

test('/running refreshes from live Codex and shows active threads even before manual sync', async () => {
  const { daemon, telegramClient, appServerClient, project } = await createDaemon();
  try {
    const thread = await appServerClient.startThread({
      cwd: project.rootPath,
      threadName: 'Live Running Thread',
    });
    await appServerClient.startTurn({
      codexThreadId: thread.codexThreadId,
      message: 'Run live work',
    });

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-running-live',
      text: '/running',
    });
    await waitForAsyncHandlers();

    const last = telegramClient.sentMessages.at(-1)?.text ?? '';
    assert.match(last, /Running Threads \(1\)/);
    assert.match(last, /Live Running Thread/);
  } finally {
    daemon.stop();
  }
});

test('/pick uses the latest /running list indices, not stale /threads indices', async () => {
  const { daemon, telegramClient, appServerClient, project } = await createDaemon();
  try {
    await appServerClient.startThread({
      cwd: project.rootPath,
      threadName: 'Idle Thread',
    });
    const running = await appServerClient.startThread({
      cwd: project.rootPath,
      threadName: 'Running Thread',
    });
    await appServerClient.startTurn({
      codexThreadId: running.codexThreadId,
      message: 'live work',
    });

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-run-pick-1',
      text: '/threads',
    });
    await waitForAsyncHandlers();

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-run-pick-2',
      text: '/running',
    });
    await waitForAsyncHandlers();

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-run-pick-3',
      text: '/pick 1',
    });
    await waitForAsyncHandlers();

    const selected = telegramClient.sentMessages.at(-1)?.text ?? '';
    assert.match(selected, /Running Thread/);
  } finally {
    daemon.stop();
  }
});

test('/threads [2] shorthand bracket arg limits results', async () => {
  const { daemon, telegramClient, appServerClient, project } = await createDaemon();
  try {
    await appServerClient.startThread({
      cwd: project.rootPath,
      threadName: 'Short A',
    });
    await appServerClient.startThread({
      cwd: project.rootPath,
      threadName: 'Short B',
    });
    await appServerClient.startThread({
      cwd: project.rootPath,
      threadName: 'Short C',
    });

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm8',
      text: '/threads [2]',
    });
    await waitForAsyncHandlers();

    const last = telegramClient.sentMessages.at(-1)?.text ?? '';
    assert.match(last, /Codex Threads \(2\//);
  } finally {
    daemon.stop();
  }
});

test('/run with natural-language first word does not override selected thread', async () => {
  const { daemon, telegramClient, project, appServerClient } = await createDaemon();
  try {
    const selectedCodex = await appServerClient.startThread({
      cwd: project.rootPath,
      threadName: 'Plan RCC build with subagents',
    });
    await appServerClient.startThread({
      cwd: project.rootPath,
      threadName: 'Run NN baseline',
    });

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm5',
      text: '/threads limit[5]',
    });
    await waitForAsyncHandlers();

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm6',
      text: '/pick Plan RCC build with subagents',
    });
    await waitForAsyncHandlers();

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm7',
      text: '/run Run exactly this command: git status --short',
    });
    await waitForAsyncHandlers();

    const mapped = daemon.sessionRegistry.findThreadByCodexThreadId(selectedCodex.codexThreadId);
    assert.ok(mapped);
    const operatorMessage = daemon.repository.listOperatorMessages(mapped!.id, 1)[0];
    assert.ok(operatorMessage);
    assert.match(operatorMessage?.messageText ?? '', /Run exactly this command: git status --short/);
  } finally {
    daemon.stop();
  }
});

test('completion pushes status but does not auto-send artifact files', async () => {
  const { daemon, appServerClient, telegramClient, project } = await createDaemon();
  try {
    const created = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'No Auto Artifact Push',
    });

    daemon.sessionRegistry.setOperatorFocusThread(created.threadId);
    const started = await daemon.codexBridge.startTurn(created.threadId, 'quick task');
    fs.writeFileSync(path.join(project.rootPath, 'completion-output.md'), '# done', 'utf8');
    appServerClient.emitTurnCompleted(created.codexThreadId, started.turnId);
    await waitForAsyncHandlers();

    const joined = telegramClient.sentMessages.map((m) => m.text).join('\n');
    assert.match(joined, /Completed/);
    assert.match(joined, /Result/);
    assert.match(joined, /completion-output\.md/);
    assert.match(joined, /Use \/artifact to fetch files from this thread/);
    assert.equal(telegramClient.sentDocuments.length, 0);
  } finally {
    daemon.stop();
  }
});

test('completion result falls back to captured App Server output when session tail is empty', async () => {
  const { daemon, appServerClient, telegramClient, project } = await createDaemon();
  try {
    const created = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Completion Output Fallback',
    });

    daemon.sessionRegistry.setOperatorFocusThread(created.threadId);
    const started = await daemon.codexBridge.startTurn(created.threadId, 'produce final output');
    appServerClient.emitTurnStream(created.codexThreadId, started.turnId, 'final answer from app server');
    await waitForAsyncHandlers();

    appServerClient.emitTurnCompleted(created.codexThreadId, started.turnId);
    await waitForAsyncHandlers();
    const result = telegramClient.sentMessages
      .map((message) => message.text)
      .find((message) => message.startsWith('Result\n') && message.includes('Completion Output Fallback')) ?? '';

    assert.match(result, /Assistant: final answer from app server/);
    assert.doesNotMatch(result, /no assistant text captured/);
  } finally {
    daemon.stop();
  }
});

test('/pick rejects extra arguments to avoid ambiguous selection', async () => {
  const { daemon, telegramClient, appServerClient, project } = await createDaemon();
  try {
    await appServerClient.startThread({
      cwd: project.rootPath,
      threadName: 'Strict Pick Test',
    });

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-p1',
      text: '/threads',
    });
    await waitForAsyncHandlers();

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-p2',
      text: '/pick 1 extra',
    });
    await waitForAsyncHandlers();

    const last = telegramClient.sentMessages.at(-1)?.text ?? '';
    assert.match(last, /Usage: \/pick <threadRef from \/threads>/);
  } finally {
    daemon.stop();
  }
});

test('/approval-demo creates approval card and resolves through callback', async () => {
  const { daemon, telegramClient, appServerClient, project } = await createDaemon();
  try {
    await appServerClient.startThread({
      cwd: project.rootPath,
      threadName: 'Approval Demo Thread',
    });

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-a1',
      text: '/threads',
    });
    await waitForAsyncHandlers();

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-a2',
      text: '/pick 1',
    });
    await waitForAsyncHandlers();

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-a3',
      text: '/approval_demo',
    });
    await waitForAsyncHandlers();

    const card = telegramClient.sentCards.at(-1);
    assert.ok(card);
    assert.ok(card?.approvalId);

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-a4',
      callbackData: `approve:${card?.approvalId}`,
    });
    await waitForAsyncHandlers();

    const approval = card?.approvalId ? daemon.repository.findApprovalById(card.approvalId) : undefined;
    assert.equal(approval?.status, 'approved');

    const eventTypes = daemon.dbManager.db
      .prepare('SELECT event_type FROM event_log ORDER BY sequence ASC')
      .all() as Array<{ event_type: string }>;
    assert.ok(eventTypes.some((row) => row.event_type === 'ApprovalResolutionForwarded'));
    assert.ok(eventTypes.some((row) => row.event_type === 'ApprovalResolutionAcked'));
  } finally {
    daemon.stop();
  }
});

test('duplicate approval callbacks are idempotent and do not throw race errors', async () => {
  const { daemon, telegramClient, appServerClient, project } = await createDaemon();
  try {
    const created = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Duplicate Callback Thread',
    });

    appServerClient.emitApprovalRequest({
      requestId: 'req-duplicate',
      codexThreadId: created.codexThreadId,
      actionType: 'command',
      summary: 'duplicate callback test',
      scope: 'once',
    });
    await waitForAsyncHandlers();

    const approval = daemon.repository.listApprovals(created.threadId)[0];
    assert.ok(approval);

    const callback = `approve:${approval?.id}`;
    const results = await Promise.allSettled([
      daemon.approvalRouter.resolveFromTelegramCallback(callback),
      daemon.approvalRouter.resolveFromTelegramCallback(callback),
    ]);
    assert.ok(results.every((result) => result.status === 'fulfilled'));

    const resolved = approval ? daemon.repository.findApprovalById(approval.id) : undefined;
    assert.equal(resolved?.status, 'approved');
  } finally {
    daemon.stop();
  }
});

test('desktop recovered approval cannot be resolved remotely when strategy is appserver_only', async () => {
  const { daemon, project, telegramClient } = await createDaemon({
    configOverride: {
      approvalStrategy: 'appserver_only',
    },
  });
  try {
    const thread = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Desktop Approval Policy Block',
    });

    daemon.repository.createApproval({
      id: 'approval-desktop-policy-block',
      threadId: thread.threadId,
      codexRequestId: 'desktop:policy-block:1',
      turnId: undefined,
      actionType: 'command',
      summary: 'cat /etc/hosts',
      status: 'pending',
    });

    await daemon.approvalRouter.resolveFromTelegramCallback('approve:approval-desktop-policy-block');
    const approval = daemon.repository.findApprovalById('approval-desktop-policy-block');
    assert.equal(approval?.status, 'pending');
    assert.match(
      telegramClient.sentMessages.map((message) => message.text).join('\n'),
      /Remote approval is disabled by policy/,
    );
  } finally {
    daemon.stop();
  }
});

test('desktop recovered approval resolves via ui automation when enabled', async () => {
  const calls: Array<{ decision: 'approved' | 'denied'; approvalId: string; codexRequestId: string }> = [];
  const mockUiApproval: UiApprovalAutomationService = {
    async resolveInCodexDesktop(input) {
      calls.push(input);
      return { ackId: `ui-automation:${input.codexRequestId}:test` };
    },
  };

  const { daemon, project, telegramClient } = await createDaemon({
    configOverride: {
      uiAutomationEnabled: true,
    },
    uiApprovalAutomation: mockUiApproval,
  });
  try {
    const thread = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Desktop Approval UI Path',
    });

    daemon.repository.createApproval({
      id: 'approval-desktop-ui',
      threadId: thread.threadId,
      codexRequestId: 'desktop:ui-path:1',
      turnId: undefined,
      actionType: 'command',
      summary: 'git status --short',
      status: 'pending',
    });

    await daemon.approvalRouter.resolveFromTelegramCallback('approve:approval-desktop-ui');

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.approvalId, 'approval-desktop-ui');
    assert.equal(calls[0]?.decision, 'approved');
    assert.equal(calls[0]?.codexRequestId, 'desktop:ui-path:1');
    const approval = daemon.repository.findApprovalById('approval-desktop-ui');
    assert.equal(approval?.status, 'approved');
    const sent = telegramClient.sentMessages.map((message) => message.text).join('\n');
    assert.match(sent, /Resolved approval-desktop-ui via ui_automation/);
    assert.match(sent, /Source: ui-automation/);
  } finally {
    daemon.stop();
  }
});

test('desktop recovered approval sends explicit operator error when ui automation fallback cannot act', async () => {
  const mockUiApproval: UiApprovalAutomationService = {
    async resolveInCodexDesktop() {
      throw new Error(
        'UI automation failed: no accessible Codex window found. Keep Codex open, unlocked, and make sure the approval card is visible.',
      );
    },
  };

  const { daemon, project, telegramClient } = await createDaemon({
    configOverride: {
      uiAutomationEnabled: true,
    },
    uiApprovalAutomation: mockUiApproval,
  });
  try {
    const thread = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Desktop Approval UI Failure',
    });

    daemon.repository.createApproval({
      id: 'approval-desktop-ui-failure',
      threadId: thread.threadId,
      codexRequestId: 'desktop:ui-path:failure',
      turnId: undefined,
      actionType: 'command',
      summary: 'cat /etc/hosts',
      status: 'pending',
    });

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-ui-failure',
      callbackData: 'approve:approval-desktop-ui-failure',
    });
    await waitForAsyncHandlers();

    const approval = daemon.repository.findApprovalById('approval-desktop-ui-failure');
    assert.equal(approval?.status, 'pending');
    const sent = telegramClient.sentMessages.map((message) => message.text).join('\n');
    assert.match(sent, /Approval approval-desktop-ui-failure was not changed in Codex/);
    assert.match(sent, /UI automation failed: no accessible Codex window found/);
    assert.match(sent, /Keep Codex open\/unlocked with the approval card visible/);
  } finally {
    daemon.stop();
  }
});

test('ui automation normalizes missing Codex window errors', () => {
  const service = new AppleScriptApprovalAutomationService(new Logger('error')) as unknown as {
    normalizeOsascriptError(message: string): string;
  };

  const normalized = service.normalizeOsascriptError(
    '107:150: execution error: System Events got an error: Can’t get window 1 of process "Codex". Invalid index. (-1719)',
  );

  assert.equal(
    normalized,
    'UI automation failed: no accessible Codex window found. Keep Codex open, unlocked, and make sure the approval card is visible.',
  );
});

test('/last reflects Codex session tail for desktop-started work', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-desktop-last-'));
  const desktop = createDesktopMirror(baseDir);
  const appServerClient = new MockAppServerClient();
  const telegramClient = new MockTelegramClient();
  const config = makeConfig(baseDir);
  const daemon = new RccDaemon({
    config,
    appServerClient,
    telegramClient,
    logger: new Logger('error'),
    codexDesktopStateOptions: {
      codexHome: desktop.codexHome,
      pollIntervalMs: 60_000,
    },
    codexSessionsRoot: path.join(desktop.codexHome, 'sessions'),
  });
  await daemon.start();

  try {
    const projectRoot = path.join(baseDir, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });
    const project = daemon.sessionRegistry.registerProject({
      id: 'p1',
      name: 'project-one',
      rootPath: projectRoot,
    });

    const thread = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Desktop Started Thread',
    });

    const sessionDir = path.join(desktop.codexHome, 'sessions', '2026', '04', '25');
    fs.mkdirSync(sessionDir, { recursive: true });
    const rolloutPath = path.join(sessionDir, `rollout-2026-04-25T10-00-00-${thread.codexThreadId}.jsonl`);
    fs.writeFileSync(
      rolloutPath,
      [
        JSON.stringify({
          timestamp: '2026-04-25T10:00:00.000Z',
          payload: {
            type: 'message',
            content: [{ type: 'input_text', text: 'continue the Nexus scope doc and summarize blockers' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-25T10:00:02.000Z',
          payload: {
            type: 'message',
            content: [{ type: 'output_text', text: 'I updated the draft and listed two blockers.' }],
          },
        }),
      ].join('\n'),
      'utf8',
    );

    desktop.insertThread({
      codexThreadId: thread.codexThreadId,
      cwd: project.rootPath,
      title: 'Desktop Started Thread',
      rolloutPath,
      updatedAtMs: Date.now(),
    });

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-last-1',
      text: '/threads',
    });
    await waitForAsyncHandlers();

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-last-2',
      text: '/pick 1',
    });
    await waitForAsyncHandlers();

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-last-3',
      text: '/last',
    });
    await waitForAsyncHandlers();

    const last = telegramClient.sentMessages.at(-1)?.text ?? '';
    assert.match(last, /Last instruction \(via RCC\/Telegram\):\n\(none recorded; this thread may have been started from the desktop app\)/);
    assert.match(last, /Last instruction \(Codex session\):\ncontinue the Nexus scope doc and summarize blockers/);
    assert.match(last, /Last assistant: I updated the draft and listed two blockers\./);
  } finally {
    daemon.stop();
    desktop.close();
  }
});

	test('/artifact is list-first and only sends files after explicit send command', async () => {
	  const { daemon, telegramClient, appServerClient, project } = await createDaemon();
	  try {
	    const codexThread = await appServerClient.startThread({
	      cwd: project.rootPath,
	      threadName: 'Artifact Flow Thread',
	    });

	    telegramClient.emitUpdate({
	      chatId: 'test-chat',
	      messageId: 'm-f1',
      text: '/threads',
    });
    await waitForAsyncHandlers();

	    telegramClient.emitUpdate({
	      chatId: 'test-chat',
	      messageId: 'm-f2',
	      text: '/pick 1',
	    });
	    await waitForAsyncHandlers();

	    const mapped = daemon.sessionRegistry.findThreadByCodexThreadId(codexThread.codexThreadId);
	    assert.ok(mapped);
	    const artifactDir = path.join(daemon.config.artifactsRoot, mapped.id);
	    fs.mkdirSync(artifactDir, { recursive: true });
	    const artifactPath = path.join(artifactDir, 'artifact_list_first_test.md');
	    fs.writeFileSync(artifactPath, '# artifact', 'utf8');

	    telegramClient.emitUpdate({
	      chatId: 'test-chat',
	      messageId: 'm-f3',
	      text: '/artifact',
	    });
    await waitForAsyncHandlers();

    assert.equal(telegramClient.sentDocuments.length, 0);
    const listed = telegramClient.sentMessages.at(-1)?.text ?? '';
    assert.match(listed, /No files are auto-sent|Artifacts for/);

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-f4',
      text: '/artifact send 1',
    });
    await waitForAsyncHandlers();

    assert.equal(telegramClient.sentDocuments.length, 1);
  } finally {
    daemon.stop();
	  }
	});

test('oversized artifact falls back to manifest without sending document', async () => {
  const { daemon, telegramClient, project } = await createDaemon({
    configOverride: {
      telegramSendDocumentLimitBytes: 1,
    },
  });
  try {
    const thread = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Artifact Fallback Thread',
    });

    const artifactDir = path.join(daemon.config.artifactsRoot, thread.threadId);
    fs.mkdirSync(artifactDir, { recursive: true });
    const artifactPath = path.join(artifactDir, 'oversized_artifact.md');
    fs.writeFileSync(artifactPath, '# oversized artifact\n', 'utf8');
    const artifact = daemon.repository.createArtifact({
      id: 'artifact-oversized-manifest',
      threadId: thread.threadId,
      artifactType: 'md',
      filename: 'oversized_artifact.md',
      localPath: artifactPath,
      sizeBytes: fs.statSync(artifactPath).size,
      status: 'detected',
    });

    const result = await daemon.artifactWatcher.sendArtifacts(thread.threadId, [artifact.id]);

    assert.deepEqual(result, { sent: 0, manifested: 1 });
    assert.equal(telegramClient.sentDocuments.length, 0);
    const fallback = telegramClient.sentMessages.at(-1)?.text ?? '';
    assert.match(fallback, /Artifact too large for direct Telegram delivery/);
    assert.match(fallback, /Local path:/);
    assert.match(fallback, /Manifest:/);

    const manifestPath = fallback.match(/Manifest: (.+)$/m)?.[1]?.trim();
    assert.ok(manifestPath);
    assert.ok(fs.existsSync(manifestPath));

    const updated = daemon.repository.listArtifactsByThread(thread.threadId).find((item) => item.id === artifact.id);
    assert.equal(updated?.status, 'manifested');
  } finally {
    daemon.stop();
  }
});

test('artifact sending blocks stored paths outside the thread artifact root', async () => {
  const { daemon, telegramClient, project, baseDir } = await createDaemon();
  try {
    const thread = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Artifact Path Policy Thread',
    });

    const outsidePath = path.join(baseDir, 'outside-secret.md');
    fs.writeFileSync(outsidePath, '# should not be sent\n', 'utf8');
    const artifact = daemon.repository.createArtifact({
      id: 'artifact-outside-root',
      threadId: thread.threadId,
      artifactType: 'md',
      filename: 'outside-secret.md',
      localPath: outsidePath,
      sizeBytes: fs.statSync(outsidePath).size,
      status: 'detected',
    });

    const result = await daemon.artifactWatcher.sendArtifacts(thread.threadId, [artifact.id]);

    assert.deepEqual(result, { sent: 0, manifested: 0 });
    assert.equal(telegramClient.sentDocuments.length, 0);
    assert.equal(daemon.repository.listArtifactsByThread(thread.threadId).find((item) => item.id === artifact.id)?.status, 'failed');
    assert.match(telegramClient.sentMessages.at(-1)?.text ?? '', /Artifact blocked by path policy/);
  } finally {
    daemon.stop();
  }
});

	test('turn stream events are mirrored to Telegram updates', async () => {
	  const { daemon, telegramClient, project, appServerClient } = await createDaemon();
	  try {
	    const created = await daemon.codexBridge.createThread({
	      projectId: project.id,
	      cwd: project.rootPath,
	      threadName: 'Stream Mirror Thread',
	    });
	    // Stream output should only be forwarded for the focused thread.
	    daemon.sessionRegistry.setOperatorFocusThread(created.threadId);
	    const started = await daemon.codexBridge.startTurn(created.threadId, 'stream test');
	    appServerClient.emitTurnStream(created.codexThreadId, started.turnId, 'stream output hello');
	    // Stream forwarding is coalesced on a timer.
	    await new Promise((resolve) => setTimeout(resolve, 1400));

	    const joined = telegramClient.sentMessages.map((m) => m.text).join('\n');
	    assert.match(joined, /Update/);
	    assert.match(joined, /stream output hello/);
  } finally {
    daemon.stop();
  }
});

test('background threads send alerts but do not stream live output when another thread is focused', async () => {
  const { daemon, telegramClient, project, appServerClient } = await createDaemon();
  try {
    const focused = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Focused Thread',
    });
    const background = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Background Thread',
    });

    daemon.sessionRegistry.setOperatorFocusThread(focused.threadId);

    const focusedTurn = await daemon.codexBridge.startTurn(focused.threadId, 'focus task');
    const backgroundTurn = await daemon.codexBridge.startTurn(background.threadId, 'background task');

    appServerClient.emitTurnStream(focused.codexThreadId, focusedTurn.turnId, 'focused stream hello');
    appServerClient.emitTurnStream(background.codexThreadId, backgroundTurn.turnId, 'background stream should stay muted');
    await new Promise((resolve) => setTimeout(resolve, 1400));

    const joined = telegramClient.sentMessages.map((m) => m.text).join('\n');
    assert.match(joined, /Running\nProject: project-one\nThread: Focused Thread/);
    assert.match(joined, /Running\nProject: project-one\nThread: Background Thread/);
    assert.match(joined, /focused stream hello/);
    assert.doesNotMatch(joined, /background stream should stay muted/);
  } finally {
    daemon.stop();
  }
});

test('reasoning summaries are persisted, redacted, and exposed as summaries only', async () => {
  const { daemon, telegramClient, project, appServerClient } = await createDaemon({
    configOverride: {
      localStatusEnabled: true,
      localStatusHost: '127.0.0.1',
      localStatusPort: 0,
    },
  });
  try {
    const created = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Reasoning Summary Thread',
    });
    daemon.sessionRegistry.setOperatorFocusThread(created.threadId);
    const started = await daemon.codexBridge.startTurn(created.threadId, 'summary task');
    assert.equal(appServerClient.startedTurns.at(-1)?.reasoningSummary, 'auto');

    appServerClient.emitReasoningSummary(
      created.codexThreadId,
      started.turnId,
      'Inspecting files with API_KEY=supersecretvalue123 and Bearer abcdefghijklmnopqrstuvwxyz123456.',
    );
    await waitForAsyncHandlers();

    const rows = daemon.dbManager.db
      .prepare("SELECT payload_json FROM event_log WHERE event_type = 'ReasoningSummaryObserved'")
      .all() as Array<{ payload_json: string }>;
    assert.equal(rows.length, 1);
    assert.doesNotMatch(rows[0]!.payload_json, /supersecretvalue123|abcdefghijklmnopqrstuvwxyz123456/);
    assert.match(rows[0]!.payload_json, /REDACTED/);

    const summaries = daemon.repository.listRecentReasoningSummaries(created.threadId, 5);
    assert.equal(summaries.length, 1);
    assert.match(summaries[0]!.text, /API_KEY=\[REDACTED\]/);
    assert.match(summaries[0]!.text, /Bearer \[REDACTED\]/);

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-thinking',
      text: '/thinking',
    });
    await waitForAsyncHandlers();
    const joined = telegramClient.sentMessages.map((m) => m.text).join('\n');
    assert.match(joined, /Reasoning Summary for selected thread:/);
    assert.match(joined, /This is an App Server-exposed summary, not raw hidden reasoning\./);
    assert.doesNotMatch(joined, /supersecretvalue123|abcdefghijklmnopqrstuvwxyz123456/);

    const url = daemon.localStatusServer.url();
    assert.ok(url);
    const detail = await fetch(`${url}/api/threads/${encodeURIComponent(created.threadId)}`).then((response) => response.text());
    assert.match(detail, /reasoningSummaries/);
    assert.match(detail, /API_KEY=\[REDACTED\]/);
    assert.doesNotMatch(detail, /supersecretvalue123|abcdefghijklmnopqrstuvwxyz123456/);
  } finally {
    daemon.stop();
  }
});

test('reasoning text deltas are disabled and non-persistent by default', async () => {
  const { daemon, project, appServerClient } = await createDaemon();
  try {
    const created = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Reasoning Text Delta Thread',
    });
    const started = await daemon.codexBridge.startTurn(created.threadId, 'delta task');

    appServerClient.emitReasoningTextDelta(created.codexThreadId, started.turnId, 'experimental hidden-looking text');
    await waitForAsyncHandlers();

    const rows = daemon.dbManager.db
      .prepare("SELECT event_type FROM event_log WHERE event_type = 'ReasoningTextDeltaObserved'")
      .all() as Array<{ event_type: string }>;
    assert.equal(rows.length, 0);
  } finally {
    daemon.stop();
  }
});

test('experimental reasoning text deltas can be enabled without persistence', async () => {
  const { daemon, project, appServerClient } = await createDaemon({
    configOverride: {
      reasoningTextDeltaEnabled: true,
      reasoningPersistTextDelta: false,
    },
  });
  try {
    const created = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Ephemeral Reasoning Delta Thread',
    });
    const started = await daemon.codexBridge.startTurn(created.threadId, 'delta task');
    let observed = false;
    daemon.eventBus.on('ReasoningTextDeltaObserved', () => {
      observed = true;
    });

    appServerClient.emitReasoningTextDelta(created.codexThreadId, started.turnId, 'TOKEN=secrettextdelta12345');
    await waitForAsyncHandlers();

    assert.equal(observed, true);
    const rows = daemon.dbManager.db
      .prepare("SELECT event_type FROM event_log WHERE event_type = 'ReasoningTextDeltaObserved'")
      .all() as Array<{ event_type: string }>;
    assert.equal(rows.length, 0);
  } finally {
    daemon.stop();
  }
});

test('redaction handles common token shapes before reasoning display', () => {
  const redacted = redactSensitiveText([
    'Bearer abcdefghijklmnopqrstuvwxyz123456',
    'RCC_WEB_AUTH_TOKEN=privatevalue123456789',
    '123456789:abcdefghijklmnopqrstuvwxyzABCDEF_123456',
    '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
  ].join('\n'));
  assert.doesNotMatch(redacted, /privatevalue123456789|abcdefghijklmnopqrstuvwxyzABCDEF_123456|BEGIN PRIVATE KEY/);
  assert.match(redacted, /Bearer \[REDACTED\]/);
  assert.match(redacted, /RCC_WEB_AUTH_TOKEN=\[REDACTED\]/);
});

test('/run --thread override can intentionally target a different thread than selected', async () => {
  const { daemon, telegramClient, appServerClient, project } = await createDaemon();
  try {
    await appServerClient.startThread({
      cwd: project.rootPath,
      threadName: 'Selected Thread',
    });
    const overrideCodex = await appServerClient.startThread({
      cwd: project.rootPath,
      threadName: 'Override Thread',
    });

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-o1',
      text: '/threads limit[5]',
    });
    await waitForAsyncHandlers();

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-o2',
      text: '/pick 1',
    });
    await waitForAsyncHandlers();

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-o3',
      text: '/run --thread=Override Thread override run message',
    });
    await waitForAsyncHandlers();

    const mapped = daemon.sessionRegistry.findThreadByCodexThreadId(overrideCodex.codexThreadId);
    assert.ok(mapped);
    const operatorMessage = daemon.repository.listOperatorMessages(mapped!.id, 1)[0];
    assert.ok(operatorMessage);
    assert.match(operatorMessage?.messageText ?? '', /override run message/);
  } finally {
    daemon.stop();
  }
});

test('/approvals lists only pending actionable approvals with project and thread context', async () => {
  const { daemon, telegramClient, appServerClient, project } = await createDaemon();
  try {
    const created = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Approvals List Thread',
    });

    appServerClient.emitApprovalRequest({
      requestId: 'req-approvals-list',
      codexThreadId: created.codexThreadId,
      turnId: 'turn-approvals-list',
      actionType: 'command',
      summary: 'git status --short',
      scope: 'once',
    });
    await waitForAsyncHandlers();

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-approvals-list',
      text: '/approvals',
    });
    await waitForAsyncHandlers();

    const text = telegramClient.sentMessages.at(-1)?.text ?? '';
    assert.match(text, /Approvals/);
    assert.match(text, /Pending actionable: 1/);
    assert.match(text, /project-one \/ Approvals List Thread/);
    assert.match(text, /git status --short/);
    assert.match(text, /actions: \/approve/);
  } finally {
    daemon.stop();
  }
});

test('superseded approval callback is rejected and /approvals shows only the latest actionable approval', async () => {
  const { daemon, telegramClient, appServerClient, project } = await createDaemon();
  try {
    const created = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Superseded Approval Thread',
    });

    appServerClient.emitApprovalRequest({
      requestId: 'req-superseded-old',
      codexThreadId: created.codexThreadId,
      turnId: 'turn-same',
      actionType: 'command',
      summary: 'old command',
      scope: 'once',
    });
    await waitForAsyncHandlers();
    const oldApproval = daemon.repository.listApprovals(created.threadId)[0];
    assert.ok(oldApproval);

    appServerClient.emitApprovalRequest({
      requestId: 'req-superseded-new',
      codexThreadId: created.codexThreadId,
      turnId: 'turn-same',
      actionType: 'command',
      summary: 'new command',
      scope: 'once',
    });
    await waitForAsyncHandlers();

    const oldAfter = oldApproval ? daemon.repository.findApprovalById(oldApproval.id) : undefined;
    assert.equal(oldAfter?.status, 'superseded');

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-old-callback',
      callbackData: `approve:${oldApproval?.id}`,
    });
    await waitForAsyncHandlers();

    const joined = telegramClient.sentMessages.map((message) => message.text).join('\n');
    assert.match(joined, /was superseded/);
    assert.match(joined, /Use \/approvals/);

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-approvals-after-supersede',
      text: '/approvals',
    });
    await waitForAsyncHandlers();
    const listText = telegramClient.sentMessages.at(-1)?.text ?? '';
    assert.doesNotMatch(listText, /old command/);
    assert.match(listText, /new command/);
  } finally {
    daemon.stop();
  }
});

test('/status reports App Server compatibility and thread-list health', async () => {
  const { daemon, telegramClient } = await createDaemon();
  try {
    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-compat-status',
      text: '/status',
    });
    await waitForAsyncHandlers();

    const text = telegramClient.sentMessages.at(-1)?.text ?? '';
    assert.match(text, /App Server Compatibility: compatible/);
    assert.match(text, /Thread List Health: ok/);
  } finally {
    daemon.stop();
  }
});

test('thread/list retry recovers from temporary App Server overload', async () => {
  const { daemon, telegramClient, appServerClient, project } = await createDaemon();
  try {
    await appServerClient.startThread({ cwd: project.rootPath, threadName: 'Retry Thread' });
    appServerClient.setTransientListFailures(2);
    (daemon.codexBridge as unknown as { threadListCache?: unknown }).threadListCache = undefined;

    telegramClient.emitUpdate({
      chatId: 'test-chat',
      messageId: 'm-retry-threads',
      text: '/threads',
    });

    const text = await waitForTelegramText(telegramClient, (message) => /Codex Threads/.test(message));
    assert.match(text, /Codex Threads/);
    assert.match(text, /Retry Thread/);
    assert.ok(appServerClient.listThreadsCallCount >= 3);
    assert.equal(daemon.codexBridge.getThreadListHealth().status, 'ok');
  } finally {
    daemon.stop();
  }
});

test('thread detail and last-output ignore token usage stream noise', async () => {
  const { daemon, project, appServerClient } = await createDaemon({
    configOverride: {
      localStatusEnabled: true,
      localStatusHost: '127.0.0.1',
      localStatusPort: 0,
    },
  });
  try {
    const created = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Noisy Output Thread',
    });
    const started = await daemon.codexBridge.startTurn(created.threadId, 'produce useful output');
    appServerClient.emitTurnStream(created.codexThreadId, started.turnId, 'thread/tokenUsage/updated', {
      kind: 'system',
      method: 'thread/tokenUsage/updated',
    });
    appServerClient.emitTurnStream(created.codexThreadId, started.turnId, 'useful assistant output');
    appServerClient.emitTurnStream(created.codexThreadId, started.turnId, 'thread/tokenUsage/updated', {
      kind: 'system',
      method: 'thread/tokenUsage/updated',
    });
    await waitForAsyncHandlers();

    const url = daemon.localStatusServer.url();
    assert.ok(url);
    const detail = await fetch(`${url}/api/threads/${encodeURIComponent(created.threadId)}`).then((response) => response.json()) as {
      outputs: Array<{ text: string }>;
    };
    assert.deepEqual(detail.outputs.map((output) => output.text), ['useful assistant output']);

    const lastOutput = await fetch(`${url}/api/threads/${encodeURIComponent(created.threadId)}/last-output`).then((response) => response.json()) as {
      output?: { text: string };
    };
    assert.equal(lastOutput.output?.text, 'useful assistant output');
  } finally {
    daemon.stop();
  }
});

test('last-output coalesces latest streamed assistant deltas into display text', async () => {
  const { daemon, project, appServerClient } = await createDaemon({
    configOverride: {
      localStatusEnabled: true,
      localStatusHost: '127.0.0.1',
      localStatusPort: 0,
    },
  });
  try {
    const created = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Chunked Last Output Thread',
    });
    const started = await daemon.codexBridge.startTurn(created.threadId, 'produce chunked output');
    for (const chunk of ['WEB', '_SM', 'OKE', '_OK']) {
      appServerClient.emitTurnStream(created.codexThreadId, started.turnId, chunk);
    }
    appServerClient.emitTurnStream(created.codexThreadId, started.turnId, 'thread/tokenUsage/updated', {
      kind: 'system',
      method: 'thread/tokenUsage/updated',
    });
    await waitForAsyncHandlers();

    const url = daemon.localStatusServer.url();
    assert.ok(url);
    const lastOutput = await fetch(`${url}/api/threads/${encodeURIComponent(created.threadId)}/last-output`).then((response) => response.json()) as {
      output?: { text: string };
    };
    assert.equal(lastOutput.output?.text, 'WEB_SMOKE_OK');
  } finally {
    daemon.stop();
  }
});

test('relay watch_thread adds selected thread detail to snapshots', async () => {
  const relay = new RelayHttpServer({
    operatorToken: 'operator-relay-token',
    macToken: 'mac-relay-token',
    host: '127.0.0.1',
    port: 0,
    logger: new Logger('error'),
  });
  await relay.start();
  const relayUrl = relay.url();
  assert.ok(relayUrl);
  const { daemon, project, appServerClient } = await createDaemon({
    configOverride: {
      relayEnabled: true,
      relayBaseUrl: relayUrl,
      relayMacToken: 'mac-relay-token',
      relayPollIntervalMs: 60_000,
      relaySnapshotIntervalMs: 60_000,
    },
  });
  try {
    const created = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Watched Relay Thread',
    });
    const started = await daemon.codexBridge.startTurn(created.threadId, 'watch relay output');
    appServerClient.emitTurnStream(created.codexThreadId, started.turnId, 'watched relay output');
    await waitForAsyncHandlers();

    const response = await fetch(`${relayUrl}/api/relay/commands`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer operator-relay-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'watch_thread',
        targetKind: 'thread',
        targetId: created.threadId,
      }),
    });
    assert.equal(response.status, 202);
    await daemon.relayClient.pollOnce();

    const snapshot = await fetch(`${relayUrl}/api/relay/snapshot`, {
      headers: { authorization: 'Bearer operator-relay-token' },
    }).then((res) => res.json()) as {
      snapshot?: {
        watchedThreadId?: string;
        watchedThreadDetail?: { outputs?: Array<{ text: string }> };
      };
    };
    assert.equal(snapshot.snapshot?.watchedThreadId, created.threadId);
    assert.equal(snapshot.snapshot?.watchedThreadDetail?.outputs?.[0]?.text, 'watched relay output');
  } finally {
    daemon.stop();
    await relay.stop();
  }
});

test('web approval response and dismiss move approvals from pending to history', async () => {
  const { daemon, project, appServerClient } = await createDaemon({
    configOverride: {
      localStatusEnabled: true,
      localStatusHost: '127.0.0.1',
      localStatusPort: 0,
      webControlEnabled: true,
      webAuthToken: 'web-token',
    },
  });
  try {
    const created = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Approval History Thread',
    });
    appServerClient.emitApprovalRequest({
      requestId: 'req-approval-history-deny',
      codexThreadId: created.codexThreadId,
      turnId: 'turn-approval-history',
      actionType: 'command',
      summary: 'rm -rf tmp',
      scope: 'once',
    });
    await waitForAsyncHandlers();
    const approval = daemon.repository.listApprovals(created.threadId)[0];
    assert.ok(approval);
    const url = daemon.localStatusServer.url();
    assert.ok(url);

    const response = await fetch(`${url}/api/approvals/${encodeURIComponent(approval.id)}/respond`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer web-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'denied', guidance: 'Use a read-only inspection first.' }),
    });
    assert.equal(response.status, 200);
    assert.equal(daemon.repository.findApprovalById(approval.id)?.status, 'denied');
    assert.match(daemon.repository.listOperatorMessages(created.threadId, 1)[0]?.messageText ?? '', /read-only inspection/);

    const pending = await fetch(`${url}/api/approvals`, {
      headers: { authorization: 'Bearer web-token' },
    }).then((res) => res.json()) as { approvals: Array<{ id: string }> };
    assert.equal(pending.approvals.some((item) => item.id === approval.id), false);

    const history = await fetch(`${url}/api/approvals/history`, {
      headers: { authorization: 'Bearer web-token' },
    }).then((res) => res.json()) as { approvals: Array<{ id: string; status: string; guidance?: string }> };
    assert.equal(history.approvals.some((item) => item.id === approval.id && item.status === 'denied'), true);

    appServerClient.emitApprovalRequest({
      requestId: 'req-approval-history-dismiss',
      codexThreadId: created.codexThreadId,
      turnId: 'turn-approval-history-2',
      actionType: 'command',
      summary: 'cat README.md',
      scope: 'once',
    });
    await waitForAsyncHandlers();
    const dismissApproval = daemon.repository.listPendingApprovals()[0];
    assert.ok(dismissApproval);
    const dismissResponse = await fetch(`${url}/api/approvals/${encodeURIComponent(dismissApproval.id)}/dismiss`, {
      method: 'POST',
      headers: { authorization: 'Bearer web-token' },
    });
    assert.equal(dismissResponse.status, 200);
    assert.equal(daemon.repository.findApprovalById(dismissApproval.id)?.status, 'dismissed');
  } finally {
    daemon.stop();
  }
});

test('demo replay runs without credentials and prints the duplicate and unknown approval replies', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/demo-replay.ts'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60_000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rcc> Callback already processed: approve:<id-\d+>/);
  assert.match(result.stdout, /rcc> Command failed: Unknown approval does-not-exist/);
});

test('RCC_PROJECT_ROOTS registers each folder once and reports missing folders', async () => {
  const { daemon, baseDir } = await createDaemon();
  try {
    const alpha = path.join(baseDir, 'alpha');
    const beta = path.join(baseDir, 'beta');
    const missing = path.join(baseDir, 'missing');
    fs.mkdirSync(alpha);
    fs.mkdirSync(beta);
    const raw = [alpha, beta, missing].join(',');

    const first = registerConfiguredProjects(daemon.sessionRegistry, raw);
    assert.deepEqual(first.registered.map((root) => path.basename(root)), ['alpha', 'beta']);
    assert.deepEqual(first.skipped, [missing]);

    const second = registerConfiguredProjects(daemon.sessionRegistry, raw);
    assert.deepEqual(second.registered, []);

    const roots = daemon.sessionRegistry.listProjects().map((project) => project.rootPath);
    assert.equal(roots.filter((root) => root === fs.realpathSync(alpha)).length, 1);
    assert.equal(roots.filter((root) => root === fs.realpathSync(beta)).length, 1);
    assert.equal(registerConfiguredProjects(daemon.sessionRegistry, undefined).registered.length, 0);
  } finally {
    daemon.stop();
  }
});

// The tokens below are fake. They have the right shape, and the test joins the parts so the secret scan stays quiet.
const FAKE_BOT_CREDENTIAL = ['123456789', 'AAFakeWizardTokenForTestsOnly0123456789'].join(':');
const FAKE_BOT_CREDENTIAL_OTHER = ['987654321', 'BBFakeWizardTokenForTestsOnly0123456789'].join(':');
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

interface TelegramReply {
  status?: number;
  body: unknown;
}

const okBody = (result: unknown): TelegramReply => ({ body: { ok: true, result } });
const rejectedBody: TelegramReply = { status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } };

const telegramFetch = (
  reply: (method: string, body: Record<string, unknown>) => TelegramReply | Error,
): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const method = String(input).split('/').pop() ?? '';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const outcome = reply(method, body);
    if (outcome instanceof Error) {
      throw outcome;
    }
    return new Response(JSON.stringify(outcome.body), { status: outcome.status ?? 200 });
  }) as unknown as typeof fetch;

const makeWizardTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-setup-test-'));
  fs.mkdirSync(path.join(dir, 'project'));
  return dir;
};

const makeWizardDeps = (options: {
  dir: string;
  fetch?: typeof fetch;
  answers?: string[];
  secrets?: string[];
  env?: Record<string, string | undefined>;
  clock?: { now(): number };
}) => {
  const logs: string[] = [];
  const prompts: string[] = [];
  const answers = [...(options.answers ?? [])];
  const secrets = [...(options.secrets ?? [])];
  const nextScripted = (list: string[], question: string): string => {
    prompts.push(question);
    const next = list.shift();
    if (next === undefined) {
      throw new Error(`Unscripted prompt: ${question}`);
    }
    return next;
  };
  const deps: WizardDeps = {
    io: {
      ask: async (question) => nextScripted(answers, question),
      askSecret: async (question) => nextScripted(secrets, question),
      log: (line) => {
        logs.push(line);
      },
    },
    fetch:
      options.fetch ??
      (async () => {
        throw new Error('Telegram must not be called in this test');
      }),
    fs,
    env: options.env ?? {},
    clock: options.clock ?? { now: () => Date.now() },
    home: path.join(options.dir, 'home'),
    startDir: path.join(options.dir, 'project'),
    rootDir: repoRoot,
    setupPath: path.join(options.dir, 'setup.md'),
    nodeVersion: process.versions.node,
    now: () => new Date('2026-10-10T12:00:00.000Z'),
    checkCodex: async () => 'codex-cli test',
    isGitIgnored: async () => true,
    startRcc: async () => 0,
  };
  return { deps, logs, prompts };
};

const fileMode = (file: string): number => fs.statSync(file).mode & 0o777;

test('bot token shape check accepts BotFather tokens and rejects other text', () => {
  assert.equal(isBotTokenShape(FAKE_BOT_CREDENTIAL), true);
  assert.equal(isBotTokenShape('replace_with_botfather_token'), false);
  assert.equal(isBotTokenShape('123456789'), false);
  assert.equal(isBotTokenShape('123456789:short'), false);
  assert.equal(isBotTokenShape(`${FAKE_BOT_CREDENTIAL} `), false);
});

test('setup checks the Node version against the engines range', () => {
  assert.equal(isNodeVersionSupported('22.22.2', '>=22.5.0'), true);
  assert.equal(isNodeVersionSupported('22.5.0', '>=22.5.0'), true);
  assert.equal(isNodeVersionSupported('23.0.0', '>=22.5.0'), true);
  assert.equal(isNodeVersionSupported('22.4.1', '>=22.5.0'), false);
  assert.equal(isNodeVersionSupported('20.11.0', '>=22.5.0'), false);
});

test('getMe reports the bot username and turns a rejected or unreachable token into a clear error', async () => {
  const dir = makeWizardTempDir();

  const accepted = makeWizardDeps({
    dir,
    fetch: telegramFetch(() => okBody({ username: 'rcc_test_bot', first_name: 'RCC' })),
  });
  const identity = await fetchBotIdentity(accepted.deps, FAKE_BOT_CREDENTIAL);
  assert.equal(identity.username, 'rcc_test_bot');

  const rejected = makeWizardDeps({ dir, fetch: telegramFetch(() => rejectedBody) });
  await assert.rejects(fetchBotIdentity(rejected.deps, FAKE_BOT_CREDENTIAL), (error: unknown) => {
    assert.ok(error instanceof WizardError);
    assert.match(error.message, /Telegram rejected this token/);
    assert.equal(error.message.includes(FAKE_BOT_CREDENTIAL), false);
    return true;
  });

  // A network error can carry the request URL, and the URL holds the token. The wizard must not repeat it.
  const offline = makeWizardDeps({
    dir,
    fetch: async (input) => {
      throw new Error(`connect ECONNREFUSED ${String(input)}`);
    },
  });
  await assert.rejects(fetchBotIdentity(offline.deps, FAKE_BOT_CREDENTIAL), (error: unknown) => {
    assert.ok(error instanceof WizardError);
    assert.match(error.message, /Could not reach Telegram/);
    assert.equal(error.message.includes(FAKE_BOT_CREDENTIAL), false);
    return true;
  });
});

test('chat capture ignores group chats and accepts a private chat only after the user confirms it', async () => {
  const dir = makeWizardTempDir();
  let now = 0;
  const batches: Array<Array<Record<string, unknown>>> = [
    [{ update_id: 10, message: { chat: { id: -100123, type: 'supergroup' }, from: { first_name: 'Group' } } }],
    [{ update_id: 11, message: { chat: { id: 555, type: 'private', first_name: 'Stranger' }, from: { first_name: 'Stranger' } } }],
    [{ update_id: 12, message: { chat: { id: 123456789, type: 'private' }, from: { first_name: 'Om', username: 'om_test' } } }],
  ];
  const offsets: unknown[] = [];
  const fetchImpl = telegramFetch((method, body) => {
    if (method !== 'getUpdates') {
      return rejectedBody;
    }
    offsets.push(body.offset);
    now += 10_000;
    return okBody(batches.shift() ?? []);
  });

  const { deps, logs } = makeWizardDeps({ dir, fetch: fetchImpl, clock: { now: () => now } });
  const answers = ['n', 'y'];
  const asked: ChatCandidate[] = [];
  const chat = await captureOperatorChat(deps, FAKE_BOT_CREDENTIAL, async (candidate) => {
    asked.push(candidate);
    return answers.shift() === 'y';
  });

  assert.deepEqual(chat, { id: '123456789', type: 'private', firstName: 'Om', username: 'om_test' });
  assert.deepEqual(asked.map((candidate) => candidate.id), ['555', '123456789']);
  assert.ok(logs.some((line) => line.includes('Ignored a supergroup chat')));
  assert.deepEqual(offsets, [undefined, 11, 12]);
});

test('chat capture gives up after the window when no private chat is confirmed', async () => {
  const dir = makeWizardTempDir();
  let now = 0;
  let nextUpdateId = 1;
  const fetchImpl = telegramFetch((method) => {
    now += 10_000;
    if (method !== 'getUpdates') {
      return rejectedBody;
    }
    nextUpdateId += 1;
    return okBody([{ update_id: nextUpdateId, message: { chat: { id: 777, type: 'private' }, from: { first_name: 'Maybe' } } }]);
  });

  const { deps } = makeWizardDeps({ dir, fetch: fetchImpl, clock: { now: () => now } });
  let asked = 0;
  const chat = await captureOperatorChat(deps, FAKE_BOT_CREDENTIAL, async () => {
    asked += 1;
    return false;
  });

  assert.equal(chat, undefined);
  assert.equal(asked, 12);
});

test('setup writes setup.md with the keys run.sh reads, mode 0600, and run.sh parses it', async () => {
  const dir = makeWizardTempDir();
  const project = path.join(dir, 'project');
  const { deps, prompts } = makeWizardDeps({
    dir,
    env: { RCC_SETUP_BOT_TOKEN: FAKE_BOT_CREDENTIAL },
    fetch: telegramFetch(() => okBody({ username: 'rcc_test_bot' })),
    answers: ['n'],
  });

  const code = await runWizard(['--chat-id', '123456789', '--project', project], deps);
  assert.equal(code, 0);
  assert.ok(prompts.some((question) => question.startsWith('Start RCC now')));

  const lines = fs.readFileSync(deps.setupPath, 'utf8').split('\n');
  assert.ok(lines.includes(`RCC_TELEGRAM_BOT_TOKEN=${FAKE_BOT_CREDENTIAL}`));
  assert.ok(lines.includes('RCC_OPERATOR_CHAT_ID=123456789'));
  assert.ok(lines.includes('RCC_ALLOWED_CHAT_IDS=123456789'));
  assert.ok(lines.includes('RCC_TELEGRAM_TRANSPORT=long_polling'));
  assert.ok(lines.includes(`RCC_PROJECT_ROOTS=${project}`));
  assert.ok(lines.includes('RCC_RELAY_ENABLED=false'));
  assert.equal(fileMode(deps.setupPath), 0o600);

  // Read the file with the get_val function from run.sh, so the test follows the same parsing as the launcher.
  const getValSource = fs.readFileSync(path.join(repoRoot, 'run.sh'), 'utf8').match(/^get_val\(\) \{\n[\s\S]*?\n\}\n/m)?.[0];
  assert.ok(getValSource, 'run.sh must define get_val');
  const readWithRunSh = (key: string): string =>
    spawnSync('bash', ['-c', `${getValSource}\nget_val "$1"`, 'bash', key], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  assert.equal(readWithRunSh('RCC_TELEGRAM_BOT_TOKEN'), FAKE_BOT_CREDENTIAL);
  assert.equal(readWithRunSh('RCC_OPERATOR_CHAT_ID'), '123456789');
  assert.equal(readWithRunSh('RCC_TELEGRAM_TRANSPORT'), 'long_polling');
  assert.equal(readWithRunSh('RCC_PROJECT_ROOTS'), project);
});

test('an existing setup.md is kept as a 0600 backup before it is replaced', async () => {
  const dir = makeWizardTempDir();
  const project = path.join(dir, 'project');
  fs.writeFileSync(path.join(dir, 'setup.md'), 'RCC_OPERATOR_CHAT_ID=111\n', { mode: 0o644 });
  const { deps, prompts } = makeWizardDeps({
    dir,
    env: { RCC_SETUP_BOT_TOKEN: FAKE_BOT_CREDENTIAL },
    fetch: telegramFetch(() => okBody({ username: 'rcc_test_bot' })),
    answers: ['y', 'n'],
  });

  const code = await runWizard(['--chat-id', '123456789', '--project', project], deps);
  assert.equal(code, 0);
  assert.ok(prompts.some((question) => question.startsWith('Replace it?')));

  const backups = fs.readdirSync(dir).filter((name) => /^setup\.md\.bak-/.test(name));
  assert.equal(backups.length, 1);
  const backupPath = path.join(dir, backups[0] ?? '');
  assert.equal(fs.readFileSync(backupPath, 'utf8'), 'RCC_OPERATOR_CHAT_ID=111\n');
  assert.equal(fileMode(backupPath), 0o600);
  assert.match(fs.readFileSync(deps.setupPath, 'utf8'), /^RCC_OPERATOR_CHAT_ID=123456789$/m);
  assert.equal(fileMode(deps.setupPath), 0o600);
});

test('declining to replace setup.md leaves it unchanged and makes no backup', async () => {
  const dir = makeWizardTempDir();
  const project = path.join(dir, 'project');
  fs.writeFileSync(path.join(dir, 'setup.md'), 'RCC_OPERATOR_CHAT_ID=111\n');
  const { deps, logs } = makeWizardDeps({
    dir,
    env: { RCC_SETUP_BOT_TOKEN: FAKE_BOT_CREDENTIAL },
    fetch: telegramFetch(() => okBody({ username: 'rcc_test_bot' })),
    answers: ['n'],
  });

  assert.equal(await runWizard(['--chat-id', '123456789', '--project', project], deps), 0);
  assert.equal(fs.readFileSync(deps.setupPath, 'utf8'), 'RCC_OPERATOR_CHAT_ID=111\n');
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith('setup.md.bak-')), []);
  assert.ok(logs.includes('Left setup.md unchanged.'));
});

test('setup dry run writes nothing and never prints the bot token', async () => {
  const dir = makeWizardTempDir();
  const project = path.join(dir, 'project');
  const { deps, logs } = makeWizardDeps({
    dir,
    env: { RCC_SETUP_BOT_TOKEN: FAKE_BOT_CREDENTIAL },
    fetch: telegramFetch(() => okBody({ username: 'rcc_test_bot' })),
  });

  const code = await runWizard(['--dry-run', '--yes', '--chat-id', '123456789', '--project', project], deps);
  assert.equal(code, 0);
  assert.equal(fs.existsSync(deps.setupPath), false);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['project']);

  const output = logs.join('\n');
  assert.match(output, /^RCC_TELEGRAM_BOT_TOKEN=<hidden>$/m);
  assert.equal(output.includes(FAKE_BOT_CREDENTIAL), false);
});

test('skip-telegram-check works only with dry run and never calls Telegram', async () => {
  const dir = makeWizardTempDir();
  const project = path.join(dir, 'project');
  const offline = makeWizardDeps({ dir, env: { RCC_SETUP_BOT_TOKEN: FAKE_BOT_CREDENTIAL } });

  assert.equal(
    await runWizard(['--dry-run', '--skip-telegram-check', '--yes', '--chat-id', '123456789', '--project', project], offline.deps),
    0,
  );
  assert.equal(offline.logs.join('\n').includes(FAKE_BOT_CREDENTIAL), false);

  const refused = makeWizardDeps({ dir });
  assert.equal(await runWizard(['--skip-telegram-check', '--chat-id', '123456789'], refused.deps), 2);
  assert.match(refused.logs.join('\n'), /only works with --dry-run/);
});

test('setup errors never include the bot token', async () => {
  const dir = makeWizardTempDir();
  const project = path.join(dir, 'project');
  const argv = ['--dry-run', '--yes', '--chat-id', '123456789', '--project', project];

  const unreachable = makeWizardDeps({
    dir,
    env: { RCC_SETUP_BOT_TOKEN: FAKE_BOT_CREDENTIAL },
    fetch: async (input) => {
      throw new Error(`request failed for ${String(input)}`);
    },
  });
  assert.equal(await runWizard(argv, unreachable.deps), 1);
  assert.match(unreachable.logs.join('\n'), /Could not reach Telegram/);
  assert.equal(unreachable.logs.join('\n').includes(FAKE_BOT_CREDENTIAL), false);

  const rejected = makeWizardDeps({
    dir,
    env: { RCC_SETUP_BOT_TOKEN: FAKE_BOT_CREDENTIAL },
    fetch: telegramFetch(() => rejectedBody),
  });
  assert.equal(await runWizard(argv, rejected.deps), 1);
  assert.match(rejected.logs.join('\n'), /Telegram rejected this token/);
  assert.equal(rejected.logs.join('\n').includes(FAKE_BOT_CREDENTIAL), false);

  // A token pasted as an argument is refused and not echoed back.
  const byArgument = makeWizardDeps({ dir });
  assert.equal(await runWizard([FAKE_BOT_CREDENTIAL], byArgument.deps), 2);
  assert.equal(await runWizard(['--token', FAKE_BOT_CREDENTIAL], byArgument.deps), 2);
  assert.equal(byArgument.logs.join('\n').includes(FAKE_BOT_CREDENTIAL), false);
  assert.throws(() => parseArgs([FAKE_BOT_CREDENTIAL]), (error: unknown) => {
    assert.ok(error instanceof WizardError);
    assert.equal(error.message.includes(FAKE_BOT_CREDENTIAL), false);
    return true;
  });
});

test('interactive token prompt accepts a second try after a rejection and stops after three tries', async () => {
  const dir = makeWizardTempDir();
  const project = path.join(dir, 'project');
  let calls = 0;
  const retry = makeWizardDeps({
    dir,
    secrets: [FAKE_BOT_CREDENTIAL_OTHER, FAKE_BOT_CREDENTIAL],
    answers: ['n'],
    fetch: telegramFetch(() => {
      calls += 1;
      return calls === 1 ? rejectedBody : okBody({ username: 'rcc_test_bot' });
    }),
  });
  assert.equal(await runWizard(['--chat-id', '123456789', '--project', project], retry.deps), 0);
  assert.equal(calls, 2);
  assert.ok(fs.readFileSync(retry.deps.setupPath, 'utf8').includes(`RCC_TELEGRAM_BOT_TOKEN=${FAKE_BOT_CREDENTIAL}`));

  const shapeOnly = makeWizardDeps({ dir: makeWizardTempDir(), secrets: ['nope', 'still nope', 'no'] });
  assert.equal(await runWizard(['--chat-id', '123456789'], shapeOnly.deps), 1);
  assert.match(shapeOnly.logs.join('\n'), /No valid bot token after 3 tries/);
});

test('install.sh passes the bash syntax check', () => {
  const result = spawnSync('bash', ['-n', 'install.sh'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('install.sh stops without touching a folder that is not an RCC clone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-install-test-'));
  const installDir = path.join(dir, 'other');
  fs.mkdirSync(installDir);
  fs.writeFileSync(path.join(installDir, 'notes.txt'), 'keep me\n');

  const result = spawnSync('bash', ['install.sh'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, RCC_DIR: installDir },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not a Remote Codex Control clone/);
  assert.equal(fs.readFileSync(path.join(installDir, 'notes.txt'), 'utf8'), 'keep me\n');
});

test('setup renders the chat ID and hides the token only when asked', () => {
  const values = { botToken: FAKE_BOT_CREDENTIAL, chatId: '123456789', projectRoots: ['/tmp/one', '/tmp/two'] };
  const visible = renderSetupMd(values, { hideToken: false });
  assert.ok(visible.includes(`RCC_TELEGRAM_BOT_TOKEN=${FAKE_BOT_CREDENTIAL}`));
  assert.ok(visible.includes('RCC_PROJECT_ROOTS=/tmp/one,/tmp/two'));

  const hidden = renderSetupMd(values, { hideToken: true });
  assert.ok(hidden.includes('RCC_TELEGRAM_BOT_TOKEN=<hidden>'));
  assert.equal(hidden.includes(FAKE_BOT_CREDENTIAL), false);
});

test('project folders can be added one at a time, and a missing folder is asked for again', async () => {
  const dir = makeWizardTempDir();
  const first = path.join(dir, 'project');
  const second = path.join(dir, 'second');
  fs.mkdirSync(second);
  const { deps, prompts, logs } = makeWizardDeps({
    dir,
    env: { RCC_SETUP_BOT_TOKEN: FAKE_BOT_CREDENTIAL },
    fetch: telegramFetch(() => okBody({ username: 'rcc_test_bot' })),
    // First folder: a typo, then the real one. Second folder: added. Then Enter to finish, then no start.
    answers: [path.join(dir, 'typo'), first, second, '', 'n'],
  });

  assert.equal(await runWizard(['--chat-id', '123456789'], deps), 0);
  assert.ok(logs.some((line) => line.startsWith('Folder not found:')));
  assert.equal(prompts.filter((question) => question.startsWith('Add another project folder')).length, 2);
  assert.match(fs.readFileSync(deps.setupPath, 'utf8'), new RegExp(`^RCC_PROJECT_ROOTS=${first},${second}$`, 'm'));
});

test('--yes uses the folder the wizard started in and needs a chat ID', async () => {
  const dir = makeWizardTempDir();
  const project = path.join(dir, 'project');
  const { deps, prompts, logs } = makeWizardDeps({
    dir,
    env: { RCC_SETUP_BOT_TOKEN: FAKE_BOT_CREDENTIAL },
    fetch: telegramFetch(() => okBody({ username: 'rcc_test_bot' })),
  });

  assert.equal(await runWizard(['--yes', '--chat-id', '123456789', '--dry-run'], deps), 0);
  assert.deepEqual(prompts, []);
  assert.match(logs.join('\n'), new RegExp(`^RCC_PROJECT_ROOTS=${project}$`, 'm'));

  const noChat = makeWizardDeps({ dir, env: { RCC_SETUP_BOT_TOKEN: FAKE_BOT_CREDENTIAL } });
  assert.equal(await runWizard(['--yes'], noChat.deps), 1);
  assert.match(noChat.logs.join('\n'), /--yes needs --chat-id/);
});
