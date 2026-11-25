import { afterEach, expect, it, vi } from "vitest";
import SQLite from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "@litscout/core";
import { migrationStatements } from "@litscout/db/test/harness";
import { runCommand } from "../src/setup-commands";
import { doctorResponse } from "./helpers/doctor";

const day = "2026-11-18";
const database = "0522bdb2-8b4a-45d5-bae9-ef29cbfbdf03";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture({
  analytics = true,
  used = 100,
  now = day + "T08:30:00.000Z",
  dbDay = day,
  rolling = 71000,
} = {}) {
  const db = new SQLite(":memory:");
  cleanup.push(() => {
    db.close();
  });
  db.exec(
    "CREATE TABLE litscout_schema(version INTEGER PRIMARY KEY); INSERT INTO litscout_schema VALUES (3); CREATE TABLE sync_cursors(name TEXT);",
  );
  for (const sql of migrationStatements([
    "0004_write_budget.sql",
    "0005_write_leases.sql",
    "0018_budget_accuracy.sql",
    "0019_lease_expiry_day.sql",
  ])) {
    db.exec(sql);
  }
  const dir = await mkdtemp(path.join(tmpdir(), "litscout-reconciliation-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const account = "a".repeat(32);
  let reported = 180;
  let analyticsError = false;
  const ledger = () =>
    db.prepare("SELECT * FROM daily_write_usage WHERE day=?").get(day) as
      | {
          rows_written: number;
          unaccounted: number;
          estimate_overrun: number;
        }
      | undefined;
  if (used)
    db.prepare(
      "INSERT INTO daily_write_usage(day,rows_written) VALUES (?,?)",
    ).run(day, used);
  const run = vi.fn(async (args: readonly string[]) => {
    if (args[0] === "--version") return "4.151.0";
    if (args[0] === "whoami") return "Authenticated";
    if (args[1] === "info")
      return JSON.stringify({
        uuid: database,
        rows_read_24h: 500,
        rows_written_24h: rolling || undefined,
      });
    if (args[1] === "execute") {
      const sql = args[args.indexOf("--command") + 1]!;
      if (sql.includes("api_tokens")) return '[{"results":[]}]';
      expect(args[2]).toBe(database);
      expect(args).toContain("--remote");
      return JSON.stringify(
        db.transaction(() =>
          sql
            .replaceAll("'now'", `'${dbDay + now.slice(10)}'`)
            .split(";")
            .filter((statement) => statement.trim())
            .map((statement) => {
              const prepared = db.prepare(statement);
              if (prepared.reader)
                return { success: true, results: prepared.all() };
              prepared.run();
              return { success: true, results: [] };
            }),
        )(),
      );
    }
    throw new Error("Unexpected Wrangler command");
  });
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    if (new URL(String(input)).hostname === "api.cloudflare.com") {
      expect(JSON.parse(String(init?.body)).variables).toEqual({
        accountTag: account,
        filter: {
          AND: [
            {
              datetimeHour_geq: day + "T00:00:00.000Z",
              datetimeHour_leq: now,
              databaseId: database,
            },
          ],
        },
      });
      if (analyticsError)
        return Response.json({ errors: [{ message: "synthetic denial" }] });
      return Response.json({
        data: {
          viewer: {
            accounts: [
              {
                d1AnalyticsAdaptiveGroups: [{ sum: { rowsWritten: reported } }],
              },
            ],
          },
        },
      });
    }
    const entry = ledger();
    return doctorResponse(String(input), {
      day,
      used: entry?.rows_written ?? 0,
      reserved: 0,
      limit: entry?.unaccounted ? 75000 : 80000,
      staleLeasesReleased: 0,
      resetAt: "2026-11-19T00:00:00.000Z",
    });
  });
  const out: string[] = [];
  const command = (args: string[]) =>
    runCommand(args, {
      dir,
      cwd: dir,
      templateDir: dir,
      bundlePath: "",
      flow: { now: () => new Date(now), token: "synthetic" },
      env: analytics
        ? { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: "synthetic" }
        : {},
      loadConfig: async () =>
        defineConfig({
          instance: { name: "sample", publicUrl: "https://sample.example" },
          agent: { mode: "none" },
        }),
      print: (value) => out.push(value),
      run,
      fetch: fetcher,
      fetchVenues: vi.fn(),
      prompt: vi.fn(),
    });
  return {
    command,
    ledger,
    run,
    fetcher,
    addLease: (createdAt: string, expired = false) => {
      const leaseDay = createdAt.slice(0, 10);
      db.prepare(
        "INSERT INTO write_leases(id,day,reserved,estimate,created_at,expired,expiry_day) VALUES ('test',?,60,60,?,?,?)",
      ).run(leaseDay, createdAt, Number(expired), expired ? dbDay : null);
      if (!expired)
        db.prepare(
          "INSERT INTO daily_write_usage(day,reserved) VALUES (?,60) ON CONFLICT(day) DO UPDATE SET reserved=reserved+60",
        ).run(leaseDay);
    },
    lease: () =>
      db.prepare("SELECT expired,expiry_day FROM write_leases").get(),
    out: () => out.at(-1)!,
    setReported: (value: number) => {
      reported = value;
    },
    failAnalytics: () => {
      analyticsError = true;
    },
  };
}

it("charges only the UTC-day gap and its own ledger write, even when retried", async () => {
  const h = await fixture();
  expect(await h.command(["budget", "--reconcile", "--json"])).toBe(0);
  expect(JSON.parse(h.out()).data).toMatchObject({
    used: 181,
    limit: 75000,
    reconciliation: { status: "reconciled", reportedRows: 180 },
  });
  expect(h.ledger()).toMatchObject({ rows_written: 181, unaccounted: 80 });
  expect(
    await Promise.all([
      h.command(["budget", "--reconcile", "--json"]),
      h.command(["doctor", "--json"]),
    ]),
  ).toEqual([0, 0]);
  h.setReported(70);
  expect(await h.command(["budget", "--reconcile", "--json"])).toBe(0);
  expect(h.ledger()).toMatchObject({ rows_written: 181, unaccounted: 80 });
});

it("reports deferred reconciliation when a lease from the previous UTC day is still open", async () => {
  const h = await fixture({ now: day + "T00:03:00.000Z" });
  h.addLease("2026-11-17T23:58:00.000Z");
  expect(await h.command(["budget", "--reconcile", "--json"])).toBe(0);
  expect(JSON.parse(h.out()).data).toMatchObject({
    limit: 80000,
    reconciliation: {
      status: "deferred",
      warnings: [expect.stringMatching(/active write leases/i)],
    },
  });
  expect(h.ledger()).toMatchObject({ rows_written: 100, unaccounted: 0 });
});

it("defers reconciliation while a recovered lease can still be refunded", async () => {
  const h = await fixture({ used: 165 });
  h.addLease(day + "T07:20:00.001Z", true);
  expect(await h.command(["budget", "--reconcile", "--json"])).toBe(0);
  expect(JSON.parse(h.out()).data.reconciliation).toMatchObject({
    status: "deferred",
    warnings: [expect.stringMatching(/refund window/i)],
  });
  expect(h.ledger()).toMatchObject({ rows_written: 165, unaccounted: 0 });
});

it("recovers a crashed lease and reconciles once its refund window has closed", async () => {
  const h = await fixture();
  h.addLease(day + "T07:20:00.000Z");
  expect(await h.command(["budget", "--reconcile", "--json"])).toBe(0);
  expect(JSON.parse(h.out()).data.reconciliation).toMatchObject({
    status: "reconciled",
    reportedRows: 180,
  });
  expect(h.lease()).toEqual({ expired: 1, expiry_day: day });
  expect(h.ledger()).toMatchObject({
    rows_written: 181,
    reserved: 0,
    unaccounted: 18,
  });
});

it("shows unavailable UTC-day reconciliation as a doctor warning", async () => {
  const h = await fixture({ rolling: 0 });
  h.failAnalytics();
  expect(await h.command(["doctor", "--json"])).toBe(0);
  expect(JSON.parse(h.out()).data).toMatchObject({
    reconciliation: { status: "unavailable" },
    warnings: expect.arrayContaining([
      expect.stringMatching(/UTC-day reconciliation unavailable/i),
    ]),
  });
  expect(await h.command(["doctor"])).toBe(0);
  expect(h.out()).toMatch(/UTC-day reconciliation unavailable/i);
});

it("reconciles via doctor and initializes a day that has only out-of-band writes", async () => {
  const h = await fixture({ used: 0 });
  expect(await h.command(["doctor", "--json"])).toBe(0);
  expect(h.ledger()).toMatchObject({ rows_written: 181, unaccounted: 180 });
  expect(JSON.parse(h.out()).data).toMatchObject({
    budget: { used: 181, limit: 75000 },
    reconciliation: { status: "reconciled", reportedRows: 180 },
  });
  expect(
    h.run.mock.calls.map(([args]) =>
      args[0] === "d1" ? args.slice(0, 3).join(" ") : args[0],
    ),
  ).toEqual([
    "--version",
    "whoami",
    "d1 info sample-db",
    "d1 execute " + database,
    "d1 execute sample-db",
  ]);
});

it("uses rolling metrics for warnings only and leaves plain budget free of Wrangler calls", async () => {
  const h = await fixture({ analytics: false });
  expect(await h.command(["budget", "--json"])).toBe(0);
  expect(h.run).not.toHaveBeenCalled();
  expect(await h.command(["budget", "--reconcile"])).toBe(0);
  expect(h.out()).toContain("rolling 24 hours");
  expect(h.run.mock.calls.every(([args]) => args[1] === "info")).toBe(true);
  expect(h.ledger()).toMatchObject({ rows_written: 100, unaccounted: 0 });
});

it("does not apply a sample when D1 has moved to the next UTC day", async () => {
  const h = await fixture({ dbDay: "2026-11-19" });
  expect(await h.command(["budget", "--reconcile", "--json"])).toBe(0);
  expect(JSON.parse(h.out()).data).toMatchObject({
    reconciliation: { status: "unavailable" },
  });
  expect(h.ledger()).toMatchObject({ rows_written: 100, unaccounted: 0 });
});

it("treats a failed analytics response as rolling-only and leaves the ledger untouched", async () => {
  const h = await fixture();
  h.failAnalytics();
  expect(await h.command(["budget", "--reconcile", "--json"])).toBe(0);
  expect(JSON.parse(h.out()).data.reconciliation).toMatchObject({
    status: "rolling-only",
    rollingRows: 71000,
  });
  expect(h.run.mock.calls.every(([args]) => args[1] === "info")).toBe(true);
  expect(h.ledger()).toMatchObject({ rows_written: 100, unaccounted: 0 });
});
