import type { Policy } from './types.js';

export interface BranchPushContext {
  targetBranch: string;
}

export class BranchPushPolicy implements Policy<BranchPushContext> {
  readonly id = 'branch-push-guardrail-v1';

  evaluate(context: BranchPushContext) {
    const normalized = context.targetBranch.trim().toLowerCase();

    if (normalized === 'main') {
      return {
        allowed: false,
        reason: 'Push to main is blocked in v1',
        policyId: this.id,
      };
    }

    return {
      allowed: true,
      reason: `Push to ${context.targetBranch} allowed with separate approval`,
      policyId: this.id,
    };
  }
}
