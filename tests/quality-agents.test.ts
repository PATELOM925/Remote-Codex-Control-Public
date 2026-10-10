import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FileIntakeAgent } from '../src/agents/fileIntakeAgent.js';
import { GitGuardrailAgent } from '../src/agents/gitGuardrailAgent.js';
import { MockTelegramClient } from '../src/adapters/telegram/mockTelegramClient.js';
import type { RccConfig } from '../src/config.js';
import type { EventJournal } from '../src/event-journal/eventJournal.js';
import { Logger } from '../src/logger.js';
import { PolicyEngine } from '../src/policies/policyEngine.js';
import { RccEventBus } from '../src/runtime/eventBus.js';

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
  spawnSync('git', ['init', '-q', repo]);
  const { agent, action } = makeGitGuardrail({ cwd: repo, actionType: 'push', targetBranch: 'feature-x' });

  assert.throws(() => agent.approvePush(action.id), /origin/);

  assert.equal(action.status, 'failed');
  assert.match(action.summary ?? '', /origin/);
});

test('requestCommitApproval tells the operator that every working-tree change is committed', () => {
  const { agent, created } = makeGitGuardrail({ cwd: os.tmpdir(), actionType: 'commit' });

  agent.requestCommitApproval('thread-git', 'Fix login');

  assert.equal(created.length, 1);
  assert.match(created[0]?.summary ?? '', /Fix login/);
  assert.match(created[0]?.summary ?? '', /All changes in the working tree will be committed/);
});
