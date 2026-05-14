import http, { type Server } from 'node:http';
import { URL } from 'node:url';

import type { Logger } from '../logger.js';
import { nowIso } from '../utils/time.js';

import { InMemoryRelayStore } from './inMemoryRelayStore.js';
import type { RelayAuthConfig, RelayCommandInput } from './types.js';

export interface RelayHttpServerOptions extends RelayAuthConfig {
  host?: string;
  port?: number;
  logger?: Logger;
}

export class RelayHttpServer {
  private readonly store: InMemoryRelayStore;
  private readonly host: string;
  private readonly port: number;
  private readonly allowedOrigins: string[];
  private server?: Server;

  constructor(private readonly options: RelayHttpServerOptions) {
    this.store = new InMemoryRelayStore(options.operatorToken, options.macToken);
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 4865;
    this.allowedOrigins = options.allowedOrigins ?? [];
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = http.createServer((request, response) => {
      this.handleRequest(request, response).catch((error) => {
        this.sendJson(response, 500, {
          error: 'relay_internal_error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.port, this.host, () => {
        this.server?.off('error', reject);
        resolve();
      });
    });

    this.options.logger?.info('relay-http-server-started', { url: this.url() });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  url(): string | undefined {
    if (!this.server) {
      return undefined;
    }
    const address = this.server.address();
    const port = typeof address === 'object' && address ? address.port : this.port;
    return `http://${this.host}:${port}`;
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    this.applyCors(request, response);

    if (request.method === 'OPTIONS') {
      response.writeHead(this.isOriginAllowed(request.headers.origin) ? 204 : 403);
      response.end();
      return;
    }
    if (!this.isOriginAllowed(request.headers.origin)) {
      this.sendJson(response, 403, { error: 'relay_origin_forbidden' });
      return;
    }

    if (url.pathname === '/api/relay/commands' && request.method === 'POST') {
      if (!this.requireAuth(request, response, 'operator')) return;
      const input = this.validateCommandInput(await this.readJsonBody(request));
      this.sendJson(response, 202, { command: this.sanitizeCommand(this.store.enqueue(input)) });
      return;
    }

    if (url.pathname === '/api/relay/commands/poll' && request.method === 'GET') {
      if (!this.requireAuth(request, response, 'mac')) return;
      const macId = url.searchParams.get('macId')?.trim() || 'default-mac';
      this.sendJson(response, 200, {
        commands: this.store.poll(macId),
        generatedAt: nowIso(),
      });
      return;
    }

    const resultMatch = url.pathname.match(/^\/api\/relay\/commands\/([^/]+)\/result$/);
    if (resultMatch?.[1]) {
      const commandId = decodeURIComponent(resultMatch[1]);
      if (request.method === 'POST') {
        if (!this.requireAuth(request, response, 'mac')) return;
        const body = await this.readJsonBody(request);
        this.sendJson(response, 200, {
          result: this.store.complete(commandId, {
            ok: body.ok === true,
            message: typeof body.message === 'string' ? body.message : body.ok === true ? 'ok' : 'failed',
            data: body.data,
          }),
        });
        return;
      }
      if (request.method === 'GET') {
        if (!this.requireAuth(request, response, 'operator')) return;
        const result = this.store.getResult(commandId);
        if (result) {
          this.sendJson(response, 200, { status: 'completed', result });
          return;
        }
        const command = this.store.getCommand(commandId);
        if (command) {
          this.sendJson(response, 202, {
            status: 'pending',
            command: this.sanitizeCommand(command),
            retryAfterMs: 1100,
            message:
              command.status === 'delivered'
                ? 'Command has been delivered to the Mac daemon and is waiting for completion.'
                : 'Command is queued and waiting for the Mac daemon to poll the relay.',
          });
          return;
        }
        this.sendJson(response, 404, { error: 'result_not_found' });
        return;
      }
    }

    if (url.pathname === '/api/relay/commands/results' && request.method === 'GET') {
      if (!this.requireAuth(request, response, 'operator')) return;
      this.sendJson(response, 200, { results: this.store.listResults() });
      return;
    }

    if (url.pathname === '/api/relay/snapshot') {
      if (request.method === 'POST') {
        if (!this.requireAuth(request, response, 'mac')) return;
        const body = await this.readJsonBody(request);
        const macId = typeof body.macId === 'string' ? body.macId : 'default-mac';
        this.sendJson(response, 200, { snapshot: this.store.updateSnapshot(macId, body.snapshot ?? body) });
        return;
      }
      if (request.method === 'GET') {
        if (!this.requireAuth(request, response, 'operator')) return;
        const snapshot = this.store.getSnapshot();
        this.sendJson(response, snapshot ? 200 : 404, snapshot ?? { error: 'snapshot_not_found' });
        return;
      }
    }

    this.sendJson(response, 404, { error: 'relay_not_found' });
  }

  private validateCommandInput(body: Record<string, unknown>): RelayCommandInput {
    const action = body.action;
    if (
      ![
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
      ].includes(String(action))
    ) {
      throw new Error('invalid relay command action');
    }
    const targetKind = typeof body.targetKind === 'string' ? body.targetKind : undefined;
    if (targetKind && !['thread', 'approval', 'daemon'].includes(targetKind)) {
      throw new Error('invalid relay target kind');
    }
    return {
      action: action as RelayCommandInput['action'],
      targetKind: targetKind as RelayCommandInput['targetKind'],
      targetId: typeof body.targetId === 'string' ? body.targetId : undefined,
      message: typeof body.message === 'string' ? body.message : undefined,
      clientRequestId: typeof body.clientRequestId === 'string' ? body.clientRequestId : undefined,
    };
  }

  private sanitizeCommand(command: RelayCommandInput & {
    id?: string;
    status?: string;
    macId?: string;
    createdAt?: string;
    deliveredAt?: string;
    completedAt?: string;
  }): Record<string, unknown> {
    if (command.action !== 'attach_file') {
      return { ...command };
    }
    let summary = 'Relay file upload payload hidden from operator polling responses.';
    try {
      const parsed = JSON.parse(String(command.message || '{}')) as { files?: Array<{ name?: string; sizeBytes?: number }> };
      if (Array.isArray(parsed.files)) {
        summary = `Relay upload: ${parsed.files.length} file(s): ${parsed.files
          .map((file) => `${file.name || 'unnamed'} (${file.sizeBytes || 0} bytes)`)
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
  }

  private requireAuth(request: http.IncomingMessage, response: http.ServerResponse, role: 'operator' | 'mac'): boolean {
    const token = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    if (this.store.authenticate(role, token)) {
      return true;
    }
    this.sendJson(response, 401, { error: 'relay_unauthorized', role });
    return false;
  }

  private async readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) {
      return {};
    }
    return JSON.parse(raw) as Record<string, unknown>;
  }

  private sendJson(response: http.ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify(value, null, 2));
  }

  private applyCors(request: http.IncomingMessage, response: http.ServerResponse): void {
    const origin = request.headers.origin;
    if (!origin || !this.isOriginAllowed(origin)) {
      return;
    }
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('vary', 'Origin');
    response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    response.setHeader('access-control-allow-headers', 'authorization,content-type');
    response.setHeader('access-control-max-age', '600');
  }

  private isOriginAllowed(origin: string | undefined): boolean {
    if (!origin) {
      return true;
    }
    return this.allowedOrigins.length === 0 || this.allowedOrigins.includes(origin);
  }
}
