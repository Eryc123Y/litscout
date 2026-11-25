import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { databaseHarness } from "./harness";
import {
  reconcileWriteBudgetSql,
  reserveWriteBudget,
  settleWriteBudget,
  releaseStaleLeases,
  writeBudgetUsage,
} from "../src/write-budget";
import type { IngestDatabase } from "../src/ingest-store";

let db: IngestDatabase, close: () => Promise<void>;
beforeAll(async () => {
  const h = await databaseHarness("d1");
  db = h.db.$client as unknown as IngestDatabase;
  close = h.close;
});
afterAll(async () => close());
beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM write_leases"),
    db.prepare("DELETE FROM daily_write_usage"),
  ]);
});

it("charges the full reservation for an abandoned lease once, even under races", async () => {
  const day = "2026-11-17";
  const now = new Date(day + "T10:00:00Z");
  expect(await reserveWriteBudget(db, 1000, now, 21)).not.toBeNull();
  expect(
    await releaseStaleLeases(db, new Date(day + "T10:10:00Z")),
  ).toMatchObject({ released: 0 });
  const results = await Promise.all(
    [0, 1].map(() => releaseStaleLeases(db, new Date(day + "T10:10:01Z"))),
  );
  expect(results.reduce((n, r) => n + r.released, 0)).toBe(1);
  expect(await writeBudgetUsage(db, day)).toMatchObject({
    used: 1005,
    reserved: 0,
  });
});

it.each([
  { day: "2026-11-18", actual: 110, uncertain: false, charge: 110 },
  { day: "2026-11-19", actual: 7, uncertain: false, charge: 7 },
  { day: "2026-11-20", actual: 7, uncertain: true, charge: 100 },
])(
  "corrects the expired charge on a certain result only ($actual rows, uncertain=$uncertain)",
  async ({ day, actual, uncertain, charge }) => {
    const lease = await reserveWriteBudget(
      db,
      100,
      new Date(day + "T10:00:00Z"),
    );
    const now = new Date(day + "T10:11:00Z");
    await releaseStaleLeases(db, now);
    expect(await writeBudgetUsage(db, day)).toMatchObject({
      used: 105,
      reserved: 0,
    });
    const settled = await Promise.all([
      settleWriteBudget(db, lease!, actual, uncertain, { now }),
      settleWriteBudget(db, lease!, actual, uncertain, { now }),
    ]);
    expect(settled.sort()).toEqual([0, 5]);
    expect(await writeBudgetUsage(db, day)).toMatchObject({
      used: charge + 7,
      reserved: 0,
      estimateOverrun: Math.max(0, actual - 100),
      limit: actual > 100 ? 75000 : 80000,
    });
  },
);

it("charges the full reservation for an uncertain response and leaves no active lease", async () => {
  const day = "2026-11-22";
  const lease = await reserveWriteBudget(db, 1000, new Date(day), 8);
  const now = new Date(day);
  expect(await settleWriteBudget(db, lease!, 0, true, { now })).toBe(5);
  expect(await settleWriteBudget(db, lease!, 0, true, { now })).toBe(0);
  expect(await writeBudgetUsage(db, day)).toMatchObject({
    used: 1005,
    reserved: 0,
    estimateOverrun: 0,
    limit: 80000,
  });
});

it("charges an uncertain settlement at the full reservation on both UTC days", async () => {
  const lease = await reserveWriteBudget(
    db,
    100,
    new Date("2026-11-22T23:58:00Z"),
  );
  const now = new Date("2026-11-23T00:01:00Z");
  expect(await settleWriteBudget(db, lease!, 0, true, { now })).toBe(6);
  expect(await writeBudgetUsage(db, "2026-11-22")).toMatchObject({
    used: 103,
    reserved: 0,
  });
  expect(await writeBudgetUsage(db, "2026-11-23")).toMatchObject({
    used: 103,
    reserved: 0,
  });
});

it("attributes a measured split across midnight and charges settlement bookkeeping to the new day", async () => {
  const lease = await reserveWriteBudget(
    db,
    100,
    new Date("2026-11-23T23:58:00Z"),
  );
  const now = new Date("2026-11-24T00:01:00Z");
  expect(
    await settleWriteBudget(db, lease!, 10, false, {
      now,
      rowsBeforeMidnight: 3,
    }),
  ).toBe(6);
  expect(await writeBudgetUsage(db, lease!.day)).toMatchObject({
    used: 6,
    reserved: 0,
  });
  expect(await writeBudgetUsage(db, "2026-11-24")).toMatchObject({
    used: 10,
    reserved: 0,
  });
});

it("keeps the original charge and adds actual writes to the new day when the split is unknown", async () => {
  const lease = await reserveWriteBudget(
    db,
    100,
    new Date("2026-11-25T23:58:00Z"),
  );
  const now = new Date("2026-11-26T00:01:00Z");
  expect(await settleWriteBudget(db, lease!, 10, false, { now })).toBe(6);
  expect(await writeBudgetUsage(db, lease!.day)).toMatchObject({
    used: 103,
    reserved: 0,
  });
  expect(await writeBudgetUsage(db, "2026-11-26")).toMatchObject({
    used: 13,
    reserved: 0,
  });
});

it("charges midnight expiry to the new day and corrects that charge once at settlement", async () => {
  const lease = await reserveWriteBudget(
    db,
    100,
    new Date("2026-11-27T23:58:00Z"),
  );
  const now = new Date("2026-11-28T00:11:00Z");
  const day = now.toISOString().slice(0, 10);
  expect(await releaseStaleLeases(db, now)).toMatchObject({ released: 1 });
  expect(await writeBudgetUsage(db, lease!.day)).toMatchObject({
    used: 103,
    reserved: 0,
  });
  expect(await writeBudgetUsage(db, day)).toMatchObject({ used: 103 });
  expect(await settleWriteBudget(db, lease!, 10, false, { now })).toBe(5);
  expect(await settleWriteBudget(db, lease!, 10, false, { now })).toBe(0);
  expect(await writeBudgetUsage(db, lease!.day)).toMatchObject({ used: 103 });
  expect(await writeBudgetUsage(db, day)).toMatchObject({ used: 15 });
});

it("leaves the prior charges final when a certain settlement arrives on a third day", async () => {
  const lease = await reserveWriteBudget(
    db,
    100,
    new Date("2026-11-27T23:58:00Z"),
  );
  await releaseStaleLeases(db, new Date("2026-11-28T00:11:00Z"));
  expect(
    await settleWriteBudget(db, lease!, 10, false, {
      now: new Date("2026-11-29T00:01:00Z"),
      rowsBeforeMidnight: 3,
    }),
  ).toBe(0);
  expect(await writeBudgetUsage(db, lease!.day)).toMatchObject({ used: 103 });
  expect(await writeBudgetUsage(db, "2026-11-28")).toMatchObject({ used: 103 });
  expect(await writeBudgetUsage(db, "2026-11-29")).toMatchObject({ used: 0 });
});

it("leaves a reconciled charge intact when a certain settlement arrives after the refund window", async () => {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const created = new Date(now.getTime() - 70 * 60_000);
  const lease = await reserveWriteBudget(db, 100, created);
  await releaseStaleLeases(db, now);
  await db.batch(
    reconcileWriteBudgetSql(day, 200)
      .split(";")
      .filter((statement) => statement.trim())
      .map((statement) => db.prepare(statement)),
  );
  const reconciled = await writeBudgetUsage(db, day);
  expect(reconciled).toMatchObject({ used: 201, limit: 75000 });
  expect(await settleWriteBudget(db, lease!, 5, false, { now })).toBe(0);
  expect(await settleWriteBudget(db, lease!, 5)).toBe(0);
  expect(await writeBudgetUsage(db, day)).toEqual(reconciled);
});

it("prunes expired leases older than two days and meters the deletion once", async () => {
  const day = "2026-12-01";
  const lease = await reserveWriteBudget(db, 100, new Date(day));
  await releaseStaleLeases(db, new Date(day + "T00:11:00Z"));
  const beforeCutoff = await releaseStaleLeases(
    db,
    new Date("2026-12-03T00:00:00Z"),
  );
  expect(beforeCutoff).toMatchObject({ released: 0, rowsWritten: 0 });
  const now = new Date("2026-12-03T00:00:01Z");
  expect(await releaseStaleLeases(db, now)).toMatchObject({
    released: 0,
    rowsWritten: 2,
  });
  expect(await releaseStaleLeases(db, now)).toMatchObject({ rowsWritten: 0 });
  expect(await settleWriteBudget(db, lease!, 10, false, { now })).toBe(0);
  expect(await writeBudgetUsage(db, "2026-12-03")).toMatchObject({ used: 2 });
  expect(await writeBudgetUsage(db, day)).toMatchObject({ used: 105 });
});
