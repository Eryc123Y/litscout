import {
  schemas,
  summarySchema,
  radarSchema,
  cursorSchema,
  runSchema,
  missedSchema,
  ratingSchema,
} from "@litscout/pipeline/contracts/index";
import {
  validateRecords,
  type RecordBatch,
  type InvalidRecord,
} from "@litscout/pipeline/records";
import { ingestSummaries, ingestRadar, ingestLegacy } from "./ingest";
import type { IngestDatabase } from "./ingest-store";
type Row = {
  paperId?: string;
  projectId?: string | null;
  day?: string;
  foundOn?: string;
};
async function references<T extends Row>(
  db: IngestDatabase,
  batch: RecordBatch<T>,
  day: string | null = null,
): Promise<RecordBatch<T>> {
  const checks = batch.accepted.flatMap((row, index) =>
    [
      ["paperId", "papers"],
      ["projectId", "projects"],
    ].flatMap(([field, table]) =>
      typeof row[field as keyof Row] === "string"
        ? [
            {
              index,
              field: field!,
              table: table!,
              value: row[field as keyof Row] as string,
            },
          ]
        : [],
    ),
  );
  if (!checks.length) return batch;
  const result = await db.batch(
    checks.map((check) =>
      db.prepare(`SELECT id FROM ${check.table} WHERE id=?`).bind(check.value),
    ),
  );
  const bad = new Map<number, InvalidRecord>();
  checks.forEach((check, i) => {
    const row = batch.accepted[check.index]!;
    if (!result[i]!.results.length && !bad.has(check.index))
      bad.set(check.index, {
        day: day ?? row.day ?? row.foundOn ?? null,
        id: row.paperId ?? `row:${check.index + 1}`,
        field: check.field,
        reason: `Unknown ${check.field}`,
      });
  });
  return {
    ...batch,
    accepted: batch.accepted.filter((_, i) => !bad.has(i)),
    invalid: [...batch.invalid, ...bad.values()],
    skipped: batch.skipped + bad.size,
  };
}
function response(
  batch: { accepted: unknown[]; skipped: number; invalid: InvalidRecord[] },
  rowsWritten: number,
) {
  return {
    rowsWritten,
    accepted: batch.accepted.length,
    skipped: batch.skipped,
    invalid: batch.invalid,
  };
}
export async function ingestSummaryRecords(
  db: IngestDatabase,
  input: unknown,
  counterAllowance?: number,
) {
  const value = schemas.summaryBatch.parse(input);
  const parsed = validateRecords(value.day ?? null, value.summaries, (row) =>
    summarySchema.parse(row),
  );
  const batch = await references(db, parsed, value.day ?? null);
  return response(
    batch,
    await ingestSummaries(
      db,
      { summaries: batch.accepted },
      counterAllowance,
      value.legacy,
    ),
  );
}
export async function ingestRadarRecords(db: IngestDatabase, input: unknown) {
  const value = schemas.radarBatch.parse(input);
  const batch = await references(
    db,
    validateRecords(null, value.radar, (row) => radarSchema.parse(row)),
  );
  return response(batch, await ingestRadar(db, { radar: batch.accepted }));
}
export async function ingestLegacyRecords(db: IngestDatabase, input: unknown) {
  const value = schemas.legacyBatch.parse(input),
    cursors = validateRecords(null, value.cursors, (row) =>
      cursorSchema.parse(row),
    ),
    runs = validateRecords(null, value.runs, (row) => runSchema.parse(row));
  const missed = await references(
      db,
      validateRecords(null, value.missed, (row) => missedSchema.parse(row)),
    ),
    ratings = await references(
      db,
      validateRecords(null, value.ratings, (row) => ratingSchema.parse(row)),
    );
  const batches = [cursors, runs, missed, ratings],
    rowsWritten = await ingestLegacy(db, {
      cursors: cursors.accepted,
      runs: runs.accepted,
      missed: missed.accepted,
      ratings: ratings.accepted,
    });
  return {
    rowsWritten,
    accepted: batches.reduce((n, b) => n + b.accepted.length, 0),
    skipped: batches.reduce((n, b) => n + b.skipped, 0),
    invalid: batches.flatMap((b) => b.invalid),
  };
}
