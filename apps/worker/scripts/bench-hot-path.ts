import { performance } from "node:perf_hooks";
import { app } from "../src/app";
import type { AppEnv } from "../src/env";
import { readFixture, fakeReadD1, benchDay } from "./bench-read";

export const benchmarkToken = "lsk_" + "B".repeat(52);
const context = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;
/** Prepared result sets only. No SQL execution, network, remote DO or agent. */
export function hotBindings(due = false) {
  const rows = readFixture(),
    base = fakeReadD1(rows),
    statements = new WeakMap<object, string>();
  const days = Array.from({ length: 100 }, (_, i) => ({
    day: new Date(Date.parse(benchDay) - i * 86400000)
      .toISOString()
      .slice(0, 10),
    status: "summarised",
    counts: '{"arxiv":372}',
    crawled_at: benchDay + "T00:00:00Z",
    rev: 1,
  }));
  const stats = { tokenLookups: 0, limiterCalls: 0, batches: 0 };
  const result = (results: unknown[] = [], changes = 0) => ({
    success: true,
    results,
    meta: {
      changes,
      rows_written: changes,
      rows_read: results.length,
      duration: 0,
      last_row_id: 0,
      changed_db: false,
      size_after: 0,
    },
  });
  const db = {
    prepare(sql: string) {
      let params: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          params = values;
          return statement;
        },
        async all() {
          if (sql.includes("FROM api_tokens")) {
            stats.tokenLookups++;
            return result([
              {
                id: "tok_bench",
                name: "synthetic",
                hash: "synthetic",
                scopes: '["read","ingest"]',
                last_used_at: due ? null : new Date().toISOString(),
                revoked_at: null,
                expires_at: null,
              },
            ]);
          }
          if (sql.includes("FROM feed_days") && sql.includes("ORDER BY"))
            return result(
              days
                .filter(
                  (d) => !sql.includes("day <") || d.day < String(params[0]),
                )
                .slice(0, Number(params.at(-1)))
                .map((d) =>
                  sql.includes("SELECT day,status")
                    ? { day: d.day, status: d.status }
                    : d,
                ),
            );
          if (sql.includes("feed_read_counts") && sql.includes("day IN"))
            return result(
              sql.includes("AS total")
                ? days.map((d) => ({ day: d.day, total: 372 }))
                : days.flatMap((d) => [
                    { day: d.day, kind: "total", key: "", n: 372 },
                    { day: d.day, kind: "sources", key: "arxiv", n: 372 },
                  ]),
            );
          if (sql.includes("LIMIT ?")) {
            const offset = sql.includes("(f.rank_sort,f.paper_id,f.source)>")
              ? Number(params.at(-4)) + 1
              : 0;
            const response = await base
              .prepare(sql)
              .bind(...params.slice(0, -1), offset + Number(params.at(-1)))
              .all();
            return result(response.results.slice(offset));
          }
          return base
            .prepare(sql)
            .bind(...params)
            .all();
        },
        async first() {
          if (sql.includes("SELECT paper_id FROM paper_ids"))
            return { paper_id: rows[0]!.id };
          if (sql.includes("rows_written AS used"))
            return { used: 0, reserved: 0 };
          return base
            .prepare(sql)
            .bind(...params)
            .first();
        },
        async run() {
          return result([], 1);
        },
      };
      statements.set(statement, sql);
      return statement;
    },
    async batch(batch: object[]) {
      stats.batches++;
      return batch.map((statement) => {
        const sql = statements.get(statement) ?? "";
        const noop =
          sql.includes("created_at<?") ||
          sql.startsWith("INSERT OR IGNORE INTO daily_write_usage");
        return result([], noop ? 0 : 1);
      });
    },
  } as unknown as D1Database;
  const env = {
    DB: db,
    PUBLIC_FEED: "true",
    PAIRING_STORE: {
      idFromName: (name: string) => name,
      get: () => ({
        allowRequest: async () => {
          stats.limiterCalls++;
          return { allowed: true };
        },
      }),
    },
  } as unknown as AppEnv;
  return { env, stats };
}
export const hotRequest = (path: string) =>
  new Request(`https://bench.example/api/v1${path}`, {
    headers: {
      authorization: `Bearer ${benchmarkToken}`,
      "CF-Connecting-IP": "192.0.2.42",
    },
  });
async function cursor(isPublic: boolean, full = false, todo = false) {
  const values = [
    benchDay,
    isPublic,
    todo,
    full,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    todo ? "en" : null,
  ];
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(values)),
  );
  const context = Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return btoa(
    JSON.stringify({
      v: 1,
      context,
      rank: 49,
      id: "pap_00049",
      source: "arxiv",
    }),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
export async function benchHotPath(iterations = 100) {
  const cases = [
    { path: `/public/days/${benchDay}` },
    { path: `/public/days/${benchDay}?cursor=${await cursor(true)}` },
    { path: "/feed/days?limit=100" },
    { path: `/feed/days/${benchDay}/full` },
    { path: `/feed/days/${benchDay}/full?cursor=${await cursor(false, true)}` },
    { path: `/feed/days/${benchDay}/summary-todo?lang=en` },
    { path: `/public/papers/arxiv:2611.18340` },
    { path: `/feed/days/${benchDay}/full`, due: true },
  ];
  const results = [];
  for (const item of cases) {
    const binding = hotBindings(item.due),
      times: number[] = [];
    let firstMs = 0,
      bytes = 0;
    for (let i = 0; i < iterations + 21; i++) {
      const request = hotRequest(item.path),
        start = performance.now();
      const response = await app.fetch(request, binding.env, context);
      const body = await response.text();
      bytes = body.length;
      if (response.status !== 200)
        throw new Error(`${item.path}: ${response.status} ${body}`);
      const elapsed = performance.now() - start;
      if (i === 0) firstMs = elapsed;
      else if (i > 20) times.push(elapsed);
    }
    times.sort((a, b) => a - b);
    results.push({
      ...item,
      bytes,
      firstMs: Number(firstMs.toFixed(3)),
      warmMedianMs: Number(times[Math.floor(times.length / 2)]!.toFixed(3)),
      warmP95Ms: Number(times[Math.floor(times.length * 0.95)]!.toFixed(3)),
      ...binding.stats,
    });
  }
  return {
    note: "Real app.fetch and all middleware; synthetic D1 result sets and limiter binding stub, no SQL or network. First per-route call and warm elapsed JS, not Cloudflare cpuTime.",
    iterations,
    papers: 372,
    archiveDays: 100,
    results,
  };
}
if (process.argv[1]?.endsWith("bench-hot-path.ts"))
  process.stdout.write(JSON.stringify(await benchHotPath(), null, 2) + "\n");
