import app from "../src/index";
import { scheduled } from "../src/app";
import type { AppEnv } from "../src/env";
export { PairingStore, SourceLimiter } from "../src/index";

function observe(db: D1Database, trace: boolean) {
  let calls = 0;
  let statements = 0;
  let maxParams = 0;
  let rows = 0;
  const queries: { sql: string; params: unknown[]; rows: number }[] = [];
  const prepared = new WeakMap<
    D1PreparedStatement,
    {
      original: D1PreparedStatement;
      sql: string;
      params: unknown[];
    }
  >();
  function record(statement: D1PreparedStatement, result: D1Result) {
    const query = prepared.get(statement)!;
    statements++;
    maxParams = Math.max(maxParams, query.params.length);
    rows += result.meta.rows_read;
    if (trace)
      queries.push({
        sql: query.sql,
        params: query.params,
        rows: result.meta.rows_read,
      });
    return result;
  }
  function wrap(sql: string, params: unknown[], original: D1PreparedStatement) {
    const statement = new Proxy(original, {
      get(target, key) {
        if (key === "bind")
          return (...params: unknown[]) =>
            wrap(sql, params, target.bind(...params));
        if (key === "all" || key === "run")
          return async () => {
            calls++;
            return record(statement, await target[key]());
          };
        // D1 drops metadata from first()/raw(). Use the same single SQL execution.
        if (key === "first" || key === "raw")
          return async (arg?: string | { columnNames?: boolean }) => {
            calls++;
            const result = record(statement, await target.all());
            if (key === "raw") {
              const raw = result.results.map((row) =>
                Object.values(row as object),
              );
              if (typeof arg === "object" && arg.columnNames && raw.length)
                raw.unshift(Object.keys(result.results[0] as object));
              return raw;
            }
            const row = result.results[0] as
              Record<string, unknown> | undefined;
            return typeof arg === "string"
              ? (row?.[arg] ?? null)
              : (row ?? null);
          };
        return Reflect.get(target, key);
      },
    });
    prepared.set(statement, { original, sql, params });
    return statement;
  }
  return {
    db: new Proxy(db, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => wrap(sql, [], target.prepare(sql));
        if (key === "batch")
          return async (batch: D1PreparedStatement[]) => {
            calls++;
            const results = await target.batch(
              batch.map((statement) => prepared.get(statement)!.original),
            );
            return results.map((result, i) => record(batch[i]!, result));
          };
        return Reflect.get(target, key);
      },
    }),
    stats: () => ({ calls, statements, maxParams, rows }),
    async plans() {
      const unique = new Map<string, (typeof queries)[number]>();
      for (const query of queries) {
        if (query.rows > (unique.get(query.sql)?.rows ?? -1))
          unique.set(query.sql, query);
      }
      return Promise.all(
        [...unique.values()].map(async ({ sql, params, rows }) => ({
          sql,
          rows,
          plan: (
            await db
              .prepare("EXPLAIN QUERY PLAN " + sql)
              .bind(...params)
              .all<{ detail: string }>()
          ).results.map((row) => row.detail),
        })),
      );
    },
  };
}

export default {
  async fetch(request, env, ctx) {
    const trace = request.headers.has("x-scale-trace");
    const measured = observe(env.DB!, trace);
    const runtime = { ...env, DB: measured.db };
    const pending: Promise<unknown>[] = [];
    const context = {
      ...ctx,
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    } as ExecutionContext;
    const url = new URL(request.url);
    const response =
      url.pathname === "/__scale/cron"
        ? await scheduled(runtime, Number(url.searchParams.get("at"))).then(
            () => new Response(null),
          )
        : await app.fetch(request, runtime, context);
    await Promise.all(pending);
    if (trace) {
      const body = await response.text();
      return Response.json({
        status: response.status,
        body,
        stats: measured.stats(),
        plans: await measured.plans(),
      });
    }
    const headers = new Headers(response.headers);
    headers.set("x-scale-stats", JSON.stringify(measured.stats()));
    return new Response(response.body, { status: response.status, headers });
  },
} satisfies ExportedHandler<AppEnv>;
