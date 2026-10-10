import fs from 'node:fs';
import path from 'node:path';

import { canonicalPath } from '../utils/paths.js';
import { slugify } from '../utils/slug.js';

interface ProjectStore {
  listProjects(): Array<{ id: string; rootPath: string }>;
  registerProject(input: { id: string; name: string; rootPath: string }): unknown;
}

export interface ConfiguredProjectResult {
  registered: string[];
  skipped: string[];
}

// When the operator names project folders, those folders are the project list.
// Turn off the Codex-thread and folder discovery, which would add other folders.
// An explicit RCC_PROJECT_AUTODISCOVER_LIMIT still wins.
export const skipAutoDiscoveryWhenConfigured = (env: Record<string, string | undefined>): boolean => {
  if (!env.RCC_PROJECT_ROOTS?.trim() || env.RCC_PROJECT_AUTODISCOVER_LIMIT !== undefined) {
    return false;
  }
  env.RCC_PROJECT_AUTODISCOVER_LIMIT = '0';
  return true;
};

const isDirectory = (rawPath: string): boolean => {
  try {
    return fs.statSync(rawPath).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Registers the comma-separated folders from RCC_PROJECT_ROOTS. Already registered
 * folders are skipped, so restarts do not add duplicates. Non-folder entries go to `skipped`.
 */
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
