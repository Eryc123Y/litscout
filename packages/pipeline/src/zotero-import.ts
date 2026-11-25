import { z } from "zod";
import { publicHttpUrl } from "@litscout/core/public-url";
import {
  zoteroEntry,
  zoteroEntryLimit,
  zoteroFileBytes,
  zoteroId,
  zoteroTitleEvidence,
  zoteroTitleKey,
  type ZoteroEntry,
  type ZoteroFormat,
} from "./zotero-contracts";
import {
  bibList,
  bibText,
  readBibTeX,
  type BibTeXIssue,
} from "./zotero-bibtex";

export type ZoteroIssue = BibTeXIssue | { item: number; message: string };

const name = z.object({
  family: z.string().optional(),
  given: z.string().optional(),
  literal: z.string().optional(),
  "non-dropping-particle": z.string().optional(),
  suffix: z.string().optional(),
});
const cslTag = z.union([z.string(), z.object({ tag: z.string() })]);
const cslCollection = z.union([z.string(), z.object({ name: z.string() })]);
const cslItem = z.object({
  title: z.string().optional(),
  DOI: z.string().optional(),
  URL: z.string().optional(),
  author: z.array(name).default([]),
  issued: z
    .object({
      "date-parts": z.array(z.array(z.number().int())).optional(),
    })
    .optional(),
  "container-title": z.string().optional(),
  abstract: z.string().optional(),
  keyword: z.union([z.string(), z.array(z.string())]).optional(),
  tags: z.array(cslTag).default([]),
  collections: z.array(cslCollection).default([]),
});

function capped(value: string | undefined, max: number) {
  return value?.trim().slice(0, max) || undefined;
}

function entry(value: {
  title?: string;
  authors: string[];
  year?: number;
  doi?: string;
  arxiv?: string;
  url?: string;
  venue?: string;
  abstract?: string;
  tags: string[];
}) {
  const url = publicHttpUrl(value.url ?? "")?.href;
  const ids = [zoteroId(value.doi), zoteroId(value.arxiv), zoteroId(url)];
  return zoteroEntry.safeParse({
    title: capped(value.title, 1000),
    authors: value.authors
      .flatMap((author) => capped(author, 300) || [])
      .slice(0, 50),
    year:
      value.year && value.year >= 1 && value.year <= 9999
        ? value.year
        : undefined,
    doi: ids.find((id) => id?.kind === "doi")?.value,
    arxiv: ids.find((id) => id?.kind === "arxiv")?.value,
    url: url && url.length <= 2048 ? url : undefined,
    venue: capped(value.venue, 500),
    abstract: capped(value.abstract, 20_000),
    tags: [...new Set(value.tags.map((tag) => tag.trim()).filter(Boolean))].map(
      (tag) => "zotero/" + tag,
    ),
  });
}

function fromBibTeX(fields: Map<string, string>) {
  const field = (key: string) => bibText(fields.get(key) ?? "");
  const commaList = (key: string) => bibList(fields.get(key) ?? "", /,\s*/y);
  const eprint = field("eprint");
  const prefix = field("archiveprefix").toLowerCase();
  return entry({
    title: field("title"),
    authors: bibList(fields.get("author") ?? "", /\s+and\s+/iy),
    year: Number(field("year")),
    doi: field("doi"),
    arxiv:
      (!prefix || prefix === "arxiv") && eprint ? "arxiv:" + eprint : undefined,
    url: field("url"),
    venue: field("journal") || field("booktitle"),
    abstract: field("abstract"),
    tags: ["keywords", "groups", "collections"].flatMap(commaList),
  });
}

function fromCsl(input: unknown) {
  const result = cslItem.safeParse(input);
  if (!result.success) return null;
  const item = result.data;
  const keywords =
    typeof item.keyword === "string"
      ? item.keyword.split(",")
      : (item.keyword ?? []);
  return entry({
    title: item.title,
    authors: item.author.map(
      (author) =>
        author.literal ??
        [
          [author["non-dropping-particle"], author.family]
            .filter(Boolean)
            .join(" "),
          author.given,
          author.suffix,
        ]
          .filter(Boolean)
          .join(", "),
    ),
    year: item.issued?.["date-parts"]?.[0]?.[0],
    doi: item.DOI,
    url: item.URL,
    venue: item["container-title"],
    abstract: item.abstract,
    tags: [
      ...keywords,
      ...item.tags.map((tag) => (typeof tag === "string" ? tag : tag.tag)),
      ...item.collections.map((collection) =>
        typeof collection === "string" ? collection : collection.name,
      ),
    ],
  });
}

const entryLimitError = () =>
  new Error("Zotero exports are limited to 5,000 entries");

export function parseZotero(input: string, format: ZoteroFormat) {
  if (new TextEncoder().encode(input).byteLength > zoteroFileBytes)
    throw new Error("Zotero exports are limited to 5 MB");
  const entries: ZoteroEntry[] = [];
  const issues: ZoteroIssue[] = [];
  const text = input.replace(/^\uFEFF/, "");
  if (format === "bibtex") {
    for (const record of readBibTeX(text)) {
      if (entries.length + issues.length >= zoteroEntryLimit)
        throw entryLimitError();
      if ("message" in record) {
        issues.push(record);
        continue;
      }
      const result = fromBibTeX(record.fields);
      if (result.success) entries.push(result.data);
      else
        issues.push({
          line: record.line,
          message: "Invalid bibliographic fields",
        });
    }
    if (
      !entries.length &&
      !issues.length &&
      text.trim() &&
      !/@(?:comment|string|preamble)\b/i.test(text)
    )
      throw new Error("No BibTeX entries found");
  } else {
    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch {
      throw new Error("Invalid CSL JSON");
    }
    if (!Array.isArray(input)) throw new Error("Expected a CSL JSON array");
    if (input.length > zoteroEntryLimit) throw entryLimitError();
    input.forEach((value, index) => {
      const result = fromCsl(value);
      if (result?.success) entries.push(result.data);
      else
        issues.push({
          item: index + 1,
          message: "Invalid bibliographic fields",
        });
    });
  }
  return { entries, issues };
}

function combine(first: ZoteroEntry, second: ZoteroEntry): ZoteroEntry {
  return {
    title: first.title ?? second.title,
    authors: first.authors.length ? first.authors : second.authors,
    year: first.year ?? second.year,
    doi: first.doi ?? second.doi,
    arxiv: first.arxiv ?? second.arxiv,
    url: first.url ?? second.url,
    venue: first.venue ?? second.venue,
    abstract: first.abstract ?? second.abstract,
    tags: [...new Set([...first.tags, ...second.tags])],
  };
}

function sameTitleWork(a: ZoteroEntry, b: ZoteroEntry) {
  if (
    (a.doi && b.doi && a.doi !== b.doi) ||
    (a.arxiv && b.arxiv && a.arxiv !== b.arxiv)
  )
    return false;
  const bare = (entry: ZoteroEntry) =>
    !entry.doi && !entry.arxiv && !entry.year && !entry.authors.length;
  return zoteroTitleEvidence(a, b) || (bare(a) && bare(b));
}

/** Fold repeated export records before assigning stable batch offsets. */
export function groupZoteroEntries(entries: ZoteroEntry[]) {
  const groups = new Map<number, ZoteroEntry>();
  const strong = new Map<string, number>();
  const titles = new Map<string, number[]>();
  const parent = new Map<number, number>();
  function root(index: number) {
    let result = index;
    while (parent.has(result)) result = parent.get(result)!;
    if (result !== index) parent.set(index, result);
    return result;
  }

  for (const [index, value] of entries.entries()) {
    const ids = [
      ...(value.doi ? ["doi:" + value.doi] : []),
      ...(value.arxiv ? ["arxiv:" + value.arxiv] : []),
    ];
    const title = zoteroTitleKey(value.title);
    const known = new Set(
      ids.flatMap((id) => {
        const existing = strong.get(id);
        return existing === undefined ? [] : [root(existing)];
      }),
    );
    const candidates = titles.get(title) ?? [];
    if (!known.size && title) {
      const matching = new Set(
        candidates
          .map(root)
          .filter(
            (key) =>
              sameTitleWork(value, groups.get(key)!) ||
              (!groups.get(key)!.doi &&
                !groups.get(key)!.arxiv &&
                sameTitleWork(value, entries[key]!)),
          ),
      );
      if (matching.size === 1) known.add([...matching][0]!);
    }
    let merged = value;
    let target = index;
    for (const key of [...known].sort((a, b) => b - a)) {
      merged = combine(groups.get(key)!, merged);
      target = key;
    }
    for (const key of known) {
      if (key === target) continue;
      parent.set(key, target);
      groups.delete(key);
    }
    groups.set(target, merged);
    if (title && !candidates.includes(target)) {
      candidates.push(target);
      titles.set(title, candidates);
    }
    for (const id of ids) strong.set(id, target);
  }
  return {
    entries: [...groups.values()],
    duplicates: entries.length - groups.size,
  };
}
