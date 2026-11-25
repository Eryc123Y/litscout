import {
  httpUrlSchema,
  boundedJson,
} from "@litscout/pipeline/contracts/limits";
import { z } from "zod";
export const daySchema = z.iso.date().max(10);
export const tokenScope = z.enum(["ingest", "read", "write", "vault"]);
export type TokenScope = z.infer<typeof tokenScope>;
export const scopesSchema = z
  .array(tokenScope)
  .max(tokenScope.options.length)
  .min(1);
export const tokenInput = z.object({
  name: z
    .string()
    .max(5000)
    .regex(/^[A-Za-z0-9 _-]{1,64}$/),
  hash: z
    .string()
    .max(5000)
    .regex(/^[a-f0-9]{64}$/),
  scopes: scopesSchema,
  expiresAt: z.iso
    .datetime()
    .max(35)
    .transform((value) => new Date(value).toISOString())
    .nullable()
    .default(null),
});
export const paperInput = z.object({
  verified: z.boolean().optional(),
  title: z.string().max(1000).min(1),
  abstract: z.string().max(20000).nullable().optional(),
  authors: z
    .array(
      z.object({
        name: z.string().max(5000),
        orcid: z.string().max(5000).optional(),
      }),
    )
    .max(500)
    .default([]),
  venue: z.string().max(5000).optional(),
  venueKind: z
    .enum(["preprint", "journal", "conference", "workshop"])
    .optional(),
  publishedOn: daySchema.optional(),
  year: z.number().int().optional(),
  source: z.string().max(5000).default("manual"),
  identifiers: z
    .array(
      z.object({
        scheme: z.enum([
          "doi",
          "arxiv",
          "openalex",
          "s2",
          "openreview",
          "acl",
          "pmlr",
          "jmlr",
          "pmid",
          "dblp",
          "url",
        ]),
        value: z.string().max(5000).min(1),
      }),
    )
    .max(20)
    .default([]),
  links: z
    .array(
      z.object({
        kind: z.enum([
          "doi",
          "landing",
          "pdf_oa",
          "pdf_arxiv",
          "html",
          "code",
          "project",
          "alphaxiv",
        ]),
        url: httpUrlSchema,
        licence: z.string().max(5000).optional(),
        source: z.string().max(100).optional(),
        oaStatus: z
          .enum(["gold", "green", "hybrid", "bronze", "closed", "unknown"])
          .default("unknown"),
      }),
    )
    .max(20)
    .default([]),
});
export const feedDayInput = z.object({
  day: daySchema,
  status: z
    .enum(["pending", "crawled", "summarised", "digested", "final", "empty"])
    .default("pending"),
  counts: z
    .record(z.string().max(5000), z.number().int().nonnegative())
    .default({}),
  crawledAt: z.iso.datetime().max(35).optional(),
});
export const feedItemInput = z.object({
  day: daySchema,
  paperId: z.string().max(5000).startsWith("pap_"),
  source: z.string().max(5000).min(1),
  rankInSource: z.number().int().optional(),
  hfUpvotes: z.number().int().optional(),
  topics: z.array(z.string().max(5000)).max(50).default([]),
  shortlisted: z.boolean().default(false),
});
export const summaryInput = z.object({
  paperId: z.string().max(5000).startsWith("pap_"),
  lang: z.enum(["en", "zh"]).default("en"),
  kind: z.literal("five_part").default("five_part"),
  content: z.object({
    tldr: z.string().max(5000),
    motivation: z.string().max(5000),
    method: z.string().max(5000),
    result: z.string().max(5000),
    conclusion: z.string().max(5000),
  }),
  model: z.string().max(5000).optional(),
  client: z.string().max(5000).optional(),
});
export const digestInput = z.object({
  day: daySchema,
  lang: z.enum(["en", "zh"]).default("en"),
  kind: z.enum(["daily", "weekly"]).default("daily"),
  bodyMd: z.string().max(200000),
  picks: z.array(z.string().max(5000)).max(1000).default([]),
  radar: z.array(boundedJson).max(100).default([]),
  final: z.boolean().default(false),
});
export const runInput = z.object({
  id: z.string().max(5000).startsWith("run_").optional(),
  kind: z.enum([
    "crawl",
    "upload",
    "summaries",
    "digest",
    "weekly",
    "profile_sync",
    "alphaxiv_sync",
    "export",
    "legacy_import",
    "cron",
  ]),
  day: daySchema,
  status: z.string().max(5000).min(1),
  finishedAt: z.iso.datetime().max(35).nullable().optional(),
  stats: z.record(z.string().max(5000), boundedJson).default({}),
  error: z.string().max(5000).nullable().optional(),
});
export function snakeValues(input: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input)
      .filter(([, v]) => v !== undefined)
      .map(([key, v]) => [
        key.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase()),
        v,
      ]),
  );
}
