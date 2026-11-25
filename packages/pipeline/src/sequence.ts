/** difflib.SequenceMatcher(None, a, b), including its >=200-character autojunk rule. */
type Bounds = [number, number, number, number];
export function sequenceRatio(a: string, b: string): number {
  const index = sequenceIndex(b);
  const queue = [[0, a.length, 0, b.length]],
    blocks: number[][] = [];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop() as Bounds;
    let bestI = alo,
      bestJ = blo,
      size = 0,
      lengths = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const next = new Map<number, number>();
      for (const j of index.get(a[i]!) ?? []) {
        if (j < blo || j >= bhi) continue;
        const k = (lengths.get(j - 1) ?? 0) + 1;
        next.set(j, k);
        if (k > size) {
          bestI = i - k + 1;
          bestJ = j - k + 1;
          size = k;
        }
      }
      lengths = next;
    }
    while (bestI > alo && bestJ > blo && a[bestI - 1] === b[bestJ - 1]) {
      bestI--;
      bestJ--;
      size++;
    }
    while (
      bestI + size < ahi &&
      bestJ + size < bhi &&
      a[bestI + size] === b[bestJ + size]
    )
      size++;
    if (!size) continue;
    blocks.push([bestI, bestJ, size]);
    if (alo < bestI && blo < bestJ) queue.push([alo, bestI, blo, bestJ]);
    if (bestI + size < ahi && bestJ + size < bhi)
      queue.push([bestI + size, ahi, bestJ + size, bhi]);
  }
  return a.length + b.length
    ? (2 * blocks.reduce((n, item) => n + item[2]!, 0)) / (a.length + b.length)
    : 1;
}

function sequenceIndex(b: string) {
  const index = new Map<string, number[]>();
  [...b].forEach((c, i) => index.set(c, [...(index.get(c) ?? []), i]));
  if (b.length >= 200)
    for (const [c, positions] of index)
      if (positions.length > Math.floor(b.length / 100) + 1) index.delete(c);
  return index;
}
