// Simulated Mac for the public web demo. It answers the relay requests the
// console sends, with made-up data, and makes no network calls. It runs as a
// plain script in the browser and is loaded for side effects by Node tests.
(() => {
  const BUSY_STATUSES = ['running', 'waiting_approval', 'waiting_operator'];
  const STORAGE = {
    mode: 'demo',
    durable: false,
    note: 'Simulated in this browser. Nothing is stored or sent.',
  };
  const PROJECTS = [
    { id: 'demo-app', name: 'demo-app', rootPath: '~/projects/demo-app' },
    { id: 'docs-site', name: 'docs-site', rootPath: '~/projects/docs-site' },
    { id: 'billing-service', name: 'billing-service', rootPath: '~/projects/billing-service' },
  ];
  const SKILLS = [
    { name: 'code-review', description: 'Review a change for bugs and missing tests.', path: 'skills/code-review/SKILL.md', enabled: true },
    { name: 'write-tests', description: 'Add focused tests for one change.', path: 'skills/write-tests/SKILL.md', enabled: true },
    { name: 'release-notes', description: 'Draft short release notes from merged changes.', path: 'skills/release-notes/SKILL.md', enabled: true },
  ];
  // id, project, name, status, minutes since last activity, mode, active turn
  const THREADS = [
    ['thread-dark-mode', 'demo-app', 'Add dark mode toggle', 'idle', 42, 'plan', undefined],
    ['thread-login-test', 'demo-app', 'Fix flaky login test', 'waiting_approval', 4, 'build', 'demo-turn-login'],
    ['thread-cart-totals', 'demo-app', 'Refactor cart totals', 'running', 0, 'build', 'demo-turn-cart'],
    ['thread-install-guide', 'docs-site', 'Update install guide', 'completed', 95, 'build', undefined],
    ['thread-webhook-retry', 'billing-service', 'Add retry to webhook handler', 'failed', 30, 'build', undefined],
    ['thread-invoice-summary', 'billing-service', 'Summarize invoice export', 'waiting_approval', 6, 'plan', 'demo-turn-invoice'],
  ];
  const REPLY = {
    plan: 'Plan: read the settings page and the theme helper, add one preference, add the toggle, then run the tests. Nothing has changed yet. Switch to Build to make the change.',
    built: 'Done. The change is in place and the checks passed. This reply is simulated, so no files were changed.',
    denied: 'Understood. I did not run that command. I will look for another way to confirm the fix.',
    noted: 'Noted. I will use this guidance for the next step.',
  };

  const createDemoRelay = (options = {}) => {
    const commandDelayMs = options.commandDelayMs ?? 700;
    const turnDelayMs = options.turnDelayMs ?? 2500;
    const clock = options.now ?? (() => Date.now());
    const iso = (ms) => new Date(ms).toISOString();
    const tasks = new Set();
    let generation = 0;
    let counter = 0;
    let s = null;

    const nextId = (prefix) => {
      counter += 1;
      return `${prefix}-${counter}`;
    };
    // Runs fn after ms. Tasks from before a reset are dropped.
    const later = (ms, fn) => {
      const mine = generation;
      const task = new Promise((resolve) => setTimeout(resolve, ms))
        .then(() => {
          if (mine === generation) fn();
        })
        .finally(() => tasks.delete(task));
      tasks.add(task);
    };
    const findThread = (threadId) => s.threads.find((thread) => thread.id === threadId);
    const requireThread = (threadId) => {
      const thread = findThread(threadId);
      if (!thread) throw new Error(`Unknown thread ${threadId}`);
      return thread;
    };
    const requireApproval = (approvalId) => {
      const approval = s.approvals.find((item) => item.id === approvalId);
      if (!approval) throw new Error(`Unknown approval ${approvalId}`);
      return approval;
    };
    const addOutput = (threadId, { kind, text, method, turnId, at }) => {
      s.seq += 1;
      s.outputs.push({ sequence: s.seq, occurredAt: at || iso(clock()), threadId, turnId, kind, text, method });
      s.outputs = s.outputs.slice(-300);
    };
    const addEvent = (eventType, { threadId, turnId, summary, at }) => {
      s.seq += 1;
      const thread = threadId ? findThread(threadId) : undefined;
      s.events.push({
        sequence: s.seq,
        eventId: nextId('demo-event'),
        eventType,
        occurredAt: at || iso(clock()),
        projectId: thread?.projectId,
        threadId,
        turnId,
        summary,
      });
      s.events = s.events.slice(-200);
    };
    const approvalView = ({ id, thread, turnId, summary, category, risk, why, impact, commandPreview = '', fileSummary = '', diffSummary = '', decisionHint, createdAt, status = 'pending' }) => ({
      id,
      threadId: thread.id,
      projectName: thread.projectName,
      threadName: thread.threadName,
      turnId,
      actionType: category === 'file change' ? 'file_change' : 'command',
      summary,
      category,
      risk,
      why,
      impact,
      source: 'demo',
      cwd: thread.cwd,
      commandPreview,
      fileSummary,
      diffSummary,
      networkAccess: false,
      gitAccess: false,
      destructive: false,
      decisionHint,
      status,
      expiresAt: iso(Date.parse(createdAt) + 30 * 60_000),
      createdAt,
      actions: { approve: `/approve ${id}`, deny: `/deny ${id}`, interrupt: `/interrupt ${thread.id}` },
    });

    const seed = (base) => {
      const at = (minutes) => iso(base - minutes * 60_000);
      s = {
        seq: 0,
        threads: [],
        outputs: [],
        reasoning: [],
        events: [],
        approvals: [],
        outcomes: new Map(),
        artifacts: [],
        commands: new Map(),
        results: new Map(),
        watchedThreadId: undefined,
      };
      s.threads = THREADS.map(([id, projectId, threadName, status, minutes, mode, turnId]) => {
        const project = PROJECTS.find((item) => item.id === projectId);
        return {
          id,
          projectId,
          projectName: project.name,
          codexThreadId: `codex-${id}`,
          threadName,
          cwd: project.rootPath,
          status,
          mode,
          skills: [],
          activeTurnId: turnId,
          lastSeenAt: at(minutes),
          lastAccessAt: at(minutes),
          createdAt: at(4000),
        };
      });
      const out = (threadId, minutes, kind, text, method, turnId) => addOutput(threadId, { kind, text, method, turnId, at: at(minutes) });
      out('thread-dark-mode', 41, 'system', 'Operator message: Add a dark mode toggle to the settings page.', 'operator/message');
      out('thread-dark-mode', 40, 'assistant_text', REPLY.plan, 'item/completed');
      out('thread-login-test', 5, 'system', 'Operator message: The login test fails about one run in five. Find the cause.', 'operator/message');
      out('thread-login-test', 4, 'assistant_text', 'The test waits a fixed 200 ms before it checks the page. I want to run the suite once to confirm the fix.', 'item/completed', 'demo-turn-login');
      out('thread-login-test', 4, 'tool_status', 'Waiting for approval: Run npm test in demo-app', 'approval/requested', 'demo-turn-login');
      out('thread-cart-totals', 2, 'system', 'Operator message: Move the tax rule into one helper.', 'operator/message', 'demo-turn-cart');
      out('thread-cart-totals', 1, 'assistant_text', 'I moved the tax rule into ', 'item/agentMessage/delta', 'demo-turn-cart');
      out('thread-cart-totals', 1, 'assistant_text', 'calculateTax() and removed the copy in checkout.', 'item/agentMessage/delta', 'demo-turn-cart');
      s.reasoning.push({ sequence: ++s.seq, occurredAt: at(1), threadId: 'thread-cart-totals', turnId: 'demo-turn-cart', text: 'Checking how the cart total helper is called from checkout before I edit it.', method: 'item/reasoning/summary', source: 'app_server' });
      out('thread-install-guide', 96, 'system', 'Operator message: Update the install steps for Node 22.', 'operator/message');
      out('thread-install-guide', 94, 'tool_status', 'Built install-guide-preview.html', 'item/completed');
      out('thread-install-guide', 94, 'assistant_text', 'Done. The install guide now lists Node 22 and the start command. The preview is ready.', 'item/completed');
      out('thread-webhook-retry', 31, 'system', 'Operator message: Add a retry to the webhook handler.', 'operator/message');
      out('thread-webhook-retry', 30, 'tool_status', 'Test run exited with code 1.', 'item/completed');
      out('thread-webhook-retry', 30, 'assistant_text', 'The test run failed because the retry limit is not set in the demo config. I stopped here.', 'item/completed');
      out('thread-invoice-summary', 7, 'system', "Operator message: Summarize last month's invoice export into a short file.", 'operator/message');
      out('thread-invoice-summary', 6, 'assistant_text', 'I can write the summary to exports/invoice-summary.md. This creates a new file, so I need your approval.', 'item/completed', 'demo-turn-invoice');

      const findSeed = (id) => s.threads.find((thread) => thread.id === id);
      s.approvals.push(approvalView({
        id: 'demo-approval-login', thread: findSeed('thread-login-test'), turnId: 'demo-turn-login',
        summary: 'Run npm test in demo-app', category: 'shell command', risk: 'medium',
        why: 'The agent wants to run the test command once to check its fix.',
        impact: 'Runs the local test command in the demo project. No network access.',
        commandPreview: 'npm test', decisionHint: 'Approve if the command only runs tests.', createdAt: at(4),
      }));
      s.outcomes.set('demo-approval-login', {
        approve: 'Command finished. The test passed 20 runs in a row in this simulation. The fix changes one wait, not the test.',
        deny: REPLY.denied,
      });
      s.approvals.push(approvalView({
        id: 'demo-approval-invoice', thread: findSeed('thread-invoice-summary'), turnId: 'demo-turn-invoice',
        summary: 'Create exports/invoice-summary.md', category: 'file change', risk: 'low',
        why: 'The agent wants to create one summary file in the exports folder.',
        impact: 'Creates one new file. Existing files are not changed.',
        fileSummary: 'exports/invoice-summary.md (new file, about 40 lines)', diffSummary: '+40 -0',
        decisionHint: 'Approve if you want the summary file in this folder.', createdAt: at(6),
      }));
      s.outcomes.set('demo-approval-invoice', {
        approve: 'Created exports/invoice-summary.md with a short summary. This is a simulated result.',
        deny: REPLY.denied,
      });
      s.approvals.push(approvalView({
        id: 'demo-approval-docs', thread: findSeed('thread-install-guide'), turnId: 'demo-turn-docs',
        summary: 'Update install guide link', category: 'file change', risk: 'low',
        why: 'The agent wants to fix one broken link.', impact: 'Changes one line in the install guide.',
        fileSummary: 'install-guide.md (1 line)', diffSummary: '+1 -1',
        decisionHint: 'Approve if the link target is correct.', createdAt: at(100),
      }));
      s.approvals[s.approvals.length - 1].status = 'approved';
      s.approvals[s.approvals.length - 1].resolvedAt = at(95);
      s.artifacts = [
        { id: 'demo-artifact-notes', threadId: 'thread-dark-mode', projectName: 'demo-app', threadName: 'Add dark mode toggle', artifactType: 'markdown', filename: 'dark-mode-notes.md', localPath: '~/projects/demo-app/notes/dark-mode-notes.md', sizeBytes: 2048, status: 'detected', createdAt: at(40) },
        { id: 'demo-artifact-guide', threadId: 'thread-install-guide', projectName: 'docs-site', threadName: 'Update install guide', artifactType: 'html', filename: 'install-guide-preview.html', localPath: '~/projects/docs-site/build/install-guide-preview.html', sizeBytes: 14336, status: 'manifested', createdAt: at(94) },
      ];
      addEvent('TurnCompleted', { threadId: 'thread-install-guide', turnId: undefined, summary: 'Turn completed. Preview is ready.', at: at(94) });
      addEvent('ApprovalResolved', { threadId: 'thread-install-guide', summary: 'Approval approved: Update install guide link', at: at(95) });
      addEvent('TurnFailed', { threadId: 'thread-webhook-retry', summary: 'Test run exited with code 1.', at: at(30) });
      addEvent('ApprovalRequested', { threadId: 'thread-login-test', summary: 'Approval requested: Run npm test in demo-app', at: at(4) });
      addEvent('TurnStarted', { threadId: 'thread-cart-totals', turnId: 'demo-turn-cart', summary: 'Turn started in build mode.', at: at(2) });
      addEvent('ApprovalRequested', { threadId: 'thread-invoice-summary', summary: 'Approval requested: Create exports/invoice-summary.md', at: at(6) });
    };

    const beginTurn = (thread, text, mode) => {
      const turnId = nextId('demo-turn');
      thread.mode = mode;
      thread.activeTurnId = turnId;
      thread.status = 'running';
      thread.lastSeenAt = iso(clock());
      thread.lastAccessAt = thread.lastSeenAt;
      addOutput(thread.id, { kind: 'system', text: `Operator message: ${text}`, method: 'operator/message', turnId });
      addEvent('OperatorMessageReceived', { threadId: thread.id, turnId, summary: `Operator message received (${text.length} chars)` });
      addEvent('TurnStarted', { threadId: thread.id, turnId, summary: `Turn started in ${mode} mode.` });
      return turnId;
    };

    const finishTurn = (thread, turnId, text) => {
      if (thread.activeTurnId !== turnId) return;
      addOutput(thread.id, { kind: 'assistant_text', text, method: 'item/completed', turnId });
      addEvent('TurnCompleted', { threadId: thread.id, turnId, summary: 'Turn completed. Reply shown in the thread.' });
      thread.status = 'idle';
      thread.activeTurnId = undefined;
    };

    const startTurn = (thread, body, mode) => {
      if (BUSY_STATUSES.includes(thread.status)) {
        throw new Error('Thread is already running. Use Steer / queue to send guidance.');
      }
      const text = String(body.message || '').trim();
      if (!text) throw new Error('Message is empty.');
      const turnId = beginTurn(thread, text, mode);
      if (mode === 'build') {
        requestApproval(thread, turnId, {
          summary: `Run npm test in ${thread.projectName}`,
          category: 'shell command',
          risk: 'medium',
          why: 'The agent wants to run the test command to check its change.',
          impact: 'Runs the local test command in the demo project. No network access.',
          commandPreview: 'npm test',
          decisionHint: 'Approve if the command only runs tests.',
          outcome: { approve: REPLY.built, deny: REPLY.denied },
        });
      } else {
        later(turnDelayMs, () => finishTurn(thread, turnId, REPLY.plan));
      }
      return { threadId: thread.id, turnId, mode };
    };

    const requestApproval = (thread, turnId, spec) => {
      const id = nextId('demo-approval');
      const { outcome, ...view } = spec;
      s.approvals.push(approvalView({ id, thread, turnId, createdAt: iso(clock()), ...view }));
      s.outcomes.set(id, outcome);
      thread.status = 'waiting_approval';
      addOutput(thread.id, { kind: 'tool_status', text: `Waiting for approval: ${spec.summary}`, method: 'approval/requested', turnId });
      addEvent('ApprovalRequested', { threadId: thread.id, turnId, summary: `Approval requested: ${spec.summary}` });
      return id;
    };

    const steer = (thread, text) => {
      const message = String(text || '').trim();
      if (!message) throw new Error('Message is empty.');
      const busy = BUSY_STATUSES.includes(thread.status);
      const turnId = thread.activeTurnId;
      addOutput(thread.id, { kind: 'system', text: `Operator guidance: ${message}`, method: 'operator/guidance', turnId });
      addEvent('OperatorMessageReceived', { threadId: thread.id, turnId, summary: `Operator guidance received (${message.length} chars)` });
      later(turnDelayMs, () => {
        if (busy && thread.activeTurnId !== turnId) return;
        addOutput(thread.id, { kind: 'assistant_text', text: REPLY.noted, method: 'item/completed', turnId });
      });
      return { threadId: thread.id, mode: busy ? 'steered' : 'queued' };
    };

    const interrupt = (thread) => {
      if (!BUSY_STATUSES.includes(thread.status)) {
        return { threadId: thread.id, mode: 'interrupt', note: 'No active turn.' };
      }
      s.approvals.forEach((approval) => {
        if (approval.threadId === thread.id && approval.status === 'pending') {
          approval.status = 'superseded';
          approval.resolvedAt = iso(clock());
        }
      });
      addOutput(thread.id, { kind: 'system', text: 'Turn interrupted by operator.', method: 'turn/interrupted', turnId: thread.activeTurnId });
      addEvent('TurnInterrupted', { threadId: thread.id, turnId: thread.activeTurnId, summary: 'Turn interrupted by operator.' });
      thread.status = 'interrupted';
      thread.activeTurnId = undefined;
      return { threadId: thread.id, mode: 'interrupt' };
    };

    const resolveApproval = (approvalId, decision, guidance = '') => {
      const approval = requireApproval(approvalId);
      if (approval.status !== 'pending') {
        throw new Error(`Approval ${approvalId} is already resolved (${approval.status}).`);
      }
      const text = String(guidance || '').trim();
      if (!decision && !text) throw new Error('approval_response requires guidance text, a decision, or both.');
      const thread = requireThread(approval.threadId);
      if (text) {
        addOutput(thread.id, { kind: 'system', text: `Operator guidance: ${text}`, method: 'operator/guidance', turnId: approval.turnId });
      }
      if (!decision) {
        return { approvalId, decision: null, guidanceSent: true, status: approval.status };
      }
      const approve = decision === 'approve' || decision === 'approved';
      if (!approve && decision !== 'deny' && decision !== 'denied') {
        throw new Error(`Unknown decision ${decision}.`);
      }
      approval.status = approve ? 'approved' : 'denied';
      approval.resolvedAt = iso(clock());
      addEvent('ApprovalResolved', { threadId: thread.id, turnId: approval.turnId, summary: `Approval ${approval.status}: ${approval.summary}` });
      const outcome = s.outcomes.get(approvalId) || {};
      if (thread.activeTurnId === approval.turnId) {
        thread.status = 'running';
        const turnId = approval.turnId;
        const reply = approve ? outcome.approve : outcome.deny;
        later(turnDelayMs, () => finishTurn(thread, turnId, reply || REPLY.built));
      }
      return { approvalId, decision: approve ? 'approved' : 'denied', guidanceSent: Boolean(text), status: approval.status };
    };

    const dismissApproval = (approvalId) => {
      const approval = requireApproval(approvalId);
      if (approval.status !== 'pending') {
        throw new Error(`Approval ${approvalId} is already resolved (${approval.status}).`);
      }
      approval.status = 'dismissed';
      approval.resolvedAt = iso(clock());
      return { approvalId, status: 'dismissed' };
    };

    const threadDetail = (threadId) => {
      const thread = requireThread(threadId);
      return {
        thread: { ...thread },
        approvals: s.approvals.filter((approval) => approval.threadId === threadId),
        artifacts: s.artifacts.filter((artifact) => artifact.threadId === threadId),
        outputs: s.outputs.filter((output) => output.threadId === threadId).slice(-25),
        reasoningSummaries: s.reasoning.filter((item) => item.threadId === threadId).slice(-10),
        events: s.events.filter((event) => event.threadId === threadId).slice(-50),
      };
    };

    const parseMessage = (raw) => {
      if (!raw) return {};
      try {
        const value = JSON.parse(raw);
        return value && typeof value === 'object' ? value : { message: String(raw) };
      } catch {
        return { message: String(raw) };
      }
    };

    const execute = (command) => {
      const targetId = command.targetId;
      switch (command.action) {
        case 'refresh':
          return { refreshed: true };
        case 'list_threads':
          return {
            catalog: {
              generatedAt: iso(clock()),
              totalCount: s.threads.length,
              count: s.threads.length,
              threads: s.threads.map((thread, index) => ({ ...thread, catalogOrder: index + 1, source: 'demo' })),
              projects: PROJECTS.map((project) => ({ ...project, isEnabled: true })),
              threadListHealth: { status: 'ok' },
              note: 'Demo threads are made up. Nothing here comes from a real Codex session.',
            },
          };
        case 'list_skills':
          requireThread(targetId);
          return { threadId: targetId, skills: SKILLS };
        case 'thread_detail':
          return { threadId: targetId, detail: threadDetail(targetId) };
        case 'watch_thread':
          threadDetail(targetId);
          s.watchedThreadId = targetId;
          return { threadId: targetId, detail: threadDetail(targetId), watched: true };
        case 'last_output': {
          const thread = requireThread(targetId);
          const latest = [...s.outputs].reverse().find((output) => output.threadId === targetId && output.kind === 'assistant_text');
          return { threadId: targetId, thread: { ...thread }, output: latest || null };
        }
        case 'set_mode': {
          const thread = requireThread(targetId);
          const mode = String(command.message || '').trim();
          if (mode !== 'plan' && mode !== 'build') throw new Error('Mode must be plan or build.');
          thread.mode = mode;
          return { threadId: targetId, mode };
        }
        case 'run':
        case 'plan':
        case 'start_with_skills': {
          const thread = requireThread(targetId);
          const body = parseMessage(command.message);
          const mode = command.action === 'plan' ? 'plan' : body.mode || 'build';
          return { ...startTurn(thread, body, mode), skills: body.skills || [] };
        }
        case 'say':
          return steer(requireThread(targetId), command.message);
        case 'interrupt':
          return interrupt(requireThread(targetId));
        case 'approve':
        case 'deny':
          return resolveApproval(targetId, command.action, '');
        case 'approval_response': {
          const body = parseMessage(command.message);
          return resolveApproval(targetId, body.decision, body.guidance);
        }
        case 'dismiss_approval':
          return dismissApproval(targetId);
        default:
          throw new Error(`Not available in the demo: ${command.action}.`);
      }
    };

    const complete = (command) => {
      let outcome;
      try {
        outcome = { ok: true, message: `Executed ${command.action}`, data: execute(command) };
      } catch (error) {
        outcome = { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      command.status = outcome.ok ? 'completed' : 'failed';
      s.results.set(command.id, {
        commandId: command.id,
        ok: outcome.ok,
        message: outcome.message,
        completedAt: iso(clock()),
        ...(outcome.data ? { data: outcome.data } : {}),
      });
    };

    const queueCommand = (body) => {
      if (typeof body.action !== 'string' || !body.action) {
        return [400, { error: 'invalid relay command action', storage: STORAGE }];
      }
      const command = {
        id: body.clientRequestId || nextId('demo-command'),
        action: body.action,
        targetKind: body.targetKind || 'daemon',
        targetId: body.targetId,
        message: body.action === 'attach_file' ? undefined : body.message,
        clientRequestId: body.clientRequestId,
        status: 'pending',
        createdAt: iso(clock()),
      };
      s.commands.set(command.id, command);
      later(commandDelayMs, () => complete(command));
      return [202, { command: { ...command }, storage: STORAGE }];
    };

    const resultFor = (commandId) => {
      const result = s.results.get(commandId);
      if (result) return [200, { status: 'completed', result, storage: STORAGE }];
      const command = s.commands.get(commandId);
      if (command) {
        return [202, {
          status: 'pending',
          command: { ...command },
          retryAfterMs: 400,
          message: 'Command is queued in the simulated Mac.',
          storage: STORAGE,
        }];
      }
      return [404, { error: 'result_not_found', storage: STORAGE }];
    };

    const snapshot = () => {
      const pending = s.approvals.filter((approval) => approval.status === 'pending');
      const history = s.approvals
        .filter((approval) => approval.status !== 'pending')
        .sort((left, right) => Date.parse(right.resolvedAt) - Date.parse(left.resolvedAt))
        .slice(0, 50);
      const body = {
        generatedAt: iso(clock()),
        statusText: 'Daemon: simulated\nCodex: simulated\nApp Server: simulated\nRelay: simulated in this browser',
        health: { codexTransportStatus: 'connected', note: 'Simulated transport. No computer is connected.' },
        counts: {
          projects: PROJECTS.length,
          threads: s.threads.length,
          pendingApprovals: pending.length,
          artifacts: s.artifacts.length,
        },
        projects: PROJECTS.map((project) => ({ ...project, isEnabled: true })),
        threads: s.threads.map((thread) => ({ ...thread })),
        approvals: pending,
        approvalHistory: history,
        artifacts: s.artifacts,
        events: s.events.slice(-50),
        webSession: {
          generatedAt: iso(clock()),
          authenticated: true,
          web: { controlEnabled: true, authRequired: false },
          codexAccount: { source: 'demo', status: 'simulated', note: 'Demo only. No Codex account is used.' },
        },
      };
      if (s.watchedThreadId && findThread(s.watchedThreadId)) {
        body.watchedThreadId = s.watchedThreadId;
        body.watchedThreadDetail = threadDetail(s.watchedThreadId);
      }
      return body;
    };

    const route = (method, path, body) => {
      if (method === 'GET' && path === '/api/relay/status') {
        return [200, { ok: true, storage: STORAGE, generatedAt: iso(clock()) }];
      }
      if (method === 'GET' && path === '/api/relay/snapshot') {
        const generatedAt = iso(clock());
        return [200, { macId: 'demo-mac', generatedAt, snapshot: snapshot(), relay: { mode: 'demo', storage: STORAGE, lastSnapshotAt: generatedAt }, storage: STORAGE }];
      }
      if (method === 'GET' && path === '/api/relay/commands/results') {
        return [200, { results: [...s.results.values()].reverse().slice(0, 25), storage: STORAGE }];
      }
      if (method === 'POST' && path === '/api/relay/commands') {
        return queueCommand(body);
      }
      const resultMatch = path.match(/^\/api\/relay\/commands\/([^/]+)\/result$/);
      if (method === 'GET' && resultMatch) {
        return resultFor(decodeURIComponent(resultMatch[1]));
      }
      return [404, { error: 'not_available_in_demo', message: 'Not available in the demo.', storage: STORAGE }];
    };

    // Same contract as fetch for the calls the console makes. Returns a Response.
    const respond = async (url, options = {}) => {
      const method = String(options.method || 'GET').toUpperCase();
      const path = String(url).replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').split('?')[0];
      let body = {};
      try {
        body = options.body ? JSON.parse(options.body) : {};
      } catch {
        return new Response(JSON.stringify({ error: 'invalid_json', storage: STORAGE }), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } });
      }
      let status;
      let value;
      try {
        [status, value] = route(method, path, body);
      } catch (error) {
        status = 400;
        value = { error: error instanceof Error ? error.message : String(error), storage: STORAGE };
      }
      return new Response(JSON.stringify(value, null, 2), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    };

    const reset = () => {
      generation += 1;
      tasks.clear();
      seed(clock());
    };
    const settle = async () => {
      while (tasks.size) {
        await Promise.allSettled([...tasks]);
      }
    };

    reset();
    return { respond, reset, settle };
  };

  globalThis.RccDemoRelay = { createDemoRelay };
})();
