#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const skipPaths = [
  /^package-lock\.json$/,
  /^node_modules\//,
  /^\.dist\//,
  /^dist\//,
  /^setup\.md$/,
  /^src\/utils\/redaction\.ts$/,
];

const isProbablyText = (buffer) => !buffer.includes(0);
const obviousFixture = (value) =>
  /(abcdefghijklmnopqrstuvwxyz|supersecret|privatevalue|secrettextdelta|operator-relay-token|mac-relay-token|test-chat|example\.com)/i.test(
    value,
  );
const placeholder = (value) => {
  const trimmed = value.trim().replace(/^['"`]+|['"`;,]+$/g, '');
  return (
    !trimmed ||
    trimmed.startsWith('$') ||
    trimmed.startsWith('<') ||
    trimmed.includes('REDACTED') ||
    /^(<[^>]+>|replace(_with)?|your_|example|dummy|test|local|none|changeme)/i.test(trimmed) ||
    obviousFixture(trimmed)
  );
};

const patterns = [
  {
    name: 'Telegram bot token',
    regex: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g,
  },
  {
    name: 'OpenAI style API key',
    regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    name: 'GitHub token',
    regex: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g,
  },
  {
    name: 'Vercel token assignment',
    regex: /\bVERCEL_TOKEN[ \t]*=[ \t]*([^\s#]+)/gi,
    group: 1,
  },
  {
    name: 'Relay token assignment',
    regex: /\bRCC_RELAY_(?:OPERATOR|MAC)_TOKEN[ \t]*=[ \t]*([^\s#]+)/gi,
    group: 1,
  },
  {
    name: 'Supabase service role assignment',
    regex: /\bSUPABASE_(?:SERVICE_ROLE_KEY|SERVICE_KEY)[ \t]*=[ \t]*([^\s#]+)/gi,
    group: 1,
  },
  {
    name: 'Bearer token literal',
    regex: /\bBearer\s+([A-Za-z0-9._-]{24,})\b/g,
    group: 1,
  },
  {
    name: 'Private key block',
    regex: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/g,
  },
  {
    name: '.env style secret assignment',
    regex: /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)[ \t]*=[ \t]*([^\s#]+)/g,
    group: 1,
  },
];

const findings = [];
for (const file of tracked) {
  if (skipPaths.some((pattern) => pattern.test(file))) continue;
  const buffer = fs.readFileSync(file);
  if (!isProbablyText(buffer)) continue;
  const text = buffer.toString('utf8');
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.regex)) {
      if (file.startsWith('tests/') && pattern.name === 'Private key block') continue;
      const value = pattern.group ? match[pattern.group] : match[0];
      if (placeholder(value)) continue;
      const before = text.slice(0, match.index ?? 0);
      const line = before.split('\n').length;
      findings.push({ file, line, name: pattern.name });
    }
  }
}

if (findings.length) {
  console.error('[secrets:check] potential tracked secret(s) found:');
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line} ${finding.name}`);
  }
  process.exit(1);
}

console.log('[secrets:check] no tracked secrets matched RCC alpha patterns');
