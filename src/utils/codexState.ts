import fs from 'node:fs';
import path from 'node:path';

export const CODEX_STATE_DB_PATTERN = /^state_\d+\.sqlite$/;
export const CODEX_LOG_DB_PATTERN = /^logs_\d+\.sqlite$/;

// Codex writes versioned database files. The most recently modified match is the live one.
// Read errors are thrown to the caller.
export const latestCodexDbPath = (codexHome: string, pattern: RegExp): string | undefined => {
  if (!fs.existsSync(codexHome)) {
    return undefined;
  }

  const matches = fs
    .readdirSync(codexHome)
    .filter((name) => pattern.test(name))
    .map((name) => path.join(codexHome, name));
  if (matches.length === 0) {
    return undefined;
  }

  matches.sort((left, right) => {
    const leftStat = fs.statSync(left);
    const rightStat = fs.statSync(right);
    if (leftStat.mtimeMs !== rightStat.mtimeMs) {
      return rightStat.mtimeMs - leftStat.mtimeMs;
    }
    return right.localeCompare(left);
  });
  return matches[0];
};
