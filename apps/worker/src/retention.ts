import { storageSchema } from "@litscout/core/config";
import { shiftDay } from "@litscout/pipeline/daily";
import { type z } from "zod";
import {
  pruneOverhead,
  retentionPageSize,
  type pruneCursorSchema,
} from "@litscout/pipeline/retention-contracts";
import { finishPrune, prunePage, retentionPage } from "@litscout/db/retention";
import {
  reserveWriteBudget,
  settleWriteBudget,
  writeBudgetUsage,
  pruneBudgetUsage,
} from "@litscout/db/write-budget";
import type { AppEnv } from "./env";
import { userDay } from "./instance-day";

/** Rows kept free for the next crawl when retention work spends budget. */
export const crawlReserve = 41_000;

export function storage(env: AppEnv) {
  // An invalid deployment setting must fail closed before deletion.
  return storageSchema.parse(
    env.STORAGE_CONFIG === undefined ? {} : JSON.parse(env.STORAGE_CONFIG),
  );
}

type Options = {
  after?: z.infer<typeof pruneCursorSchema>;
  waiting?: number;
  oldOnly?: boolean;
};
export async function retentionBatch(
  env: AppEnv,
  now: Date,
  input: Options,
  dryRun: boolean,
  pageSize = retentionPageSize,
) {
  const db = env.DB!;
  const settings = storage(env);
  const at = now.toISOString(),
    day = at.slice(0, 10);
  const cutoff = shiftDay(
    userDay(env, now),
    Math.min(0, 1 - settings.fullDays),
  );
  const [usage, charged, previewPage] = await Promise.all([
    writeBudgetUsage(db, day),
    pruneBudgetUsage(db, day),
    input.waiting === undefined
      ? retentionPage(
          db,
          cutoff,
          input.after ?? null,
          pageSize,
          !dryRun || input.oldOnly,
        )
      : null,
  ]);
  const available = Math.max(
    0,
    Math.min(
      settings.pruneRowsPerDay - charged,
      usage.limit - usage.used - usage.reserved - crawlReserve - 4,
    ),
  );
  const page = previewPage?.rows ?? [];
  const rows = page.map(({ title, bound, reasons, age }) => ({
    title,
    bound,
    reasons,
    eligible: !reasons.length && age < cutoff,
  }));
  const last = page.at(-1);
  const preview = {
    enabled: settings.prune,
    available,
    rows,
    next:
      page.length === pageSize && last ? { age: last.age, id: last.id } : null,
    sizeBytes: previewPage?.sizeBytes ?? null,
  };
  const guard = { headroom: crawlReserve, pruneCap: settings.pruneRowsPerDay };
  const result = { ...preview, papersPruned: 0, rowsWritten: 0, waiting: 0 };
  if (dryRun || !settings.prune) return result;
  if (input.waiting !== undefined) {
    if (available < pruneOverhead) return result;
    const lease = await reserveWriteBudget(
      db,
      pruneOverhead,
      now,
      pruneOverhead,
      guard,
    );
    if (!lease) return result;
    try {
      const recorded = await finishPrune(db, lease, at, input.waiting);
      const business = recorded.meta.rows_written;
      const budgetRows = await settleWriteBudget(db, lease, business);
      result.rowsWritten = business + budgetRows;
    } catch (error) {
      await settleWriteBudget(db, lease, 0, true);
      throw error;
    }
    return result;
  }
  const eligible = page.filter((_, i) => rows[i]?.eligible);
  let bound = pruneOverhead;
  const selected = eligible.filter((row) => {
    // Leave room for the status report even at the pruning cap.
    if (bound + row.bound + pruneOverhead > available) return false;
    bound += row.bound;
    return true;
  });
  result.waiting = eligible.length;
  if (!selected.length) return result;
  const lease = await reserveWriteBudget(db, bound, now, bound, guard);
  if (!lease) return result;
  try {
    const run = await prunePage(db, cutoff, selected, { lease, at });
    const business = run.rowsWritten;
    const budgetRows = await settleWriteBudget(db, lease, business);
    result.papersPruned = run.pruned;
    result.rowsWritten = business + budgetRows;
    result.waiting -= run.pruned;
  } catch (error) {
    await settleWriteBudget(db, lease, 0, true);
    throw error;
  }
  return result;
}
