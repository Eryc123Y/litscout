import { beforeAll, afterAll, beforeEach, expect, it } from "vitest";
import {
  databaseHarness,
  migrationFiles,
  migrationStatements,
} from "./harness";
import {
  configureWriteLimit,
  reconcileWriteBudgetSql,
  releaseStaleLeases,
  reserveWriteBudget,
  settleWriteBudget,
  writeBudgetUsage,
} from "../src/write-budget";
import type { IngestDatabase } from "../src/ingest-store";
let client: IngestDatabase, close: () => Promise<void>;
beforeAll(async () => {
  const h = await databaseHarness("d1");
  client = h.db.$client as unknown as IngestDatabase;
  close = h.close;
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await client.batch([
    client.prepare("DELETE FROM write_leases"),
    client.prepare("DELETE FROM daily_write_usage"),
  ]);
});
it("W2 reads an unused day's zero budget without creating an accounting row", async () => {
  expect(await writeBudgetUsage(client, "2026-12-01")).toEqual({
    used: 0,
    reserved: 0,
    limit: 80000,
    baseLimit: 80000,
    unaccounted: 0,
    estimateOverrun: 0,
  });
  await expect(writeBudgetUsage(client, "invalid")).rejects.toThrow();
});
it("W1 only one concurrent 100-paper reservation fits at 70,000", async () => {
  const date = "2026-11-20";
  await client
    .prepare(
      "INSERT INTO daily_write_usage(day,rows_written,reserved) VALUES (?,70000,0)",
    )
    .bind(date)
    .run();
  const pair = await Promise.all(
    [0, 1].map(() => reserveWriteBudget(client, 7702, new Date(date))),
  );
  expect(pair.filter(Boolean)).toHaveLength(1);
});
it("W1 never discards actual costs above a reservation and refuses any next lease after settlement exhausts the budget", async () => {
  const date = "2026-11-21";
  await client
    .prepare(
      "INSERT INTO daily_write_usage(day,rows_written,reserved) VALUES (?,79900,0)",
    )
    .bind(date)
    .run();
  const lease = await reserveWriteBudget(client, 10, new Date(date));
  await settleWriteBudget(client, lease!, 150, false, { now: new Date(date) });
  expect(
    await client
      .prepare("SELECT rows_written FROM daily_write_usage WHERE day=?")
      .bind(date)
      .first("rows_written"),
  ).toBe(80054);
  expect(await reserveWriteBudget(client, 0, new Date(date))).toBeNull();
});
it("S2 counts actual D1 metadata plus both accounting writes", async () => {
  const now = new Date("2026-11-17T23:00:00Z");
  const lease = await reserveWriteBudget(client, 100, now);
  expect(lease?.rowsWritten).toBe(3);
  expect(await settleWriteBudget(client, lease!, 10, false, { now })).toBe(5);
  expect(
    await client
      .prepare(
        "SELECT rows_written,reserved FROM daily_write_usage WHERE day='2026-11-17'",
      )
      .first(),
  ).toEqual({ rows_written: 15, reserved: 0 });
});
it("holds enough room to settle each outstanding lease at the daily cap", async () => {
  const date = "2026-11-22";
  await client
    .prepare("INSERT INTO daily_write_usage(day,rows_written) VALUES (?,79983)")
    .bind(date)
    .run();
  const now = new Date(date);
  const granted = (
    await Promise.all([0, 1].map(() => reserveWriteBudget(client, 5, now)))
  ).filter((lease) => lease !== null);
  expect(granted).toHaveLength(1);
  await settleWriteBudget(client, granted[0]!, 5, false, { now });
  expect(await writeBudgetUsage(client, date)).toMatchObject({
    used: 79992,
    reserved: 0,
  });
});
it("S2 grants only one concurrent reservation near the cap and settles uncertain reservations at the measured estimate", async () => {
  await client
    .prepare(
      "INSERT INTO daily_write_usage(day,rows_written) VALUES ('2026-11-17',79980)",
    )
    .run();
  const leases = await Promise.all(
    Array.from({ length: 3 }, () =>
      reserveWriteBudget(client, 10, new Date("2026-11-17T23:00:00Z")),
    ),
  );
  const granted = leases.filter((v) => v !== null);
  expect(granted).toHaveLength(1);
  await settleWriteBudget(client, granted[0]!, 0, true, {
    now: new Date("2026-11-17T23:00:00Z"),
  });
  expect(
    await client
      .prepare("SELECT reserved FROM daily_write_usage WHERE day='2026-11-17'")
      .first("reserved"),
  ).toBe(0);
  expect(
    await reserveWriteBudget(client, 100, new Date("2026-11-18T00:00:00Z")),
  ).not.toBeNull();
  await expect(reserveWriteBudget(client, -1)).rejects.toThrow();
});

it("enforces the reduced cap after an estimate is exceeded and restores the base cap at UTC midnight", async () => {
  const day = "2026-11-26";
  const now = new Date(day);
  await client
    .prepare("INSERT INTO daily_write_usage(day,rows_written) VALUES (?,74000)")
    .bind(day)
    .run();
  const lease = await reserveWriteBudget(client, 20, now, 10);
  await settleWriteBudget(client, lease!, 12, false, { now });
  expect(await writeBudgetUsage(client, day)).toMatchObject({
    used: 74016,
    estimateOverrun: 2,
    unaccounted: 0,
    limit: 75000,
  });
  expect(await reserveWriteBudget(client, 1000, now)).toBeNull();
  expect(await reserveWriteBudget(client, 900, now)).not.toBeNull();
  expect(
    await reserveWriteBudget(client, 76000, new Date("2026-11-27")),
  ).not.toBeNull();
});

it("preserves active and expired leases on upgrade", async () => {
  const migration = "0018_budget_accuracy.sql";
  const expiryMigration = "0019_lease_expiry_day.sql";
  const h = await databaseHarness(
    "d1",
    migrationFiles.filter((file) => file < migration),
  );
  const db = h.db.$client as unknown as IngestDatabase;
  const day = "2026-11-23";
  try {
    await db.batch([
      db.prepare(
        "INSERT INTO daily_write_usage(day,rows_written,reserved) VALUES ('2026-11-23',3,120)",
      ),
      db.prepare(
        "INSERT INTO write_leases(id,day,reserved,estimate,created_at) VALUES ('legacy','2026-11-23',120,10,'2026-11-23T07:00:00.000Z')",
      ),
    ]);
    await db.batch(
      migrationStatements([migration]).map((statement) =>
        db.prepare(statement),
      ),
    );
    await db.batch([
      db.prepare(
        "INSERT INTO daily_write_usage(day,rows_written) VALUES ('2026-11-24',125)",
      ),
      db.prepare(
        "INSERT INTO write_leases(id,day,reserved,estimate,created_at,expired) VALUES ('expired','2026-11-24',120,120,'2026-11-24T07:00:00.000Z',1)",
      ),
      ...migrationStatements([expiryMigration]).map((statement) =>
        db.prepare(statement),
      ),
    ]);
    await releaseStaleLeases(db, new Date(day + "T07:11:00Z"));
    expect(await writeBudgetUsage(db, day)).toMatchObject({
      used: 125,
      reserved: 0,
    });
    await settleWriteBudget(
      db,
      { id: "legacy", day, reservation: 120, estimate: 10, rowsWritten: 3 },
      130,
      false,
      { now: new Date(day + "T07:12:00Z") },
    );
    expect(await writeBudgetUsage(db, day)).toMatchObject({
      used: 137,
      estimateOverrun: 120,
      limit: 75000,
    });
    await settleWriteBudget(
      db,
      {
        id: "expired",
        day: "2026-11-24",
        reservation: 120,
        estimate: 120,
        rowsWritten: 3,
      },
      10,
      false,
      { now: new Date("2026-11-24T07:12:00Z") },
    );
    expect(await writeBudgetUsage(db, "2026-11-24")).toMatchObject({
      used: 17,
      limit: 80000,
    });
  } finally {
    await h.close();
  }
});

it("reconciles a D1 UTC day atomically, including its own write and no charge on retries", async () => {
  const day = new Date().toISOString().slice(0, 10);
  const current = await writeBudgetUsage(client, day);
  const reported = current.used + 25;
  const reconcile = () =>
    client.batch(
      reconcileWriteBudgetSql(day, reported)
        .split(";")
        .filter((statement) => statement.trim())
        .map((statement) => client.prepare(statement)),
    );
  const results = await Promise.all([reconcile(), reconcile()]);
  expect(results.flat().reduce((n, r) => n + r.meta.rows_written, 0)).toBe(1);
  expect(await writeBudgetUsage(client, day)).toMatchObject({
    used: reported + 1,
    unaccounted: current.unaccounted + 25,
    limit: 75000,
  });
});

it("defers reconciliation during a lease and counts its writes only once after settlement", async () => {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const lease = await reserveWriteBudget(client, 6000, now);
  const reconcile = (reported: number) =>
    client.batch(
      reconcileWriteBudgetSql(day, reported)
        .split(";")
        .filter((statement) => statement.trim())
        .map((statement) => client.prepare(statement)),
    );
  const reported = 4000 + lease!.rowsWritten;
  const results = await reconcile(reported);
  expect(results.flat().reduce((n, r) => n + r.meta.rows_written, 0)).toBe(0);
  // Prefer deferring even when the apparent gap exceeds the reservation.
  await reconcile(reported + 6000);
  await settleWriteBudget(client, lease!, 4000, false, { now });
  await reconcile(reported);
  expect(await writeBudgetUsage(client, day)).toMatchObject({
    used: reported + 2,
    reserved: 0,
    unaccounted: 0,
    limit: 80000,
  });
});

it("uses the instance's write limit when one is set, and the free-plan limit otherwise", async () => {
  try {
    configureWriteLimit("1000000");
    expect(await writeBudgetUsage(client, "2026-12-02")).toMatchObject({
      limit: 1_000_000,
      baseLimit: 1_000_000,
    });
    // A reservation above the free-plan limit fits under the instance's.
    expect(
      await reserveWriteBudget(client, 90_000, new Date("2026-12-02")),
    ).not.toBeNull();
    for (const invalid of ["", "lots", "-5", "1.5", "100", "999999999999"]) {
      configureWriteLimit(invalid);
      expect(
        (await writeBudgetUsage(client, "2026-12-03")).baseLimit,
        invalid,
      ).toBe(80000);
    }
  } finally {
    configureWriteLimit(undefined);
  }
  expect((await writeBudgetUsage(client, "2026-12-03")).limit).toBe(80000);
});
