// Lowercase letters and digits joined by "_". Empty results become "project".
export const slugify = (value: string): string => {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return slug || 'project';
};
