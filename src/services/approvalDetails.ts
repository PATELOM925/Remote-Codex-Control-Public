import type { ApprovalRecord, ProjectRecord, ThreadRecord } from '../db/repositories.js';

export type ApprovalCategory =
  | 'read-only source inspection'
  | 'file write'
  | 'shell command'
  | 'git'
  | 'network'
  | 'plan approval'
  | 'permission'
  | 'unknown';

export type ApprovalRisk = 'low' | 'medium' | 'high' | 'critical' | 'unknown';

export type ApprovalRequestSource = 'app_server' | 'desktop_log_recovered' | 'demo' | 'unknown';

export interface ApprovalDetails {
  id: string;
  projectName: string;
  threadName: string;
  threadId: string;
  turnId?: string;
  cwd?: string;
  source: ApprovalRequestSource;
  category: ApprovalCategory;
  risk: ApprovalRisk;
  why: string;
  impact: string;
  actionSummary: string;
  commandPreview?: string;
  fileSummary?: string;
  networkAccess: boolean | 'unknown';
  gitAccess: boolean | 'unknown';
  destructive: boolean | 'unknown';
  decisionHint: string;
  age: string;
  expiry?: string;
}

type ApprovalClassification = {
  category: ApprovalCategory;
  risk: ApprovalRisk;
  why: string;
  impact: string;
  commandPreview?: string;
  fileSummary?: string;
  networkAccess: boolean | 'unknown';
  gitAccess: boolean | 'unknown';
  destructive: boolean | 'unknown';
  decisionHint: string;
};

const SECRET_VALUE_RE = /\b((?:sk|pk|ghp|gho|xox[baprs]|ya29|AIza)[A-Za-z0-9_\-]{8,}|[A-Za-z0-9_\-]{24,}\.[A-Za-z0-9_\-]{24,}\.[A-Za-z0-9_\-]{24,})\b/g;
const SECRET_ASSIGNMENT_RE = /\b([A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASS|CREDENTIAL)[A-Z0-9_]*)\s*=\s*(['"]?)[^\s'"]+\2/gi;
const WRITE_RE = /(^|\s)(apply_patch|rm|mv|cp|chmod|chown|mkdir|touch|tee|truncate|python3?|node|perl|ruby|sqlite3|psql|npm|pnpm|yarn|bun|pip|brew)\b|(^|[^<])>{1,2}[^>]/i;
const DESTRUCTIVE_RE = /(^|\s)(rm\s+-|rm\b|mv\b|chmod\b|chown\b|git\s+reset|git\s+clean|git\s+push|drop\s+table|delete\s+from|truncate\b|reboot\b|shutdown\b)\b/i;
const GIT_SENSITIVE_RE = /\bgit\s+(commit|push|reset|clean|checkout|switch|branch|merge|rebase|tag|remote)\b/i;
const GIT_READONLY_RE = /^\s*git\s+(status|diff|show|log|branch\s+(?:--show-current|-vv)|rev-parse|ls-files)\b/i;
const NETWORK_RE = /\b(curl|wget|ssh|scp|rsync|vercel\s+(?:deploy|env|link|pull|push)|gh\s+(?:api|pr|repo|release)|npm\s+(?:install|i|add)|pnpm\s+(?:install|add)|yarn\s+(?:install|add)|bun\s+add|pip\s+install|brew\s+install)\b/i;
const READONLY_SEGMENT_RE = /^\s*(?:sed|cat|rg|grep|ls|find|pwd|wc|head|tail|nl|printf|echo|git\s+(?:status|diff|show|log|branch\s+(?:--show-current|-vv)|rev-parse|ls-files))\b/i;

// Words that mark an approval as at least high risk, whatever category the classifier picks.
const HIGH_RISK_FLOOR_RE =
  /rm\s+-rf|\bsudo\b|\bchmod\b|\bchown\b|git\s+push|git\s+reset|git\s+clean|checkout\s+--|\bdelete\b|\berase\b|\bcurl\b|\bwget\b|\bssh\b|\bscp\b|token|secret|\.env\b/i;

const RISK_RANK: Record<ApprovalRisk, number> = { low: 0, unknown: 1, medium: 2, high: 3, critical: 4 };

/** Raises a risk to high when the text names a sensitive action. A risk is never lowered. */
export const applyRiskFloor = (risk: ApprovalRisk, text: string): ApprovalRisk =>
  HIGH_RISK_FLOOR_RE.test(text) && RISK_RANK[risk] < RISK_RANK.high ? 'high' : risk;

export const approvalRequestSource = (codexRequestId: string): ApprovalRequestSource => {
  if (codexRequestId.startsWith('desktop:')) return 'desktop_log_recovered';
  if (codexRequestId.startsWith('demo:')) return 'demo';
  if (codexRequestId) return 'app_server';
  return 'unknown';
};

/**
 * Masks token-like values and secret assignments. buildApprovalDetails applies it to the
 * summary and the command before either one is copied into the details.
 */
export const redactApprovalText = (value: string): string =>
  value.replace(SECRET_ASSIGNMENT_RE, '$1=<redacted>').replace(SECRET_VALUE_RE, '<redacted>');

export const buildApprovalDetails = (
  approval: ApprovalRecord,
  thread?: ThreadRecord,
  project?: ProjectRecord,
): ApprovalDetails => {
  const commandPreview = extractCommand(approval.summary);
  const safeSummary = redactApprovalText(approval.summary);
  const safeCommand = commandPreview ? redactApprovalText(commandPreview) : undefined;
  const source = approvalRequestSource(approval.codexRequestId);
  const classification = classifyApproval(approval.actionType, safeSummary, safeCommand);
  const projectName = project?.name ?? thread?.projectId ?? 'unknown project';
  const threadName = thread?.threadName ?? thread?.id ?? approval.threadId;

  return {
    id: approval.id,
    projectName,
    threadName,
    threadId: approval.threadId,
    turnId: approval.turnId,
    cwd: thread?.cwd,
    source,
    category: classification.category,
    risk: applyRiskFloor(classification.risk, `${approval.actionType} ${approval.summary}`),
    why: classification.why,
    impact: classification.impact,
    actionSummary: safeSummary,
    commandPreview: safeCommand,
    fileSummary: classification.fileSummary,
    networkAccess: classification.networkAccess,
    gitAccess: classification.gitAccess,
    destructive: classification.destructive,
    decisionHint: classification.decisionHint,
    age: formatAge(approval.createdAt),
    expiry: approval.expiresAt ? formatExpiry(approval.expiresAt) : undefined,
  };
};

export const formatApprovalDetailsForTelegram = (details: ApprovalDetails): string => {
  const lines = [
    'Approval needed',
    `Category: ${details.category}`,
    `Risk: ${details.risk}`,
    `Why Codex wants this: ${details.why}`,
    `What will happen: ${details.impact}`,
    `Project: ${details.projectName}`,
    `Thread: ${details.threadName}`,
    `Turn: ${details.turnId ?? 'n/a'}`,
    `cwd: ${details.cwd ?? 'unknown'}`,
    `Source: ${details.source}`,
    `Approval ID: ${details.id}`,
    `Age: ${details.age}${details.expiry ? ` | Expiry: ${details.expiry}` : ''}`,
    `Decision hint: ${details.decisionHint}`,
  ];

  if (details.commandPreview) {
    lines.push(`Command: ${truncate(details.commandPreview, 480)}`);
  }
  if (details.fileSummary) {
    lines.push(`Files: ${details.fileSummary}`);
  }
  lines.push('', `Actions: /approve ${details.id} | /deny ${details.id}`);
  return lines.join('\n');
};

const extractCommand = (summary: string): string | undefined => {
  const match = summary.match(/(?:run command|command)\s*:\s*([\s\S]+)/i);
  return match?.[1]?.trim();
};

const classifyApproval = (actionType: string, summary: string, command?: string): ApprovalClassification => {
  const haystack = `${summary}\n${command ?? ''}`;
  const networkAccess = NETWORK_RE.test(haystack);
  const gitAccess = GIT_SENSITIVE_RE.test(haystack) || GIT_READONLY_RE.test(command ?? '');
  const destructive = DESTRUCTIVE_RE.test(haystack);

  if (/git_push/i.test(actionType) || /\bgit\s+push\b/i.test(haystack)) {
    return {
      category: 'git' as const,
      risk: 'critical' as const,
      why: 'Codex wants to push Git history to a remote.',
      impact: 'Remote Git state may change. RCC blocks push to main and requires explicit push approval.',
      networkAccess: true,
      gitAccess: true,
      destructive,
      decisionHint: 'Deny unless branch, remote, and diff are exactly expected.',
    };
  }

  if (/git_commit/i.test(actionType) || /\bgit\s+commit\b/i.test(haystack)) {
    return {
      category: 'git' as const,
      risk: 'high' as const,
      why: 'Codex wants to create a Git commit.',
      impact: 'Local Git history will change. Review the diff summary before approving.',
      networkAccess,
      gitAccess: true,
      destructive,
      decisionHint: 'Approve only after reviewing the staged diff and commit target branch.',
    };
  }

  if (networkAccess) {
    return {
      category: 'network' as const,
      risk: 'high' as const,
      why: 'Codex wants network access or a command that may fetch/deploy data.',
      impact: 'The action may contact external services. Secrets and project data could leave the Mac if the command is unsafe.',
      networkAccess: true,
      gitAccess,
      destructive,
      decisionHint: 'Deny unless the destination and data flow are clear.',
    };
  }

  if (command && isReadOnlyCommand(command)) {
    return {
      category: 'read-only source inspection' as const,
      risk: 'low' as const,
      why: 'Codex wants to inspect local files or repository state before planning changes.',
      impact: 'Reads files only; no write, no Git push, no network access detected.',
      fileSummary: summarizeFiles(command),
      networkAccess: false,
      gitAccess: GIT_READONLY_RE.test(command),
      destructive: false,
      decisionHint: 'Usually safe if the project and file paths are expected.',
    };
  }

  if (/filesystem/i.test(actionType) || WRITE_RE.test(haystack)) {
    return {
      category: 'file write' as const,
      risk: destructive ? ('high' as const) : ('medium' as const),
      why: 'Codex wants to change files or run a command with filesystem side effects.',
      impact: destructive
        ? 'Files or permissions may be modified or removed.'
        : 'Project files may be created or edited.',
      networkAccess,
      gitAccess,
      destructive,
      decisionHint: 'Approve only if the affected files are inside the expected project and the change is intended.',
    };
  }

  if (/permission/i.test(summary) || /permissions?/i.test(actionType)) {
    return {
      category: 'permission' as const,
      risk: 'medium' as const,
      why: 'Codex wants expanded permission for this turn.',
      impact: 'The action may expand what Codex can access or execute.',
      networkAccess: 'unknown' as const,
      gitAccess: 'unknown' as const,
      destructive: 'unknown' as const,
      decisionHint: 'Deny unless the permission scope is narrow and expected.',
    };
  }

  return {
    category: actionType === 'other' ? ('unknown' as const) : ('shell command' as const),
    risk: 'unknown' as const,
    why: 'RCC could not classify this approval with high confidence.',
    impact: truncate(summary, 280),
    networkAccess: 'unknown' as const,
    gitAccess: 'unknown' as const,
    destructive: 'unknown' as const,
    decisionHint: 'Deny or inspect details unless you recognize the action.',
  };
};

const isReadOnlyCommand = (command: string): boolean => {
  if (WRITE_RE.test(command) || DESTRUCTIVE_RE.test(command) || NETWORK_RE.test(command)) {
    return false;
  }
  const segments = command
    .split(/&&|\|\||;|\n/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.length > 0 && segments.every((segment) => READONLY_SEGMENT_RE.test(segment));
};

const summarizeFiles = (command: string): string | undefined => {
  const matches = [...command.matchAll(/(?:^|\s)(?:[./][^\s'"|;&]+|[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|json|md|css|html|sql|sh|yml|yaml|toml|mjs|cjs))(?:\s|$)/g)]
    .map((match) => match[0]?.trim())
    .filter(Boolean)
    .filter((item) => !item.startsWith('-'));
  const unique = [...new Set(matches)].slice(0, 6);
  if (unique.length === 0) return undefined;
  return unique.join(', ');
};

const formatAge = (createdAt: string): string => {
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) return 'unknown';
  const diffMs = Math.max(0, Date.now() - createdMs);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
};

const formatExpiry = (expiresAt: string): string => {
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs)) return 'unknown';
  const diffMs = expiresMs - Date.now();
  if (diffMs <= 0) return 'expired';
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m remaining`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m remaining`;
};

const truncate = (value: string, max: number): string => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
};
