import { ArtifactSendPolicy } from './artifactSendPolicy.js';
import { AttachmentPathPolicy } from './attachmentPathPolicy.js';
import { BranchPushPolicy } from './branchPushPolicy.js';
import { ModelSwitchPolicy } from './modelSwitchPolicy.js';
import { ProjectAllowlistPolicy } from './projectAllowlistPolicy.js';
import type { PolicyDecision } from './types.js';

export class PolicyEngine {
  private readonly projectAllowlistPolicy = new ProjectAllowlistPolicy();
  private readonly branchPushPolicy = new BranchPushPolicy();
  private readonly attachmentPathPolicy = new AttachmentPathPolicy();
  private readonly modelSwitchPolicy = new ModelSwitchPolicy();
  private readonly artifactSendPolicy = new ArtifactSendPolicy();

  evaluateProjectAllowlist(projectId: string, projectEnabled: boolean): PolicyDecision {
    return this.projectAllowlistPolicy.evaluate({ projectId, projectEnabled });
  }

  evaluateBranchPush(targetBranch: string): PolicyDecision {
    return this.branchPushPolicy.evaluate({ targetBranch });
  }

  evaluateAttachmentPath(localPath: string, threadWorkspace: string, projectRoot: string): PolicyDecision {
    return this.attachmentPathPolicy.evaluate({ localPath, threadWorkspace, projectRoot });
  }

  evaluateModelSwitch(requestedBySteer: boolean): PolicyDecision {
    return this.modelSwitchPolicy.evaluate({ requestedBySteer });
  }

  evaluateArtifactSend(sizeBytes: number, sendLimitBytes: number): PolicyDecision {
    return this.artifactSendPolicy.evaluate({ sizeBytes, sendLimitBytes });
  }
}
