export const nowIso = (): string => new Date().toISOString();

/** Returns the age in milliseconds. A missing timestamp returns Infinity, so missing data counts as stale. */
export const ageMs = (isoTimestamp?: string): number => {
  if (!isoTimestamp) {
    return Number.POSITIVE_INFINITY;
  }
  return Date.now() - Date.parse(isoTimestamp);
};
