import { BudgetStop, type WriteBudget } from "./budget";
import { QuotaExceeded } from "./quota";
import { writeReservation, measuredWriteEstimate } from "./write-reservation";
import { batchResponse } from "./records";
import {
  batchFor,
  payloadFor,
  fitBatch,
  jsonBytes,
  itemId,
  BatchRetry,
  RejectedBatch,
  type BatchingReport,
} from "./ingest-batching";
import type { IngestLimits } from "@litscout/core/ingest-limits";
type Reply = {
  data: unknown;
  uncertain: boolean;
  meta?: {
    rowsWritten?: number;
    authRowsWritten: number;
    budgetRowsWritten: number;
  };
};
type Request = (path: string, method: string, body?: unknown) => Promise<Reply>;
const rowCost = (r: Reply) =>
  (r.meta?.rowsWritten ?? 0) +
  (r.meta?.authRowsWritten ?? 0) +
  (r.meta?.budgetRowsWritten ?? 0);
async function writeOnce(
  path: string,
  body: unknown,
  reservation: number,
  method: string,
  request: Request,
  budget: WriteBudget,
) {
  await budget.begin(reservation);
  try {
    const reply = await request(path, method, body);
    if (reply.meta?.rowsWritten === undefined)
      throw new Error("Write response missing row count");
    await budget.settle(
      rowCost(reply) +
        (reply.uncertain ? measuredWriteEstimate(path, body) + 4 : 0),
      reservation,
      false,
    );
    return reply;
  } catch (error) {
    if (error instanceof QuotaExceeded) {
      await budget.rejected(reservation, error.quota?.used, false);
      if (error.uncertain)
        await budget.record(measuredWriteEstimate(path, body) + 4);
    } else
      await budget.settle(
        measuredWriteEstimate(path, body) + 4,
        reservation,
        false,
      );
    throw error;
  }
}
export async function adaptiveWrite(
  path: string,
  body: unknown,
  estimate: number,
  method: string,
  request: Request,
  budget: WriteBudget,
  limits: IngestLimits,
  report: BatchingReport,
  strict = false,
) {
  const batch = batchFor(path, body, limits),
    total = batch?.rows.length ?? 1;
  const parts: { data: unknown; count: number }[] = [];
  let offset = 0,
    maximum = batch?.cap ?? 1,
    available = Infinity,
    overhead = 4,
    denials = 0,
    resumeAt: string | null = null;
  while (offset < total) {
    let size = Math.min(maximum, total - offset);
    const payload = (n: number) =>
      batch ? payloadFor(batch, offset, n) : body;
    size = fitBatch(size, limits.bytes, payload);
    if (strict && size !== total)
      throw new Error("Planned legacy batch no longer fits the request limit");
    while (
      size > 0 &&
      writeReservation(path, payload(size), estimate) + overhead >=
        Math.min(available, budget.remaining())
    )
      size = strict ? 0 : size - 1;
    if (!size) throw new BudgetStop(resumeAt ?? budget.resetAt());
    const value = payload(size),
      bytes = jsonBytes(value);
    const fail = (reason: string, transient: boolean) => {
      const id = itemId(batch?.rows[offset]?.value ?? body, offset + 1);
      report.failures.push({ path, id, reason, transient });
      parts.push({
        data: {
          accepted: 0,
          skipped: 1,
          invalid: [{ day: null, id, field: "request", reason }],
          ...(path === "/ingest/papers" ? { papers: [] } : {}),
        },
        count: 1,
      });
      offset++;
    };
    if (bytes > limits.bytes) {
      if (strict)
        throw new Error(`JSON exceeds client byte limit ${limits.bytes}`);
      fail(`JSON exceeds client byte limit ${limits.bytes}`, false);
      continue;
    }
    try {
      report.requests.push({ path, items: size, bytes });
      const reply = await writeOnce(
        path,
        value,
        writeReservation(path, value, estimate) + overhead,
        method,
        request,
        budget,
      );
      parts.push({ data: reply.data, count: size });
      report.rowsWritten += reply.meta?.rowsWritten ?? 0;
      offset += size;
      available -= rowCost(reply);
      denials = 0;
    } catch (error) {
      if (strict) {
        if (error instanceof QuotaExceeded)
          throw new BudgetStop(error.resumeAt);
        throw error;
      }
      if (error instanceof BatchRetry) {
        if (size === 1) fail(error.message, !(error instanceof RejectedBatch));
        else {
          maximum = Math.max(1, Math.floor(size / 2));
          report.retries++;
        }
        continue;
      }
      if (!(error instanceof QuotaExceeded) || !error.quota || ++denials > 3)
        throw error;
      available = error.quota.limit - error.quota.used - error.quota.reserved;
      overhead = Math.max(
        0,
        error.quota.needed - writeReservation(path, value),
      );
      resumeAt = error.resumeAt;
    }
  }
  if (parts.length === 1) return parts[0]!.data;
  const stats = parts.map((p) => batchResponse(p.data, p.count));
  return {
    ...(parts[0]?.data as object),
    accepted: stats.reduce((n, s) => n + s.accepted, 0),
    skipped: stats.reduce((n, s) => n + s.skipped, 0),
    invalid: stats.flatMap((s) => s.invalid),
    ...(path === "/ingest/papers"
      ? {
          papers: parts.flatMap(
            (p) => (p.data as { papers?: unknown[] }).papers ?? [],
          ),
        }
      : {}),
  };
}
