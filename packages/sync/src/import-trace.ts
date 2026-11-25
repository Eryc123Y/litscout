import { z } from "zod";
import type { FeedApi } from "@litscout/pipeline/api";
import {
  invalidRecordSchema,
  InvalidRecordLimit,
} from "@litscout/pipeline/records";
import type { LegacyPlan } from "./legacy";
type Chunk = {
  day: string | null;
  kind: string;
  accepted: number;
  skipped: number;
  invalid: z.output<typeof invalidRecordSchema>[];
};
const report = z.object({
  accepted: z.number().optional(),
  skipped: z.number().default(0),
  invalid: z.array(invalidRecordSchema).default([]),
});
function context(path: string, body: unknown) {
  const raw = body as Record<string, unknown>,
    kind = path.split("/").at(-1)!;
  const count = Object.values(raw)
    .filter(Array.isArray)
    .reduce((n, list) => n + list.length, 0);
  return {
    day: typeof raw.day === "string" ? raw.day : null,
    kind,
    count: kind === "feed-day" || path.startsWith("/digests/") ? 1 : count,
  };
}
export function importTrace(plan: LegacyPlan, api: FeedApi) {
  const chunks: Chunk[] = [];
  const tracked: FeedApi = {
    ...api,
    write: async (path, body, estimate, method, strict) => {
      const result = await api.write(path, body, estimate, method, strict),
        stats = report.parse(result),
        ctx = context(path, body);
      chunks.push({
        day: ctx.day,
        kind: ctx.kind,
        accepted: stats.accepted ?? ctx.count,
        skipped: stats.skipped,
        invalid: stats.invalid,
      });
      const affected = new Set(
        stats.invalid.map((issue) => issue.day ?? ctx.day),
      );
      for (const name of affected) {
        const day = plan.days.find((d) => d.day === name),
          errors = chunks
            .flatMap((c) => c.invalid)
            .filter((e) => (e.day ?? ctx.day) === name);
        if (day && (day.skipped + errors.length) * 100 > day.totalRecords)
          throw new InvalidRecordLimit(
            day.day,
            day.totalRecords,
            day.skipped + errors.length,
            [...plan.invalid.filter((e) => e.day === day.day), ...errors],
          );
      }
      return result;
    },
  };
  return { api: tracked, chunks };
}
