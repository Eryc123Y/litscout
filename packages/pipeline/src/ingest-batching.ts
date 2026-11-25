import {
  ingestLimitsSchema,
  type IngestLimits,
} from "@litscout/core/ingest-limits";
import { mirrorPath } from "./alphaxiv-contracts";
import {
  crawlWriteEstimate,
  measuredWriteEstimate,
  writeReservation,
} from "./write-reservation";
export class BatchRetry extends Error {}
export class RejectedBatch extends BatchRetry {}
export class PayloadTooLarge extends RejectedBatch {}
/** A reset is not size evidence; only the known serialized byte count is. */
export function connectionFailure(
  error: unknown,
  bytes: number,
  maximum: number,
): BatchRetry {
  let current = error;
  for (
    let depth = 0;
    depth < 3 && current && typeof current === "object";
    depth++
  ) {
    const value = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (
      bytes > maximum &&
      (value.code === "ECONNRESET" ||
        value.code === "UND_ERR_SOCKET" ||
        (typeof value.message === "string" &&
          /ECONNRESET|connection reset/i.test(value.message)))
    )
      return new PayloadTooLarge(
        `Request JSON exceeds server byte limit ${maximum}`,
      );
    current = value.cause;
  }
  return new BatchRetry("connection failure");
}
export type BatchingReport = {
  requests: { path: string; items: number; bytes: number }[];
  retries: number;
  rowsWritten: number;
  failures: { path: string; id: string; reason: string; transient: boolean }[];
};
export const isRejectedPaper = (failure: BatchingReport["failures"][number]) =>
  failure.path === "/ingest/papers" && !failure.transient;
export type Batch = {
  rows: { key: string; value: unknown }[];
  body: Record<string, unknown>;
  cap: number;
};
export const jsonBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
export function batchFor(
  path: string,
  input: unknown,
  limits: IngestLimits,
): Batch | null {
  if (!input || typeof input !== "object") return null;
  const body = input as Record<string, unknown>;
  const kind = path.replace("/ingest/", "");
  const keys =
    kind === "legacy"
      ? ["cursors", "runs", "missed", "ratings"]
      : path === mirrorPath
        ? ["items"]
        : [kind];
  if (!["papers", "summaries", "radar", "legacy", "alphaxiv"].includes(kind))
    return null;
  const rows = keys.flatMap((key) =>
    Array.isArray(body[key]) ? body[key].map((value) => ({ key, value })) : [],
  );
  return rows.length
    ? {
        rows,
        body,
        cap:
          path === mirrorPath
            ? limits.papers
            : limits[kind as "papers" | "summaries" | "radar" | "legacy"],
      }
    : null;
}
export function payloadFor(batch: Batch, offset: number, size: number) {
  const body = { ...batch.body };
  for (const { key } of batch.rows) body[key] = [];
  for (const row of batch.rows.slice(offset, offset + size))
    (body[row.key] as unknown[]).push(row.value);
  return body;
}
export function fitBatch(
  size: number,
  maximum: number,
  payload: (size: number) => unknown,
) {
  while (size > 1 && jsonBytes(payload(size)) > maximum) size--;
  return size;
}

// A request can write an auth row and up to five lease-accounting rows.
export const writeOverhead = 7;

const defaultLimits = ingestLimitsSchema.parse({});
/**
 * `true` and "batched" plan Worker reservations, `false` the Worker's own
 * estimates, and "crawl" what a crawl most likely writes.
 */
export type PlanMode = boolean | "batched" | "crawl";
export function plannedWriteRows(
  path: string,
  body: unknown,
  limits = defaultLimits,
  conservative: PlanMode = false,
) {
  const estimate =
    conservative === "crawl"
      ? crawlWriteEstimate
      : conservative
        ? writeReservation
        : measuredWriteEstimate;
  const cost = (payload: unknown) => estimate(path, payload) + writeOverhead;
  const batch = batchFor(path, body, limits);
  if (!batch) return cost(body);
  // Budget-capped imports allow for adaptive requests splitting down to one row.
  if (conservative === true)
    return batch.rows.reduce(
      (rows, _, offset) => rows + cost(payloadFor(batch, offset, 1)),
      0,
    );
  let rows = 0;
  for (let offset = 0; offset < batch.rows.length;) {
    const payload = (size: number) => payloadFor(batch, offset, size);
    const size = fitBatch(
      Math.min(batch.cap, batch.rows.length - offset),
      limits.bytes,
      payload,
    );
    rows += cost(payload(size));
    offset += size;
  }
  return rows;
}
export function itemId(value: unknown, fallback: number | string) {
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    for (const key of ["key", "paperId", "id", "name", "day"])
      if (typeof v[key] === "string") return v[key] as string;
  }
  return `item:${fallback}`;
}
