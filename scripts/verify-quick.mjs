#!/usr/bin/env node
import { spawn } from 'node:child_process';

const checks = [
  { name: 'web-static', command: 'npm', args: ['run', 'web:check'], timeoutMs: 10_000 },
  { name: 'relay-api-syntax', command: 'npm', args: ['run', 'relay:check'], timeoutMs: 10_000 },
  { name: 'tracked-secret-scan', command: 'npm', args: ['run', 'secrets:check'], timeoutMs: 10_000 },
  { name: 'launchd-static', command: 'npm', args: ['run', 'launchd:check'], timeoutMs: 10_000 },
  { name: 'typecheck', command: 'npm', args: ['run', 'typecheck'], timeoutMs: 45_000 },
  { name: 'tests', command: 'npm', args: ['test'], timeoutMs: 60_000 },
];

const run = (check) =>
  new Promise((resolve) => {
    const child = spawn(check.command, check.args, { stdio: 'inherit', shell: false });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ ...check, ok: false, timedOut: true, code: null });
    }, check.timeoutMs);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ ...check, ok: code === 0, timedOut: false, code });
    });
  });

const results = [];
for (const check of checks) {
  console.log(`\n[verify:quick] ${check.name} (${Math.round(check.timeoutMs / 1000)}s timeout)`);
  const result = await run(check);
  results.push(result);
  if (!result.ok) {
    console.error(`\n[verify:quick] ${result.name} failed${result.timedOut ? ' by timeout' : ` with exit code ${result.code}`}`);
    process.exitCode = 1;
    break;
  }
}

if (!process.exitCode) {
  console.log('\n[verify:quick] all checks passed');
}
