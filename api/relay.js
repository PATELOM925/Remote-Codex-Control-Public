import { randomUUID } from 'node:crypto';

const MEMORY_COMMAND_LIMIT = 250;
const VALID_ACTIONS = [
  'run',
  'plan',
  'say',
  'interrupt',
  'approve',
  'deny',
  'refresh',
  'thread_detail',
  'list_threads',
  'list_skills',
  'start_with_skills',
  'set_mode',
  'attach_file',
  'watch_thread',
  'last_output',
  'approval_response',
  'dismiss_approval',
];
const VALID_TARGET_KINDS = ['thread', 'approval', 'daemon'];
const SUPABASE_COMPAT_ACTIONS = new Set([
  'list_threads',
  'list_skills',
  'start_with_skills',
  'set_mode',
  'plan',
  'attach_file',
  'watch_thread',
  'last_output',
  'approval_response',
  'dismiss_approval',
]);

const memory = {
  commands: new Map(),
  results: new Map(),
  snapshot: undefined,
  lastMacPollAt: undefined,
};

const json = (response, status, value) => {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(value, null, 2));
};

const readBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
};

const token = (request) => String(request.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

const auth = (request, response, role) => {
  const expected = role === 'mac' ? process.env.RCC_RELAY_MAC_TOKEN : process.env.RCC_RELAY_OPERATOR_TOKEN;
  if (expected && token(request) === expected) {
    return true;
  }
  json(response, 401, { error: 'relay_unauthorized', role });
  return false;
};

const configuredAllowedOrigins = () =>
  String(process.env.RCC_RELAY_ALLOWED_ORIGINS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const isVercelRuntime = (request) =>
  process.env.VERCEL === '1' || Boolean(process.env.VERCEL_URL) || Boolean(request.headers['x-vercel-id']);

const sameOriginFallback = (request) => {
  const origin = request.headers.origin;
  if (!origin) return true;
  const host = request.headers['x-forwarded-host'] || request.headers.host;
  if (!host) return false;
  const proto = request.headers['x-forwarded-proto'] || 'https';
  return origin === `${proto}://${host}`;
};

const isAllowedOrigin = (request) => {
  const origin = request.headers.origin;
  if (!origin) return true;
  const allowed = configuredAllowedOrigins();
  if (allowed.length > 0) return allowed.includes(origin);
  if (isVercelRuntime(request)) return sameOriginFallback(request);
  return true;
};

const allowCors = (request, response) => {
  const origin = request.headers.origin;
  if (origin && isAllowedOrigin(request)) {
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('vary', 'Origin');
  }
  response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  response.setHeader('access-control-allow-headers', 'authorization,content-type');
  response.setHeader('access-control-max-age', '600');
};

const requireAllowedOrigin = (request, response) => {
  if (isAllowedOrigin(request)) return true;
  json(response, 403, { error: 'relay_origin_forbidden' });
  return false;
};

const trim = (map, max) => {
  while (map.size > max) {
    const key = map.keys().next().value;
    if (!key) return;
    map.delete(key);
  }
};

const validateAction = (action) => {
  if (!VALID_ACTIONS.includes(action)) {
    throw new Error('invalid relay command action');
  }
};

const validateTargetKind = (targetKind) => {
  if (!VALID_TARGET_KINDS.includes(targetKind)) {
    throw new Error('invalid relay command target kind');
  }
};

const storageConfig = () => {
  const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
  const requested = String(process.env.RCC_RELAY_STORAGE || '').trim().toLowerCase();
  if (requested === 'supabase' && (!supabaseUrl || !supabaseKey)) {
    return {
      mode: 'misconfigured',
      requested,
      error: 'RCC_RELAY_STORAGE=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY',
    };
  }
  if (supabaseUrl && supabaseKey) {
    return { mode: 'supabase', supabaseUrl, supabaseKey };
  }
  return {
    mode: 'memory_ephemeral',
    note: 'Ephemeral alpha relay. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for durable storage.',
  };
};

const storageInfo = () => {
  const config = storageConfig();
  if (config.mode === 'supabase') {
    return {
      mode: 'supabase',
      durable: true,
      projectUrl: config.supabaseUrl,
    };
  }
  return {
    mode: config.mode,
    durable: false,
    note: config.error || config.note,
  };
};

const ensureStorageReady = (response) => {
  const config = storageConfig();
  if (config.mode === 'misconfigured') {
    json(response, 503, {
      error: 'relay_storage_misconfigured',
      message: config.error,
      storage: storageInfo(),
    });
    return undefined;
  }
  return config;
};

const supabaseHeaders = (config, prefer) => ({
  apikey: config.supabaseKey,
  authorization: `Bearer ${config.supabaseKey}`,
  'content-type': 'application/json',
  ...(prefer ? { prefer } : {}),
});

const supabaseUrl = (config, table, query = '') =>
  `${config.supabaseUrl}/rest/v1/${table}${query ? `?${query}` : ''}`;

const supabaseRequest = async (config, table, { method = 'GET', query = '', body, prefer } = {}) => {
  const response = await fetch(supabaseUrl(config, table, query), {
    method,
    headers: supabaseHeaders(config, prefer),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`supabase_request_failed:${response.status}:${text.slice(0, 240)}`);
  }
  return text ? JSON.parse(text) : null;
};

const decodeCompatAction = (action, message) => {
  const raw = String(message || '');
  const match = action === 'refresh' ? raw.match(/^__rcc_action:([a-z_]+)\n([\s\S]*)$/) : null;
  if (!match) {
    return { action, message: message || undefined };
  }
  const decodedAction = VALID_ACTIONS.includes(match[1]) ? match[1] : action;
  return { action: decodedAction, message: match[2] || undefined };
};

const encodeCompatAction = (body) => {
  if (!SUPABASE_COMPAT_ACTIONS.has(body.action)) {
    return { action: body.action, message: body.message || null };
  }
  return {
    action: 'refresh',
    message: `__rcc_action:${body.action}\n${body.message || ''}`,
  };
};

const sanitizeCommandForOperator = (command) => {
  if (!command || command.action !== 'attach_file') {
    return command;
  }
  let summary = 'Relay file upload payload hidden from operator polling responses.';
  try {
    const parsed = JSON.parse(String(command.message || '{}'));
    if (Array.isArray(parsed.files)) {
      summary = `Relay upload: ${parsed.files.length} file(s): ${parsed.files
        .map((file) => `${file?.name || 'unnamed'} (${Number(file?.sizeBytes || 0)} bytes)`)
        .join(', ')}`;
    }
  } catch {
    summary = 'Relay file upload payload hidden from operator polling responses.';
  }
  return {
    ...command,
    message: summary,
    payloadRedacted: true,
  };
};

const toCommand = (row) => {
  const decoded = decodeCompatAction(row.action, row.message);
  return {
    id: row.id,
    action: decoded.action,
    targetKind: row.target_kind,
    targetId: row.target_id || undefined,
    message: decoded.message,
    clientRequestId: row.client_request_id || undefined,
    status: row.status,
    macId: row.mac_id || undefined,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at || undefined,
    completedAt: row.completed_at || undefined,
  };
};

const toResult = (row) => ({
  commandId: row.command_id,
  ok: row.ok === true,
  message: row.message,
  completedAt: row.completed_at,
  data: row.data || undefined,
});

const toSnapshot = (row) => ({
  macId: row.mac_id,
  generatedAt: row.generated_at || row.updated_at,
  snapshot: row.payload,
  relay: {
    mode: 'short_poll',
    storage: storageInfo(),
    lastMacPollAt: row.last_mac_poll_at || undefined,
    lastSnapshotAt: row.updated_at,
  },
});

const memoryCreateCommand = (body) => {
  const now = new Date().toISOString();
  const command = {
    id: body.clientRequestId || randomUUID(),
    action: body.action,
    targetKind: body.targetKind || 'daemon',
    targetId: body.targetId,
    message: body.message,
    clientRequestId: body.clientRequestId,
    status: 'pending',
    createdAt: now,
  };
  memory.commands.set(command.id, command);
  trim(memory.commands, MEMORY_COMMAND_LIMIT);
  return command;
};

const supabaseCreateCommand = async (config, body) => {
  const targetKind = body.targetKind || 'daemon';
  const encoded = encodeCompatAction(body);
  const command = {
    id: body.clientRequestId || randomUUID(),
    action: encoded.action,
    target_kind: targetKind,
    target_id: body.targetId || null,
    message: encoded.message,
    client_request_id: body.clientRequestId || null,
    status: 'pending',
  };
  const rows = await supabaseRequest(config, 'rcc_relay_commands', {
    method: 'POST',
    body: command,
    prefer: 'return=representation',
  });
  return toCommand(rows[0]);
};

const memoryPollCommands = (macId) => {
  const now = new Date().toISOString();
  memory.lastMacPollAt = now;
  const pending = [...memory.commands.values()]
    .filter((command) => command.status === 'pending')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(0, 25)
    .map((command) => {
      const delivered = {
        ...command,
        macId,
        status: 'delivered',
        deliveredAt: now,
      };
      memory.commands.set(command.id, delivered);
      return delivered;
    });
  return { commands: pending, generatedAt: now };
};

const supabasePollCommands = async (config, macId) => {
  const now = new Date().toISOString();
  const query = 'status=eq.pending&order=created_at.asc&limit=25';
  const pendingRows = await supabaseRequest(config, 'rcc_relay_commands', { query });
  const delivered = [];
  for (const row of pendingRows || []) {
    const updateQuery = `id=eq.${encodeURIComponent(row.id)}`;
    const updated = await supabaseRequest(config, 'rcc_relay_commands', {
      method: 'PATCH',
      query: updateQuery,
      body: {
        status: 'delivered',
        mac_id: macId,
        delivered_at: now,
      },
      prefer: 'return=representation',
    });
    if (updated?.[0]) {
      delivered.push(toCommand(updated[0]));
    }
  }
  return { commands: delivered, generatedAt: now };
};

const memorySaveResult = (commandId, body) => {
  const completedAt = new Date().toISOString();
  const result = {
    commandId,
    ok: body.ok === true,
    message: typeof body.message === 'string' ? body.message : body.ok === true ? 'ok' : 'failed',
    completedAt,
    data: body.data,
  };
  memory.results.set(commandId, result);
  trim(memory.results, MEMORY_COMMAND_LIMIT);
  const command = memory.commands.get(commandId);
  if (command) {
    memory.commands.set(commandId, {
      ...command,
      status: result.ok ? 'completed' : 'failed',
      completedAt,
    });
  }
  return result;
};

const supabaseSaveResult = async (config, commandId, body) => {
  const completedAt = new Date().toISOString();
  const resultRow = {
    command_id: commandId,
    ok: body.ok === true,
    message: typeof body.message === 'string' ? body.message : body.ok === true ? 'ok' : 'failed',
    data: body.data || null,
    completed_at: completedAt,
  };
  const rows = await supabaseRequest(config, 'rcc_relay_results', {
    method: 'POST',
    query: 'on_conflict=command_id',
    body: resultRow,
    prefer: 'resolution=merge-duplicates,return=representation',
  });
  await supabaseRequest(config, 'rcc_relay_commands', {
    method: 'PATCH',
    query: `id=eq.${encodeURIComponent(commandId)}`,
    body: {
      status: resultRow.ok ? 'completed' : 'failed',
      completed_at: completedAt,
    },
    prefer: 'return=minimal',
  });
  return toResult(rows[0]);
};

const memoryGetResult = (commandId) => memory.results.get(commandId);

const memoryGetCommand = (commandId) => memory.commands.get(commandId);

const supabaseGetResult = async (config, commandId) => {
  const rows = await supabaseRequest(config, 'rcc_relay_results', {
    query: `command_id=eq.${encodeURIComponent(commandId)}&limit=1`,
  });
  return rows?.[0] ? toResult(rows[0]) : undefined;
};

const supabaseGetCommand = async (config, commandId) => {
  const rows = await supabaseRequest(config, 'rcc_relay_commands', {
    query: `id=eq.${encodeURIComponent(commandId)}&limit=1`,
  });
  return rows?.[0] ? toCommand(rows[0]) : undefined;
};

const pendingResultPayload = (command) => ({
  status: 'pending',
  command: sanitizeCommandForOperator(command),
  retryAfterMs: 1100,
  message:
    command.status === 'delivered'
      ? 'Command has been delivered to the Mac daemon and is waiting for completion.'
      : 'Command is queued and waiting for the Mac daemon to poll the relay.',
  storage: storageInfo(),
});

const memoryListResults = () =>
  [...memory.results.values()].sort((left, right) => right.completedAt.localeCompare(left.completedAt)).slice(0, 25);

const supabaseListResults = async (config) => {
  const rows = await supabaseRequest(config, 'rcc_relay_results', {
    query: 'order=completed_at.desc&limit=25',
  });
  return (rows || []).map(toResult);
};

const memorySaveSnapshot = (body) => {
  const now = new Date().toISOString();
  memory.snapshot = {
    macId: body.macId || 'default-mac',
    generatedAt: now,
    snapshot: body.snapshot || body,
    relay: {
      mode: 'short_poll',
      storage: storageInfo(),
      lastMacPollAt: memory.lastMacPollAt,
      lastSnapshotAt: now,
    },
  };
  return memory.snapshot;
};

const supabaseSaveSnapshot = async (config, body) => {
  const now = new Date().toISOString();
  const row = {
    mac_id: body.macId || 'default-mac',
    payload: body.snapshot || body,
    generated_at: now,
    updated_at: now,
  };
  const rows = await supabaseRequest(config, 'rcc_relay_snapshots', {
    method: 'POST',
    query: 'on_conflict=mac_id',
    body: row,
    prefer: 'resolution=merge-duplicates,return=representation',
  });
  return toSnapshot(rows[0]);
};

const memoryGetSnapshot = () => memory.snapshot;

const supabaseGetSnapshot = async (config) => {
  const rows = await supabaseRequest(config, 'rcc_relay_snapshots', {
    query: 'order=updated_at.desc&limit=1',
  });
  return rows?.[0] ? toSnapshot(rows[0]) : undefined;
};

export default async function handler(request, response) {
  allowCors(request, response);
  if (request.method === 'OPTIONS') {
    response.statusCode = isAllowedOrigin(request) ? 204 : 403;
    response.end();
    return;
  }

  const config = ensureStorageReady(response);
  if (!config) return;

  const url = new URL(request.url || '/', `https://${request.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (pathname === '/api/relay/status' && request.method === 'GET') {
      if (!requireAllowedOrigin(request, response)) return;
      if (!auth(request, response, 'operator')) return;
      json(response, 200, {
        ok: true,
        storage: storageInfo(),
        generatedAt: new Date().toISOString(),
      });
      return;
    }

    if (pathname === '/api/relay/commands' && request.method === 'POST') {
      if (!requireAllowedOrigin(request, response)) return;
      if (!auth(request, response, 'operator')) return;
      const body = await readBody(request);
      validateAction(body.action);
      validateTargetKind(body.targetKind || 'daemon');
      const command =
        config.mode === 'supabase' ? await supabaseCreateCommand(config, body) : memoryCreateCommand(body);
      json(response, 202, { command: sanitizeCommandForOperator(command), storage: storageInfo() });
      return;
    }

    if (pathname === '/api/relay/commands/poll' && request.method === 'GET') {
      if (!auth(request, response, 'mac')) return;
      const macId = url.searchParams.get('macId') || 'default-mac';
      const payload =
        config.mode === 'supabase' ? await supabasePollCommands(config, macId) : memoryPollCommands(macId);
      json(response, 200, { ...payload, storage: storageInfo() });
      return;
    }

    const resultMatch = pathname.match(/^\/api\/relay\/commands\/([^/]+)\/result$/);
    if (resultMatch && request.method === 'POST') {
      if (!auth(request, response, 'mac')) return;
      const body = await readBody(request);
      const commandId = decodeURIComponent(resultMatch[1]);
      const result =
        config.mode === 'supabase'
          ? await supabaseSaveResult(config, commandId, body)
          : memorySaveResult(commandId, body);
      json(response, 200, { result, storage: storageInfo() });
      return;
    }

    if (resultMatch && request.method === 'GET') {
      if (!requireAllowedOrigin(request, response)) return;
      if (!auth(request, response, 'operator')) return;
      const commandId = decodeURIComponent(resultMatch[1]);
      const result =
        config.mode === 'supabase'
          ? await supabaseGetResult(config, commandId)
          : memoryGetResult(commandId);
      if (result) {
        json(response, 200, { status: 'completed', result, storage: storageInfo() });
        return;
      }
      const command =
        config.mode === 'supabase'
          ? await supabaseGetCommand(config, commandId)
          : memoryGetCommand(commandId);
      if (command) {
        json(response, 202, pendingResultPayload(command));
        return;
      }
      json(response, 404, { error: 'result_not_found', storage: storageInfo() });
      return;
    }

    if (pathname === '/api/relay/commands/results' && request.method === 'GET') {
      if (!requireAllowedOrigin(request, response)) return;
      if (!auth(request, response, 'operator')) return;
      const results = config.mode === 'supabase' ? await supabaseListResults(config) : memoryListResults();
      json(response, 200, { results, storage: storageInfo() });
      return;
    }

    if (pathname === '/api/relay/snapshot' && request.method === 'POST') {
      if (!auth(request, response, 'mac')) return;
      const body = await readBody(request);
      const snapshot =
        config.mode === 'supabase' ? await supabaseSaveSnapshot(config, body) : memorySaveSnapshot(body);
      json(response, 200, { snapshot, storage: storageInfo() });
      return;
    }

    if (pathname === '/api/relay/snapshot' && request.method === 'GET') {
      if (!requireAllowedOrigin(request, response)) return;
      if (!auth(request, response, 'operator')) return;
      const snapshot = config.mode === 'supabase' ? await supabaseGetSnapshot(config) : memoryGetSnapshot();
      json(response, snapshot ? 200 : 404, snapshot ? { ...snapshot, storage: storageInfo() } : { error: 'snapshot_not_found', storage: storageInfo() });
      return;
    }

    json(response, 404, { error: 'relay_not_found', storage: storageInfo() });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : String(error), storage: storageInfo() });
  }
}
