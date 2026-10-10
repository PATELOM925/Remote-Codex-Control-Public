import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { CodexThread } from '../contracts/codex.js';
import { CODEX_STATE_DB_PATTERN, latestCodexDbPath } from '../utils/codexState.js';

interface DesktopThreadRow {
  id: string;
  cwd: string;
  title?: string | null;
  updated_at_ms?: number | null;
}

export class CodexDesktopThreadCatalogService {
  private stateDbPath?: string;
  private stateDb?: DatabaseSync;

  constructor(private readonly codexHome: string) {}

  static defaultCodexHome(): string {
    const home = process.env.HOME;
    if (!home) {
      throw new Error('HOME is not set; cannot locate Codex desktop state.');
    }
    return path.join(home, '.codex');
  }

  getThread(codexThreadId: string): CodexThread | undefined {
    const db = this.openStateDb();
    if (!db) {
      return undefined;
    }

    try {
      const row = db.prepare('SELECT id, cwd, title, updated_at_ms FROM threads WHERE id = ? LIMIT 1').get(codexThreadId) as
        | DesktopThreadRow
        | undefined;
      return row ? this.mapRow(row) : undefined;
    } catch {
      return undefined;
    }
  }

  listThreads(limit = 200): CodexThread[] {
    const db = this.openStateDb();
    if (!db) {
      return [];
    }

    try {
      const rows = db
        .prepare(
          'SELECT id, cwd, title, updated_at_ms FROM threads ORDER BY COALESCE(updated_at_ms, 0) DESC, id DESC LIMIT ?',
        )
        .all(limit) as unknown as DesktopThreadRow[];
      return rows.map((row) => this.mapRow(row));
    } catch {
      return [];
    }
  }

  private mapRow(row: DesktopThreadRow): CodexThread {
    return {
      codexThreadId: row.id,
      cwd: row.cwd,
      threadName: this.compactTitle(row.title),
      status: 'idle',
      updatedAtMs: typeof row.updated_at_ms === 'number' ? row.updated_at_ms : undefined,
    };
  }

  private compactTitle(title?: string | null): string | undefined {
    const value = title?.trim();
    return value ? value : undefined;
  }

  private openStateDb(): DatabaseSync | undefined {
    const newest = latestCodexDbPath(this.codexHome, CODEX_STATE_DB_PATTERN);
    if (!newest) {
      return undefined;
    }

    if (this.stateDb && this.stateDbPath === newest) {
      return this.stateDb;
    }
    if (this.stateDb) {
      this.stateDb.close();
      this.stateDb = undefined;
    }

    this.stateDbPath = newest;
    this.stateDb = new DatabaseSync(newest, { readOnly: true });
    return this.stateDb;
  }
}
