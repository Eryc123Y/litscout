import { z } from "zod";
export const digestSuggestionLimit = 10;
export const INGEST_CAPS = {
  papers: 40,
  summaries: 50,
  legacy: 40,
  radar: 40,
  bytes: 512 * 1024,
} as const;
export const ingestLimitsSchema = z.strictObject({
  papers: z.number().int().min(1).max(INGEST_CAPS.papers).default(5),
  summaries: z.number().int().min(1).max(INGEST_CAPS.summaries).default(20),
  legacy: z.number().int().min(1).max(INGEST_CAPS.legacy).default(20),
  radar: z.number().int().min(1).max(INGEST_CAPS.radar).default(20),
  bytes: z
    .number()
    .int()
    .min(1)
    .max(INGEST_CAPS.bytes)
    .default(256 * 1024),
});
export type IngestLimits = z.output<typeof ingestLimitsSchema>;
