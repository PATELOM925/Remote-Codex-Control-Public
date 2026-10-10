import fs from 'node:fs';
import path from 'node:path';

// Resolves symbolic links, so one directory always maps to one path. A missing path returns the resolved input.
export const canonicalPath = (rawPath: string): string => {
  const resolved = path.resolve(rawPath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
};
