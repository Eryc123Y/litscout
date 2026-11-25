import { z } from "zod";
export const invalidRecordSchema = z.strictObject({
  day: z.iso.date().max(10).nullable(),
  id: z.string().max(1000),
  field: z.string().max(1000),
  reason: z.string().max(1000),
});
export type InvalidRecord = z.output<typeof invalidRecordSchema>;
export const chunkReportSchema = z.strictObject({
  day: z.iso.date().max(10).nullable(),
  kind: z.string().max(64),
  accepted: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  invalid: z.array(invalidRecordSchema).max(1000),
});
const responseSchema = z.object({
  accepted: z.number().int().nonnegative().optional(),
  skipped: z.number().int().nonnegative().default(0),
  invalid: z.array(invalidRecordSchema).max(1000).default([]),
});
export function batchResponse(value: unknown, fallback: number) {
  const report = responseSchema.parse(value ?? {});
  return { ...report, accepted: report.accepted ?? fallback };
}
export type RecordBatch<T> = {
  accepted: T[];
  invalid: InvalidRecord[];
  total: number;
  skipped: number;
};
export class InvalidRecordLimit extends Error {
  constructor(
    readonly day: string,
    readonly total: number,
    readonly skipped: number,
    readonly invalid: InvalidRecord[],
  ) {
    super(
      `${day}: ${skipped}/${total} records invalid; import exceeds the 1% limit`,
    );
    this.name = "InvalidRecordLimit";
  }
}
function recordId(value: unknown, index: number) {
  if (value && typeof value === "object")
    for (const key of ["key", "id", "paperId", "name"]) {
      const id = (value as Record<string, unknown>)[key];
      if (typeof id === "string") return id.slice(0, 1000);
    }
  return `row:${index + 1}`;
}
function invalidRecord(
  day: string | null,
  value: unknown,
  index: number,
  error: unknown,
): InvalidRecord {
  const issue = error instanceof z.ZodError ? error.issues[0] : undefined;
  const ownDay =
    value && typeof value === "object"
      ? ((value as Record<string, unknown>).day ??
        (value as Record<string, unknown>).date ??
        (value as Record<string, unknown>).foundOn)
      : null;
  const date =
    day ?? (z.iso.date().safeParse(ownDay).success ? (ownDay as string) : null);
  return {
    day: date,
    id: recordId(value, index),
    field: issue?.path.join(".") || "$",
    reason: (
      issue?.message ??
      (error instanceof SyntaxError
        ? "Invalid JSON record"
        : "Record validation failed")
    ).slice(0, 1000),
  };
}
function collect<T>(
  day: string | null,
  readers: (() => unknown)[],
  convert: (value: unknown) => T,
): RecordBatch<T> {
  const accepted: T[] = [],
    invalid: InvalidRecord[] = [];
  readers.forEach((read, index) => {
    let record: unknown;
    try {
      record = read();
      accepted.push(convert(record));
    } catch (error) {
      invalid.push(invalidRecord(day, record, index, error));
    }
  });
  return { accepted, invalid, total: readers.length, skipped: invalid.length };
}
export function validateRecords<T>(
  day: string | null,
  values: readonly unknown[],
  convert: (value: unknown) => T,
) {
  return collect(
    day,
    values.map((value) => () => value),
    convert,
  );
}
export function validateJsonl<T>(
  day: string | null,
  text: string,
  convert: (value: unknown) => T,
) {
  return collect(
    day,
    text
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => () => JSON.parse(line)),
    convert,
  );
}
