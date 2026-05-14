import path from 'node:path';

import type { Policy } from './types.js';

export interface AttachmentPathContext {
  localPath: string;
  threadWorkspace: string;
  projectRoot: string;
}

export class AttachmentPathPolicy implements Policy<AttachmentPathContext> {
  readonly id = 'attachment-path-scope-v1';

  evaluate(context: AttachmentPathContext) {
    const resolvedPath = path.resolve(context.localPath);
    const resolvedThreadWorkspace = path.resolve(context.threadWorkspace);
    const resolvedProjectRoot = path.resolve(context.projectRoot);

    const insideThreadWorkspace = resolvedPath.startsWith(`${resolvedThreadWorkspace}${path.sep}`);
    const insideProjectRoot = resolvedPath.startsWith(`${resolvedProjectRoot}${path.sep}`);

    if (!(insideThreadWorkspace || insideProjectRoot)) {
      return {
        allowed: false,
        reason: `Attachment path ${resolvedPath} is outside thread or project scope`,
        policyId: this.id,
      };
    }

    return {
      allowed: true,
      reason: 'Attachment path is inside allowed workspace scope',
      policyId: this.id,
    };
  }
}
