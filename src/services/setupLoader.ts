import fs from 'node:fs';
import path from 'node:path';

const ASSIGNMENT_PATTERN = /^([A-Z0-9_]+)=(.+)$/;

export const loadSetupFile = (setupPath = path.join(process.cwd(), 'setup.md')): void => {
  if (!fs.existsSync(setupPath)) {
    return;
  }

  const lines = fs.readFileSync(setupPath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const match = line.match(ASSIGNMENT_PATTERN);
    if (!match) {
      continue;
    }

    const [, key, valueRaw] = match;
    if (!key) {
      continue;
    }

    if (!valueRaw) {
      continue;
    }

    const value = valueRaw.trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
};
