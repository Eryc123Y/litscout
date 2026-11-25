import { sequenceRatio } from "./sequence";
export type LegacyRecord = {
  id: string;
  title?: string;
  authors?: string[];
  doi?: string | null;
  oa_url?: string | null;
  has_abstract?: boolean;
  [key: string]: unknown;
};
export type FeedPaper = { record: LegacyRecord; abstract: string };
const words = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
function keys(p: LegacyRecord) {
  const id = p.id.startsWith("doi:") ? null : p.id;
  const doi =
    p.doi
      ?.trim()
      .replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)/i, "")
      .toLowerCase() || (p.id.startsWith("doi:") ? p.id.slice(4) : null);
  const author = p.authors?.[0] ?? "";
  return {
    id,
    doi,
    title: words(p.title ?? ""),
    family: words(author.includes(",") ? author.split(",")[0]! : author)
      .split(" ")
      .at(-1)!,
  };
}
type Owner = number | string | null;
function index() {
  const ids = new Map<string, Owner>(),
    dois = new Map<string, Owner>(),
    titles = new Map<string, Map<string, Owner>>();
  return {
    add(p: LegacyRecord, owner: Owner) {
      const k = keys(p);
      if (k.id && !ids.has(k.id)) ids.set(k.id, owner);
      if (k.doi && !dois.has(k.doi)) dois.set(k.doi, owner);
      if (!k.title) return;
      const family = titles.get(k.family) ?? new Map<string, Owner>();
      if (!family.has(k.title)) family.set(k.title, owner);
      titles.set(k.family, family);
    },
    find(p: LegacyRecord): { matched: boolean; owner?: Owner } {
      const k = keys(p);
      if (k.id && ids.has(k.id)) return { matched: true, owner: ids.get(k.id) };
      if (k.doi && dois.has(k.doi))
        return { matched: true, owner: dois.get(k.doi) };
      const family = titles.get(k.family);
      if (family?.has(k.title))
        return { matched: true, owner: family.get(k.title) };
      for (const [title, owner] of family ?? [])
        if (sequenceRatio(k.title, title) > 0.9)
          return { matched: true, owner };
      return { matched: false };
    },
  };
}
export function dedupe(
  existing: readonly LegacyRecord[],
  batch: readonly FeedPaper[],
  lacking: readonly string[] = [],
) {
  const known = index(),
    fresh: FeedPaper[] = [],
    gained: Record<string, string> = {};
  existing.forEach((p) => known.add(p, lacking.includes(p.id) ? p.id : null));
  for (const p of batch) {
    const { matched, owner } = known.find(p.record);
    if (!matched) {
      known.add(p.record, fresh.length);
      fresh.push(p);
    } else if (typeof owner === "number") {
      const kept = fresh[owner]!,
        abstract = kept.abstract || p.abstract;
      const extra = Object.fromEntries(
        ["doi", "oa_url"]
          .filter((k) => !kept.record[k] && p.record[k])
          .map((k) => [k, p.record[k]]),
      );
      fresh[owner] = {
        record: { ...kept.record, ...extra, has_abstract: Boolean(abstract) },
        abstract,
      };
    } else if (typeof owner === "string" && p.abstract && !gained[owner])
      gained[owner] = p.abstract;
  }
  return {
    fresh,
    duplicates: batch.length - fresh.length - Object.keys(gained).length,
    gained,
  };
}
