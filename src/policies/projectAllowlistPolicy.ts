import type { Policy } from './types.js';

export interface ProjectAllowlistContext {
  projectId: string;
  projectEnabled: boolean;
}

export class ProjectAllowlistPolicy implements Policy<ProjectAllowlistContext> {
  readonly id = 'project-allowlist-v1';

  evaluate(context: ProjectAllowlistContext) {
    if (!context.projectEnabled) {
      return {
        allowed: false,
        reason: `Project ${context.projectId} is not enabled in allowlist`,
        policyId: this.id,
      };
    }

    return {
      allowed: true,
      reason: `Project ${context.projectId} is allowlisted`,
      policyId: this.id,
    };
  }
}
