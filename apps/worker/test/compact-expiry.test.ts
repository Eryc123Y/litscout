import { afterAll, beforeEach, beforeAll, expect, it } from "vitest";
import { databaseHarness } from "@litscout/db/test/harness";
import { ingestPapers } from "@litscout/db/ingest-papers";
import { prunePage, retentionPage } from "@litscout/db/retention";
import { pruneBudgetUsage, writeBudgetUsage } from "@litscout/db/write-budget";
import { shiftDay } from "@litscout/pipeline/daily";
import { app } from "../src/app";
import { monthsBefore } from "../src/compact-expiry";
import { userDay } from "../src/instance-day";
import { workerEnv } from "./helpers/worker-env";
import { countingDb } from "./helpers/counting-db";

// GET and POST /api/v1/ingest/expire: compact rows last listed more than
// storage.compactMonths ago go, oldest first; over the storage cap the
// horizon moves up to a week past the oldest row, never into the window of
// full records. The work is charged to the day's pruning cap.
let harness: Awaited<ReturnType<typeof databaseHarness>>;
let db: D1Database;
let counter: ReturnType<typeof countingDb>;
const utcDay = () => new Date().toISOString().slice(0, 10);
const today = userDay(workerEnv().env, new Date());
const bindings = (storage: Record<string, unknown> = {}) => ({
  ...workerEnv().env,
  DB: counter.db,
  LOCAL_DEV: "true",
  STORAGE_CONFIG: JSON.stringify(storage),
});
const path = "/api/v1/ingest/expire";
const call = (env: ReturnType<typeof bindings>, body?: object) =>
  app.request(
    "https://worker.example" + path,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
    env,
  );
// Days the fixture papers were listed: two over a year ago, four within
// the year but older than the full-record window (45 days by default).
const listed = {
  "2501.00001": -400,
  "2501.00002": -390,
  "2501.00003": -90,
  "2501.00004": -88,
  "2501.00005": -80,
  "2501.00006": -47,
};
const compactIds = async () =>
  (
    await db
      .prepare(
        "SELECT title FROM paper_index WHERE has_canonical=0 ORDER BY title",
      )
      .all<{ title: string }>()
  ).results.map((row) => row.title);

beforeAll(async () => {
  harness = await databaseHarness("d1");
  db = harness.db.$client as D1Database;
  counter = countingDb(db);
});
afterAll(async () => harness?.close());
beforeEach(async () => {
  await db.batch(
    [
      "feed_items",
      "paper_index",
      "feed_days",
      "papers",
      "daily_write_usage",
    ].map((t) => db.prepare("DELETE FROM " + t)),
  );
  for (const [arxiv, offset] of Object.entries(listed))
    await ingestPapers(db, shiftDay(today, offset), [
      {
        key: arxiv,
        source: "arxiv",
        title: "Listed " + arxiv,
        abstract: "Abstract",
        topics: ["vision"],
        identifiers: [{ scheme: "arxiv", value: arxiv }],
      },
    ]);
  const cutoff = shiftDay(today, -46);
  const { rows } = await retentionPage(db, cutoff, null, 40);
  await prunePage(db, cutoff, rows);
  expect(await compactIds()).toHaveLength(6);
});

it("counts calendar months back from a day", () => {
  expect(monthsBefore("2026-11-22", 12)).toBe("2025-11-22");
  expect(monthsBefore("2026-03-31", 1)).toBe("2026-02-28");
  expect(monthsBefore("2024-03-30", 1)).toBe("2024-02-29");
  expect(monthsBefore("2026-01-15", 13)).toBe("2024-12-15");
});

it("previews without writes, then expires what was listed over 12 months ago", async () => {
  const env = bindings();
  counter.reset();
  const preview = await (await call(env)).json();
  expect(preview).toMatchObject({
    success: true,
    data: {
      enabled: true,
      before: monthsBefore(today, 12),
      count: 2,
      oldestDay: shiftDay(today, -400),
      sample: ["Listed 2501.00001", "Listed 2501.00002"],
    },
  });
  expect(counter.stats()).toMatchObject({ rowsWritten: 0 });
  const done = await (await call(env, {})).json();
  expect(done).toMatchObject({
    data: { expired: 2, waiting: 0, more: false },
  });
  expect(await compactIds()).toEqual([
    "Listed 2501.00003",
    "Listed 2501.00004",
    "Listed 2501.00005",
    "Listed 2501.00006",
  ]);
  expect(await (await call(env, {})).json()).toMatchObject({
    data: { expired: 0 },
  });
  const usage = await writeBudgetUsage(db, utcDay());
  expect(usage.reserved).toBe(0);
  expect(await pruneBudgetUsage(db, utcDay())).toBeGreaterThan(0);
});

it("over the cap expires a week past the oldest row, never into the full window", async () => {
  const env = bindings({ compactMonths: 12 });
  await call(env, {});
  const steps = [];
  for (let i = 0; i < 3; i++)
    steps.push(
      (
        (await (await call(env, { overCap: true })).json()) as {
          data: { before: string; expired: number };
        }
      ).data,
    );
  expect(steps).toMatchObject([
    { before: shiftDay(today, -83), expired: 2 },
    { before: shiftDay(today, -73), expired: 1 },
    { before: shiftDay(today, -44), expired: 1 },
  ]);
  expect(await compactIds()).toEqual([]);
});

it("never expires past notAfter, so a run keeps its first horizon", async () => {
  const env = bindings();
  await call(env, {});
  const capped = await (
    await call(env, { overCap: true, notAfter: shiftDay(today, -89) })
  ).json();
  expect(capped).toMatchObject({
    data: { before: shiftDay(today, -89), expired: 1 },
  });
  expect(await compactIds()).toHaveLength(3);
});

it("follows storage.compactMonths", async () => {
  expect(
    await (await call(bindings({ compactMonths: 2 }), {})).json(),
  ).toMatchObject({ data: { before: monthsBefore(today, 2), expired: 5 } });
  expect(await compactIds()).toEqual(["Listed 2501.00006"]);
});

it("stops when pruning is off or the day's pruning cap is spent", async () => {
  expect(
    await (await call(bindings({ prune: false }), {})).json(),
  ).toMatchObject({ data: { enabled: false, expired: 0 } });
  expect(
    await (await call(bindings({ pruneRowsPerDay: 1 }), {})).json(),
  ).toMatchObject({ data: { expired: 0, waiting: 2 } });
  expect(await compactIds()).toHaveLength(6);
});

it("rejects unknown options", async () => {
  expect((await call(bindings(), { overCap: "yes" })).status).toBe(400);
  expect((await call(bindings(), { horizon: "2020-01-01" })).status).toBe(400);
});
