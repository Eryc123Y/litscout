import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  nextReset,
  outstandingSettlementSql,
  writeBudgetLimitSql,
  WRITE_LIMIT,
} from "@litscout/db/write-budget";
import type { CliDeps } from "./commands";
import { UsageError } from "./command-types";

const historyTable = `CREATE TABLE IF NOT EXISTS d1_migrations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;
const usageTable = `CREATE TABLE IF NOT EXISTS migration_write_usage(
  name TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  rows_written INTEGER NOT NULL
) WITHOUT ROWID`;
const largeRebuild = 50_000;
const budgetAccuracyMigration = "0018_budget_accuracy.sql";
// Allow for creating the ledger tables on first use, the Wrangler history
// row and its index, and both precharge and settlement updates.
const bookkeeping = 12;
const nonnegative = z.number().int().nonnegative();
const sqlFile = z.string().regex(/^\d+_[a-z0-9_]+\.sql$/);
const costManifest = z.record(
  sqlFile,
  z.strictObject({
    fixed: nonnegative,
    rebuild: z.boolean().optional(),
    counts: z
      .array(
        z.strictObject({
          table: z.string().regex(/^[a-z][a-z0-9_]*$/),
          writes: nonnegative,
          where: z.string().optional(),
          count: z.string().optional(),
        }),
      )
      .optional(),
  }),
);
const wranglerResult = z
  .array(
    z.object({
      success: z.boolean().optional(),
      results: z.array(z.record(z.string(), z.unknown())),
      meta: z.object({ rows_written: nonnegative.optional() }).optional(),
    }),
  )
  .nonempty();

export function executeD1(
  deps: CliDeps,
  database: string,
  sql: string,
  config?: string,
) {
  return deps
    .run([
      "d1",
      "execute",
      database,
      "--remote",
      ...(config ? ["--config", config] : []),
      "--command",
      sql,
      "--json",
    ])
    .then((raw) => {
      const results = wranglerResult.parse(JSON.parse(raw));
      if (results.some((result) => result.success === false))
        throw new Error("D1 did not execute the command");
      return results;
    });
}
type Cost = z.infer<typeof costManifest>[string];
function countQuery(rule: NonNullable<Cost["counts"]>[number]) {
  return `SELECT ${rule.count ?? "count(*)"} FROM ${rule.table}${rule.where ? " WHERE " + rule.where : ""}`;
}
function usedRows(
  day: string,
  daily: boolean,
  leases: boolean,
  budgetAccuracy: boolean,
) {
  if (!daily)
    return `coalesce((SELECT sum(rows_written) FROM migration_write_usage WHERE day='${day}'),0)`;
  const held = budgetAccuracy
    ? `+${outstandingSettlementSql}`
    : leases
      ? `+2*(SELECT count(*) FROM write_leases WHERE day='${day}')`
      : "";
  return `coalesce((SELECT rows_written+reserved${held} FROM daily_write_usage WHERE day='${day}'),0)`;
}
function migrationLimit(day: string, budgetAccuracy: boolean) {
  return budgetAccuracy
    ? `coalesce((SELECT ${writeBudgetLimitSql()} FROM daily_write_usage WHERE day='${day}'),${WRITE_LIMIT})`
    : String(WRITE_LIMIT);
}
export async function migrationPlan(
  deps: CliDeps,
  databaseId: string | undefined,
) {
  const dir = path.join(path.dirname(deps.bundlePath), "migrations");
  const files = (await readdir(dir))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const costs = costManifest.parse(
    JSON.parse(await readFile(path.join(dir, "costs.json"), "utf8")),
  );
  if (
    files.length !== Object.keys(costs).length ||
    files.some((file) => !Object.hasOwn(costs, file))
  )
    throw new UsageError(
      "The bundled migration cost manifest must cover every migration.",
    );
  const day = new Date().toISOString().slice(0, 10);
  const read = async (sql: string) =>
    databaseId
      ? (await executeD1(deps, databaseId, sql)).flatMap(
          (result) => result.results,
        )
      : [];
  const tables = new Set(
    (await read("SELECT name FROM sqlite_schema WHERE type='table'")).map(
      (row) => String(row.name),
    ),
  );
  const applied = new Set(
    tables.has("d1_migrations")
      ? (await read("SELECT name FROM d1_migrations")).map((row) =>
          String(row.name),
        )
      : [],
  );
  const pending = files.filter((file) => !applied.has(file));
  const queries = [
    ...new Set(
      pending.flatMap((file) =>
        (costs[file]!.counts ?? [])
          .filter((rule) => tables.has(rule.table))
          .map(countQuery),
      ),
    ),
  ];
  const daily = tables.has("daily_write_usage");
  const leases = tables.has("write_leases");
  const budgetAccuracy = applied.has(budgetAccuracyMigration);
  const usage =
    daily || tables.has("migration_write_usage")
      ? usedRows(day, daily, leases, budgetAccuracy)
      : "0";
  const [row] = await read(
    `SELECT ${usage} AS used, ${migrationLimit(day, budgetAccuracy)} AS cap${queries.map((query, i) => `, (${query}) AS c${i}`).join("")}`,
  );
  if (databaseId && !row) throw new Error("D1 did not return migration counts");
  const counts = new Map(
    queries.map((query, i) => [query, nonnegative.parse(row?.["c" + i])]),
  );
  const remaining = Math.max(
    0,
    databaseId
      ? nonnegative.parse(row?.cap) - nonnegative.parse(row?.used)
      : WRITE_LIMIT,
  );
  const migrations = pending.map((name) => ({
    name,
    estimatedRows:
      costs[name]!.fixed +
      (costs[name]!.counts ?? []).reduce(
        (sum, rule) => sum + rule.writes * (counts.get(countQuery(rule)) ?? 0),
        0,
      ),
  }));
  return {
    dir,
    costs,
    migrations,
    day,
    daily,
    leases,
    budgetAccuracy,
    remaining,
    resetAt: nextReset(day),
  };
}
type Plan = Awaited<ReturnType<typeof migrationPlan>>;

export function migrationMessages(plan: Plan, allowOverBudget: boolean) {
  const needed = plan.migrations.reduce(
    (sum, item) => sum + item.estimatedRows + bookkeeping,
    0,
  );
  return [
    ...(plan.migrations.length
      ? plan.migrations.map(
          ({ name, estimatedRows }) =>
            `${name}: ${estimatedRows} estimated rows written`,
        )
      : ["No pending D1 migrations."]),
    `Migrations need ${needed} writes including bookkeeping. ${plan.remaining} remain today. UTC reset: ${plan.resetAt}.`,
    ...plan.migrations.flatMap(({ name, estimatedRows }) => {
      if (!plan.costs[name]!.rebuild || estimatedRows <= largeRebuild)
        return [];
      const required = estimatedRows + bookkeeping;
      const count = Math.ceil(required / plan.remaining);
      const days = plan.remaining
        ? `needs ${count} ${count === 1 ? "day" : "days"} of writes at current headroom`
        : "cannot start with zero headroom";
      const advice =
        required <= plan.remaining
          ? ""
          : required > WRITE_LIMIT
            ? "A daily reset alone cannot fit this rebuild. Arrange a quota that can fit the whole copy before proceeding."
            : "Wait until there is enough room for the whole copy.";
      return [
        `${name} ${days}. Table rebuilds run in one transaction.${advice ? " " + advice : ""}`,
      ];
    }),
    ...(needed > plan.remaining
      ? [
          allowOverBudget
            ? "--allow-over-budget overrides LitScout’s cap. Cloudflare’s quota still applies."
            : "Deploy right after the UTC reset if the migration will fit. Use --allow-over-budget only if your Cloudflare quota can cover the writes.",
        ]
      : []),
  ];
}

export function checkMigrationBudget(plan: Plan, allowOverBudget: boolean) {
  const needed = plan.migrations.reduce(
    (sum, item) => sum + item.estimatedRows + bookkeeping,
    0,
  );
  if (!allowOverBudget && needed > plan.remaining)
    throw new UsageError(
      [
        "Deployment exceeds the daily write budget.",
        ...migrationMessages(plan, false),
      ].join("\n"),
    );
}

export async function applyMigrations(
  deps: CliDeps,
  database: string,
  plan: Plan,
  allowOverBudget: boolean,
  config: string,
) {
  let { daily, leases, budgetAccuracy } = plan;
  const { day } = plan;
  for (const { name, estimatedRows } of plan.migrations) {
    const estimate = estimatedRows + bookkeeping;
    const dailyAfter = daily || name === "0004_write_budget.sql";
    const budgetAccuracyAfter =
      budgetAccuracy || name === budgetAccuracyMigration;
    const cost = plan.costs[name]!;
    const current = [
      cost.fixed,
      ...(cost.counts ?? []).map(
        (rule) => `${rule.writes}*(${countQuery(rule)})`,
      ),
    ].join("+");
    const guard = [
      `date('now')='${day}'`,
      `NOT EXISTS(SELECT 1 FROM d1_migrations WHERE name='${name}')`,
      `(${current})<=${estimatedRows}`,
      ...(allowOverBudget
        ? []
        : [
            `(${usedRows(day, daily, leases, budgetAccuracy)})+${estimate}<=${migrationLimit(day, budgetAccuracy)}`,
          ]),
    ].join(" AND ");
    const migration = await readFile(path.join(plan.dir, name), "utf8");
    // Use Wrangler's history format. Precharge, schema changes and the applied marker
    // are one D1 transaction. An ambiguous response leaves the conservative charge intact.
    const batch = [
      historyTable + ";",
      usageTable + ";",
      `SELECT CASE WHEN ${guard} THEN 1 ELSE json('migration plan changed') END;`,
      `INSERT INTO migration_write_usage(name,day,rows_written) VALUES ('${name}','${day}',${estimate});`,
      ...(daily
        ? [
            `INSERT INTO daily_write_usage(day,rows_written) VALUES ('${day}',${estimate})
        ON CONFLICT(day) DO UPDATE SET rows_written=rows_written+excluded.rows_written;`,
          ]
        : []),
      migration,
      `INSERT INTO d1_migrations(name) VALUES ('${name}');`,
      ...(!daily && dailyAfter
        ? [
            `INSERT INTO daily_write_usage(day,rows_written)
        SELECT day,sum(rows_written) FROM migration_write_usage WHERE day='${day}' GROUP BY day;`,
          ]
        : []),
    ].join("\n");
    const results = await executeD1(deps, database, batch, config).catch(() => {
      throw new UsageError(
        `Migration ${name} did not confirm. Rerun deploy to check its status, current counts and write budget.`,
      );
    });
    // Use the estimate unless metadata covers every result (including a single aggregate result).
    const actual = results.every(
      (result) => result.meta?.rows_written !== undefined,
    )
      ? results.reduce((sum, result) => sum + result.meta!.rows_written!, 0) +
        (dailyAfter ? 2 : 1)
      : estimate;
    if (actual !== estimate) {
      await executeD1(
        deps,
        database,
        [
          ...(dailyAfter
            ? [
                `UPDATE daily_write_usage SET rows_written=rows_written+${actual}-
          (SELECT rows_written FROM migration_write_usage WHERE name='${name}')${
            budgetAccuracyAfter
              ? `, estimate_overrun=estimate_overrun+${Math.max(0, actual - estimate)}`
              : ""
          } WHERE day='${day}';`,
              ]
            : []),
          `UPDATE migration_write_usage SET rows_written=${actual} WHERE name='${name}';`,
        ].join("\n"),
        config,
      ).catch(() => {
        throw new UsageError(
          `Migration ${name} applied, but Wrangler did not confirm the accounting update. Rerun deploy to continue.`,
        );
      });
    }
    deps.print(`${name}: ${actual} writes charged including bookkeeping.`);
    daily = dailyAfter;
    leases ||= name === "0005_write_leases.sql";
    budgetAccuracy = budgetAccuracyAfter;
  }
}
