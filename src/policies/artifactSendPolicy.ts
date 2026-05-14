import type { Policy } from './types.js';

export interface ArtifactSendContext {
  sizeBytes: number;
  sendLimitBytes: number;
}

export class ArtifactSendPolicy implements Policy<ArtifactSendContext> {
  readonly id = 'artifact-send-limit-v1';

  evaluate(context: ArtifactSendContext) {
    if (context.sizeBytes > context.sendLimitBytes) {
      return {
        allowed: false,
        reason: `Artifact exceeds sendDocument limit (${context.sendLimitBytes} bytes baseline)`,
        policyId: this.id,
      };
    }

    return {
      allowed: true,
      reason: 'Artifact within sendDocument baseline limit',
      policyId: this.id,
    };
  }
}
