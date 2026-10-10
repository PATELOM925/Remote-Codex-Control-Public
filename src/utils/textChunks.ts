// Splits text at line breaks so each chunk is at most maxChars long. A line longer than maxChars is cut into pieces.
export const chunkTextByLines = (text: string, maxChars: number): string[] => {
  if (text.length <= maxChars) {
    return [text];
  }

  const lines = text.split('\n');
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
    }
    if (line.length <= maxChars) {
      current = line;
      continue;
    }
    let rest = line;
    while (rest.length > maxChars) {
      chunks.push(rest.slice(0, maxChars));
      rest = rest.slice(maxChars);
    }
    current = rest;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
};
