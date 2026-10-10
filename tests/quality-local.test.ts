import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { RccConfig } from '../src/config.js';
import { MockAppServerClient } from '../src/adapters/codex/mockAppServerClient.js';
import { MockTelegramClient } from '../src/adapters/telegram/mockTelegramClient.js';
import { Logger } from '../src/logger.js';
import { RccDaemon } from '../src/services/rccDaemon.js';

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
