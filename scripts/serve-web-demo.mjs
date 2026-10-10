#!/usr/bin/env node
// Serves dist-demo/ on 127.0.0.1 for local checks. Sends the same headers as
// dist-demo/_headers, so the browser enforces the same Content-Security-Policy.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.resolve(process.argv[2] || path.join(root, 'dist-demo'));
const port = Number(process.env.PORT || 4790);
const headersFile = path.join(dir, '_headers');

if (!fs.existsSync(headersFile)) {
  console.error(`[web:demo:serve] ${path.relative(root, headersFile)} is missing. Run npm run web:demo:build first.`);
  process.exit(1);
}

const headers = {};
for (const line of fs.readFileSync(headersFile, 'utf8').split('\n')) {
  if (!/^\s+[A-Za-z-]+:/.test(line)) continue;
  const index = line.indexOf(':');
  headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' });
    response.end();
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
  } catch {
    response.writeHead(400);
    response.end();
    return;
  }
  const file = path.join(dir, pathname === '/' ? 'index.html' : pathname);
  const inside = file.startsWith(`${dir}${path.sep}`);
  if (!inside || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    response.writeHead(404, { ...headers, 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  const { size } = fs.statSync(file);
  response.writeHead(200, {
    ...headers,
    'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
    'content-length': size,
    'cache-control': 'no-store',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  fs.createReadStream(file).pipe(response);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[web:demo:serve] serving ${path.relative(root, dir) || '.'} at http://127.0.0.1:${port}/`);
});
