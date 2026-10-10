import fs from 'node:fs';
import path from 'node:path';

interface ProjectStore {
  listProjects(): Array<{ id: string; rootPath: string }>;
  registerProject(input: { id: string; name: string; rootPath: string }): unknown;
}

export interface ConfiguredProjectResult {
  registered: string[];
  skipped: string[];
}

const canonicalPath = (rawPath: string): string => {
  const resolved = path.resolve(rawPath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
};

const isDirectory = (rawPath: string): boolean => {
  try {
    return fs.statSync(rawPath).isDirectory();
  } catch {
    return false;
  }
};

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'project';

// Registers the comma-separated folders from RCC_PROJECT_ROOTS. A folder that
// is already registered is left alone, so restarts do not add duplicates.
export const registerConfiguredProjects = (store: ProjectStore, raw: string | undefined): ConfiguredProjectResult => {
  const result: ConfiguredProjectResult = { registered: [], skipped: [] };
  const entries = (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    return result;
  }

  const existing = store.listProjects();
  const knownRoots = new Set(existing.map((project) => canonicalPath(project.rootPath)));
  const knownIds = new Set(existing.map((project) => project.id));

  for (const entry of entries) {
    if (!isDirectory(entry)) {
      result.skipped.push(entry);
      continue;
    }

    const rootPath = canonicalPath(entry);
    if (knownRoots.has(rootPath)) {
      continue;
    }

    const name = path.basename(rootPath) || 'project';
    const baseId = `cfg_${slugify(name)}`;
    let id = baseId;
    for (let suffix = 2; knownIds.has(id); suffix += 1) {
      id = `${baseId}_${suffix}`;
    }

    store.registerProject({ id, name, rootPath });
    knownRoots.add(rootPath);
    knownIds.add(id);
    result.registered.push(rootPath);
  }

  return result;
};
