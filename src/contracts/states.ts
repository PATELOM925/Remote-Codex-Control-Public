export type ThreadStatus =
  | 'idle'
  | 'running'
  | 'waiting_approval'
  | 'waiting_operator'
  | 'completed'
  | 'interrupted'
  | 'failed';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'superseded' | 'dismissed';

export type AttachmentStatus =
  | 'received'
  | 'downloaded'
  | 'materialized'
  | 'announced_to_codex'
  | 'consumed'
  | 'failed';

export type ArtifactStatus = 'detected' | 'sent' | 'manifested' | 'failed';

export type GitActionStatus = 'pending' | 'approved' | 'denied' | 'completed' | 'failed';

export type ReasoningEffort = 'low' | 'medium' | 'high';

export type TransportStatus = 'connected' | 'disconnected';

export type FreshnessState =
  | 'healthy_quiet'
  | 'healthy_active'
  | 'stalled_active_no_events'
  | 'stalled_disconnected';

export type SleepPreventionState = 'expected' | 'not_expected';

export type ApprovalActionType =
  | 'command'
  | 'filesystem'
  | 'network'
  | 'git_commit'
  | 'git_push'
  | 'other';

export type DeliveryMode = 'turn_start' | 'steer_active_turn' | 'queue_next_instruction';
