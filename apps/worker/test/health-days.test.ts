import { afterEach, expect, it, vi } from "vitest";
import { databaseHarness } from "@litscout/db/test/harness";
import { healthSchema } from "@litscout/pipeline/health-contracts";
import { app } from "../src/app";
import { workerEnv } from "./helpers/worker-env";

const done = { status: "done" };
const steps = {
  fetch: done,
  summaries: done,
  digest: done,
  sync: done,
  legacy: { status: "skipped" },
};

afterEach(() => {
  vi.useRealTimers();
});

it("marks days before LitScout's first run and days from the legacy import", async () => {
  vi.setSystemTime(new Date("2026-11-21T07:00:00.000Z"));
  const { db, close } = await databaseHarness("d1");
  const client = db.$client as D1Database;
  const env = {
    ...workerEnv().env,
    DB: client,
    LOCAL_DEV: "true",
    INSTANCE_CONFIG: JSON.stringify({
      name: "Test",
      language: "en",
      timezone: "UTC",
      topics: ["Depth"],
    }),
    HEALTH_ON_TIME_BY: "11:00",
  };
  const health = async () => {
    const response = await app.request("/api/v1/operations/health", {}, env);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as { data: unknown };
    const data = healthSchema.parse(body.data);
    return {
      ...data,
      status: (day: string) => data.days.find((row) => row.day === day),
    };
  };
  try {
    // No runs at all: every weekday is before LitScout started.
    const fresh = await health();
    expect(fresh.firstRunDay).toBeNull();
    expect(fresh.status("2026-11-20")).toMatchObject({
      status: "before-start",
    });
    expect(fresh.status("2026-11-21")).toBeUndefined();
    expect(fresh.status("2026-11-14")).toMatchObject({ status: "no-listing" });

    await client.batch([
      client.prepare(
        `INSERT INTO feed_days(day,counts) VALUES
          ('2026-11-02','{"arxiv":3}'),('2026-11-16','{"arxiv":3}'),
          ('2026-11-17','{"arxiv":3}'),('2026-11-18','{"arxiv":3}')`,
      ),
      // The old pipeline's digest arrived with the legacy import, long after
      // its day, and the import did not bring the day's listing counts.
      client.prepare(
        `INSERT INTO digests(day,lang,body_md,created_at,updated_at) VALUES
          ('2026-10-29','zh','Old','2026-11-15T09:00:00.000Z','2026-11-15T09:00:00.000Z'),
          ('2026-11-16','en','New','2026-11-16T03:00:00.000Z','2026-11-16T03:00:00.000Z'),
          ('2026-11-18','en','New','2026-11-18T12:00:00.000Z','2026-11-18T12:00:00.000Z')`,
      ),
      client.prepare(
        `INSERT INTO runs(id,kind,day,status,started_at,finished_at) VALUES
          ('run_legacy_2026-10-29_0','digest','2026-10-29','done','2026-10-29T03:00:00.000Z','2026-10-29T03:00:00.000Z'),
          ('run_legacy_2026-10-30_1','digest','2026-10-30','done','2026-10-30T03:00:00.000Z','2026-10-30T03:00:00.000Z')`,
      ),
      client
        .prepare(
          `INSERT INTO daily_runs(id,run_day,started_at,target_day,finished_at,steps,rows_written) VALUES
            ('43d91359-fbdc-4047-a843-30e90031a4df','2026-11-16','2026-11-16T02:00:00.000Z','2026-11-16','2026-11-16T03:00:00.000Z',?,1),
            ('ccae65f9-c16a-4c6c-acc5-70d867ac23c1','2026-11-18','2026-11-18T02:00:00.000Z','2026-11-18',NULL,NULL,NULL)`,
        )
        .bind(JSON.stringify(steps)),
    ]);
    const data = await health();
    expect(data.firstRunDay).toBe("2026-11-16");
    // Imported: the digest exists and the legacy import reported its day.
    expect(data.status("2026-10-29")).toMatchObject({
      status: "imported",
      digestAt: "2026-11-15T09:00:00.000Z",
    });
    // A legacy run without a digest is not an imported digest.
    expect(data.status("2026-10-30")).toMatchObject({
      status: "before-start",
    });
    expect(data.status("2026-11-02")).toMatchObject({
      status: "before-start",
    });
    expect(data.status("2026-10-31")).toMatchObject({ status: "no-listing" });
    expect(data.status("2026-11-16")).toMatchObject({
      status: "on-time",
      reported: true,
    });
    expect(data.status("2026-11-17")).toMatchObject({ status: "missed" });
    expect(data.status("2026-11-18")).toMatchObject({ status: "late" });

    // LitScout wrote digests before run reports existed (staging: 16 and
    // 18 Nov, run reports from 19 Nov). Its first digest counts as its start.
    await client.batch([
      client.prepare(
        `INSERT INTO feed_days(day,counts) VALUES ('2026-11-12','{"arxiv":3}'),('2026-11-13','{"arxiv":3}')`,
      ),
      client.prepare(
        `INSERT INTO digests(day,lang,body_md,created_at,updated_at) VALUES
          ('2026-11-12','en','New','2026-11-12T13:00:00.000Z','2026-11-12T13:00:00.000Z')`,
      ),
    ]);
    const earlier = await health();
    expect(earlier.firstRunDay).toBe("2026-11-12");
    expect(earlier.status("2026-11-12")).toMatchObject({ status: "late" });
    expect(earlier.status("2026-11-13")).toMatchObject({ status: "missed" });
    expect(earlier.status("2026-10-29")).toMatchObject({ status: "imported" });
  } finally {
    await close();
  }
});
