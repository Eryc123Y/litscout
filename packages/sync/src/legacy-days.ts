import { z } from "zod";
import { validateJsonl, type InvalidRecord } from "@litscout/pipeline/records";
import { legacyPaper, rawSchema } from "./legacy-records";
import type { LegacyPlan } from "./legacy";
export function legacyDays(
  files: Record<string, string>,
  window: { from: string; to: string },
) {
  const invalid: InvalidRecord[] = [];
  const days = Object.keys(files)
    .filter(
      (file) =>
        /^data\/\d{4}-\d{2}-\d{2}\.jsonl$/.test(file) &&
        file.slice(5, 15) >= window.from &&
        file.slice(5, 15) <= window.to,
    )
    .sort()
    .map((file) => {
      const day = file.slice(5, 15),
        hf = z
          .record(z.string(), z.number().int())
          .parse(JSON.parse(files[`data/${day}_hf.json`] ?? "{}"));
      const raw = validateJsonl(day, files[file]!, (row) =>
        legacyPaper(row, hf),
      );
      const summaries: LegacyPlan["days"][number]["summaries"] = [];
      let totalRecords = raw.total,
        skipped = raw.skipped;
      invalid.push(...raw.invalid);
      for (const [lang, name] of [
        ["en", "English"],
        ["zh", "Chinese"],
      ] as const) {
        const batch = summaryBatch(day, files, lang, name);
        summaries.push(...batch.accepted);
        totalRecords += batch.total;
        skipped += batch.skipped;
        invalid.push(...batch.invalid);
      }
      return { day, papers: raw.accepted, summaries, totalRecords, skipped };
    });
  return { days, invalid };
}

function summaryBatch(
  day: string,
  files: Record<string, string>,
  lang: "en" | "zh",
  name: "English" | "Chinese",
) {
  const batch = validateJsonl(
    day,
    files[`data/${day}_AI_enhanced_${name}.jsonl`] ?? "",
    (value) => {
      const row = rawSchema.parse(value);
      if (!row.AI)
        throw new z.ZodError([
          {
            code: "custom",
            path: ["AI"],
            message: "Complete five-part summary required",
          },
        ]);
      return { key: row.id, lang, content: row.AI };
    },
  );
  return batch;
}
