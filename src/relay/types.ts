export type RelayCommandAction =
  | 'run'
  | 'plan'
  | 'say'
  | 'interrupt'
  | 'approve'
  | 'deny'
  | 'refresh'
  | 'thread_detail'
  | 'list_threads'
  | 'list_skills'
  | 'start_with_skills'
  | 'set_mode'
  | 'attach_file'
  | 'watch_thread'
  | 'last_output'
  | 'approval_response'
  | 'dismiss_approval';

export type RelayCommandStatus = 'pending' | 'delivered' | 'completed' | 'failed';

export type RelayTargetKind = 'thread' | 'approval' | 'daemon';

export interface RelayCommandInput {
  action: RelayCommandAction;
  targetKind?: RelayTargetKind;
  targetId?: string;
  message?: string;
  clientRequestId?: string;
}

export interface RelayCommand extends RelayCommandInput {
  id: string;
  macId?: string;
  status: RelayCommandStatus;
  createdAt: string;
  deliveredAt?: string;
  completedAt?: string;
}

export interface RelayCommandResult {
  commandId: string;
  ok: boolean;
  message: string;
  completedAt: string;
  data?: unknown;
}

export interface RelaySnapshot {
  macId: string;
  generatedAt: string;
  snapshot: unknown;
  watchedThreadId?: string;
  watchedThreadDetail?: unknown;
  lastOutputAt?: string;
  relay: {
    mode: 'short_poll';
    lastMacPollAt?: string;
    lastSnapshotAt?: string;
    note: string;
  };
}

export interface RelayAuthConfig {
  operatorToken: string;
  macToken: string;
  allowedOrigins?: string[];
}

export interface RelayPollResponse {
  commands: RelayCommand[];
  generatedAt: string;
}
