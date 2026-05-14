#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const required = [
  'apps/web/index.html',
  'apps/web/styles.css',
  'apps/web/app.js',
  'apps/web/manifest.webmanifest',
  'vercel.json',
];

for (const rel of required) {
  if (!fs.existsSync(path.join(root, rel))) {
    console.error(`[web:check] missing ${rel}`);
    process.exit(1);
  }
}

const html = fs.readFileSync(path.join(root, 'apps/web/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'apps/web/app.js'), 'utf8');
const relayApi = fs.readFileSync(path.join(root, 'api/relay.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'apps/web/styles.css'), 'utf8');
const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const docsToCheck = [
  'README.md',
  'QUICKSTART.md',
  'INSTALL.md',
  'apps/web/README.md',
].map((rel) => [rel, fs.readFileSync(path.join(root, rel), 'utf8')]);

const requiredHtml = [
  'RCC Web Console',
  'Connect to RCC',
  'Control your Codex from anywhere',
  'Remote Relay',
  'Quick Web Setup',
  'RCC control room',
  'Workspace',
  'Approvals',
  'Artifacts',
  'Events',
  'Health',
  'Allowlisted workspaces',
  'Search projects',
  'Selected thread workspace',
  'Composer',
  'Plan',
  'Build',
  'Model',
  'Reasoning',
  'Speed preset',
  'Show last output',
  'Skill',
  'Codex output',
  'Reasoning Summary',
  'Approval history',
  'Approval details',
  'Attach files',
  'Session and transport',
  './scripts/setup_relay_quickstart.sh',
  'npm run smoke:runtime',
  'Runtime smoke check',
  'Codex App Server',
  'RCC_RELAY_OPERATOR_TOKEN',
  'This site never receives your OpenAI/Codex password',
  'type="password"',
  'noindex,nofollow',
];
for (const needle of requiredHtml) {
  if (!html.includes(needle)) {
    console.error(`[web:check] index.html missing required copy: ${needle}`);
    process.exit(1);
  }
}

const requiredApp = [
  '/api/session/login',
  '/api/dashboard',
  '/api/threads/',
  '/api/approvals/',
  '/api/artifacts/',
  '/api/relay/snapshot',
  '/api/relay/commands',
  'snapshot_not_found',
  'RCC_RELAY_OPERATOR_TOKEN',
  'watch_thread',
  'last_output',
  'list_threads',
  'approval_response',
  'dismiss_approval',
  'approvalHistory',
  "status === 'pending'",
  'renderHealth',
  'renderSession',
  'isRelaySnapshotFresh',
  'selectedProjectId',
  'selectedThreadAvailable',
  '/api/threads/catalog',
  'relayCommandAndWait',
  'coalesceOutputForDisplay',
  'renderedOutputKeys',
  'outputKey',
  'assistant message stream',
  'Bearer ${state.token}',
  'composerPayload',
  'sendComposerAction',
  'openApprovalDrawer',
  'rcc.composerText',
  'rcc.composerMode',
  'attach_file',
  'RELAY_UPLOAD_MAX_BYTES',
  'validateBaseUrl',
  'focusAppViewHeading',
  'appViewAliases',
  'normalizeAppView',
];
for (const needle of requiredApp) {
  if (!app.includes(needle)) {
    console.error(`[web:check] app.js missing required behavior: ${needle}`);
    process.exit(1);
  }
}
if (app.includes("card.querySelector('textarea')") || app.includes('Tell RCC what Codex should do next in this thread')) {
  console.error('[web:check] thread cards must not own message textareas; use the selected-thread composer');
  process.exit(1);
}
if (!html.includes('href="./styles.css') || !html.includes('src="./app.js')) {
  console.error('[web:check] web shell assets must use relative paths so file:// QA opens are styled');
  process.exit(1);
}
if (!css.includes('.workspace-sidebar-stack { display: grid; grid-template-columns: 1fr;')) {
  console.error('[web:check] workspace sidebars must use normal page flow, not clipped nested panes');
  process.exit(1);
}
if (!css.includes('.project-sidebar { min-height: 0; max-height: calc(100vh - 154px); overflow: hidden; display: flex; flex-direction: column;')) {
  console.error('[web:check] Projects sidebar must own a fixed shell with a scrollable list');
  process.exit(1);
}
if (!css.includes('.sidebar-scroll { min-height: 0; display: grid; align-content: start; grid-auto-rows: max-content; overflow: auto;')) {
  console.error('[web:check] sidebar list must scroll without clipping the sticky header');
  process.exit(1);
}
if (css.includes('.final-panel { display: none')) {
  console.error('[web:check] final output panel must be visible in the selected-thread workspace');
  process.exit(1);
}
if (app.includes('if (state.threadDetailInFlight) return;')) {
  console.error('[web:check] thread selection must not be dropped while an older detail fetch is in flight');
  process.exit(1);
}
if (!app.includes("state.selectedThreadId && !selectedThreadAvailable()")) {
  console.error('[web:check] stale selectedThreadId must be cleared when loaded projects/catalog no longer contain it');
  process.exit(1);
}
if (html.includes('Recent Codex threads') || html.includes('id="threads"') || html.includes('id="threadSearch"')) {
  console.error('[web:check] threads must be nested under the selected project, not shown as a separate recent-thread panel');
  process.exit(1);
}
if (!html.includes('id="workspaceSidebarToggle"') || !css.includes('.workspace-shell.sidebar-collapsed') || !app.includes('rcc.workspaceSidebarCollapsed')) {
  console.error('[web:check] workspace must provide a persistent sidebar collapse toggle');
  process.exit(1);
}
if (html.includes('id="skillPicker"') || app.includes('skillPicker')) {
  console.error('[web:check] duplicate skill dropdown must not return; use searchable skill chips only');
  process.exit(1);
}
if (app.includes("searchParams.set('token'") || app.includes('searchParams.set("token"')) {
  console.error('[web:check] bearer tokens must never be placed in URLs');
  process.exit(1);
}
if (!app.includes("state.mode === 'relay' ? 15000 : 5000")) {
  console.error('[web:check] relay browser refresh must stay conservative for free-plan hosting');
  process.exit(1);
}
if (pkg.scripts?.['smoke:runtime'] !== 'node scripts/smoke-runtime.mjs') {
  console.error('[web:check] package.json must expose npm run smoke:runtime');
  process.exit(1);
}
if (!relayApi.includes('sameOriginFallback') || !relayApi.includes('relay_origin_forbidden')) {
  console.error('[web:check] relay API must keep same-origin fallback and explicit origin rejection');
  process.exit(1);
}
const staleClaims = [
  'Open live',
  'thread_detail relay command',
  'Relay mode does not transfer attachment bytes in this alpha',
];
for (const [rel, content] of docsToCheck) {
  for (const claim of staleClaims) {
    if (content.includes(claim)) {
      console.error(`[web:check] ${rel} contains stale web/relay claim: ${claim}`);
      process.exit(1);
    }
  }
}
if (!Array.isArray(vercel.builds) || !Array.isArray(vercel.routes)) {
  console.error('[web:check] vercel.json must define static builds and routes');
  process.exit(1);
}
const relayRoute = vercel.routes.some((route) => route.src === '/api/relay/(.*)' && route.dest === '/api/relay.js');
if (!relayRoute) {
  console.error('[web:check] vercel.json must route /api/relay/* to the relay API function');
  process.exit(1);
}

console.log('[web:check] web control console checks passed');
