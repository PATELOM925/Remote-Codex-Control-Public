export const nowIso = (): string => new Date().toISOString();

export const ageMs = (isoTimestamp?: string): number => {
  if (!isoTimestamp) {
    return Number.POSITIVE_INFINITY;
  }
  return Date.now() - Date.parse(isoTimestamp);
};
