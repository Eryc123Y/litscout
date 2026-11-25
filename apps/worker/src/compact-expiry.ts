import { shiftDay } from "@litscout/pipeline/daily";
import { expiryPageSize } from "@litscout/pipeline/retention-contracts";
import {
  expirePage,
  expiryPage,
  expiryPreview,
  type ExpiryRow,
} from "@litscout/db/compact-expiry";
import {
  pruneBudgetUsage,
  reserveWriteBudget,
  settleWriteBudget,
  writeBudgetUsage,
} from "@litscout/db/write-budget";
import type { AppEnv } from "./env";
import { userDay } from "./instance-day";
import { crawlReserve, storage } from "./retention";

/** The same day `months` calendar months earlier, or the last day of that
 * month when it is shorter. */
export function monthsBefore(day: string, months: number) {
  const [year, month, date] = day.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const index = year * 12 + (month - 1) - months;
  const y = Math.floor(index / 12),
    m = (index % 12) + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(y, 4)}-${pad(m)}-${pad(Math.min(date, last))}`;
}

/** Compact rows last listed before this day expire. Normally that is
 * `storage.compactMonths` ago. Over the storage cap it moves to a week past
 * the oldest compact row, so the oldest days go first, but never into the
 * window of full records that `prune` keeps. */
async function horizon(
  env: AppEnv,
  now: Date,
  { overCap = false, notAfter }: ExpiryOptions,
) {
  const settings = storage(env);
  const today = userDay(env, now);
  const normal = monthsBefore(today, settings.compactMonths);
  const earlier = (day: string) =>
    notAfter && notAfter < day ? notAfter : day;
  if (!overCap) return { settings, before: earlier(normal) };
  const window = shiftDay(today, Math.min(0, 1 - settings.fullDays));
  const { oldestDay } = await expiryPreview(env.DB!, window);
  const week = oldestDay ? shiftDay(oldestDay, 7) : normal;
  const later = week > normal ? week : normal;
  return { settings, before: earlier(later < window ? later : window) };
}
type ExpiryOptions = { overCap?: boolean; notAfter?: string };

export async function expiryStatus(
  env: AppEnv,
  now: Date,
  options: ExpiryOptions = {},
) {
  const { settings, before } = await horizon(env, now, options);
  return {
    enabled: settings.prune,
    before,
    ...(await expiryPreview(env.DB!, before)),
  };
}

/** Rows of a page that fit the budget, oldest first. */
function fitting(rows: readonly ExpiryRow[], available: number) {
  let bound = 0,
    count = 0;
  for (const row of rows) {
    if (bound + row.bound > available) break;
    bound += row.bound;
    count++;
  }
  return { selected: rows.slice(0, count), bound };
}

/** Expire one page of compact rows, charged to the day's pruning cap and
 * leaving the crawl's reserve. */
export async function expiryBatch(
  env: AppEnv,
  now: Date,
  options: ExpiryOptions = {},
) {
  const db = env.DB!;
  const { settings, before } = await horizon(env, now, options);
  const idle = {
    enabled: settings.prune,
    before,
    expired: 0,
    rowsWritten: 0,
    waiting: 0,
    more: false,
  };
  if (!settings.prune) return idle;
  const day = now.toISOString().slice(0, 10);
  const [usage, charged, { rows }] = await Promise.all([
    writeBudgetUsage(db, day),
    pruneBudgetUsage(db, day),
    expiryPage(db, before, expiryPageSize),
  ]);
  const available = Math.max(
    0,
    Math.min(
      settings.pruneRowsPerDay - charged,
      usage.limit - usage.used - usage.reserved - crawlReserve - 4,
    ),
  );
  const { selected, bound } = fitting(rows, available);
  const page = {
    ...idle,
    waiting: rows.length - selected.length,
    more: rows.length === expiryPageSize,
  };
  if (!selected.length) return page;
  const lease = await reserveWriteBudget(db, bound, now, bound, {
    headroom: crawlReserve,
    pruneCap: settings.pruneRowsPerDay,
  });
  if (!lease) return { ...page, waiting: rows.length };
  try {
    const run = await expirePage(db, before, selected, { lease });
    const budgetRows = await settleWriteBudget(db, lease, run.rowsWritten);
    return {
      ...page,
      expired: run.expired,
      rowsWritten: run.rowsWritten + budgetRows,
    };
  } catch (error) {
    await settleWriteBudget(db, lease, 0, true);
    throw error;
  }
}
