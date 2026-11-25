import path from "node:path";
import { z } from "zod";
import { reconcileWriteBudgetSql } from "@litscout/db/write-budget";
import type { SetupDeps } from "./command-types";
import { nowFor } from "./flow-runtime";
import { executeD1 } from "./migration-deploy";

const infoSchema = z.object({
  uuid: z.uuid().optional().catch(undefined),
  database_size: z.number().nonnegative().optional(),
  rows_read_24h: z.number().nonnegative().optional(),
  rows_written_24h: z.number().nonnegative().optional(),
});
const analyticsSchema = z.object({
  errors: z.array(z.unknown()).max(0).nullish(),
  data: z.object({
    viewer: z.object({
      accounts: z.tuple([
        z.object({
          d1AnalyticsAdaptiveGroups: z.array(
            z.object({
              sum: z.object({ rowsWritten: z.number().nonnegative() }),
            }),
          ),
        }),
      ]),
    }),
  }),
});
// Match the D1 metrics dataset and filter used by Wrangler 4.151.0.
const analyticsQuery = `query BudgetWrites($accountTag: string, $filter: ZoneWorkersRequestsFilter_InputObject) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      d1AnalyticsAdaptiveGroups(limit: 10000, filter: $filter) {
        dimensions { datetimeHour }
        sum { rowsWritten }
      }
    }
  }
}`;

const configFile = (deps: SetupDeps) => path.join(deps.dir, "wrangler.jsonc");

export async function databaseUsage(deps: SetupDeps, name: string) {
  try {
    return infoSchema.parse(
      JSON.parse(
        await deps.run([
          "d1",
          "info",
          `${name}-db`,
          "--json",
          "--config",
          configFile(deps),
        ]),
      ),
    );
  } catch {
    return null;
  }
}
type DatabaseUsage = Awaited<ReturnType<typeof databaseUsage>>;

async function reportedRows(
  deps: SetupDeps,
  databaseId: string,
  accountTag: string,
  token: string,
  sampledAt: string,
) {
  const response = await deps.fetch(
    "https://api.cloudflare.com/client/v4/graphql",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: analyticsQuery,
        variables: {
          accountTag,
          filter: {
            AND: [
              {
                datetimeHour_geq: sampledAt.slice(0, 10) + "T00:00:00.000Z",
                datetimeHour_leq: sampledAt,
                databaseId,
              },
            ],
          },
        },
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) throw new Error("D1 Analytics unavailable");
  const [account] = analyticsSchema.parse(await response.json()).data.viewer
    .accounts;
  const rows = account.d1AnalyticsAdaptiveGroups.reduce(
    (total, group) => total + group.sum.rowsWritten,
    0,
  );
  return z.number().int().nonnegative().parse(Math.ceil(rows));
}

export type BudgetReconciliation = {
  status: "unavailable" | "rolling-only" | "reconciled" | "deferred";
  day?: string;
  reportedRows?: number;
  rollingRows?: number;
  warnings: string[];
};

export async function reconcileBudget(
  deps: SetupDeps,
  info: DatabaseUsage,
): Promise<BudgetReconciliation> {
  const env = deps.env ?? process.env;
  const account = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = env.CLOUDFLARE_API_TOKEN?.trim();
  const databaseId = info?.uuid;
  const rollingRows = info?.rows_written_24h;
  const rollingWarning =
    rollingRows === undefined
      ? []
      : [
          `Wrangler reports ${rollingRows} D1 writes over a rolling 24 hours. The ledger requires a UTC-day total.`,
        ];
  if (!databaseId || !account || !token)
    return {
      status: rollingRows === undefined ? "unavailable" : "rolling-only",
      rollingRows,
      warnings: [
        ...rollingWarning,
        "UTC-day reconciliation requires D1 Analytics access and the deployed database ID from Wrangler.",
      ],
    };
  const sampledAt = nowFor(deps).toISOString();
  const day = sampledAt.slice(0, 10);
  let reported: number;
  try {
    reported = await reportedRows(deps, databaseId, account, token, sampledAt);
  } catch {
    return {
      status: rollingRows === undefined ? "unavailable" : "rolling-only",
      rollingRows,
      warnings: [
        ...rollingWarning,
        "Cloudflare D1 Analytics did not return a UTC-day total.",
      ],
    };
  }
  try {
    const results = await executeD1(
      deps,
      databaseId,
      reconcileWriteBudgetSql(day, reported, nowFor(deps)),
      configFile(deps),
    );
    const ledger = results.at(-1)?.results[0];
    if (!ledger || (ledger.pendingLeases !== 0 && ledger.pendingLeases !== 1))
      throw new Error("D1 did not return the reconciliation state");
    if (ledger.day !== day)
      return {
        status: "unavailable",
        warnings: [
          "D1's UTC day changed during reconciliation. Run reconciliation again.",
        ],
      };
    if (ledger.pendingLeases === 1)
      return {
        status: "deferred",
        day,
        reportedRows: reported,
        warnings: [
          "UTC-day reconciliation deferred while active write leases remain or expired leases are still in their refund window. Retry after they settle or the window closes.",
        ],
      };
    return { status: "reconciled", day, reportedRows: reported, warnings: [] };
  } catch {
    return {
      status: "unavailable",
      warnings: [
        ...rollingWarning,
        "D1 did not confirm the reconciliation. Check Wrangler access and deploy the current migrations before retrying.",
      ],
    };
  }
}
