#!/usr/bin/env node

const DEFAULT_WEB_URL = 'https://rcc-magnus-alpha.vercel.app';
const DEFAULT_LOCAL_URL = 'http://127.0.0.1:4765';
const TIMEOUT_MS = Number(process.env.RCC_SMOKE_TIMEOUT_MS ?? 8000);
const strict = (process.env.RCC_SMOKE_STRICT ?? 'false').toLowerCase() === 'true';

const results = [];
const env = {
  relayEnabled: (process.env.RCC_RELAY_ENABLED ?? 'true').toLowerCase() === 'true',
  webUrl: stripTrailingSlash(process.env.RCC_SMOKE_WEB_URL || process.env.RCC_RELAY_BASE_URL || DEFAULT_WEB_URL),
  relayBaseUrl: stripTrailingSlash(process.env.RCC_SMOKE_RELAY_BASE_URL || process.env.RCC_RELAY_BASE_URL || DEFAULT_WEB_URL),
  relayToken: process.env.RCC_RELAY_OPERATOR_TOKEN || '',
  localUrl: stripTrailingSlash(process.env.RCC_SMOKE_LOCAL_URL || DEFAULT_LOCAL_URL),
  telegramToken: process.env.RCC_TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.RCC_OPERATOR_CHAT_ID || '',
  sendTelegram: (process.env.RCC_SMOKE_TELEGRAM_SEND ?? 'false').toLowerCase() === 'true',
  strictSnapshot: (process.env.RCC_SMOKE_REQUIRE_SNAPSHOT ?? 'false').toLowerCase() === 'true',
};

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function record(name, ok, detail, skipped = false) {
  results.push({ name, ok, detail, skipped });
  const marker = skipped ? 'SKIP' : ok ? 'PASS' : 'FAIL';
  console.log(`[smoke:${marker}] ${name} - ${detail}`);
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

async function checkHostedWeb() {
  if (!env.relayEnabled) {
    record('hosted web shell', true, 'RCC_RELAY_ENABLED=false; hosted web smoke skipped for local/Telegram-only mode', true);
    return;
  }
  const response = await fetchWithTimeout(`${env.webUrl}/`);
  const text = await response.text();
  const ok = response.ok && text.includes('RCC Web Console') && text.includes('Runtime smoke check');
  record('hosted web shell', ok, ok ? `${response.status} ${env.webUrl}` : `unexpected hosted web response ${response.status}`);
}

async function checkRelay() {
  if (!env.relayEnabled) {
    record('remote relay auth', true, 'RCC_RELAY_ENABLED=false; remote relay smoke skipped', true);
    return;
  }
  if (!env.relayToken) {
    record('remote relay auth', !strict, 'RCC_RELAY_OPERATOR_TOKEN not set; relay auth smoke skipped', true);
    return;
  }

  const headers = {
    authorization: `Bearer ${env.relayToken}`,
    origin: env.webUrl,
  };
  const status = await fetchWithTimeout(`${env.relayBaseUrl}/api/relay/status`, { headers });
  if (!status.ok) {
    record('remote relay auth', false, `GET /api/relay/status returned ${status.status}`);
    return;
  }
  const statusJson = await status.json();
  record('remote relay auth', true, `storage=${statusJson.storage?.mode || 'unknown'}`);

  const snapshot = await fetchWithTimeout(`${env.relayBaseUrl}/api/relay/snapshot`, { headers });
  if (snapshot.status === 200) {
    const snapshotJson = await snapshot.json();
    const age = snapshotJson.relay?.lastSnapshotAt || snapshotJson.generatedAt || 'unknown';
    record('relay snapshot', true, `snapshot available; last=${age}`);
    return;
  }
  const skipped = snapshot.status === 404 && !env.strictSnapshot && !strict;
  record('relay snapshot', skipped, `GET /api/relay/snapshot returned ${snapshot.status}; start Mac daemon if this is a live demo`, skipped);
}

async function checkLocalDaemon() {
  const response = await fetchWithTimeout(`${env.localUrl}/api/health`).catch((error) => error);
  if (response instanceof Error) {
    record('local daemon health', !strict, `not reachable at ${env.localUrl}; ${response.message}`, true);
    return;
  }
  record('local daemon health', response.ok, `GET /api/health returned ${response.status}`);
}

async function checkTelegram() {
  if (!env.telegramToken) {
    record('telegram bot identity', !strict, 'RCC_TELEGRAM_BOT_TOKEN not set; Telegram smoke skipped', true);
    return;
  }
  const response = await fetchWithTimeout(`https://api.telegram.org/bot${env.telegramToken}/getMe`);
  const body = await response.json().catch(() => ({}));
  record('telegram bot identity', response.ok && body.ok === true, response.ok ? `bot=@${body.result?.username || 'unknown'}` : `getMe returned ${response.status}`);

  if (!env.sendTelegram) {
    record('telegram operator message', true, 'send disabled; set RCC_SMOKE_TELEGRAM_SEND=true and RCC_OPERATOR_CHAT_ID to send a test message', true);
    return;
  }
  if (!env.telegramChatId) {
    record('telegram operator message', false, 'RCC_OPERATOR_CHAT_ID is required when RCC_SMOKE_TELEGRAM_SEND=true');
    return;
  }
  const send = await fetchWithTimeout(`https://api.telegram.org/bot${env.telegramToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.telegramChatId,
      text: 'RCC runtime smoke: Telegram path is reachable. Run /status in the bot to verify daemon command handling.',
      disable_notification: true,
    }),
  });
  const sendBody = await send.json().catch(() => ({}));
  record('telegram operator message', send.ok && sendBody.ok === true, send.ok ? 'test message sent' : `sendMessage returned ${send.status}`);
}

for (const check of [checkHostedWeb, checkRelay, checkLocalDaemon, checkTelegram]) {
  try {
    await check();
  } catch (error) {
    record(check.name, false, error instanceof Error ? error.message : String(error));
  }
}

const failed = results.filter((result) => !result.ok && !result.skipped);
if (failed.length > 0 || (strict && results.some((result) => result.skipped))) {
  console.error(`[smoke:FAIL] ${failed.length} failed check(s); strict=${strict}`);
  process.exit(1);
}

console.log('[smoke:PASS] runtime smoke completed with no required failures');
