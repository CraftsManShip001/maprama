/**
 * Text normalization and n-gram indexing shared by every `PlacesRepo`
 * implementation (memory, D1/FTS5) and the seed scripts, so that ranking is
 * identical regardless of storage.
 *
 * Korean place names are short and written without reliable spacing
 * ("성수역" / "성수 역"), so the index uses character bigrams of the
 * whitespace-stripped normalized string, plus the first character as a
 * unigram so one-character queries still match by prefix.
 */

/** Normalizes a name/address: NFKC, lowercase, removes whitespace and punctuation. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** Character bigrams (unique, in order of first appearance). One-character input yields itself. */
export function bigrams(normalized: string): string[] {
  const chars = Array.from(normalized);
  if (chars.length === 0) return [];
  if (chars.length === 1) return [chars[0]!];
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < chars.length - 1; i++) {
    const g = chars[i]! + chars[i + 1]!;
    if (!seen.has(g)) {
      seen.add(g);
      out.push(g);
    }
  }
  return out;
}

/** Index tokens for a place: bigrams of name and address, plus leading unigrams. */
export function indexTokens(name: string, address?: string | null): string[] {
  const set = new Set<string>();
  for (const field of [name, address ?? '']) {
    const norm = normalizeText(field);
    if (!norm) continue;
    set.add(Array.from(norm)[0]!);
    for (const g of bigrams(norm)) set.add(g);
  }
  return [...set];
}

/**
 * Text relevance in `[0, 1]` of a place for a normalized query.
 * Exact name match 1.0; name prefix 0.9; name substring 0.8; otherwise
 * bigram overlap (share of query bigrams found in name or address) × 0.7.
 */
export function textScore(queryNorm: string, name: string, address?: string | null): number {
  if (!queryNorm) return 0;
  const nameNorm = normalizeText(name);
  const addrNorm = normalizeText(address ?? '');
  if (nameNorm === queryNorm) return 1;
  if (nameNorm.startsWith(queryNorm)) return 0.9;
  if (nameNorm.includes(queryNorm)) return 0.8;
  if (addrNorm.includes(queryNorm)) return 0.75;
  const q = bigrams(queryNorm);
  if (q.length === 0) return 0;
  const hay = new Set([...bigrams(nameNorm), ...bigrams(addrNorm)]);
  let hit = 0;
  for (const g of q) if (hay.has(g)) hit++;
  return (hit / q.length) * 0.7;
}
