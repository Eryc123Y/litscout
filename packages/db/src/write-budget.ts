import { z } from "zod";
import type { IngestDatabase } from "./ingest-store";
/** The Cloudflare D1 Free plan allows 100,000 rows written a day. */
export const WRITE_LIMIT = 80000;
/** The highest limit an instance may set (an own server's SQLite file). */
export const MAX_WRITE_LIMIT = 10_000_000;
const SAFETY_MARGIN = 5000;
const writeLimitInput = z.coerce
  .number()
  .int()
  .min(4 * SAFETY_MARGIN)
  .max(MAX_WRITE_LIMIT);
let instanceLimit = WRITE_LIMIT;
/**
 * The instance's daily write limit, from the Worker's `WRITE_LIMIT` setting.
 * An instance has one setting, so the Worker sets it on every request; a
 * missing or invalid value keeps the free-plan limit.
 */
export function configureWriteLimit(value: unknown) {
  const parsed =
    typeof value === "string" && value.trim()
      ? writeLimitInput.safeParse(value)
      : undefined;
  instanceLimit = parsed?.success ? parsed.data : WRITE_LIMIT;
}
export const writeLimit = () => instanceLimit;
export const writeBudgetLimitSql =
  () => `CASE WHEN unaccounted>0 OR estimate_overrun>0
  THEN ${instanceLimit - SAFETY_MARGIN} ELSE ${instanceLimit} END`;
export type WriteLease = {
  id: string;
  day: string;
  reservation: number;
  estimate: number;
  rowsWritten: number;
};
const dayInput = z.iso.date();
const reservationInput = {
  parse: (value: unknown) =>
    z.number().int().min(0).max(instanceLimit).parse(value),
};
const rowInput = z.number().int().nonnegative();
const leaseDurationMinutes = 10;
const refundWindowMinutes = 60;
const leaseRetentionMinutes = 2 * 24 * 60;
const cutoffSql = (now: string, minutes: number) =>
  `strftime('%Y-%m-%dT%H:%M:%fZ',${now},'-${minutes} minutes')`;
const refundableLeaseSql = (now: string) =>
  `created_at>${cutoffSql(now, leaseDurationMinutes + refundWindowMinutes)}`;
export const outstandingSettlementSql = `2 * (SELECT count(*) FROM write_leases
  WHERE day=daily_write_usage.day AND expired=0)`;
export const nextReset = (day: string) =>
  new Date(Date.parse(day) + 86400000).toISOString();

export type WriteBudgetUsage = {
  used: number;
  reserved: number;
  unaccounted: number;
  estimateOverrun: number;
  limit: number;
  baseLimit: number;
};

export function writeBudgetUsageQuery(db: IngestDatabase, day: string) {
  dayInput.parse(day);
  return db
    .prepare(
      `SELECT coalesce(rows_written,0) AS used,
      coalesce(reserved,0)+${outstandingSettlementSql} AS reserved,
      coalesce(unaccounted,0) AS unaccounted,
      coalesce(estimate_overrun,0) AS estimateOverrun,
      ${writeBudgetLimitSql()} AS "limit", ${instanceLimit} AS baseLimit
    FROM (SELECT ? AS day) AS target
    LEFT JOIN daily_write_usage ON daily_write_usage.day=target.day`,
    )
    .bind(day);
}

export async function writeBudgetUsage(db: IngestDatabase, day: string) {
  return (await writeBudgetUsageQuery(db, day).first<WriteBudgetUsage>())!;
}

export async function pruneBudgetUsage(db: IngestDatabase, day: string) {
  return (
    (await db
      .prepare("SELECT prune_charged FROM daily_write_usage WHERE day=?")
      .bind(day)
      .first<number>("prune_charged")) ?? 0
  );
}

/** Recover abandoned leases before considering a sample against the final ledger. */
export function reconcileWriteBudgetSql(
  day: string,
  reported: number,
  recoveryTime = new Date(),
) {
  dayInput.parse(day);
  rowInput.parse(reported);
  const now = "'now'";
  // A sample can include any part of a reservation, even across midnight.
  const pendingLeases = `EXISTS (SELECT 1 FROM write_leases
    WHERE expired=0 OR ${refundableLeaseSql(now)})`;
  // Use one timestamp for all recovery statements so they charge exactly
  // the leases they mark and prune, even if a cutoff passes during the batch.
  const recovery = releaseStaleLeaseSql(`'${recoveryTime.toISOString()}'`);
  return `${recovery.join(";\n")};
    INSERT INTO daily_write_usage(day,rows_written,unaccounted)
    SELECT '${day}',${reported}+1,${reported} WHERE ${reported}>0 AND date('now')='${day}'
      AND NOT ${pendingLeases}
    ON CONFLICT(day) DO UPDATE SET
      unaccounted=unaccounted+excluded.unaccounted-rows_written,
      rows_written=excluded.rows_written
    WHERE excluded.unaccounted>rows_written;
    SELECT date('now') AS day, ${pendingLeases} AS pendingLeases;`;
}

export async function migrationWriteUsage(db: IngestDatabase, day: string) {
  dayInput.parse(day);
  const installed = await db
    .prepare(
      "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='migration_write_usage'",
    )
    .first();
  if (!installed) return 0;
  return (
    (await db
      .prepare(
        "SELECT sum(rows_written) AS written FROM migration_write_usage WHERE day=?",
      )
      .bind(day)
      .first<number>("written")) ?? 0
  );
}
function releaseStaleLeaseSql(now: string) {
  const day = `date(${now})`;
  const cutoff = cutoffSql(now, leaseDurationMinutes);
  const pruneBefore = cutoffSql(now, leaseRetentionMinutes);
  // Prune batches check the database's UTC day before any business writes,
  // so stale prune work can only have been charged to its original day.
  return [
    `WITH stale AS (
          SELECT day, sum(reserved) AS held, count(*) AS leases,
            sum(CASE WHEN day=${day} OR id NOT GLOB 'prune:*' THEN reserved ELSE 0 END) AS expiry_held
          FROM write_leases WHERE expired=0 AND created_at<${cutoff} GROUP BY day
        ), totals AS (
          SELECT coalesce(sum(expiry_held),0) AS held,
            coalesce(sum(held) FILTER (WHERE day=${day}),0) AS held_today,
            coalesce(sum(leases),0) AS expired,
            count(*) FILTER (WHERE day<>${day}) AS old_days,
            (SELECT count(*) FROM write_leases WHERE created_at<${pruneBefore}) AS pruned
          FROM stale
        )
        INSERT INTO daily_write_usage(day,rows_written,reserved)
          SELECT day,held,-held FROM stale WHERE day<>${day}
          UNION ALL
          SELECT ${day},held+expired+old_days+1+pruned,-held_today
            FROM totals WHERE expired+pruned>0
        ON CONFLICT(day) DO UPDATE SET
          rows_written=rows_written+excluded.rows_written,
          reserved=max(0,reserved+excluded.reserved)`,
    `UPDATE write_leases SET expired=1, expiry_day=${day}
        WHERE expired=0 AND created_at<${cutoff}`,
    `DELETE FROM write_leases WHERE expired=1 AND created_at<${pruneBefore}`,
  ];
}

/** Charge, mark and prune leases in one D1 transaction. */
export async function releaseStaleLeases(db: IngestDatabase, now = new Date()) {
  const time = now.toISOString();
  const results = await db.batch(
    releaseStaleLeaseSql("?1").map((sql) => db.prepare(sql).bind(time)),
  );
  return {
    released: results[1]!.meta.changes,
    rowsWritten: results.reduce((n, r) => n + r.meta.rows_written, 0),
  };
}
export async function reserveWriteBudget(
  db: IngestDatabase,
  reservation: number,
  now = new Date(),
  estimate = reservation,
  { headroom = 0, pruneCap }: { headroom?: number; pruneCap?: number } = {},
): Promise<WriteLease | null> {
  reservationInput.parse(reservation);
  rowInput.parse(estimate);
  reservationInput.parse(headroom);
  if (pruneCap !== undefined) rowInput.parse(pruneCap);
  if (
    pruneCap !== undefined &&
    !(await db
      .prepare("SELECT 1 WHERE date('now')=?")
      .bind(now.toISOString().slice(0, 10))
      .first())
  )
    return null;
  await releaseStaleLeases(db, now);
  const day = now.toISOString().slice(0, 10),
    id =
      (pruneCap === undefined ? "" : "prune:" + day + ":") +
      crypto.randomUUID();
  const result = await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO daily_write_usage(day,rows_written,reserved) VALUES (?,1,0)",
      )
      .bind(day),
    db
      .prepare(
        `INSERT INTO write_leases(id,day,reserved,estimate,created_at)
      SELECT ?,day,?,?,? FROM daily_write_usage WHERE day=?
        AND rows_written+reserved+${outstandingSettlementSql}+?+4<=(${writeBudgetLimitSql()})-?
        ${
          pruneCap === undefined
            ? ""
            : `AND day=date('now') AND prune_charged+?<=?`
        }`,
      )
      .bind(
        id,
        reservation,
        estimate,
        now.toISOString(),
        day,
        reservation,
        headroom,
        ...(pruneCap === undefined ? [] : [reservation, pruneCap]),
      ),
    db
      .prepare(
        `UPDATE daily_write_usage SET rows_written=rows_written+2,reserved=reserved+?
        ${pruneCap === undefined ? "" : ",prune_charged=prune_charged+?"}
        WHERE day=? AND EXISTS(SELECT 1 FROM write_leases WHERE id=?)`,
      )
      .bind(
        reservation,
        ...(pruneCap === undefined ? [] : [reservation]),
        day,
        id,
      ),
  ]);
  return result[1]!.meta.changes
    ? {
        id,
        day,
        reservation,
        estimate,
        rowsWritten: result.reduce((n, r) => n + r.meta.rows_written, 0),
      }
    : null;
}
export async function settleWriteBudget(
  db: IngestDatabase,
  lease: WriteLease,
  actual: number,
  uncertain = false,
  { now, rowsBeforeMidnight }: { now?: Date; rowsBeforeMidnight?: number } = {},
) {
  rowInput.parse(actual);
  const time = now?.toISOString();
  const day = (time ?? new Date().toISOString()).slice(0, 10);
  const prune = lease.id.startsWith("prune:");
  const beforeMidnight =
    day !== lease.day && prune
      ? uncertain
        ? lease.reservation
        : actual
      : uncertain || day === lease.day || rowsBeforeMidnight === undefined
        ? null
        : rowInput.max(actual).parse(rowsBeforeMidnight);
  const pruneAdjustment =
    prune && !uncertain
      ? actual +
        lease.rowsWritten +
        2 +
        Number(day !== lease.day) -
        lease.reservation
      : 0;
  // A certain result replaces any provisional expiry-day charge. Keep the
  // original day's charge when there is no measured split across midnight.
  const result = await db.batch([
    db
      .prepare(
        `WITH lease AS (
          SELECT *, ? AS settled_day, ? AS actual, ? AS uncertain, ? AS before_midnight
          FROM write_leases WHERE id=? AND day=?
            AND ${refundableLeaseSql("?")}
        ), past_charges AS (
          SELECT day, coalesce(before_midnight,reserved) - CASE WHEN expired=1 THEN reserved ELSE 0 END AS written,
            CASE WHEN expired=0 THEN -reserved ELSE 0 END AS held
            ${prune ? ", ? AS prune_adjustment" : ""}
          FROM lease WHERE day<>settled_day AND (expired=0 OR before_midnight IS NOT NULL)
          UNION ALL
          SELECT expiry_day,-reserved,0${prune ? ",0" : ""} FROM lease
          WHERE expiry_day<>day AND expiry_day<>settled_day AND uncertain=0 AND id NOT GLOB 'prune:*'
        )
        INSERT INTO daily_write_usage(day,rows_written,reserved,estimate_overrun${prune ? ",prune_charged" : ""})
          SELECT day,written,held,0${prune ? ",prune_adjustment" : ""} FROM past_charges
          UNION ALL
          SELECT settled_day,
            max(actual-coalesce(before_midnight,0),
                CASE WHEN uncertain=1 AND before_midnight IS NULL THEN reserved ELSE 0 END)
              - CASE WHEN expired=1 AND (day=settled_day OR (expiry_day=settled_day AND id NOT GLOB 'prune:*')) THEN reserved ELSE 0 END
              + 2 + (SELECT count(*) FROM past_charges),
            CASE WHEN expired=0 AND day=settled_day THEN -reserved ELSE 0 END,
            max(0,actual-estimate)
            ${prune ? ",CASE WHEN day=settled_day THEN ? ELSE 0 END" : ""}
          FROM lease WHERE true
        ON CONFLICT(day) DO UPDATE SET
          rows_written=max(0,rows_written+excluded.rows_written),
          reserved=max(0,reserved+excluded.reserved),
          estimate_overrun=estimate_overrun+excluded.estimate_overrun
          ${prune ? ",prune_charged=max(0,prune_charged+excluded.prune_charged)" : ""}`,
      )
      .bind(
        day,
        actual,
        Number(uncertain),
        beforeMidnight,
        lease.id,
        lease.day,
        // Check the deadline against D1's clock, like reconciliation.
        time ?? "now",
        ...(prune ? [pruneAdjustment, pruneAdjustment] : []),
      ),
    // Use the ledger update's result so expiry cannot intervene between statements.
    db
      .prepare("DELETE FROM write_leases WHERE id=? AND day=? AND changes()>0")
      .bind(lease.id, lease.day),
  ]);
  return (
    (result[1]!.meta.changes ? lease.rowsWritten : 0) +
    result.reduce((n, r) => n + r.meta.rows_written, 0)
  );
}
