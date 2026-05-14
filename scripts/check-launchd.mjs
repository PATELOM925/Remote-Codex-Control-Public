#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-launchd-check-'));
const generated = path.join(tmp, 'com.remote-codex-control.daemon.plist');

execFileSync('bash', ['scripts/install-launchd.sh', '--dry-run', '--plist-output', generated], {
  cwd: root,
  stdio: 'pipe',
});

const plist = fs.readFileSync(generated, 'utf8');
assert.match(plist, /<key>Label<\/key>\s*<string>com\.remote-codex-control\.daemon<\/string>/);
assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
assert.match(plist, /scripts\/rcc-launchd-runner\.sh/);
assert.match(plist, /launchd\.out\.log/);
assert.match(plist, /launchd\.err\.log/);
assert.doesNotMatch(plist, /RCC_RELAY_(?:OPERATOR|MAC)_TOKEN|RCC_WEB_AUTH_TOKEN|RCC_TELEGRAM_BOT_TOKEN/);

const runner = fs.readFileSync(path.join(root, 'scripts/rcc-launchd-runner.sh'), 'utf8');
assert.match(runner, /\/usr\/bin\/caffeinate -i -m -s \.\/run\.sh/);
assert.match(runner, /setup\.md is missing/);
assert.match(runner, /RCC_DISABLE_CAFFEINATE/);

const installer = fs.readFileSync(path.join(root, 'scripts/install-launchd.sh'), 'utf8');
assert.match(installer, /--dry-run/);
assert.match(installer, /launchctl bootstrap/);
assert.match(installer, /launchctl kickstart/);
assert.match(installer, /closed-display mode/);

const uninstaller = fs.readFileSync(path.join(root, 'scripts/uninstall-launchd.sh'), 'utf8');
assert.match(uninstaller, /launchctl bootout/);
assert.match(uninstaller, /rm -f/);

console.log('[launchd:check] LaunchAgent scripts and generated plist passed static checks');
