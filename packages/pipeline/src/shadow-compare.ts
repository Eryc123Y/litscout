/**
 * The weekday shadow comparison: what the old pipeline's digest picked, and
 * how much of it LitScout's digest shares. Pure, so the CLI and tests share it.
 * Identifiers are compared, never titles (DOI or arXiv/platform ID).
 */

/**
 * Lower-case; drop `arxiv:`, `doi:` and doi.org prefixes, so a DOI matches
 * with or without them; drop an arXiv version (new and old style).
 */
export function canonicalId(raw: string) {
  const id = raw
    .trim()
    .toLowerCase()
    .replace(/^(?:arxiv:|doi:|https?:\/\/(?:dx\.)?doi\.org\/)/, "");
  return /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})v\d+$/.test(id)
    ? id.replace(/v\d+$/, "")
    : id;
}

const readingDayPattern = /arXiv (\d{4}-\d{2}-\d{2}) 批次/;
const linkDayPattern = /#day=(\d{4}-\d{2}-\d{2})/;
const paperParam = /[#&?]paper=([^&)\s]+)/g;

/**
 * The old digest's reading day and its picked papers, in order and without
 * repeats. The Hugging Face popular list is not a pick and is skipped.
 */
export function oldDigestFacts(markdown: string) {
  // The reading day is in the header; paper text further down is not.
  const header = markdown.split("\n").slice(0, 10).join("\n");
  const readingDay =
    readingDayPattern.exec(header)?.[1] ??
    linkDayPattern.exec(header)?.[1] ??
    null;
  const ids: string[] = [];
  for (const line of markdown.split("\n")) {
    if (/^\*\*HF\b/.test(line.trim())) continue;
    for (const match of line.matchAll(paperParam)) {
      let value: string;
      try {
        value = decodeURIComponent(match[1]!);
      } catch {
        continue;
      }
      const id = canonicalId(value);
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return { readingDay, ids };
}

/**
 * Picks both digests made, as intersection and union. A new pick is shared
 * when any of its identifiers is one of the old picks; each old pick counts
 * once.
 */
export function pickOverlap(
  oldIds: readonly string[],
  picks: readonly { identifiers: readonly string[] }[],
) {
  // The same paper picked twice is one pick.
  const seen = new Set<string>();
  const newPicks = picks.filter(({ identifiers }) => {
    const key = identifiers.map(canonicalId).sort().join(" ");
    if (key && seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const remaining = new Set(oldIds.map(canonicalId));
  let intersection = 0;
  for (const pick of newPicks) {
    const hit = pick.identifiers
      .map(canonicalId)
      .find((id) => remaining.has(id));
    if (hit) {
      remaining.delete(hit);
      intersection++;
    }
  }
  return {
    intersection,
    union:
      new Set(oldIds.map(canonicalId)).size + newPicks.length - intersection,
  };
}
