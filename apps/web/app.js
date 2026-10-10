const demoMode = window.RCC_DEMO === true;
const isHostedConsole = !['localhost', '127.0.0.1', '::1', ''].includes(window.location.hostname);
const urlParams = new URLSearchParams(window.location.search);
const prefKey = (key) => (demoMode ? key.replace(/^rcc\./, 'rcc.demo.') : key);
const prefs = {
  getItem: (key) => localStorage.getItem(prefKey(key)),
  setItem: (key, value) => localStorage.setItem(prefKey(key), value),
  removeItem: (key) => localStorage.removeItem(prefKey(key)),
};
const demoRelay = demoMode ? window.RccDemoRelay.createDemoRelay() : null;
const savedMode = prefs.getItem('rcc.mode');
const requestedMode = urlParams.get('mode');
const initialMode = (() => {
  if (demoMode) return 'relay';
  if (requestedMode === 'local' || requestedMode === 'relay') return requestedMode;
  if (isHostedConsole) return 'relay';
  return savedMode === 'local' || savedMode === 'relay' ? savedMode : 'local';
})();
const readJsonStorage = (key, fallback) => {
  try {
    return JSON.parse(prefs.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
};
const allowedAppViews = new Set(['workspace', 'approvalsSection', 'artifactsSection', 'eventsSection', 'healthSection', 'setupSection']);
const appViewAliases = {
  approvals: 'approvalsSection',
  artifacts: 'artifactsSection',
  events: 'eventsSection',
  health: 'healthSection',
  setup: 'setupSection',
};
const normalizeAppView = (view) => {
  if (allowedAppViews.has(view)) return view;
  return appViewAliases[view] || 'workspace';
};
const initialAppView = normalizeAppView(urlParams.get('view'));

const state = {
  mode: initialMode,
  localBaseUrl: prefs.getItem('rcc.localBaseUrl') || prefs.getItem('rcc.baseUrl') || 'http://127.0.0.1:4765',
  relayBaseUrl: prefs.getItem('rcc.relayBaseUrl') || '',
  localToken: demoMode ? '' : sessionStorage.getItem('rcc.localToken') || sessionStorage.getItem('rcc.webToken') || '',
  relayToken: demoMode ? '' : sessionStorage.getItem('rcc.relayToken') || '',
  token: '',
  dashboard: null,
  threadCatalog: [],
  threadCatalogMeta: null,
  selectedProjectId: prefs.getItem('rcc.selectedProjectId') || '',
  projectSearch: prefs.getItem('rcc.projectSearch') || '',
  visibleProjectCount: 8,
  visibleThreadCount: 8,
  selectedThreadId: prefs.getItem('rcc.selectedThreadId') || '',
  composerText: prefs.getItem('rcc.composerText') || '',
  composerMode: prefs.getItem('rcc.composerMode') || 'plan',
  composerModel: prefs.getItem('rcc.composerModel') || '',
  composerReasoningEffort: prefs.getItem('rcc.composerReasoningEffort') || 'high',
  composerSpeedPreset: prefs.getItem('rcc.composerSpeedPreset') || 'balanced',
  pendingSteerConfirm: false,
  composerBusy: false,
  selectedSkills: readJsonStorage('rcc.selectedSkills', []),
  availableSkills: [],
  skillSearch: '',
  selectedApproval: null,
  refreshTimer: null,
  threadStream: null,
  threadDetailInFlight: false,
  threadDetailRequestSeq: 0,
  renderedOutputKeys: new Set(),
  selectedThreadOutputs: [],
  refreshing: false,
  lastRefreshAt: '',
  relayCommandState: null,
  activeAppView: initialAppView,
  sidebarCollapsed: prefs.getItem('rcc.workspaceSidebarCollapsed') === 'true',
};

const $ = (id) => document.querySelector(`#${id}`);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const json = (value) => JSON.stringify(value, null, 2);
const trimSlash = (value) => String(value || '').trim().replace(/\/$/, '');
const validateBaseUrl = (value, { allowBlank = false, field = 'Base URL' } = {}) => {
  const trimmed = trimSlash(value);
  if (!trimmed && allowBlank) return '';
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${field} must be a valid http(s) URL.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${field} must start with http:// or https://.`);
  }
  return trimmed;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shortTime = (value) => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};
const fullTime = (value) => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
};
const ageMs = (value) => {
  const time = Date.parse(value || '');
  return Number.isNaN(time) ? Infinity : Math.max(0, Date.now() - time);
};
const ageLabel = (value) => {
  const ms = ageMs(value);
  if (!Number.isFinite(ms)) return 'unknown';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
};
const compactPath = (value = '') => String(value || '').replace(/^\/Users\/[^/]+/, '~');
const snapshotGeneratedAt = () => state.dashboard?.generatedAt || state.dashboard?.snapshot?.generatedAt || state.dashboard?.relay?.lastSnapshotAt;
const relaySnapshotAgeMs = () => ageMs(snapshotGeneratedAt());
const isRelaySnapshotFresh = () => state.mode !== 'relay' || relaySnapshotAgeMs() <= 90_000;
const toast = (message) => {
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = message;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 4600);
};
const endpointFor = (baseUrl, path) => {
  const cleanBase = trimSlash(baseUrl);
  return cleanBase ? `${cleanBase}${path}` : path;
};
const localEndpoint = (path) => endpointFor(state.localBaseUrl, path);
const relayEndpoint = (path) => endpointFor(state.relayBaseUrl, path);
const currentModeLabel = () => {
  if (demoMode) return 'Demo Mac (simulated)';
  return state.mode === 'relay' ? 'Remote Relay' : 'Local RCC API';
};
const activeToken = () => (state.mode === 'relay' ? state.relayToken : state.localToken);
const selectedThread = () => (
  state.threadCatalog.find((thread) => thread.id === state.selectedThreadId)
  || state.dashboard?.threads?.find((thread) => thread.id === state.selectedThreadId)
  || null
);
const selectedThreadAvailable = () => !state.selectedThreadId || Boolean(selectedThread());
const RELAY_UPLOAD_MAX_BYTES = 512 * 1024;
const RELAY_UPLOAD_MAX_FILES = 3;

const updateActiveToken = () => {
  state.token = activeToken();
};

const readResponseBody = async (response) => {
  const contentType = response.headers.get('content-type') || '';
  return contentType.includes('application/json') ? response.json() : response.text();
};

const parseError = (body) => {
  if (typeof body === 'string') return body;
  return body.error || body.nextStep || body.message || JSON.stringify(body);
};

const requestUrl = async (url, options = {}) => {
  updateActiveToken();
  const headers = {
    accept: 'application/json',
    ...(options.body ? { 'content-type': 'application/json' } : {}),
    ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
    ...(options.headers || {}),
  };
  const response = demoRelay
    ? await demoRelay.respond(url, { ...options, headers })
    : await fetch(url, { ...options, headers, cache: 'no-store' });
  const body = await readResponseBody(response);
  if (!response.ok) {
    throw new Error(`${response.status} ${parseError(body)}`);
  }
  return body;
};

const request = async (path, options = {}) => requestUrl(localEndpoint(path), options);
const action = async (path, body) => request(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });

const requireRelayToken = () => {
  if (!demoMode && !state.relayToken) {
    throw new Error('Relay token required. Enter the relay Bearer token; RCC does not ship with a default token.');
  }
};

const relayRequest = async (path, options = {}) => {
  requireRelayToken();
  return requestUrl(relayEndpoint(path), options);
};

const relayCommand = async (payload = {}) => relayRequest('/api/relay/commands', {
  method: 'POST',
  body: JSON.stringify(payload),
});

const renderRelayCommandState = () => {
  const node = $('relayState');
  if (!node) return;
  const status = state.relayCommandState;
  if (!status) {
    node.innerHTML = '<span class="status-dot idle"></span><span>No queued web command.</span>';
    return;
  }
  node.innerHTML = `
    <span class="status-dot ${escapeHtml(status.kind || 'pending')}"></span>
    <span><strong>${escapeHtml(status.label)}</strong>${status.detail ? ` <small>${escapeHtml(status.detail)}</small>` : ''}</span>
  `;
};

const setRelayCommandState = (next) => {
  state.relayCommandState = next;
  renderRelayCommandState();
};

const relayCommandAndWait = async (payload = {}, timeoutMs = 22_000) => {
  const queued = await relayCommand(payload);
  const commandId = queued.command?.id;
  if (!commandId) {
    throw new Error('Relay accepted the command but did not return a command id.');
  }
  setRelayCommandState({
    kind: 'pending',
    label: 'Command queued',
    detail: `${payload.action || 'command'} waiting for ${demoMode ? 'the simulated Mac' : 'the Mac daemon'}`,
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resultPayload = await relayRequest(`/api/relay/commands/${encodeURIComponent(commandId)}/result`);
    if (resultPayload.status === 'pending') {
      setRelayCommandState({
        kind: 'pending',
        label: resultPayload.command?.status === 'delivered' ? 'Waiting for Mac' : 'Command queued',
        detail: resultPayload.message || `Relay command ${commandId} is pending.`,
      });
      await sleep(Number(resultPayload.retryAfterMs || 1100));
      continue;
    }
    const result = resultPayload.result;
    if (!result) {
      throw new Error('Relay result payload was empty.');
    }
    if (result.ok !== true) {
      setRelayCommandState({ kind: 'failed', label: 'Command failed', detail: result.message || 'Mac reported failure.' });
      throw new Error(result.message || 'Relay command failed on the Mac.');
    }
    setRelayCommandState({ kind: 'completed', label: 'Command completed', detail: result.message || payload.action || '' });
    return result;
  }
  setRelayCommandState({ kind: 'failed', label: 'Command timed out', detail: `Command ${commandId} is still pending.` });
  throw new Error(`Relay command queued (${commandId}) but the Mac did not report completion yet. Keep RCC running and press Refresh.`);
};

const normalizeSnapshot = (data = {}) => data.snapshot || data.dashboard || data;

const fileToPayload = async (file) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return {
    name: file.name,
    mimeType: file.type || undefined,
    sizeBytes: file.size,
    base64: btoa(binary),
  };
};

const showAppView = () => {
  document.body.classList.add('connected');
  renderAppView();
  const params = new URLSearchParams(window.location.search);
  params.set('mode', state.mode);
  params.set('view', state.activeAppView);
  window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}#app`);
};

const showLandingView = () => {
  document.body.classList.remove('connected');
};

const scrollToLandingSection = (id) => {
  showLandingView();
  const node = $(id);
  if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

window.addEventListener('hashchange', () => {
  if (window.location.hash === '#connect') {
    scrollToLandingSection('connect');
  }
  if (window.location.hash === '#quick-setup') {
    scrollToLandingSection('quick-setup');
  }
  if (window.location.hash === '#app' && state.dashboard) {
    showAppView();
  }
});

window.addEventListener('popstate', () => {
  const next = new URLSearchParams(window.location.search).get('view');
  state.activeAppView = normalizeAppView(next);
  renderAppView();
  focusAppViewHeading(state.activeAppView);
});

const appViewLabel = (view) => ({
  workspace: 'Workspace',
  approvalsSection: 'Approvals',
  artifactsSection: 'Artifacts',
  eventsSection: 'Events',
  healthSection: 'Health',
  setupSection: 'Setup',
}[view] || 'Workspace');

const renderAppView = () => {
  const params = new URLSearchParams(window.location.search);
  params.set('mode', state.mode);
  document.querySelectorAll('[data-app-section]').forEach((link) => {
    const active = link.dataset.appSection === state.activeAppView;
    link.classList.toggle('active', active);
    link.setAttribute('aria-current', active ? 'page' : 'false');
    const linkParams = new URLSearchParams(params);
    linkParams.set('view', link.dataset.appSection);
    link.setAttribute('href', `${window.location.pathname}?${linkParams.toString()}#app`);
  });
  ['workspace', 'approvalsSection', 'artifactsSection', 'eventsSection', 'healthSection', 'setupSection'].forEach((id) => {
    const node = $(id);
    if (node) node.hidden = id !== state.activeAppView;
  });
  params.set('view', state.activeAppView);
  const nextUrl = `${window.location.pathname}?${params.toString()}#app`;
  if (document.body.classList.contains('connected') && window.location.href !== new URL(nextUrl, window.location.origin).href) window.history.replaceState(null, '', nextUrl);
  updateWorkspaceSidebarState();
};

const updateWorkspaceSidebarState = () => {
  const workspace = $('workspace');
  const toggle = $('workspaceSidebarToggle');
  if (!workspace || !toggle) return;
  workspace.classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
  toggle.textContent = state.sidebarCollapsed ? 'Show projects' : 'Hide sidebar';
  toggle.setAttribute('aria-expanded', state.sidebarCollapsed ? 'false' : 'true');
  toggle.setAttribute('aria-label', state.sidebarCollapsed ? 'Show projects and threads sidebar' : 'Hide projects and threads sidebar');
};

const focusAppViewHeading = (view) => {
  const heading = $(view)?.querySelector('h2');
  if (!heading) return;
  heading.setAttribute('tabindex', '-1');
  heading.focus({ preventScroll: false });
};

const setAppView = (view) => {
  state.activeAppView = normalizeAppView(view);
  const params = new URLSearchParams(window.location.search);
  params.set('mode', state.mode);
  params.set('view', state.activeAppView);
  window.history.pushState(null, '', `${window.location.pathname}?${params.toString()}#app`);
  renderAppView();
  focusAppViewHeading(state.activeAppView);
  toast(`${appViewLabel(state.activeAppView)} opened.`);
};

const relayFailureText = (error) => {
  const message = String(error);
  if (message.includes('404 snapshot_not_found')) {
    return [
      'Remote Relay is reachable, but the Mac has not posted a snapshot yet.',
      '',
      message,
      '',
      'Fast fix on the Mac:',
      '1. Keep Codex open and signed in locally.',
      '2. In the RCC checkout, run:',
      '   ./scripts/setup_relay_quickstart.sh --configure-vercel --deploy',
      '   ./run.sh',
      '3. Keep the Mac awake, online, and unlocked.',
      '4. Return here and press Connect through relay again.',
      '',
      'If RCC is already running, it must be restarted with relay env loaded. Do not start a second daemon against the same bot/database.',
    ].join('\n');
  }

  if (message.includes('401')) {
    return [
      'Could not authenticate to the Remote Relay.',
      '',
      message,
      '',
      'Use RCC_RELAY_OPERATOR_TOKEN in this field. Do not use RCC_WEB_AUTH_TOKEN or the Mac relay token.',
      '',
      'If you do not have an operator token yet, run this on the Mac from the RCC checkout:',
      '  ./scripts/setup_relay_quickstart.sh --configure-vercel --deploy',
      '',
      'The script saves the operator token under .dist/backups/ and copies it to the clipboard when possible.',
    ].join('\n');
  }

  return [
    'Could not reach the Remote Relay.',
    '',
    message,
    '',
    'Required relay setup:',
    '1. Vercel relay exposes GET /api/relay/snapshot and POST /api/relay/commands.',
    '2. This page uses RCC_RELAY_OPERATOR_TOKEN as its Bearer token.',
    '3. The Mac daemon runs with RCC_RELAY_ENABLED=true and a matching RCC_RELAY_MAC_TOKEN.',
    '4. The Mac posts snapshots and polls commands while Codex runs locally.',
  ].join('\n');
};

const renderCounts = (counts = {}) => {
  $('counts').innerHTML = Object.entries(counts).map(([key, value]) => `
    <div class="count-card"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(key)}</span></div>
  `).join('') || '<p class="muted">No counts.</p>';
};

const projectKey = (project = {}) => project.id || project.projectId || project.name || project.rootPath || project.cwd || '';
const threadProjectKey = (thread = {}) => thread.projectId || thread.projectName || thread.projectRoot || thread.cwd || '';
const getProjects = () => state.dashboard?.projects || state.threadCatalogMeta?.projects || [];
const getThreads = () => state.threadCatalog.length ? state.threadCatalog : state.dashboard?.threads || [];
const UNASSIGNED_PROJECT_ID = '__rcc_imported_unassigned__';

const threadActivityTime = (thread = {}) => {
  const value = thread.lastAccessAt || thread.lastSeenAt || thread.updatedAt || thread.createdAt || thread.startedAt;
  const parsed = Date.parse(value || '');
  return Number.isNaN(parsed) ? 0 : parsed;
};

const projectMatchesThread = (project = {}, thread = {}) => {
  const id = projectKey(project);
  const candidates = new Set([
    id,
    project.name,
    project.rootPath,
    project.cwd,
    project.id,
  ].filter(Boolean).map(String));
  return [
    threadProjectKey(thread),
    thread.projectName,
    thread.projectRoot,
    thread.cwd,
    thread.projectId,
  ].filter(Boolean).some((value) => candidates.has(String(value)));
};

const buildProjectGroups = () => {
  const projects = getProjects();
  const threads = getThreads();
  const usedThreadIds = new Set();
  const groups = projects.map((project) => {
    const id = projectKey(project);
    const projectThreads = threads
      .filter((thread) => projectMatchesThread(project, thread))
      .sort((a, b) => threadActivityTime(b) - threadActivityTime(a));
    projectThreads.forEach((thread) => usedThreadIds.add(thread.id));
    return {
      id,
      project,
      name: project.name || project.id || id || 'Project',
      rootPath: project.rootPath || project.cwd || '',
      threads: projectThreads,
      latestAt: projectThreads[0] ? threadActivityTime(projectThreads[0]) : 0,
    };
  });
  const orphanThreads = threads
    .filter((thread) => !usedThreadIds.has(thread.id))
    .sort((a, b) => threadActivityTime(b) - threadActivityTime(a));
  if (orphanThreads.length) {
    groups.push({
      id: UNASSIGNED_PROJECT_ID,
      project: { id: UNASSIGNED_PROJECT_ID, name: 'Imported / unassigned threads', rootPath: 'Threads without a matched allowlisted project' },
      name: 'Imported / unassigned threads',
      rootPath: 'Threads without a matched allowlisted project',
      threads: orphanThreads,
      latestAt: threadActivityTime(orphanThreads[0]),
    });
  }
  return groups.sort((a, b) => b.latestAt - a.latestAt || a.name.localeCompare(b.name));
};

const projectSearchMatches = (group) => {
  const query = state.projectSearch.trim().toLowerCase();
  if (!query) return true;
  return [
    group.id,
    group.name,
    group.rootPath,
    group.project?.id,
    group.project?.cwd,
  ].some((value) => String(value || '').toLowerCase().includes(query));
};

const selectedProjectGroup = () => buildProjectGroups().find((group) => group.id === state.selectedProjectId) || null;

const threadCardHtml = (thread) => `
  <button type="button" class="thread-row ${thread.id === state.selectedThreadId ? 'selected' : ''}" data-thread-id="${escapeHtml(thread.id)}" data-action="view">
    <span>
      <strong>${escapeHtml(thread.threadName || thread.codexThreadId || thread.id)}</strong>
      <small>${escapeHtml(compactPath(thread.cwd || thread.projectName || ''))}</small>
    </span>
    <span class="tag ${escapeHtml(thread.status)}">${escapeHtml(thread.status || 'unknown')}</span>
  </button>
`;

const renderProjects = () => {
  const groups = buildProjectGroups().filter(projectSearchMatches);
  const selectedGroup = groups.find((group) => group.id === state.selectedProjectId) || groups[0] || null;
  if ((!state.selectedProjectId || !groups.some((group) => group.id === state.selectedProjectId)) && selectedGroup) {
    state.selectedProjectId = selectedGroup.id;
    prefs.setItem('rcc.selectedProjectId', state.selectedProjectId);
  }
  const baseVisible = groups.slice(0, state.visibleProjectCount);
  const visible = selectedGroup && !baseVisible.some((group) => group.id === selectedGroup.id)
    ? [selectedGroup, ...baseVisible].slice(0, state.visibleProjectCount)
    : baseVisible;
  $('projects').innerHTML = visible.map((group) => {
    const expanded = group.id === state.selectedProjectId;
    const threads = expanded ? group.threads.slice(0, state.visibleThreadCount) : [];
    return `
      <section class="project-group ${expanded ? 'selected' : ''}" data-project-id="${escapeHtml(group.id)}">
        <button type="button" class="project-heading" data-project-id="${escapeHtml(group.id)}">
          <span>
            <strong>${escapeHtml(group.name)}</strong>
            <small>${escapeHtml(compactPath(group.rootPath || ''))}</small>
          </span>
          <span class="tag">${escapeHtml(group.threads.length)} threads</span>
        </button>
        ${expanded ? `
          <div class="nested-thread-list" aria-label="Threads for ${escapeHtml(group.name)}">
            ${threads.map(threadCardHtml).join('') || '<p class="muted small-copy">No threads in this project yet.</p>'}
            ${group.threads.length > threads.length ? `<button type="button" class="see-more-inline" id="seeMoreThreads">See more threads (${group.threads.length - threads.length} more)</button>` : ''}
          </div>
        ` : ''}
      </section>
    `;
  }).join('') || '<p class="muted">No projects match that search.</p>';
  if (groups.length > visible.length) {
    $('projects').insertAdjacentHTML('beforeend', `
      <button type="button" class="see-more-inline" id="seeMoreProjects">See more projects (${groups.length - visible.length} more)</button>
    `);
  }
};

const renderThreads = () => renderProjects();

const approvalTimestamp = (approval = {}) => approval.requestedAt || approval.createdAt || approval.occurredAt || approval.updatedAt;

const renderApprovals = (approvals = [], history = []) => {
  $('approvals').innerHTML = approvals.map((approval) => {
    const timestamp = approvalTimestamp(approval);
    return `
      <div class="card approval-card" data-approval-id="${escapeHtml(approval.id)}">
        <div class="card-title">
          <strong>${escapeHtml(approval.why || approval.summary || approval.id)}</strong>
          <span class="tag">${escapeHtml(approval.risk || approval.actionType || 'approval')}</span>
        </div>
        <p class="muted">${escapeHtml(approval.category || 'unknown')} | ${escapeHtml(approval.projectName)} / ${escapeHtml(approval.threadName)}</p>
        <p class="muted">Requested ${escapeHtml(fullTime(timestamp) || 'unknown')} (${escapeHtml(ageLabel(timestamp))})</p>
        <p>${escapeHtml(approval.impact || approval.summary || '')}</p>
        <p class="muted">${escapeHtml(approval.decisionHint || '')}</p>
        <code>${escapeHtml(approval.id)}</code>
        <label class="approval-guidance-label" for="approvalGuidance-${escapeHtml(approval.id)}">Optional operator guidance</label>
        <textarea id="approvalGuidance-${escapeHtml(approval.id)}" class="approval-guidance" placeholder="Add steering guidance. Guidance never grants extra authority by itself."></textarea>
        <div class="row-actions">
          <button data-action="details" class="secondary">Details</button>
          <button data-action="approve">Approve once</button>
          <button data-action="deny" class="danger">Deny</button>
          <button data-action="guidance" class="secondary">Send guidance</button>
          <button data-action="dismiss" class="secondary">Dismiss</button>
        </div>
      </div>
    `;
  }).join('') || '<p class="muted">No pending approvals.</p>';
  $('approvalHistory').innerHTML = history.slice(0, 20).map((approval) => {
    const timestamp = approval.resolvedAt || approval.dismissedAt || approvalTimestamp(approval);
    return `
      <div class="card compact-card">
        <div class="card-title"><strong>${escapeHtml(approval.summary || approval.id)}</strong><span class="tag">${escapeHtml(approval.status || 'resolved')}</span></div>
        <p class="muted">${escapeHtml(fullTime(timestamp) || 'unknown')} | ${escapeHtml(approval.projectName || '')} / ${escapeHtml(approval.threadName || '')}</p>
      </div>
    `;
  }).join('') || '<p class="muted">Resolved and dismissed approvals will appear here.</p>';
};

const openApprovalDrawer = (approvalId) => {
  const approval = [
    ...(state.dashboard?.approvals || []),
    ...(state.dashboard?.approvalHistory || []),
  ].find((item) => item.id === approvalId);
  state.selectedApproval = approval || { id: approvalId, note: 'Approval not found in latest dashboard snapshot.' };
  $('approvalDrawerTitle').textContent = state.selectedApproval.summary || state.selectedApproval.id || 'Approval details';
  $('approvalDrawerBody').textContent = json(state.selectedApproval);
  $('approvalDrawer').hidden = false;
};

const downloadLocalArtifact = async (artifactId, filename) => {
  if (demoMode) throw new Error('Artifact download is not available in the demo.');
  updateActiveToken();
  const response = await fetch(localEndpoint(`/api/artifacts/${encodeURIComponent(artifactId)}/download`), {
    headers: state.token ? { authorization: `Bearer ${state.token}` } : {},
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename || 'rcc-artifact';
  link.click();
  URL.revokeObjectURL(url);
};

const renderArtifacts = (artifacts = []) => {
  const actionLabel = demoMode ? 'Not in demo' : (state.mode === 'relay' ? 'Request from Mac' : 'Download');
  const demoNote = demoMode ? '<p class="muted small-copy">Artifact files are not included in the demo.</p>' : '';
  $('artifacts').innerHTML = demoNote + (artifacts.map((artifact) => `
    <div class="card" data-artifact-id="${escapeHtml(artifact.id)}" data-filename="${escapeHtml(artifact.filename)}">
      <div class="card-title"><strong>${escapeHtml(artifact.filename || artifact.id)}</strong><span class="tag">${escapeHtml(artifact.status || 'artifact')}</span></div>
      <p class="muted">${escapeHtml(artifact.projectName)} / ${escapeHtml(artifact.threadName)} | ${escapeHtml(artifact.sizeBytes || 0)} bytes</p>
      <button data-action="download" ${demoMode ? 'disabled' : ''}>${actionLabel}</button>
    </div>
  `).join('') || '<p class="muted">No artifacts detected.</p>');
};

const renderEvents = (events = []) => {
  $('events').innerHTML = events.slice(-12).reverse().map((event) => `
    <div class="card"><strong>${escapeHtml(event.eventType || event.type)}</strong><p class="muted">${escapeHtml(event.occurredAt || event.createdAt || '')}</p><p>${escapeHtml(event.summary || event.message || '')}</p></div>
  `).join('') || '<p class="muted">No events yet.</p>';
};

const statusLineValue = (statusText = '', label) => {
  const line = String(statusText || '').split('\n').find((item) => item.toLowerCase().startsWith(`${label.toLowerCase()}:`));
  return line ? line.slice(line.indexOf(':') + 1).trim() : '';
};

const renderSession = (data = {}) => {
  const snapshotAge = snapshotGeneratedAt() ? ageLabel(snapshotGeneratedAt()) : 'unknown';
  const macFresh = isRelaySnapshotFresh();
  const transportNote = demoMode
    ? 'Simulated in this browser. No computer is connected.'
    : (state.mode === 'relay' ? 'Phone/browser talks to Vercel; the Mac polls safely outbound.' : 'Browser talks directly to the Mac daemon.');
  const macLabel = demoMode
    ? 'Simulated Mac online'
    : (state.mode === 'relay' ? (macFresh ? 'Mac daemon connected' : 'Mac snapshot stale') : 'Mac daemon direct');
  $('modeBadge').textContent = currentModeLabel();
  $('sessionPanel').innerHTML = `
    <div class="session-grid">
      <div class="mini-status"><span class="status-dot ${state.mode === 'relay' ? 'pending' : 'completed'}"></span><strong>${escapeHtml(currentModeLabel())}</strong><small>${transportNote}</small></div>
      <div class="mini-status"><span class="status-dot ${macFresh ? 'completed' : 'failed'}"></span><strong>${escapeHtml(macLabel)}</strong><small>Last snapshot ${escapeHtml(snapshotAge)}</small></div>
      <div class="mini-status"><span class="status-dot idle"></span><strong>Codex auth stays on Mac</strong><small>No Codex password or OpenAI token is stored by this website.</small></div>
    </div>
  `;
  renderRelayCommandState();
  const banner = $('relayFreshnessBanner');
  if (state.mode === 'relay' && !macFresh) {
    banner.hidden = false;
    banner.innerHTML = `<strong>Mac snapshot is stale.</strong> Last update was ${escapeHtml(snapshotAge)}. Keep the Mac awake, run <code>./run.sh</code>, and wait for the daemon to post a fresh relay snapshot before sending commands.`;
  } else {
    banner.hidden = true;
    banner.textContent = '';
  }
};

const renderHealth = (data = {}) => {
  const statusText = data.statusText || '';
  const health = data.health || data.status || {};
  const cards = [
    ['Daemon', statusLineValue(statusText, 'Daemon') || health.daemon || 'running if this page loaded'],
    ['Codex transport', statusLineValue(statusText, 'Codex') || health.codex || health.codexTransport || 'unknown'],
    ['App Server compatibility', statusLineValue(statusText, 'App Server') || health.appServerCompatibility || 'unknown'],
    ['Thread-list health', data.threadListHealth?.status || state.threadCatalogMeta?.threadListHealth?.status || 'snapshot'],
    ['Relay freshness', state.mode === 'relay' ? `${isRelaySnapshotFresh() ? 'fresh' : 'stale'} (${ageLabel(snapshotGeneratedAt())})` : 'local direct'],
    ['Pending approvals', String(data.counts?.pendingApprovals ?? data.approvals?.length ?? 0)],
  ];
  $('healthPanel').innerHTML = cards.map(([label, value]) => `
    <div class="health-card">
      <span class="status-dot ${String(value).includes('stale') || String(value).includes('failed') ? 'failed' : 'completed'}"></span>
      <div><strong>${escapeHtml(label)}</strong><small>${escapeHtml(value)}</small></div>
    </div>
  `).join('');
};

const isFinalOutput = (output = {}) => {
  const kind = String(output.kind || output.type || '').toLowerCase();
  const method = String(output.method || '').toLowerCase();
  return kind.includes('final') || kind.includes('complete') || method.includes('final');
};

const outputKey = (output = {}) => {
  if (output.sequence !== undefined && output.sequence !== null) return `sequence:${output.sequence}`;
  return [
    output.threadId,
    output.turnId,
    output.kind || output.type,
    output.method,
    output.occurredAt,
    output.text,
  ].map((value) => String(value ?? '')).join('|');
};

const resetRenderedOutputs = (outputs = []) => {
  state.selectedThreadOutputs = [...outputs];
  state.renderedOutputKeys = new Set(outputs.map(outputKey));
};

const rememberRenderedOutput = (output = {}) => {
  const key = outputKey(output);
  if (state.renderedOutputKeys.has(key)) return false;
  state.renderedOutputKeys.add(key);
  state.selectedThreadOutputs = [...state.selectedThreadOutputs, output].slice(-200);
  return true;
};

const outputSortValue = (output = {}) => {
  const sequence = Number(output.sequence);
  if (Number.isFinite(sequence)) return sequence;
  const occurred = Date.parse(output.occurredAt || '');
  return Number.isFinite(occurred) ? occurred : 0;
};

const isAssistantDelta = (output = {}) => {
  const kind = String(output.kind || output.type || '').toLowerCase();
  const method = String(output.method || '').toLowerCase();
  return kind === 'assistant_text' && method.includes('/delta');
};

const coalesceOutputForDisplay = (outputs = []) => {
  const ordered = [...outputs].sort((left, right) => outputSortValue(left) - outputSortValue(right));
  const display = [];
  for (const output of ordered) {
    const text = String(output.text || '');
    const last = display[display.length - 1];
    if (
      text
      && isAssistantDelta(output)
      && last
      && last.__coalesced === true
      && last.turnId === output.turnId
      && last.kind === output.kind
    ) {
      last.text = `${last.text || ''}${text}`;
      last.occurredAt = output.occurredAt || last.occurredAt;
      last.sequence = output.sequence ?? last.sequence;
      last.updateCount = (last.updateCount || 1) + 1;
      continue;
    }
    display.push({
      ...output,
      text,
      method: isAssistantDelta(output) ? 'assistant message stream' : output.method,
      __coalesced: isAssistantDelta(output),
      updateCount: 1,
    });
  }
  return display;
};

const renderFinalOutputs = (outputs = []) => {
  const displayOutputs = coalesceOutputForDisplay(outputs);
  const finals = displayOutputs.filter(isFinalOutput);
  const candidates = finals.length ? finals : displayOutputs.slice(-1);
  $('finalOutputs').innerHTML = candidates.slice(-3).reverse().map((output) => `
    <div class="card output-card final-output">
      <div class="card-title"><strong>${escapeHtml(output.kind || 'latest output')}</strong><span class="tag">${escapeHtml(shortTime(output.occurredAt))}</span></div>
      <p>${escapeHtml(output.text || '')}</p>
      <p class="muted">${escapeHtml(output.method || output.turnId || '')}</p>
    </div>
  `).join('') || '<p class="muted">No final output for this selected thread yet.</p>';
};

const markPanelEmpty = (id, empty) => {
  const node = $(id);
  if (node) node.classList.toggle('is-empty', Boolean(empty));
};

const renderThreadError = (detail = {}) => {
  const message = detail.error || detail.message || 'Could not load selected thread.';
  $('liveThreadPanel').hidden = false;
  $('liveThreadTitle').textContent = 'Thread unavailable';
  $('selectedThreadSummary').textContent = `${message}${detail.threadId ? ` | ${detail.threadId}` : ''}`;
  $('liveOutputMeta').textContent = 'error';
  markPanelEmpty('codexOutputPanel', false);
  $('threadOutputs').innerHTML = `<p class="muted">${escapeHtml(message)}</p>`;
  $('reasoningMeta').textContent = 'unavailable';
  markPanelEmpty('reasoningPanel', false);
  $('reasoningSummaries').innerHTML = '<p class="muted">Reasoning Summary is unavailable until a valid thread is selected.</p>';
  resetRenderedOutputs([]);
  renderFinalOutputs([]);
  $('threadEvents').innerHTML = '<p class="muted">No events loaded for this thread.</p>';
};

const renderThreadPlaceholder = (summary) => {
  $('liveThreadTitle').textContent = 'Open a thread';
  $('selectedThreadSummary').textContent = summary || 'Select a project, then open a thread. RCC loads detailed output only for the selected thread.';
  $('liveOutputMeta').textContent = 'idle';
  markPanelEmpty('codexOutputPanel', true);
  $('threadOutputs').innerHTML = '';
  $('reasoningMeta').textContent = 'summary';
  markPanelEmpty('reasoningPanel', true);
  $('reasoningSummaries').innerHTML = '';
  resetRenderedOutputs([]);
  renderFinalOutputs([]);
  $('threadEvents').innerHTML = '<p class="muted">Open a thread to see recent events.</p>';
};

const clearStaleSelectedThread = () => {
  if (!(state.selectedThreadId && !selectedThreadAvailable())) return false;
  const staleThreadId = state.selectedThreadId;
  state.selectedThreadId = '';
  state.pendingSteerConfirm = false;
  state.availableSkills = [];
  state.selectedSkills = [];
  prefs.removeItem('rcc.selectedThreadId');
  prefs.setItem('rcc.selectedSkills', '[]');
  renderThreadPlaceholder(`Previously selected thread ${staleThreadId} is not in the loaded catalog. Pick a current thread to resume local control.`);
  updateComposerState();
  return true;
};

const renderThreadDetail = (detail = {}) => {
  if (detail.error) {
    renderThreadError(detail);
    return;
  }
  const thread = detail.thread || {};
  $('liveThreadPanel').hidden = false;
  $('liveThreadTitle').textContent = thread.threadName || thread.codexThreadId || thread.id || state.selectedThreadId || 'Live thread';
  $('selectedThreadSummary').textContent = [
    thread.projectName || selectedThread()?.projectName || 'Unknown project',
    thread.cwd || selectedThread()?.cwd || '',
    thread.status || selectedThread()?.status || '',
  ].filter(Boolean).join(' | ');
  const outputs = detail.outputs || [];
  resetRenderedOutputs(outputs);
  const displayOutputs = coalesceOutputForDisplay(outputs);
  const reasoningSummaries = detail.reasoningSummaries || [];
  const events = detail.events || [];
  $('liveOutputMeta').textContent = displayOutputs.length
    ? `${displayOutputs.length} messages${outputs.length !== displayOutputs.length ? ` from ${outputs.length} updates` : ''}`
    : 'empty';
  $('threadOutputs').innerHTML = displayOutputs.map((output) => `
    <div class="card output-card" data-delta="${output.__coalesced ? 'true' : 'false'}" data-turn-id="${escapeHtml(output.turnId || '')}" data-kind="${escapeHtml(output.kind || '')}">
      <div class="card-title"><strong>${escapeHtml(output.kind || 'output')}</strong><span class="tag">${escapeHtml(shortTime(output.occurredAt))}</span></div>
      <p data-output-text>${escapeHtml(output.text || '')}</p>
      <p class="muted">${escapeHtml(output.method || output.turnId || '')}${output.updateCount > 1 ? ` | ${output.updateCount} streamed chunks` : ''}</p>
    </div>
  `).join('') || '<p class="muted">No Codex output for this thread yet.</p>';
  markPanelEmpty('codexOutputPanel', displayOutputs.length === 0);
  $('reasoningMeta').textContent = reasoningSummaries.length ? `${reasoningSummaries.length} summaries` : 'empty';
  $('reasoningSummaries').innerHTML = reasoningSummaries.map(reasoningCardHtml).join('')
    || '<p class="muted">No Reasoning Summary for this selected thread yet. App Server-exposed summary only; RCC does not display hidden chain-of-thought.</p>';
  markPanelEmpty('reasoningPanel', reasoningSummaries.length === 0);
  renderFinalOutputs(state.selectedThreadOutputs);
  $('threadEvents').innerHTML = events.slice(-10).reverse().map((event) => `
    <div class="card event-card">
      <div class="card-title"><strong>${escapeHtml(event.eventType)}</strong><span class="tag">${escapeHtml(shortTime(event.occurredAt))}</span></div>
      <p>${escapeHtml(event.summary || '')}</p>
    </div>
  `).join('') || '<p class="muted">No recent events for this thread yet.</p>';
};

const fetchThreadDetail = async (threadId) => {
  if (!threadId) return null;
  if (state.mode === 'relay') {
    const result = await relayCommandAndWait({ action: 'watch_thread', targetKind: 'thread', targetId: threadId }, 24_000);
    return result.data?.detail || result.data;
  }
  return request(`/api/threads/${encodeURIComponent(threadId)}`);
};

const fetchLastOutput = async (threadId) => {
  if (!threadId) return null;
  if (state.mode === 'relay') {
    const result = await relayCommandAndWait({ action: 'last_output', targetKind: 'thread', targetId: threadId }, 24_000);
    return result.data?.detail || result.data;
  }
  return request(`/api/threads/${encodeURIComponent(threadId)}/last-output`);
};

const fetchThreadSkills = async (threadId) => {
  if (!threadId) return { skills: [], activeSkills: [] };
  if (state.mode === 'relay') {
    const result = await relayCommandAndWait({ action: 'list_skills', targetKind: 'thread', targetId: threadId }, 24_000);
    return { skills: result.data?.skills || [], activeSkills: selectedThread()?.skills || [] };
  }
  return request(`/api/threads/${encodeURIComponent(threadId)}/skills`);
};

const fetchThreadCatalog = async () => {
  if (state.mode === 'relay') {
    if (!isRelaySnapshotFresh()) {
      const fallbackThreads = state.dashboard?.threads || [];
      return {
        generatedAt: new Date().toISOString(),
        totalCount: fallbackThreads.length,
        count: fallbackThreads.length,
        threads: fallbackThreads,
        projects: state.dashboard?.projects || [],
        threadListHealth: {
          status: 'relay_snapshot_stale',
          lastError: 'Mac daemon has not posted a fresh snapshot; command actions are paused.',
        },
        note: 'Showing cached relay snapshot only. Start or wake the Mac daemon, then refresh.',
      };
    }
    try {
      const result = await relayCommandAndWait({ action: 'list_threads', targetKind: 'daemon', message: '50' }, 32_000);
      return result.data?.catalog || result.data;
    } catch (error) {
      if (String(error).includes('unsupported relay command list_threads')) {
        const fallbackThreads = state.dashboard?.threads || [];
        return {
          generatedAt: new Date().toISOString(),
          totalCount: fallbackThreads.length,
          count: fallbackThreads.length,
          threads: fallbackThreads,
          projects: state.dashboard?.projects || [],
          threadListHealth: {
            status: 'relay_snapshot_fallback',
            lastError: 'Mac daemon does not support relay list_threads yet. Restart RCC from the updated alpha branch to enable full Codex thread library.',
          },
          note: 'Showing the latest relay snapshot only. Full existing-thread discovery requires the Mac daemon to run the updated alpha branch.',
        };
      }
      throw error;
    }
  }
  return request('/api/threads/catalog?limit=50');
};

const refreshThreadCatalog = async () => {
  $('threadCatalogMeta').textContent = 'Loading live Codex thread library from the Mac...';
  const catalog = await fetchThreadCatalog();
  state.threadCatalog = catalog.threads || [];
  state.threadCatalogMeta = catalog;
  clearStaleSelectedThread();
  if (catalog.projects?.length && state.dashboard) {
    state.dashboard = { ...state.dashboard, projects: catalog.projects };
    renderProjects();
  }
  $('threadCatalogMeta').textContent = [
    `${state.threadCatalog.length}/${catalog.totalCount ?? state.threadCatalog.length} threads loaded`,
    `source: ${state.mode === 'relay' ? 'Mac via Remote Relay' : 'Local RCC API'}`,
    catalog.threadListHealth?.status ? `thread/list: ${catalog.threadListHealth.status}` : '',
    catalog.note || '',
  ].filter(Boolean).join(' | ');
  renderProjects();
  return catalog;
};

const setRefreshButtonState = (status, detail = '') => {
  const button = $('refreshButton');
  if (!button) return;
  button.dataset.status = status;
  if (status === 'loading') button.textContent = 'Refreshing...';
  else if (status === 'success') button.textContent = 'Refresh';
  else if (status === 'failed') button.textContent = 'Retry refresh';
  button.disabled = status === 'loading';
  const last = $('lastRefreshText');
  if (last) {
    last.textContent = detail || (state.lastRefreshAt ? `Last refreshed ${shortTime(state.lastRefreshAt)}` : 'Not refreshed yet.');
  }
};

const withRefreshState = async (label, fn) => {
  setRefreshButtonState('loading', `${label}...`);
  try {
    const result = await fn();
    state.lastRefreshAt = new Date().toISOString();
    setRefreshButtonState('success', `Last refreshed ${shortTime(state.lastRefreshAt)}`);
    return result;
  } catch (error) {
    setRefreshButtonState('failed', `Refresh failed: ${String(error)}`);
    throw error;
  }
};

const openThread = async (threadId) => {
  const requestSeq = state.threadDetailRequestSeq + 1;
  state.threadDetailRequestSeq = requestSeq;
  state.activeAppView = 'workspace';
  state.selectedThreadId = threadId;
  prefs.setItem('rcc.selectedThreadId', threadId);
  renderProjects();
  updateComposerState();
  if (state.mode === 'relay' && !isRelaySnapshotFresh()) {
    $('liveThreadPanel').hidden = false;
    $('liveThreadTitle').textContent = selectedThread()?.threadName || threadId;
    $('selectedThreadSummary').textContent = 'Mac snapshot is stale. Start or wake the Mac daemon, then refresh this thread.';
    $('threadOutputs').innerHTML = '<p class="muted">RCC will fetch live output after the Mac posts a fresh relay snapshot.</p>';
    $('reasoningSummaries').innerHTML = '<p class="muted">Reasoning Summary waits for a fresh selected-thread fetch.</p>';
    resetRenderedOutputs([]);
    renderFinalOutputs([]);
    return;
  }
  state.threadDetailInFlight = true;
  $('liveThreadPanel').hidden = false;
  $('liveThreadTitle').textContent = 'Loading live thread...';
  $('selectedThreadSummary').textContent = 'Fetching latest selected-thread detail from the Mac...';
  $('liveOutputMeta').textContent = 'loading';
  markPanelEmpty('codexOutputPanel', false);
  $('threadOutputs').innerHTML = '<p class="muted">Fetching recent output...</p>';
  $('reasoningMeta').textContent = 'loading';
  markPanelEmpty('reasoningPanel', false);
  $('reasoningSummaries').innerHTML = '<p class="muted">Fetching reasoning summary...</p>';
  $('finalOutputs').innerHTML = '<p class="muted">Waiting for final output...</p>';
  $('threadEvents').innerHTML = '<p class="muted">Fetching recent events...</p>';
  try {
    const detail = await fetchThreadDetail(threadId);
    if (requestSeq !== state.threadDetailRequestSeq || state.selectedThreadId !== threadId) return;
    renderThreadDetail(detail);
    await loadThreadSkills(threadId);
    if (requestSeq !== state.threadDetailRequestSeq || state.selectedThreadId !== threadId) return;
    startThreadStream(threadId);
  } catch (error) {
    if (requestSeq === state.threadDetailRequestSeq && state.selectedThreadId === threadId) {
      renderThreadError({ error: String(error), threadId });
    }
    throw error;
  } finally {
    if (requestSeq === state.threadDetailRequestSeq) {
      state.threadDetailInFlight = false;
      updateComposerState();
    }
  }
};

const loadThreadSkills = async (threadId) => {
  try {
    const payload = await fetchThreadSkills(threadId);
    if (state.selectedThreadId !== threadId) return;
    state.availableSkills = payload.skills || [];
    state.selectedSkills = state.selectedSkills.filter((name) =>
      state.availableSkills.some((skill) => skill.name === name && skill.enabled !== false),
    );
    prefs.setItem('rcc.selectedSkills', JSON.stringify(state.selectedSkills));
    updateComposerState();
  } catch (error) {
    state.availableSkills = [];
    $('skillHelp').textContent = `Skills unavailable: ${String(error)}`;
    updateComposerState();
  }
};

const startThreadStream = (threadId) => {
  if (state.threadStream) {
    state.threadStream.close();
    state.threadStream = null;
  }
  if (state.mode !== 'local' || !threadId) return;
  updateActiveToken();
  const streamUrl = new URL(localEndpoint(`/api/threads/${encodeURIComponent(threadId)}/stream`));
  const source = new EventSource(streamUrl.toString());
  state.threadStream = source;
  source.addEventListener('thread-output', (event) => {
    const output = JSON.parse(event.data);
    appendOutput(output);
  });
  source.addEventListener('thread-event', (event) => {
    const item = JSON.parse(event.data);
    prependThreadEvent(item);
  });
  source.addEventListener('reasoning-summary', (event) => {
    const summary = JSON.parse(event.data);
    prependReasoningSummary(summary);
  });
  source.addEventListener('reasoning-text-delta', (event) => {
    const summary = JSON.parse(event.data);
    prependReasoningSummary({ ...summary, experimental: true });
  });
  source.onerror = () => {
    $('liveOutputMeta').textContent = 'stream paused';
  };
};

const appendOutput = (output) => {
  if (!rememberRenderedOutput(output)) {
    return;
  }
  const last = $('threadOutputs').lastElementChild;
  if (
    last
    && last.dataset.delta === 'true'
    && isAssistantDelta(output)
    && last.dataset.turnId === (output.turnId || '')
    && last.dataset.kind === (output.kind || '')
    ) {
    const body = last.querySelector('[data-output-text]');
    if (body) body.textContent = `${body.textContent || ''}${output.text || ''}`;
    $('liveOutputMeta').textContent = 'live';
    markPanelEmpty('codexOutputPanel', false);
    renderFinalOutputs(state.selectedThreadOutputs);
    return;
  }
  const node = document.createElement('div');
  node.className = 'card output-card';
  node.dataset.delta = isAssistantDelta(output) ? 'true' : 'false';
  node.dataset.turnId = output.turnId || '';
  node.dataset.kind = output.kind || '';
  node.innerHTML = `
    <div class="card-title"><strong>${escapeHtml(output.kind || 'output')}</strong><span class="tag">${escapeHtml(shortTime(output.occurredAt))}</span></div>
    <p data-output-text>${escapeHtml(output.text || '')}</p>
    <p class="muted">${escapeHtml(isAssistantDelta(output) ? 'assistant message stream' : (output.method || output.turnId || ''))}</p>
  `;
  $('threadOutputs').append(node);
  $('liveOutputMeta').textContent = 'live';
  markPanelEmpty('codexOutputPanel', false);
  renderFinalOutputs(state.selectedThreadOutputs);
};

const prependThreadEvent = (item) => {
  const node = document.createElement('div');
  node.className = 'card event-card';
  node.innerHTML = `
    <div class="card-title"><strong>${escapeHtml(item.eventType)}</strong><span class="tag">${escapeHtml(shortTime(item.occurredAt))}</span></div>
    <p>${escapeHtml(item.summary || '')}</p>
  `;
  $('threadEvents').prepend(node);
};

const reasoningCardHtml = (summary = {}) => `
  <div class="card reasoning-card">
    <div class="card-title"><strong>${escapeHtml(summary.experimental ? 'Reasoning text delta' : 'Reasoning Summary')}</strong><span class="tag">${escapeHtml(shortTime(summary.occurredAt))}</span></div>
    <p>${escapeHtml(summary.text || '')}</p>
    <p class="muted">${escapeHtml(summary.method || summary.turnId || 'App Server-exposed summary. RCC does not display hidden chain-of-thought.')}</p>
  </div>
`;

const prependReasoningSummary = (summary) => {
  const node = document.createElement('div');
  node.innerHTML = reasoningCardHtml(summary);
  const card = node.firstElementChild;
  if (card) $('reasoningSummaries').prepend(card);
  $('reasoningMeta').textContent = summary.experimental ? 'experimental' : 'live';
};

const updateComposerState = () => {
  const thread = selectedThread();
  const staleRelay = state.mode === 'relay' && !isRelaySnapshotFresh();
  const staleSelectedThread = state.selectedThreadId && !selectedThreadAvailable();
  const disabled = !state.selectedThreadId || staleSelectedThread || staleRelay;
  const status = String(thread?.status || '').toLowerCase();
  const running = ['running', 'waiting_approval', 'waiting_operator'].includes(status);
  const hasText = Boolean(state.composerText.trim());
  const composerInput = $('composerInput');
  if (document.activeElement !== composerInput && composerInput.value !== state.composerText) {
    composerInput.value = state.composerText;
  }
  $('composerTitle').textContent = thread
    ? `Message ${thread.threadName || thread.codexThreadId || thread.id}`
    : 'Message selected thread';
  $('composerInput').disabled = disabled || state.composerBusy;
  $('composerInterruptButton').hidden = !state.selectedThreadId || staleSelectedThread || !running || staleRelay;
  $('composerInterruptButton').disabled = disabled || !running || state.composerBusy;
  const sendButton = $('composerSendButton');
  sendButton.hidden = !state.selectedThreadId || staleSelectedThread || !hasText || staleRelay;
  sendButton.disabled = disabled || !hasText || state.composerBusy;
  sendButton.textContent = running ? 'Steer / queue' : (state.composerMode === 'plan' ? 'Run plan' : 'Run build');
  $('lastOutputButton').disabled = !state.selectedThreadId || state.composerBusy;
  $('composerModel').disabled = disabled || running || state.composerBusy;
  $('composerReasoning').disabled = disabled || running || state.composerBusy;
  $('composerSpeed').disabled = disabled || running || state.composerBusy;
  $('steerConfirm').hidden = !state.pendingSteerConfirm;
  $('composerStateHint').textContent = !state.selectedThreadId
    ? 'Select a thread to unlock messaging.'
    : staleSelectedThread
      ? 'The previously selected thread is not in the loaded catalog. Pick a current thread before sending commands.'
      : staleRelay
        ? 'Commands are paused until the Mac posts a fresh relay snapshot.'
        : running
          ? 'Active thread: Enter asks for confirmation, then sends steering guidance to the running turn.'
          : 'Idle thread: write a message, then Run in Plan or Build mode.';
  document.querySelectorAll('.mode-toggle .toggle').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === state.composerMode);
  });
  renderSkillControls();
};

const setComposerBusy = (busy, message = '') => {
  state.composerBusy = busy;
  const progress = $('composerProgress');
  if (progress) progress.textContent = message;
  updateComposerState();
};

const composerPayload = () => {
  const attachments = Array.from($('attachmentInput').files || []).map((file) => file.name);
  const attachmentPrefix = attachments.length ? `[Attachments selected in web UI: ${attachments.join(', ')}]` : '';
  return [attachmentPrefix, state.composerText].filter(Boolean).join('\n\n');
};

const selectedSkillPayload = () => state.selectedSkills.map((name) => ({ name }));

const turnOptions = () => {
  const speedMap = {
    fast: { reasoningEffort: 'low' },
    balanced: {},
    deep: { reasoningEffort: 'xhigh' },
  };
  const speedDefaults = speedMap[state.composerSpeedPreset] || {};
  return {
    ...(state.composerModel ? { model: state.composerModel } : {}),
    reasoningEffort: state.composerReasoningEffort || speedDefaults.reasoningEffort || 'high',
  };
};

const relayMessagePayload = (message) => JSON.stringify({
  message,
  mode: state.composerMode,
  skills: selectedSkillPayload(),
  ...turnOptions(),
});

const uploadSelectedAttachments = async (threadId) => {
  const files = Array.from($('attachmentInput').files || []);
  if (files.length === 0) return;
  if (state.mode === 'relay') {
    if (files.length > RELAY_UPLOAD_MAX_FILES) {
      throw new Error(`Relay upload accepts ${RELAY_UPLOAD_MAX_FILES} files at a time. Use Telegram /attach or Local API for larger batches.`);
    }
    for (const file of files) {
      if (file.size > RELAY_UPLOAD_MAX_BYTES) {
        throw new Error(`Relay upload limit is ${Math.round(RELAY_UPLOAD_MAX_BYTES / 1024)} KB per file. Use Telegram /attach or Local API for larger files.`);
      }
    }
    $('attachmentsPreview').textContent = 'Uploading selected file(s) through relay...';
    const payload = { files: await Promise.all(files.map(fileToPayload)) };
    await relayCommandAndWait({
      action: 'attach_file',
      targetKind: 'thread',
      targetId: threadId,
      message: JSON.stringify(payload),
    }, 45_000);
    $('attachmentInput').value = '';
    $('attachmentsPreview').textContent = 'Attachments materialized on the Mac for the selected thread.';
    return;
  }
  const payload = { files: await Promise.all(files.map(fileToPayload)) };
  await action(`/api/threads/${encodeURIComponent(threadId)}/attachments`, payload);
  $('attachmentInput').value = '';
  $('attachmentsPreview').textContent = 'Attachments uploaded to selected thread workspace.';
};

const renderSkillControls = () => {
  const skills = state.availableSkills || [];
  const query = state.skillSearch.trim().toLowerCase();
  const visibleSkills = query
    ? skills.filter((skill) => [
        skill.name,
        skill.description,
        skill.path,
      ].some((value) => String(value || '').toLowerCase().includes(query)))
    : skills;
  const selectedCount = state.selectedSkills.length;
  $('skillChips').innerHTML = visibleSkills.length
    ? visibleSkills.map((skill) => `
      <button type="button" class="skill-chip ${state.selectedSkills.includes(skill.name) ? 'active' : ''}" data-skill="${escapeHtml(skill.name)}">
        ${escapeHtml(skill.name)}
      </button>
    `).join('')
    : `<span class="muted small-copy">${skills.length ? 'No skills match that search.' : 'No skills loaded for this thread.'}</span>`;
  $('skillHelp').textContent = skills.length
    ? `${selectedCount} selected. Skills are selected context for the next turn. They do not bypass approvals or project policy.`
    : 'Open a thread to load skills from the local Codex App Server.';
};

const sendComposerAction = async (actionName) => {
  const threadId = state.selectedThreadId;
  if (!threadId) {
    toast('Select a thread before sending a message.');
    return;
  }
  state.composerText = $('composerInput').value;
  prefs.setItem('rcc.composerText', state.composerText);
  const message = composerPayload();
  if ((actionName === 'auto' || actionName === 'run' || actionName === 'say') && !message.trim()) {
    toast('Add an instruction before sending.');
    return;
  }
  const status = String(selectedThread()?.status || '').toLowerCase();
  const running = ['running', 'waiting_approval', 'waiting_operator'].includes(status);
  let resolvedAction = actionName === 'auto' ? (running ? 'say' : 'run') : actionName;
  if (actionName === 'auto' && running && !state.pendingSteerConfirm) {
    state.pendingSteerConfirm = true;
    updateComposerState();
    toast('Codex is already running. Press Steer / queue again to send this as guidance.');
    return;
  }
  state.pendingSteerConfirm = false;
  setComposerBusy(true, resolvedAction === 'interrupt' ? 'Interrupting selected thread...' : 'Sending command to the Mac. Waiting for output or acknowledgement...');
  try {
    if (state.mode === 'relay') {
      if (resolvedAction === 'run' || resolvedAction === 'say') await uploadSelectedAttachments(threadId);
      if (resolvedAction === 'run' && state.selectedSkills.length) await relayCommandAndWait({ action: 'start_with_skills', targetKind: 'thread', targetId: threadId, message: relayMessagePayload(message) });
      else if (resolvedAction === 'run' && state.composerMode === 'plan') await relayCommandAndWait({ action: 'plan', targetKind: 'thread', targetId: threadId, message: relayMessagePayload(message) });
      else if (resolvedAction === 'run') await relayCommandAndWait({ action: 'run', targetKind: 'thread', targetId: threadId, message: relayMessagePayload(message) });
      if (resolvedAction === 'say') await relayCommandAndWait({ action: 'say', targetKind: 'thread', targetId: threadId, message });
      if (resolvedAction === 'interrupt') await relayCommandAndWait({ action: 'interrupt', targetKind: 'thread', targetId: threadId });
    } else {
      if (resolvedAction === 'run' || resolvedAction === 'say') await uploadSelectedAttachments(threadId);
      if (resolvedAction === 'run') await action(`/api/threads/${encodeURIComponent(threadId)}/run`, { message, mode: state.composerMode, skills: selectedSkillPayload(), ...turnOptions() });
      if (resolvedAction === 'say') await action(`/api/threads/${encodeURIComponent(threadId)}/say`, { message });
      if (resolvedAction === 'interrupt') await action(`/api/threads/${encodeURIComponent(threadId)}/interrupt`);
    }
    toast(`${resolvedAction} sent for selected thread.`);
    setComposerBusy(false, 'Command accepted. Refreshing selected thread output...');
    await refresh();
    await openThread(threadId);
    setComposerBusy(false, 'Latest selected-thread state loaded.');
  } catch (error) {
    setComposerBusy(false, `Command failed: ${String(error)}`);
    throw error;
  }
};

const renderDashboard = (data) => {
  $('dashboard').hidden = false;
  renderSession(data);
  renderHealth(data);
  renderCounts(data.counts);
  if (data.watchedThreadId && data.watchedThreadDetail && data.watchedThreadId === state.selectedThreadId) {
    renderThreadDetail(data.watchedThreadDetail);
  }
  renderProjects();
  renderApprovals(data.approvals, data.approvalHistory || []);
  renderArtifacts(data.artifacts);
  renderEvents(data.events);
  updateComposerState();
  renderAppView();
};

const fetchSnapshot = async () => {
  if (state.mode === 'relay') {
    return normalizeSnapshot(await relayRequest('/api/relay/snapshot'));
  }
  return request('/api/dashboard');
};

const refresh = async () => {
  const data = await withRefreshState('Refreshing RCC state', fetchSnapshot);
  state.dashboard = data;
  renderDashboard(data);
};

const startAutoRefresh = () => {
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
  }
  state.refreshTimer = setInterval(() => {
    refresh().catch((error) => {
      setRefreshButtonState('failed', `Live refresh paused: ${String(error)}`);
    });
  }, demoMode ? 2000 : (state.mode === 'relay' ? 15000 : 5000));
};

const setMode = (mode) => {
  state.mode = mode === 'relay' ? 'relay' : 'local';
  updateActiveToken();
  prefs.setItem('rcc.mode', state.mode);
  document.querySelectorAll('input[name="mode"]').forEach((input) => {
    input.checked = input.value === state.mode;
  });
  $('localFields').hidden = state.mode !== 'local';
  $('relayFields').hidden = state.mode !== 'relay';
  $('modeHelp').textContent = state.mode === 'relay'
    ? 'Use this from a phone or bus. Leave base URL blank for this hosted site and paste RCC_RELAY_OPERATOR_TOKEN.'
    : 'Use this only when your browser can directly reach the Mac daemon. Paste RCC_WEB_AUTH_TOKEN.';
  $('connectButton').textContent = state.mode === 'relay' ? 'Connect through relay' : 'Connect to local RCC';
  $('sessionResult').textContent = state.dashboard
    ? `Mode switched to ${currentModeLabel()}. Refresh to load this mode.`
    : `Mode selected: ${currentModeLabel()}.`;
};

const saveFormState = () => {
  state.localBaseUrl = validateBaseUrl($('localBaseUrl').value || 'http://127.0.0.1:4765', { field: 'Local RCC API base URL' });
  state.relayBaseUrl = validateBaseUrl($('relayBaseUrl').value, { allowBlank: true, field: 'Relay base URL' });
  state.localToken = $('localToken').value.trim();
  state.relayToken = $('relayToken').value.trim();
  updateActiveToken();
  prefs.setItem('rcc.localBaseUrl', state.localBaseUrl);
  prefs.setItem('rcc.baseUrl', state.localBaseUrl);
  prefs.setItem('rcc.relayBaseUrl', state.relayBaseUrl);
  sessionStorage.setItem('rcc.localToken', state.localToken);
  sessionStorage.setItem('rcc.webToken', state.localToken);
  sessionStorage.setItem('rcc.relayToken', state.relayToken);
};

if (!demoMode) {
  $('localBaseUrl').value = state.localBaseUrl;
  $('relayBaseUrl').value = state.relayBaseUrl;
  $('localToken').value = state.localToken;
  $('relayToken').value = state.relayToken;
}
$('projectSearch').value = state.projectSearch;
$('composerInput').value = state.composerText;
$('composerModel').value = state.composerModel;
$('composerReasoning').value = state.composerReasoningEffort;
$('composerSpeed').value = state.composerSpeedPreset;
if (!demoMode) setMode(state.mode);
updateComposerState();
if (!demoMode && !state.dashboard && (window.location.hash === '#app' || urlParams.has('view'))) {
  $('sessionResult').textContent = `Connect first to open ${appViewLabel(state.activeAppView)}. RCC sends tokens as Authorization headers only; do not put tokens in URLs.`;
}

const connectDemo = async () => {
  $('sessionResult').textContent = 'Connecting to the simulated Mac...';
  const snapshot = await fetchSnapshot();
  $('sessionResult').textContent = 'Connected to the simulated Mac. Nothing you do here leaves this browser.';
  state.dashboard = snapshot;
  renderDashboard(snapshot);
  showAppView();
  refreshThreadCatalog().catch((error) => {
    $('threadCatalogMeta').textContent = `Demo threads did not load: ${String(error)}`;
  });
  startAutoRefresh();
};

const resetDemo = async () => {
  demoRelay.reset();
  state.selectedThreadId = '';
  state.composerText = '';
  state.pendingSteerConfirm = false;
  prefs.removeItem('rcc.selectedThreadId');
  prefs.removeItem('rcc.composerText');
  $('composerInput').value = '';
  setRelayCommandState(null);
  renderThreadPlaceholder('Demo reset. Pick a thread to open it.');
  await connectDemo();
  toast('Demo reset.');
};

$('connectForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (demoMode) {
    connectDemo().catch((error) => {
      $('sessionResult').textContent = String(error);
    });
    return;
  }
  try {
    saveFormState();
    $('sessionResult').textContent = `Connecting with ${currentModeLabel()}...`;
    if (state.mode === 'relay') {
      const snapshot = await fetchSnapshot();
      $('sessionResult').textContent = [
        'Connected through Remote Relay.',
        '',
        'RCC is receiving snapshots from the Mac. Commands you send here are queued, then executed by the Mac daemon on its next poll.',
        'Open a thread to fetch explicit live output for that thread.',
        '',
        json({ generatedAt: snapshot.generatedAt, counts: snapshot.counts, statusText: snapshot.statusText }),
      ].join('\n');
      state.dashboard = snapshot;
      renderDashboard(snapshot);
      showAppView();
      refreshThreadCatalog().catch((error) => {
        $('threadCatalogMeta').textContent = `Connected, but live thread catalog did not load yet: ${String(error)}`;
      });
      startAutoRefresh();
      return;
    }

    const session = state.localToken
      ? await action('/api/session/login', { token: state.localToken })
      : await request('/api/session');
    $('sessionResult').textContent = json(session);
    await refresh();
    showAppView();
    refreshThreadCatalog().catch((error) => {
      $('threadCatalogMeta').textContent = `Connected, but live thread catalog did not load yet: ${String(error)}`;
    });
    startAutoRefresh();
  } catch (error) {
    $('sessionResult').textContent = state.mode === 'relay'
      ? relayFailureText(error)
      : [
          'Could not sign into RCC.',
          '',
          String(error),
          '',
          isHostedConsole
            ? 'You are on the hosted web console. For phone/bus use, switch Connection mode to Remote Relay and enter RCC_RELAY_OPERATOR_TOKEN. Local RCC API mode only works when this browser can directly reach your Mac daemon.'
            : 'Local RCC API mode only works when this browser can directly reach your Mac daemon.',
          '',
          'Required local setup:',
          'RCC_WEB_CONTROL_ENABLED=true',
          'RCC_WEB_AUTH_TOKEN=<private-token>',
          'RCC_WEB_ALLOWED_ORIGINS=<your relay URL>',
          '',
          'The Codex account stays in the local Codex app/CLI; this web console signs into RCC, not OpenAI directly.',
        ].join('\n');
  }
});

document.querySelectorAll('input[name="mode"]').forEach((input) => {
  input.addEventListener('change', () => setMode(input.value));
});

document.querySelectorAll('[data-mode-link]').forEach((link) => {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    setMode(link.dataset.modeLink);
    window.history.replaceState(null, '', `${window.location.pathname}?mode=${state.mode}#connect`);
    scrollToLandingSection('connect');
  });
});

document.querySelectorAll('[data-section-link]').forEach((link) => {
  link.addEventListener('click', (event) => {
    const targetId = link.dataset.sectionLink;
    if (!targetId) return;
    event.preventDefault();
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${targetId}`);
    scrollToLandingSection(targetId);
  });
});

$('demoResetButton')?.addEventListener('click', () => resetDemo().catch((error) => alert(String(error))));

$('refreshButton').addEventListener('click', () => refresh().catch((error) => {
  $('healthPanel').innerHTML = `<div class="health-card"><span class="status-dot failed"></span><div><strong>Refresh failed</strong><small>${escapeHtml(String(error))}</small></div></div>`;
}));
$('threadCatalogRefresh').addEventListener('click', () => withRefreshState('Refreshing thread library', refreshThreadCatalog).catch((error) => { $('threadCatalogMeta').textContent = String(error); }));
$('projectSearch').addEventListener('input', () => {
  state.projectSearch = $('projectSearch').value;
  prefs.setItem('rcc.projectSearch', state.projectSearch);
  state.visibleProjectCount = 8;
  renderProjects();
});
$('workspaceSidebarToggle').addEventListener('click', () => {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  prefs.setItem('rcc.workspaceSidebarCollapsed', String(state.sidebarCollapsed));
  updateWorkspaceSidebarState();
});
$('liveThreadRefresh').addEventListener('click', () => {
  if (!state.selectedThreadId) {
    toast('Open a thread first.');
    return;
  }
  openThread(state.selectedThreadId).catch((error) => { $('threadOutputs').innerHTML = `<p class="muted">${escapeHtml(String(error))}</p>`; });
});

$('composerInput').addEventListener('input', () => {
  state.composerText = $('composerInput').value;
  prefs.setItem('rcc.composerText', state.composerText);
  state.pendingSteerConfirm = false;
  updateComposerState();
});

document.querySelectorAll('.mode-toggle .toggle').forEach((button) => {
  button.addEventListener('click', () => {
    state.composerMode = button.dataset.mode === 'build' ? 'build' : 'plan';
    prefs.setItem('rcc.composerMode', state.composerMode);
    state.pendingSteerConfirm = false;
    updateComposerState();
  });
});

$('composerModel').addEventListener('change', () => {
  state.composerModel = $('composerModel').value;
  prefs.setItem('rcc.composerModel', state.composerModel);
});

$('composerReasoning').addEventListener('change', () => {
  state.composerReasoningEffort = $('composerReasoning').value;
  prefs.setItem('rcc.composerReasoningEffort', state.composerReasoningEffort);
});

$('composerSpeed').addEventListener('change', () => {
  state.composerSpeedPreset = $('composerSpeed').value;
  prefs.setItem('rcc.composerSpeedPreset', state.composerSpeedPreset);
  if (state.composerSpeedPreset === 'fast') state.composerReasoningEffort = 'low';
  if (state.composerSpeedPreset === 'deep') state.composerReasoningEffort = 'xhigh';
  if (state.composerSpeedPreset === 'balanced' && !state.composerReasoningEffort) state.composerReasoningEffort = 'high';
  $('composerReasoning').value = state.composerReasoningEffort;
  prefs.setItem('rcc.composerReasoningEffort', state.composerReasoningEffort);
});

$('skillChips').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-skill]');
  if (!chip) return;
  const skill = chip.dataset.skill;
  state.selectedSkills = state.selectedSkills.includes(skill)
    ? state.selectedSkills.filter((item) => item !== skill)
    : [...state.selectedSkills, skill];
  prefs.setItem('rcc.selectedSkills', JSON.stringify(state.selectedSkills));
  updateComposerState();
});

$('skillSearch').addEventListener('input', () => {
  state.skillSearch = $('skillSearch').value;
  renderSkillControls();
});

$('attachmentInput').addEventListener('change', () => {
  const files = Array.from($('attachmentInput').files || []);
  $('attachmentsPreview').textContent = files.length
    ? files.map((file) => `${file.name} (${Math.ceil(file.size / 1024)} KB)`).join(' | ')
    : 'No attachments selected.';
});

$('composerForm').addEventListener('submit', (event) => {
  event.preventDefault();
  sendComposerAction('auto').catch((error) => alert(String(error)));
});

$('lastOutputButton').addEventListener('click', async () => {
  if (!state.selectedThreadId) {
    toast('Open a thread first.');
    return;
  }
  try {
    const detail = await fetchLastOutput(state.selectedThreadId);
    renderThreadDetail(detail);
    $('codexOutputPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast('Last selected-thread output loaded.');
  } catch (error) {
    alert(String(error));
  }
});

$('composerInterruptButton').addEventListener('click', () => {
  sendComposerAction('interrupt').catch((error) => alert(String(error)));
});

$('projects').addEventListener('click', (event) => {
  const more = event.target.closest('#seeMoreProjects');
  if (more) {
    state.visibleProjectCount += 12;
    renderProjects();
    return;
  }
  const moreThreads = event.target.closest('#seeMoreThreads');
  if (moreThreads) {
    state.visibleThreadCount += 20;
    renderProjects();
    return;
  }
  const threadCard = event.target.closest('[data-thread-id]');
  if (threadCard) {
    state.activeAppView = 'workspace';
    renderAppView();
    openThread(threadCard.dataset.threadId).catch((error) => alert(String(error)));
    return;
  }
  const card = event.target.closest('[data-project-id]');
  if (!card) return;
  state.activeAppView = 'workspace';
  renderAppView();
  state.selectedProjectId = card.dataset.projectId || '';
  prefs.setItem('rcc.selectedProjectId', state.selectedProjectId);
  state.visibleThreadCount = 8;
  renderProjects();
});

document.querySelectorAll('[data-app-section]').forEach((link) => {
  link.addEventListener('click', (event) => {
    const targetId = link.dataset.appSection;
    if (!targetId || !allowedAppViews.has(targetId)) return;
    event.preventDefault();
    showAppView();
    setAppView(targetId);
  });
});

$('approvals').addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const card = button.closest('[data-approval-id]');
  const approvalId = card.dataset.approvalId;
  const guidance = card.querySelector('.approval-guidance')?.value?.trim() || '';
  const actionName = button.dataset.action;
  try {
    if (actionName === 'details') {
      openApprovalDrawer(approvalId);
      return;
    }
    if (actionName === 'guidance' && !guidance) {
      toast('Write guidance before sending it.');
      return;
    }
    if (state.mode === 'relay') {
      if (actionName === 'approve' || actionName === 'deny' || actionName === 'guidance') {
        await relayCommandAndWait({
          action: 'approval_response',
          targetKind: 'approval',
          targetId: approvalId,
          message: JSON.stringify({
            decision: actionName === 'guidance' ? undefined : actionName,
            guidance,
          }),
        });
      } else {
        await relayCommandAndWait({ action: 'dismiss_approval', targetKind: 'approval', targetId: approvalId });
      }
    } else {
      if (actionName === 'approve' || actionName === 'deny' || actionName === 'guidance') {
        await action(`/api/approvals/${encodeURIComponent(approvalId)}/respond`, {
          decision: actionName === 'guidance' ? undefined : actionName,
          guidance,
        });
      } else {
        await action(`/api/approvals/${encodeURIComponent(approvalId)}/dismiss`);
      }
    }
    toast(`Approval ${actionName} sent.`);
    await refresh();
  } catch (error) {
    alert(String(error));
  }
});

$('approvalDrawerClose').addEventListener('click', () => {
  $('approvalDrawer').hidden = true;
});

$('artifacts').addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const card = button.closest('[data-artifact-id]');
  try {
    if (state.mode === 'relay') {
      await relayCommandAndWait({ action: 'refresh', targetKind: 'daemon', message: `Operator requested artifact ${card.dataset.artifactId}` });
      $('sessionResult').textContent = 'Relay artifact byte delivery is not automatic yet. RCC refreshed the Mac state; use Telegram /artifact send for explicit file delivery in this alpha.';
      await refresh();
      return;
    }
    await downloadLocalArtifact(card.dataset.artifactId, card.dataset.filename);
  } catch (error) {
    alert(String(error));
  }
});

if (demoMode && window.location.hash === '#app') {
  connectDemo().catch((error) => {
    $('sessionResult').textContent = String(error);
  });
}
