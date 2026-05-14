import { nowIso } from './utils/time.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

export class Logger {
  constructor(private readonly level: LogLevel = 'info') {}

  debug(message: string, fields: LogFields = {}): void {
    this.log('debug', message, fields);
  }

  info(message: string, fields: LogFields = {}): void {
    this.log('info', message, fields);
  }

  warn(message: string, fields: LogFields = {}): void {
    this.log('warn', message, fields);
  }

  error(message: string, fields: LogFields = {}): void {
    this.log('error', message, fields);
  }

  private shouldLog(level: LogLevel): boolean {
    const priorities: Record<LogLevel, number> = {
      debug: 10,
      info: 20,
      warn: 30,
      error: 40,
    };
    return priorities[level] >= priorities[this.level];
  }

  private log(level: LogLevel, message: string, fields: LogFields): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const payload = {
      ts: nowIso(),
      level,
      message,
      ...fields,
    };

    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }
}
