import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface CodexSessionTail {
  sessionFile?: string;
  sessionMtimeMs?: number;
  lastTimestamp?: string;
  lastUserText?: string;
  lastToolCall?: { name: string; summary: string };
  lastToolOutput?: { callId?: string; summary: string };
  lastAssistantText?: string;
}

export class CodexSessionService {
  private readonly codexHome: string;
  private stateDbPath?: string;
  private stateDb?: DatabaseSync;

  constructor(private readonly sessionsRoot: string) {
    // sessionsRoot is typically ~/.codex/sessions, so codexHome is ~/.codex
    this.codexHome = path.dirname(sessionsRoot);
  }

  static defaultSessionsRoot(): string {
    const home = process.env.HOME;
    if (!home) {
      throw new Error('HOME is not set; cannot locate Codex sessions.');
    }
    return path.join(home, '.codex', 'sessions');
  }

  latestSessionFileForThread(threadId: string, lookbackDays = 14): string | undefined {
    if (!threadId) {
      return undefined;
    }
    if (!fs.existsSync(this.sessionsRoot)) {
      return undefined;
    }

    // Prefer the state DB rollout_path if available. Threads can persist their rollout
    // JSONL in an older date-based directory while continuing to append to it.
    const fromState = this.rolloutPathFromStateDb(threadId);
    if (fromState) {
      return fromState;
    }

    const now = new Date();
    let best: { file: string; mtimeMs: number } | undefined;

    for (let i = 0; i <= lookbackDays; i += 1) {
      const candidate = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const yyyy = String(candidate.getFullYear());
      const mm = String(candidate.getMonth() + 1).padStart(2, '0');
      const dd = String(candidate.getDate()).padStart(2, '0');
      const dayDir = path.join(this.sessionsRoot, yyyy, mm, dd);
      if (!fs.existsSync(dayDir)) {
        continue;
      }

      let entries: string[] = [];
      try {
        entries = fs.readdirSync(dayDir);
      } catch {
        continue;
      }

      for (const name of entries) {
        if (!name.endsWith(`${threadId}.jsonl`)) {
          continue;
        }
        const fullPath = path.join(dayDir, name);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(fullPath);
        } catch {
          continue;
        }
        if (!best || stat.mtimeMs > best.mtimeMs) {
          best = { file: fullPath, mtimeMs: stat.mtimeMs };
        }
      }
    }

    return best?.file;
  }

  isRecentlyActive(threadId: string, windowMs: number): { active: boolean; sessionFile?: string; mtimeMs?: number } {
    const sessionFile = this.latestSessionFileForThread(threadId);
    if (!sessionFile) {
      return { active: false };
    }
    try {
      const stat = fs.statSync(sessionFile);
      const active = Date.now() - stat.mtimeMs <= windowMs;
      return { active, sessionFile, mtimeMs: stat.mtimeMs };
    } catch {
      return { active: false };
    }
  }

  // NOTE: Codex session JSONL lines can contain large encrypted reasoning payloads.
  // A small tail window can miss the most recent user message, so keep a larger
  // default to make /last reliable.
  readTail(threadId: string, bytes = 2_000_000): CodexSessionTail {
    const sessionFile = this.latestSessionFileForThread(threadId);
    if (!sessionFile) {
      return {};
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(sessionFile);
    } catch {
      return {};
    }

    const fd = fs.openSync(sessionFile, 'r');
    try {
      const size = stat.size;
      let windowBytes = Math.min(bytes, size);

      // Read a tail window, and if we can't find a recent user message, expand
      // the window (up to the full file). This keeps /last reliable even when
      // the session includes very large encrypted reasoning payloads.
      while (true) {
        const start = Math.max(0, size - windowBytes);
        const buffer = Buffer.alloc(size - start);
        fs.readSync(fd, buffer, 0, buffer.length, start);
        const text = buffer.toString('utf8');
        const lines = text.split('\n');

        // Scan from the end; ignore truncated/invalid JSON lines.
        let lastTimestamp: string | undefined;
        let lastUserText: string | undefined;
        let lastToolCall: CodexSessionTail['lastToolCall'];
        let lastToolOutput: CodexSessionTail['lastToolOutput'];
        let lastAssistantText: string | undefined;

        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const raw = lines[i]?.trim();
          if (!raw) {
            continue;
          }
          let record: any;
          try {
            record = JSON.parse(raw);
          } catch {
            continue;
          }

          if (!lastTimestamp && typeof record.timestamp === 'string') {
            lastTimestamp = record.timestamp;
          }

          const payload = record.payload ?? {};
          if (!lastToolOutput && payload.type === 'function_call_output' && typeof payload.output === 'string') {
            lastToolOutput = {
              callId: typeof payload.call_id === 'string' ? payload.call_id : undefined,
              summary: this.oneLine(payload.output, 900),
            };
            continue;
          }

          if (!lastToolCall && payload.type === 'function_call' && typeof payload.name === 'string') {
            const args = typeof payload.arguments === 'string' ? payload.arguments : '';
            lastToolCall = {
              name: payload.name,
              summary: this.oneLine(args, 700),
            };
            continue;
          }

          if (!lastAssistantText && payload.type === 'message' && Array.isArray(payload.content)) {
            const textParts: string[] = [];
            for (const item of payload.content) {
              if (item?.type === 'output_text' && typeof item.text === 'string') {
                textParts.push(item.text);
              }
            }
            if (textParts.length) {
              lastAssistantText = this.oneLine(textParts.join('\n'), 900);
              continue;
            }
          }

          if (!lastUserText && payload.type === 'message' && Array.isArray(payload.content)) {
            const textParts: string[] = [];
            for (const item of payload.content) {
              if (item?.type === 'input_text' && typeof item.text === 'string') {
                textParts.push(item.text);
              }
            }
            if (textParts.length) {
              lastUserText = this.oneLine(textParts.join('\n'), 900);
              continue;
            }
          }
        }

        if (lastUserText || start === 0 || windowBytes >= size) {
          return {
            sessionFile,
            sessionMtimeMs: stat.mtimeMs,
            lastTimestamp,
            lastUserText,
            lastToolCall,
            lastToolOutput,
            lastAssistantText,
          };
        }

        windowBytes = Math.min(size, windowBytes * 2);
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  private rolloutPathFromStateDb(threadId: string): string | undefined {
    const db = this.openStateDb();
    if (!db) {
      return undefined;
    }
    try {
      const row = db.prepare('SELECT rollout_path FROM threads WHERE id = ? LIMIT 1').get(threadId) as
        | { rollout_path?: string | null }
        | undefined;
      const value = row?.rollout_path;
      if (typeof value !== 'string' || !value) {
        return undefined;
      }
      if (!fs.existsSync(value)) {
        return undefined;
      }
      return value;
    } catch {
      return undefined;
    }
  }

  private openStateDb(): DatabaseSync | undefined {
    if (!fs.existsSync(this.codexHome)) {
      return undefined;
    }

    let candidates: string[] = [];
    try {
      candidates = fs
        .readdirSync(this.codexHome)
        .filter((name) => /^state_\d+\.sqlite$/.test(name))
        .map((name) => path.join(this.codexHome, name));
    } catch {
      return undefined;
    }
    if (candidates.length === 0) {
      return undefined;
    }

    candidates.sort((left, right) => {
      const leftStat = fs.statSync(left);
      const rightStat = fs.statSync(right);
      if (leftStat.mtimeMs !== rightStat.mtimeMs) {
        return rightStat.mtimeMs - leftStat.mtimeMs;
      }
      return right.localeCompare(left);
    });
    const newest = candidates[0];
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

  private oneLine(input: string, max: number): string {
    const one = input.replace(/\s+/g, ' ').trim();
    if (one.length <= max) {
      return one;
    }
    return `${one.slice(0, max - 3)}...`;
  }
}
