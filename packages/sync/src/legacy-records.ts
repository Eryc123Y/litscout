import { z } from "zod";
import {
  paperSchema,
  fivePartSchema,
} from "@litscout/pipeline/contracts/index";
export const rawSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    authors: z.array(z.string()).default([]),
    summary: z.string().nullable().optional(),
    abstract: z.string().nullable().optional(),
    categories: z.array(z.string()).default([]),
    source: z.string().optional(),
    venue: z.string().optional(),
    kind: z.string().optional(),
    doi: z.string().nullable().optional(),
    oa_url: z.string().nullable().optional(),
    abs: z.string().optional(),
    pdf: z.string().optional(),
    url: z.string().optional(),
    code_url: z.string().optional(),
    published: z.string().optional(),
    AI: fivePartSchema.optional(),
  })
  .passthrough();
export function parseLedger(text: string, from: string, to: string) {
  const rows: { day: string; key: string }[] = [],
    warnings: string[] = [];
  if (!text.trim()) return { rows, warnings };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { rows, warnings: ["Unreadable legacy ledger JSON"] };
  }
  const envelope = z
    .union([
      z.array(z.unknown()),
      z.object({
        items: z.array(z.unknown()).optional(),
        entries: z.array(z.unknown()).optional(),
      }),
    ])
    .safeParse(raw);
  if (!envelope.success)
    return { rows, warnings: ["Unreadable legacy ledger shape"] };
  const entries = Array.isArray(envelope.data)
    ? envelope.data
    : (envelope.data.items ?? envelope.data.entries ?? []);
  const item = z.object({
    date: z.iso.date().optional(),
    day: z.iso.date().optional(),
    id: z.string().optional(),
    ids: z.array(z.string()).optional(),
  });
  for (const entry of entries) {
    const parsed = item.safeParse(entry);
    if (!parsed.success) {
      warnings.push("Unreadable legacy ledger entry");
      continue;
    }
    const day = parsed.data.date ?? parsed.data.day;
    if (!day || day < from || day > to) continue;
    for (const key of [
      ...(parsed.data.id ? [parsed.data.id] : []),
      ...(parsed.data.ids ?? []),
    ])
      rows.push({ day, key });
  }
  return { rows, warnings };
}
export function parseJsonl(text: string) {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as unknown);
}
export function legacyPaper(
  record: unknown,
  upvotes: Record<string, number> = {},
) {
  const r = rawSchema.parse(record),
    source = r.source ?? "arxiv";
  const scheme =
    source === "arxiv" || /^\d{4}\.\d{4,5}$/.test(r.id)
      ? "arxiv"
      : r.id.startsWith("openreview:")
        ? "openreview"
        : r.id.startsWith("doi:") || r.doi
          ? "doi"
          : "url";
  const value =
    scheme === "arxiv"
      ? r.id
      : scheme === "doi"
        ? (r.doi ?? r.id.slice(4))
        : r.id.replace(/^(openreview|url):/, "");
  const identifiers = [
    { scheme, value },
    ...(r.doi && scheme !== "doi" ? [{ scheme: "doi", value: r.doi }] : []),
  ];
  const links = [
    r.abs || r.url ? { kind: "landing", url: r.abs ?? r.url } : null,
    r.pdf ? { kind: "pdf_arxiv", url: r.pdf } : null,
    r.oa_url ? { kind: "pdf_oa", url: r.oa_url } : null,
    r.code_url ? { kind: "code", url: r.code_url } : null,
  ].filter(Boolean);
  return paperSchema.parse({
    key: r.id,
    title: r.title,
    authors: r.authors,
    abstract: r.summary || r.abstract || null,
    categories: r.categories,
    source,
    venue: r.venue ?? null,
    venueKind: source === "arxiv" ? "preprint" : (r.kind ?? "journal"),
    publishedOn: r.published ?? null,
    identifiers,
    links,
    hfUpvotes: upvotes[r.id] ?? null,
  });
}
const cell = (line: string) =>
  (line.match(/(?:\\\||[^|])+/g) ?? []).map((s) =>
    s.trim().replaceAll("\\|", "|"),
  );
export function parseRadarTable(text: string, from: string, to: string) {
  const rows: {
      day: string;
      key: string;
      title: string;
      level: "high" | "medium" | "borrow";
      reason: string;
      action: string;
      lookBack: boolean;
    }[] = [],
    warnings: string[] = [];
  for (const line of text.split(/\r?\n/).filter(
    (l) =>
      l.startsWith("|") &&
      !/^\|[\s|:-]+$/.test(l) &&
      !l
        .split("|")[2]
        ?.trim()
        .match(/^arXiv ID$/i),
  )) {
    const cells = cell(line),
      [day, key, title, grade, reason = "", action = ""] = cells;
    const level = grade?.match(/^(高|中|可借鉴|high|medium|borrow)/)?.[1];
    if (!z.iso.date().safeParse(day).success || !key || !title || !level) {
      warnings.push("Unreadable legacy table row");
      continue;
    }
    if (day! < from || day! > to) continue;
    rows.push({
      day: day!,
      key,
      title,
      level:
        (
          { 高: "high", 中: "medium", 可借鉴: "borrow" } as Record<
            string,
            "high" | "medium" | "borrow"
          >
        )[level] ?? (level as "high" | "medium" | "borrow"),
      reason,
      action,
      lookBack: grade!.includes("回溯"),
    });
  }
  return { rows, warnings };
}
