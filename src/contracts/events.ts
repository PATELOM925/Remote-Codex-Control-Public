import type {
  ApprovalActionType,
  ApprovalStatus,
  AttachmentStatus,
  ArtifactStatus,
  DeliveryMode,
  FreshnessState,
  GitActionStatus,
  ReasoningEffort,
  SleepPreventionState,
  ThreadStatus,
  TransportStatus,
} from './states.js';

export type RccEventType =
  | 'ProjectRegistered'
  | 'ProjectRenamed'
  | 'ThreadRegistered'
  | 'ThreadStatusChanged'
  | 'TurnStarted'
  | 'TurnCompleted'
  | 'TurnInterrupted'
  | 'TurnOutputObserved'
  | 'ReasoningSummaryObserved'
  | 'ReasoningTextDeltaObserved'
  | 'OperatorMessageReceived'
  | 'OperatorMessageQueued'
  | 'SteerForwarded'
  | 'AttachmentReceived'
  | 'AttachmentMaterialized'
  | 'AttachmentAnnouncedToCodex'
  | 'ArtifactDetected'
  | 'ArtifactSendAttempted'
  | 'ArtifactSendFallbackUsed'
  | 'GitActionRequested'
  | 'GitActionUpdated'
  | 'ApprovalAwaitingOperator'
  | 'ApprovalExpired'
  | 'ApprovalSuperseded'
  | 'ApprovalResolutionForwarded'
  | 'ApprovalResolutionAcked'
  | 'ApprovalResolutionFailed'
  | 'PolicyEvaluated'
  | 'CodexTransportConnected'
  | 'CodexTransportDisconnected'
  | 'HeartbeatObserved'
  | 'CheckpointCompleted';

export interface RccEventEnvelope<TPayload = unknown> {
  eventId: string;
  eventType: RccEventType;
  occurredAt: string;
  projectId?: string;
  threadId?: string;
  turnId?: string;
  causationId?: string;
  correlationId?: string;
  payload: TPayload;
}

export interface ApprovalAwaitingOperatorPayload {
  approvalId: string;
  codexRequestId: string;
  threadId: string;
  turnId?: string;
  projectId: string;
  actionType: ApprovalActionType;
  summary: string;
  scope: 'once' | 'session' | 'blocked';
  expiresAt?: string;
}

export interface ApprovalExpiredPayload {
  approvalId: string;
  reason: string;
}

export interface ApprovalSupersededPayload {
  approvalId: string;
  supersededByApprovalId: string;
}

export interface ApprovalResolutionForwardedPayload {
  approvalId: string;
  decision: Extract<ApprovalStatus, 'approved' | 'denied'>;
}

export interface ApprovalResolutionAckedPayload {
  approvalId: string;
  decision: Extract<ApprovalStatus, 'approved' | 'denied'>;
  codexAckId: string;
}

export interface ApprovalResolutionFailedPayload {
  approvalId: string;
  decision: Extract<ApprovalStatus, 'approved' | 'denied'>;
  codexRequestId: string;
  source: 'app-server' | 'ui-automation';
  requestSource: 'app_server' | 'desktop_log_recovered' | 'demo' | 'unknown';
  reason: string;
  actionableHint: string;
  retryGuidance: string;
  provider?: string;
}

export interface AttachmentMaterializedPayload {
  attachmentId: string;
  threadId: string;
  localPath: string;
  status: AttachmentStatus;
}

export interface ArtifactDetectedPayload {
  artifactId: string;
  threadId: string;
  localPath: string;
  artifactType: string;
  status: ArtifactStatus;
}

export interface ThreadStatusChangedPayload {
  status: ThreadStatus;
  previousStatus?: ThreadStatus;
}

export interface OperatorMessagePayload {
  threadId: string;
  messageText: string;
  deliveryMode: DeliveryMode;
}

export interface TurnOutputObservedPayload {
  threadId: string;
  turnId?: string;
  kind: 'assistant_text' | 'tool_status' | 'system';
  text: string;
  method?: string;
}

export interface ReasoningSummaryObservedPayload {
  threadId: string;
  turnId?: string;
  text: string;
  method?: string;
  source: 'app_server';
}

export interface ReasoningTextDeltaObservedPayload {
  threadId: string;
  turnId?: string;
  text: string;
  method?: string;
  source: 'app_server';
  experimental: true;
}

export interface PolicyEvaluatedPayload {
  policyId: string;
  action: string;
  allowed: boolean;
  reason: string;
}

export interface HealthSnapshot {
  daemonAlive: boolean;
  codexTransportStatus: TransportStatus;
  lastEventAt?: string;
  activeThreadCount: number;
  sleepPreventionState: SleepPreventionState;
  freshnessState: FreshnessState;
}

export interface CheckpointCompletedPayload {
  checkpointName: string;
  eventId: string;
}

export interface GitActionPayload {
  gitActionId: string;
  threadId: string;
  actionType: 'review' | 'commit' | 'push';
  targetBranch?: string;
  status: GitActionStatus;
  summary?: string;
}

export interface ModelPolicyRequestedPayload {
  threadId: string;
  requestedModel?: string;
  requestedEffort?: ReasoningEffort;
}
