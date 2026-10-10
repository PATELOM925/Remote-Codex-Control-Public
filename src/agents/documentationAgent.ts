import fs from 'node:fs';
import path from 'node:path';

export class DocumentationAgent {
  readonly requiredDocs = [
    'README.md',
    'INSTALL.md',
    'QUICKSTART.md',
    'EXAMPLES.md',
    'ARCHITECTURE.md',
    'TELEGRAM_BOT_SPEC.md',
    'SECURITY.md',
    'CONTRIBUTING.md',
    'docs/SETUP_REFERENCE.md',
    'docs/ARCHITECTURE_DIAGRAM.md',
    'docs/THREAT_MODEL.md',
    'docs/SECURITY_ALPHA_CHECKLIST.md',
  ] as const;

  missingDocs(cwd = process.cwd()): string[] {
    return this.requiredDocs.filter((relativePath) => !fs.existsSync(path.join(cwd, relativePath)));
  }

  assertCoverage(cwd = process.cwd()): void {
    const missing = this.missingDocs(cwd);
    if (missing.length > 0) {
      throw new Error(`Documentation coverage incomplete. Missing: ${missing.join(', ')}`);
    }
  }
}
