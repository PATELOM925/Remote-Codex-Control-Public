import type { ReasoningEffort, ThreadStatus } from './states.js';

export interface CodexThread {
  codexThreadId: string;
  threadName?: string;
  cwd: string;
  status: ThreadStatus;
  updatedAtMs?: number;
}

export type CodexThreadMode = 'build' | 'plan';
export type CodexReasoningSummaryMode = 'auto' | 'concise' | 'detailed' | 'none';

export type AppServerCompatibilityState = 'unknown' | 'compatible' | 'degraded' | 'incompatible';

export interface AppServerCompatibilityResult {
  status: AppServerCompatibilityState;
  checkedAt?: string;
  requiredMethods: string[];
  missingMethods: string[];
  lastError?: string;
}

export interface ThreadListHealth {
  status: 'unknown' | 'ok' | 'cache' | 'local_fallback' | 'failed';
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
  lastRetryCount: number;
  inFlight: boolean;
}

export interface StartThreadInput {
  cwd: string;
  threadName?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface StartTurnInput {
  codexThreadId: string;
  message: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  skills?: CodexSkillRef[];
  reasoningSummary?: CodexReasoningSummaryMode;
}

export interface SteerTurnInput {
  codexThreadId: string;
  turnId: string;
  message: string;
}

export interface AppServerApprovalRequest {
  requestId: string;
  codexThreadId: string;
  turnId?: string;
  actionType: 'command' | 'filesystem' | 'network' | 'git_commit' | 'git_push' | 'other';
  summary: string;
  scope: 'once' | 'session' | 'blocked';
  expiresAt?: string;
}

export interface CodexSkillRef {
  name: string;
  path?: string;
  description?: string;
  enabled?: boolean;
}

export interface AppServerEvent {
  type:
    | 'thread_started'
    | 'thread_status_changed'
    | 'turn_started'
    | 'turn_completed'
    | 'turn_interrupted'
    | 'turn_stream'
    | 'reasoning_summary'
    | 'reasoning_text_delta'
    | 'approval_requested'
    | 'transport_connected'
    | 'transport_disconnected'
    | 'heartbeat';
  codexThreadId?: string;
  turnId?: string;
  timestamp: string;
  streamKind?: 'assistant_text' | 'tool_status' | 'system';
  streamText?: string;
  streamMethod?: string;
  reasoningText?: string;
  reasoningMethod?: string;
  threadName?: string;
  cwd?: string;
  status?: ThreadStatus;
  approval?: AppServerApprovalRequest;
}

export interface AppServerClient {
  initialize(): Promise<void>;
  onEvent(listener: (event: AppServerEvent) => void): void;
  startThread(input: StartThreadInput): Promise<CodexThread>;
  resumeThread(codexThreadId: string): Promise<CodexThread>;
  startTurn(input: StartTurnInput): Promise<{ turnId: string }>;
  steerTurn(input: SteerTurnInput): Promise<void>;
  interruptTurn(codexThreadId: string, turnId: string): Promise<void>;
  listThreads(): Promise<CodexThread[]>;
  resolveApproval(requestId: string, decision: 'approved' | 'denied'): Promise<{ ackId: string }>;
  /** Optional. When it is absent, the bridge reports no skills for a thread. */
  listSkills?(cwd: string): Promise<CodexSkillRef[]>;
  /** Optional. Called once when the daemon stops, to end the connection. */
  close?(): void | Promise<void>;
}
