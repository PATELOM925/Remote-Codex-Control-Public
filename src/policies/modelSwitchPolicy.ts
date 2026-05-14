import type { Policy } from './types.js';

export interface ModelSwitchContext {
  requestedBySteer: boolean;
}

export class ModelSwitchPolicy implements Policy<ModelSwitchContext> {
  readonly id = 'model-switch-next-turn-only-v1';

  evaluate(context: ModelSwitchContext) {
    if (context.requestedBySteer) {
      return {
        allowed: false,
        reason: 'Model or effort changes cannot be applied through turn/steer',
        policyId: this.id,
      };
    }

    return {
      allowed: true,
      reason: 'Model or effort update accepted for next turn/resume/new thread',
      policyId: this.id,
    };
  }
}
