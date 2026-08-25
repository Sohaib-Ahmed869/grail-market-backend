/** Dice coefficient on character bigrams — tolerant of OCR mangling. */
export function similarity(a: string, b: string): number {
  const bigrams = (s: string) => {
    const norm = s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const set = new Map<string, number>();
    for (let i = 0; i < norm.length - 1; i++) {
      const bg = norm.slice(i, i + 2);
      set.set(bg, (set.get(bg) ?? 0) + 1);
    }
    return set;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let overlap = 0;
  let total = 0;
  for (const [bg, n] of A) {
    overlap += Math.min(n, B.get(bg) ?? 0);
    total += n;
  }
  for (const n of B.values()) total += n;
  return total === 0 ? 0 : (2 * overlap) / total;
}

export function bestAgainst(names: string[], candidate: string): { score: number; name: string } {
  let score = -1;
  let name = names[0] ?? "";
  for (const n of names) {
    const s = similarity(n, candidate);
    if (s > score) {
      score = s;
      name = n;
    }
  }
  return { score, name };
}
