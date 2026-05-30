const MIN_EXCERPT_MATCH = 40;
const MAX_SPEC_LINKS = 3;

export const containsSpecProse = (codeDoc: string, excerpts: string[]): boolean => {
  const normalized = codeDoc.toLowerCase();
  for (const excerpt of excerpts) {
    const trimmed = excerpt.trim();
    if (trimmed.length < MIN_EXCERPT_MATCH) continue;
    if (normalized.includes(trimmed.toLowerCase())) return true;
  }
  return false;
};

export const validateSpecLinks = (
  links: Array<{ title: string; href: string }>,
  index: Set<string>,
): Array<{ title: string; href: string }> =>
  links.filter((link) => index.has(link.href)).slice(0, MAX_SPEC_LINKS);

const tokenize = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((t) => t.length >= 4),
  );

export const jaccardSimilarity = (a: string, b: string): number => {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  return intersection / (setA.size + setB.size - intersection);
};

export const dedupeSimilarCodeDocs = <T extends { entityId: string; codeDoc: string }>(
  records: T[],
  threshold = 0.85,
): T[] => {
  const kept: T[] = [];
  for (const record of records) {
    const duplicate = kept.find(
      (existing) => jaccardSimilarity(existing.codeDoc, record.codeDoc) > threshold,
    );
    if (!duplicate) kept.push(record);
  }
  return kept;
};
