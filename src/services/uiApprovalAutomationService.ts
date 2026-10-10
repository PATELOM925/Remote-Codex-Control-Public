import { execFile } from 'node:child_process';

import type { Logger } from '../logger.js';

export interface UiApprovalAutomationService {
  resolveInCodexDesktop(input: {
    decision: 'approved' | 'denied';
    approvalId: string;
    codexRequestId: string;
  }): Promise<{ ackId: string }>;
}

export class AppleScriptApprovalAutomationService implements UiApprovalAutomationService {
  constructor(private readonly logger: Logger) {}

  async resolveInCodexDesktop(input: {
    decision: 'approved' | 'denied';
    approvalId: string;
    codexRequestId: string;
  }): Promise<{ ackId: string }> {
    // Button labels for each decision. The first button whose name matches one of them is clicked.
    const positiveLabels = ['Approve once', 'Allow', 'Approve'];
    const negativeLabels = ['Deny', 'Reject', 'Decline'];
    const labels = input.decision === 'approved' ? positiveLabels : negativeLabels;

    const lines = [
      'tell application "Codex" to reopen',
      'tell application "Codex" to activate',
      'delay 0.5',
      'tell application "System Events" to if not (exists process "Codex") then error "Codex process is not available; open Codex and keep it unlocked on the approval screen"',
      'tell application "System Events"',
      'tell process "Codex"',
      this.makeClickVisibleApprovalButtonSnippet(labels),
      'end tell',
      'end tell',
    ];

    const args = lines.flatMap((line) => ['-e', line]);
    await this.execOsascript(args);
    return { ackId: `ui-automation:${input.codexRequestId}:${Date.now()}` };
  }

  private makeClickVisibleApprovalButtonSnippet(labels: string[]): string {
    const escaped = labels.map((label) => `"${label.replace(/"/g, '\\"')}"`).join(', ');
    return [
      `set wantedLabels to {${escaped}}`,
      'set foundButton to missing value',
      'set candidateWindows to {}',
      'repeat 10 times',
      'try',
      'set candidateWindows to every window',
      'on error',
      'set candidateWindows to {}',
      'end try',
      'if (count of candidateWindows) > 0 then exit repeat',
      'delay 0.2',
      'end repeat',
      'if (count of candidateWindows) is 0 then error "no accessible Codex window found; keep Codex open, unlocked, and on the approval screen"',
      'repeat with win in candidateWindows',
      'set windowButtons to {}',
      'try',
      'set windowButtons to buttons of entire contents of win',
      'on error',
      'try',
      'set windowButtons to every button of win',
      'on error',
      'set windowButtons to {}',
      'end try',
      'end try',
      'repeat with btn in windowButtons',
      'repeat with label in wantedLabels',
      'try',
      'if (name of btn as text) is (label as text) then',
      'set foundButton to btn',
      'exit repeat',
      'end if',
      'end try',
      'end repeat',
      'if foundButton is not missing value then exit repeat',
      'end repeat',
      'if foundButton is not missing value then exit repeat',
      'end repeat',
      'if foundButton is missing value then error "approval button not found; make sure the approval card is visible in Codex"',
      'click foundButton',
    ].join('\n');
  }

  private async execOsascript(args: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      execFile('/usr/bin/osascript', args, { timeout: 10_000 }, (error, stdout, stderr) => {
        if (error) {
          const message = stderr?.trim() || stdout?.trim() || error.message;
          reject(new Error(this.normalizeOsascriptError(message)));
          return;
        }

        this.logger.info('ui-automation-executed', {
          provider: 'applescript',
          stdout: stdout?.trim() || undefined,
        });
        resolve();
      });
    });
  }

  private normalizeOsascriptError(message: string): string {
    if (
      message.includes('Can’t get window 1 of process "Codex". Invalid index.') ||
      message.includes('Can\'t get window 1 of process "Codex". Invalid index.')
    ) {
      return 'UI automation failed: no accessible Codex window found. Keep Codex open, unlocked, and make sure the approval card is visible.';
    }
    if (message.includes('not allowed assistive access') || message.includes('is not allowed assistive access')) {
      return 'UI automation failed: Codex or the terminal does not have Accessibility permission. Grant Accessibility access in macOS Privacy & Security, then retry.';
    }
    return `UI automation failed: ${message}`;
  }
}
