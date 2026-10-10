import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RccConfig } from '../config.js';
import type { FreshnessState } from '../contracts/states.js';
import type { Logger } from '../logger.js';
import type { DatabaseManager } from '../db/database.js';
import type { RccRepository } from '../db/repositories.js';
import type { EventJournal } from '../event-journal/eventJournal.js';
import type { RccEventBus } from '../runtime/eventBus.js';
import { ageMs } from '../utils/time.js';

import { CodexBridgeAgent } from './codexBridgeAgent.js';

export class HealthOpsAgent {
  constructor(
    private readonly codexBridge: CodexBridgeAgent,
    private readonly repository: RccRepository,
    private readonly databaseManager: DatabaseManager,
    private readonly journal: EventJournal,
    private readonly eventBus: RccEventBus,
    private readonly config: RccConfig,
    private readonly logger: Logger,
    private readonly signals?: {
      getTelegramCommandsState?: () => 'installed' | 'pending' | 'disabled';
    },
  ) {}

  captureSnapshot(): {
    daemonAlive: boolean;
    codexTransportStatus: 'connected' | 'disconnected';
    lastEventAt?: string;
    activeThreadCount: number;
    sleepPreventionState: 'expected' | 'not_expected';
    freshnessState: FreshnessState;
  } {
    this.expireStaleApprovals();

    const codexTransportStatus = this.codexBridge.getTransportStatus();
    const lastEventAt = this.codexBridge.getLastEventAt();
    const activeThreadCount = this.repository.countRunningThreads();
    const freshnessState = this.deriveFreshnessState(codexTransportStatus, activeThreadCount, lastEventAt);
    const sleepPreventionState = activeThreadCount > 0 ? 'expected' : 'not_expected';

    const snapshot = this.repository.saveHealthSnapshot({
      daemonAlive: true,
      codexTransportStatus,
      lastEventAt,
      activeThreadCount,
      sleepPreventionState,
      freshnessState,
    });

    return {
      daemonAlive: snapshot.daemonAlive,
      codexTransportStatus: snapshot.codexTransportStatus,
      lastEventAt: snapshot.lastEventAt,
      activeThreadCount: snapshot.activeThreadCount,
      sleepPreventionState: snapshot.sleepPreventionState,
      freshnessState: snapshot.freshnessState,
    };
  }

  runWalMaintenance(): void {
    const walBytes = this.databaseManager.readWalBytes();
    if (walBytes < this.config.walGrowthAlertBytes) {
      return;
    }

    this.logger.warn('wal-growth-threshold-exceeded', {
      walBytes,
      threshold: this.config.walGrowthAlertBytes,
    });

    this.databaseManager.checkpoint('PASSIVE');
    const event = this.journal.createEnvelope(
      'CheckpointCompleted',
      {
        checkpointName: 'wal-maintenance',
        walBytes,
      },
      {},
    );
    this.journal.append(event);
    this.eventBus.emit(event);
  }

  statusText(): string {
    const latest = this.captureSnapshot();
    const eventAge = latest.lastEventAt ? ageMs(latest.lastEventAt) : undefined;
    const preventIdleSleepEnabled = this.readPreventIdleSleepSetting();
    const mismatch =
      latest.sleepPreventionState === 'expected' && preventIdleSleepEnabled === false ? 'yes' : 'no';
    const commandsState = this.signals?.getTelegramCommandsState?.() ?? 'pending';
    const remoteApprovalMode =
      this.config.approvalStrategy === 'appserver_only'
        ? 'app_server_only'
        : this.config.uiAutomationEnabled
          ? `app_server_then_${this.config.uiAutomationProvider}`
          : 'app_server_then_manual_desktop';
    const desktopFallbackLine =
      this.config.approvalStrategy === 'appserver_only'
        ? 'Desktop Approval Fallback: disabled by policy'
        : this.config.uiAutomationEnabled
          ? `Desktop Approval Fallback: enabled (${this.config.uiAutomationProvider}; requires unlocked Mac + visible Codex approval window)`
          : 'Desktop Approval Fallback: disabled (desktop-only approvals must be handled on the Mac)';
    const compatibility = this.codexBridge.getCompatibility();
    const listHealth = this.codexBridge.getThreadListHealth();

    return [
      'RCC Status',
      `Daemon: ${latest.daemonAlive ? 'alive' : 'dead'}`,
      `Codex Transport: ${latest.codexTransportStatus}`,
      `App Server Compatibility: ${compatibility.status}${compatibility.lastError ? ` (${compatibility.lastError})` : ''}`,
      `Thread List Health: ${listHealth.status}${listHealth.lastError ? ` (${listHealth.lastError})` : ''}`,
      `Thread List Last Success: ${listHealth.lastSuccessAt ?? 'none'}`,
      `Last Event: ${latest.lastEventAt ?? 'none'}`,
      `Event Age: ${eventAge === undefined ? 'n/a' : `${Math.max(0, Math.floor(eventAge / 1000))}s`}`,
      `Freshness Threshold: ${Math.floor(this.config.eventFreshnessThresholdMs / 1000)}s`,
      `Recent Event Healthy: ${latest.freshnessState === 'healthy_active' || latest.freshnessState === 'healthy_quiet' ? 'yes' : 'no'}`,
      `Freshness State: ${latest.freshnessState}`,
      `Active Threads: ${latest.activeThreadCount}`,
      'Remote Mode: focused_thread_stream + background_alerts',
      `Remote Approval Mode: ${remoteApprovalMode}`,
      desktopFallbackLine,
      `Telegram Commands: ${commandsState}`,
      `Sleep Prevention: ${latest.sleepPreventionState}`,
      `Codex prevent_idle_sleep: ${preventIdleSleepEnabled === undefined ? 'unknown' : preventIdleSleepEnabled ? 'enabled' : 'disabled'}`,
      `Sleep Prevention Mismatch: ${mismatch}`,
    ].join('\n');
  }

  private deriveFreshnessState(
    transportStatus: 'connected' | 'disconnected',
    activeThreadCount: number,
    lastEventAt?: string,
  ): FreshnessState {
    if (transportStatus === 'disconnected') {
      return 'stalled_disconnected';
    }

    if (activeThreadCount === 0) {
      return 'healthy_quiet';
    }

    const eventAgeMs = ageMs(lastEventAt);
    if (eventAgeMs <= this.config.eventFreshnessThresholdMs) {
      return 'healthy_active';
    }

    return 'stalled_active_no_events';
  }

  private readPreventIdleSleepSetting(): boolean | undefined {
    const configPath = path.join(os.homedir(), '.codex', 'config.toml');
    if (!fs.existsSync(configPath)) {
      return undefined;
    }

    try {
      const text = fs.readFileSync(configPath, 'utf8');
      const match = text.match(/prevent_idle_sleep\s*=\s*(true|false)/i);
      if (!match?.[1]) {
        return undefined;
      }
      return match[1].toLowerCase() === 'true';
    } catch {
      return undefined;
    }
  }

  private expireStaleApprovals(): void {
    const nowMs = Date.now();
    const approvals = this.repository.listApprovals();
    for (const approval of approvals) {
      if (approval.status !== 'pending') {
        continue;
      }

      if (approval.expiresAt) {
        const expMs = Date.parse(approval.expiresAt);
        if (Number.isFinite(expMs) && expMs <= nowMs) {
          this.codexBridge.expireApproval(approval.id, 'expires_at_passed');
        }
        continue;
      }

      // Desktop-recovered approvals have no expiry, so they expire by age instead.
      if (!approval.codexRequestId.startsWith('desktop:')) {
        continue;
      }

      const createdMs = Date.parse(approval.createdAt);
      if (!Number.isFinite(createdMs)) {
        continue;
      }
      if (nowMs - createdMs <= this.config.desktopApprovalStaleMs) {
        continue;
      }

      this.codexBridge.expireApproval(approval.id, 'desktop_approval_stale');
    }
  }
}
