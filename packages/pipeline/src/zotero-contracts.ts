import { z } from "zod";
import { parsePaperId } from "@litscout/core/ids";
import { namesCompatible, vaultTitleKey } from "@litscout/core/normalize";

export const zoteroFormat = z.enum(["bibtex", "csl"]);
export type ZoteroFormat = z.infer<typeof zoteroFormat>;
export const zoteroFileBytes = 5 * 1024 * 1024;
export const zoteroEntryLimit = 5000;
export const zoteroBatchSize = 20;
export const zoteroImportPath = "/library/import";

export function zoteroId(value?: string) {
  if (!value || value.length > 2048) return undefined;
  try {
    const id = parsePaperId(value);
    return id.kind === "doi" || id.kind === "arxiv" ? id : undefined;
  } catch {
    return undefined;
  }
}

const text = (max: number) => z.string().trim().min(1).max(max);
export const zoteroEntry = z
  .object({
    title: text(1000).optional(),
    authors: z.array(text(300)).max(50),
    year: z.number().int().min(1).max(9999).optional(),
    doi: z
      .string()
      .refine(
        (id) => zoteroId(id)?.kind === "doi" && zoteroId(id)?.value === id,
      )
      .optional(),
    arxiv: z
      .string()
      .refine(
        (id) => zoteroId(id)?.kind === "arxiv" && zoteroId(id)?.value === id,
      )
      .optional(),
    url: z.url().max(2048).optional(),
    venue: text(500).optional(),
    abstract: text(20000).optional(),
    tags: z.array(text(5000).startsWith("zotero/")),
  })
  .refine(
    (entry) => entry.title || entry.doi || entry.arxiv,
    "Expected a title, DOI or arXiv ID",
  );

export type ZoteroEntry = z.infer<typeof zoteroEntry>;
export const zoteroBatch = z
  .object({
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    format: zoteroFormat,
    offset: z.number().int().nonnegative(),
    total: z.number().int().min(1).max(zoteroEntryLimit),
    entries: z.array(zoteroEntry).min(1).max(zoteroBatchSize),
    dryRun: z.boolean(),
  })
  .refine(
    (batch) => batch.offset + batch.entries.length <= batch.total,
    "Invalid import offset",
  );
export type ZoteroBatch = z.infer<typeof zoteroBatch>;

const count = z.number().int().nonnegative();
export const zoteroProgress = z.object({
  next: count,
  new: count,
  linked: count,
  duplicates: count,
  unverified: count,
  invalid: count,
});
export type ZoteroProgress = z.infer<typeof zoteroProgress>;
export const newZoteroProgress = (): ZoteroProgress => ({
  next: 0,
  new: 0,
  linked: 0,
  duplicates: 0,
  unverified: 0,
  invalid: 0,
});

export const zoteroTitleKey = (title?: string) =>
  vaultTitleKey(title ?? "").replaceAll(" ", "");

type Work = { authors: readonly string[]; year?: number | null };
export function zoteroTitleEvidence(a: Work, b: Work) {
  return (
    (a.year !== undefined && a.year !== null && a.year === b.year) ||
    a.authors.some((name) =>
      b.authors.some((other) => namesCompatible(name, other)),
    )
  );
}
