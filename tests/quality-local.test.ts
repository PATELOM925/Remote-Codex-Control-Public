import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { RccConfig } from '../src/config.js';
import { MockAppServerClient } from '../src/adapters/codex/mockAppServerClient.js';
import { MockTelegramClient } from '../src/adapters/telegram/mockTelegramClient.js';
import { Logger } from '../src/logger.js';
import { RccDaemon } from '../src/services/rccDaemon.js';

process.env.RCC_CODEX_DESKTOP_APPROVAL_CARD_GRACE_MS = '0';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

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

const createDaemon = async (configOverride: Partial<RccConfig>) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-quality-'));
  const appServerClient = new MockAppServerClient();
  const codexHome = path.join(baseDir, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });

  const daemon = new RccDaemon({
    config: { ...makeConfig(baseDir), ...configOverride },
    appServerClient,
    telegramClient: new MockTelegramClient(),
    logger: new Logger('error'),
    codexDesktopStateOptions: {
      codexHome,
      pollIntervalMs: 60_000,
    },
    codexSessionsRoot: path.join(codexHome, 'sessions'),
  });
  await daemon.start();

  const projectRoot = path.join(baseDir, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  const project = daemon.sessionRegistry.registerProject({
    id: 'p1',
    name: 'project-one',
    rootPath: projectRoot,
  });

  return { daemon, appServerClient, project };
};

const waitForAsyncHandlers = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 25));
};

// Reads an open event stream until the text matches or the timeout aborts the request.
const readStreamUntil = async (url: string, headers: Record<string, string>, done: (text: string) => boolean): Promise<{ response: Response; text: string }> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    try {
      while (!done(text)) {
        const { value, done: ended } = await reader.read();
        if (ended) {
          break;
        }
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel();
    }
    return { response, text };
  } finally {
    clearTimeout(timer);
  }
};

// Complete SSE frames only. A partial frame at the end of the read is ignored.
const completeFrames = (text: string): string[] => text.split('\n\n').slice(0, -1);

test('local event stream sends standard SSE framing', async () => {
  const { daemon, project } = await createDaemon({
    localStatusEnabled: true,
    localStatusHost: '127.0.0.1',
    localStatusPort: 0,
  });
  try {
    const url = daemon.localStatusServer.url();
    assert.ok(url);
    const pending = readStreamUntil(`${url}/api/events/stream`, {}, (text) => text.includes('event: rcc-event'));
    await waitForAsyncHandlers();
    await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Stream Framing Thread',
    });
    const { response, text } = await pending;

    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
    assert.ok(text.startsWith(': RCC local event stream. Payloads are redacted by design.\n\n'), text.slice(0, 120));
    const eventFrames = completeFrames(text).filter((frame) => frame.startsWith('event: rcc-event'));
    assert.ok(eventFrames.length > 0, 'expected at least one complete rcc-event frame');
    for (const frame of eventFrames) {
      const lines = frame.split('\n');
      assert.equal(lines.length, 2, frame);
      assert.equal(lines[0], 'event: rcc-event');
      assert.match(lines[1] ?? '', /^data: \{/);
      assert.doesNotThrow(() => JSON.parse((lines[1] ?? '').slice('data: '.length)));
    }
  } finally {
    daemon.stop();
  }
});

test('selected-thread event stream sends standard SSE framing', async () => {
  const { daemon, appServerClient, project } = await createDaemon({
    localStatusEnabled: true,
    localStatusHost: '127.0.0.1',
    localStatusPort: 0,
  });
  try {
    const url = daemon.localStatusServer.url();
    assert.ok(url);
    const created = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Thread Stream Framing',
    });
    const started = await daemon.codexBridge.startTurn(created.threadId, 'stream framing task');
    appServerClient.emitTurnStream(created.codexThreadId, started.turnId, 'framing output line');
    await waitForAsyncHandlers();

    const { response, text } = await readStreamUntil(
      `${url}/api/threads/${encodeURIComponent(created.threadId)}/stream`,
      {},
      (value) => value.includes('event: thread-output'),
    );

    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
    assert.ok(text.startsWith(': RCC selected-thread stream.'), text.slice(0, 120));
    assert.ok(text.includes(': RCC selected-thread stream. Only App Server-exposed output/events are sent; hidden/raw reasoning is not exposed.\n\n'));
    const outputFrames = completeFrames(text).filter((frame) => frame.startsWith('event: thread-output'));
    assert.ok(outputFrames.length > 0, 'expected at least one complete thread-output frame');
    const lines = (outputFrames[0] ?? '').split('\n');
    assert.equal(lines.length, 2, outputFrames[0]);
    assert.match(lines[1] ?? '', /^data: \{/);
    const output = JSON.parse((lines[1] ?? '').slice('data: '.length)) as { text?: string };
    assert.equal(output.text, 'framing output line');
  } finally {
    daemon.stop();
  }
});

test('web login and bearer checks accept only the exact configured token', async () => {
  const webToken = 'fake-web-token-0001';
  const { daemon } = await createDaemon({
    localStatusEnabled: true,
    localStatusHost: '127.0.0.1',
    localStatusPort: 0,
    webControlEnabled: true,
    webAuthToken: webToken,
  });
  try {
    const url = daemon.localStatusServer.url();
    assert.ok(url);

    const login = (token: string) => fetch(`${url}/api/session/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    assert.equal((await login(webToken)).status, 200);
    assert.equal((await login('fake-web-token-0002')).status, 401, 'same length, wrong value');
    assert.equal((await login('fake-web-token')).status, 401, 'shorter');
    assert.equal((await login(`${webToken}-extra`)).status, 401, 'longer');

    // Missing thread means the bearer check passed. A bad bearer returns 401 before the thread lookup.
    const interrupt = (authorization?: string) => fetch(`${url}/api/threads/missing-thread/interrupt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
      body: '{}',
    });
    const accepted = await interrupt(`Bearer ${webToken}`);
    assert.equal(accepted.status, 404);
    assert.equal(((await accepted.json()) as { error?: string }).error, 'thread_not_found');
    for (const authorization of ['Bearer fake-web-token-0002', 'Bearer fake-web-token', `Bearer ${webToken}-extra`, webToken, undefined]) {
      const rejected = await interrupt(authorization);
      assert.equal(rejected.status, 401, `authorization ${authorization ?? '(none)'}`);
      assert.equal(((await rejected.json()) as { error?: string }).error, 'unauthorized_web_session');
    }
  } finally {
    daemon.stop();
  }
});

test('web attachment request rejects a sixth file', async () => {
  const webToken = 'fake-web-token-0003';
  const { daemon, project } = await createDaemon({
    localStatusEnabled: true,
    localStatusHost: '127.0.0.1',
    localStatusPort: 0,
    webControlEnabled: true,
    webAuthToken: webToken,
  });
  try {
    const url = daemon.localStatusServer.url();
    assert.ok(url);
    const created = await daemon.codexBridge.createThread({
      projectId: project.id,
      cwd: project.rootPath,
      threadName: 'Attachment Limit Thread',
    });
    const file = { name: 'note.txt', mimeType: 'text/plain', sizeBytes: 1, base64: 'YQ==' };
    const response = await fetch(`${url}/api/threads/${encodeURIComponent(created.threadId)}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${webToken}` },
      body: JSON.stringify({ files: Array.from({ length: 6 }, () => file) }),
    });
    assert.equal(((await response.json()) as { error?: string }).error, 'At most 5 files may be uploaded in one request.');
  } finally {
    daemon.stop();
  }
});

test('relay upload rejects a fourth file per command', async () => {
  const { daemon } = await createDaemon({});
  try {
    // parseAttachmentMessage is private; the test calls it to check the count limit alone.
    const relayClient = daemon.relayClient as unknown as { parseAttachmentMessage(value: string | undefined): unknown };
    const message = (count: number) => JSON.stringify({
      files: Array.from({ length: count }, (_, index) => ({ name: `note-${index}.txt`, sizeBytes: 1, base64: 'YQ==' })),
    });
    assert.equal((relayClient.parseAttachmentMessage(message(3)) as unknown[]).length, 3);
    assert.throws(() => relayClient.parseAttachmentMessage(message(4)), /Relay upload accepts at most 3 files per command\./);
  } finally {
    daemon.stop();
  }
});

test('telegram chat id script keeps the bot token out of curl arguments', async () => {
  const fakeToken = '123456789:FAKE_test_token_not_real';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-chat-ids-'));
  const scriptsDir = path.join(root, 'scripts');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(scriptsDir);
  fs.mkdirSync(binDir);
  fs.copyFileSync(path.join(repoRoot, 'scripts', 'telegram_chat_ids.sh'), path.join(scriptsDir, 'telegram_chat_ids.sh'));
  fs.writeFileSync(path.join(root, 'setup.md'), `RCC_TELEGRAM_BOT_TOKEN=${fakeToken}\n`);
  // Stub curl: records its arguments and stdin, then prints the response file written by each run.
  fs.writeFileSync(path.join(binDir, 'curl'), [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$@" > "$CURL_LOG_DIR/args.txt"',
    'cat > "$CURL_LOG_DIR/stdin.txt"',
    'cat "$CURL_LOG_DIR/response.json"',
    '',
  ].join('\n'), { mode: 0o755 });

  const runScript = (response: string) => {
    fs.writeFileSync(path.join(root, 'response.json'), response);
    return spawnSync('bash', [path.join(scriptsDir, 'telegram_chat_ids.sh'), '30'], {
      encoding: 'utf8',
      input: '',
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`, CURL_LOG_DIR: root },
    });
  };

  const empty = runScript('{"ok":true,"result":[]}');
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /No pending updates found\./);

  const withChat = runScript('{"ok":true,"result":[{"update_id":1,"message":{"chat":{"id":4242,"type":"private","username":"tester"}}}]}');
  assert.equal(withChat.status, 0, withChat.stderr);
  assert.equal(withChat.stdout, [
    'Discovered chat ids (use the numeric id for RCC_OPERATOR_CHAT_ID):',
    '- 4242 | private | tester',
    '',
    'Suggested setup.md values:',
    'RCC_OPERATOR_CHAT_ID=4242',
    'RCC_ALLOWED_CHAT_IDS=4242',
    '',
  ].join('\n'));

  const args = fs.readFileSync(path.join(root, 'args.txt'), 'utf8');
  const stdin = fs.readFileSync(path.join(root, 'stdin.txt'), 'utf8');
  assert.ok(!args.includes(fakeToken), 'bot token must not appear in curl arguments');
  assert.ok(!args.includes('getUpdates'), 'request URL must not appear in curl arguments');
  assert.equal(stdin, `url = "https://api.telegram.org/bot${fakeToken}/getUpdates?limit=50&timeout=30"\n`);
});
