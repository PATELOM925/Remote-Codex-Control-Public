import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { RccConfig } from '../config.js';
import type { Logger } from '../logger.js';

import { runMigrations } from './migrations.js';

export class DatabaseManager {
  readonly db: DatabaseSync;

  constructor(
    private readonly config: RccConfig,
    private readonly logger: Logger,
  ) {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    this.db = this.openWithGuardedRecovery();
    this.configure();
    runMigrations(this.db);
    this.validateStartupState();
  }

  private openWithGuardedRecovery(): DatabaseSync {
    try {
      return new DatabaseSync(this.config.dbPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/IOERR|disk I\/O|locked|busy|database/i.test(message)) {
        throw error;
      }
      this.logger.warn('sqlite-open-failed-recovery-attempt', { dbPath: this.config.dbPath, message });
      this.backupSqliteFiles();
      const recovered = new DatabaseSync(this.config.dbPath);
      recovered.exec('PRAGMA integrity_check;');
      recovered.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      recovered.close();
      this.logger.warn('sqlite-startup-recovery-completed', { dbPath: this.config.dbPath });
      return new DatabaseSync(this.config.dbPath);
    }
  }

  private backupSqliteFiles(): void {
    const backupDir = path.join(path.dirname(this.config.dbPath), 'recovery-backups', new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(backupDir, { recursive: true });
    for (const file of [this.config.dbPath, `${this.config.dbPath}-wal`, `${this.config.dbPath}-shm`]) {
      if (!fs.existsSync(file)) {
        continue;
      }
      fs.copyFileSync(file, path.join(backupDir, path.basename(file)));
    }
    this.logger.warn('sqlite-recovery-backup-created', { backupDir });
  }

  private configure(): void {
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec(`PRAGMA wal_autocheckpoint = ${this.config.walAutoCheckpointPages};`);

    this.logger.info('sqlite-configured', {
      dbPath: this.config.dbPath,
      walAutoCheckpointPages: this.config.walAutoCheckpointPages,
    });
  }

  private validateStartupState(): void {
    const integrity = this.db.prepare('PRAGMA integrity_check;').get() as Record<string, unknown> | undefined;
    const journalMode = this.db.prepare('PRAGMA journal_mode;').get() as Record<string, unknown> | undefined;
    this.logger.info('sqlite-startup-check-completed', {
      integrity: integrity ? Object.values(integrity)[0] : 'unknown',
      journalMode: journalMode ? Object.values(journalMode)[0] : 'unknown',
      walBytes: this.readWalBytes(),
    });
  }

  rebuildProjectionsFromEventLog(): void {
    // Current projections are directly updated by agents and event-log replay is not yet
    // destructive. This startup hook verifies replay source availability and logs the
    // latest sequence so operators can distinguish safe verification from state deletion.
    const row = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) as max_sequence FROM event_log').get() as { max_sequence: number };
    this.logger.info('projection-rebuild-source-verified', { latestSequence: row.max_sequence });
  }

  checkpoint(mode: 'PASSIVE' | 'FULL' = 'PASSIVE'): void {
    this.db.exec(`PRAGMA wal_checkpoint(${mode});`);
    this.logger.info('wal-checkpoint-completed', { mode });
  }

  readWalBytes(): number {
    const walPath = `${this.config.dbPath}-wal`;
    if (!fs.existsSync(walPath)) {
      return 0;
    }
    return fs.statSync(walPath).size;
  }

  close(): void {
    this.db.close();
  }
}
