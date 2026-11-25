import { expect, it, vi } from "vitest";
import { defineConfig } from "@litscout/core";
import { weeklyCommand } from "../src/weekly-command";
import { digestRecordSchema } from "@litscout/pipeline/contracts/index";
import type { FlowDeps } from "../src/flow-runtime";

const config = defineConfig({ instance: { timezone: "Asia/Shanghai" } });
const deps = {
  flow: { now: () => new Date("2026-11-21T16:01:00Z") },
} as FlowDeps;
const past = "2026-11-15";
const monday = "2026-11-16";
const sunday = "2026-11-22";
const future = "2026-11-23";

function week(dates: string[], dailyPadding = 0, runs: unknown[] = []) {
  const result = {
    get: vi.fn(async (route: string) => {
      if (route.startsWith("/feed/days?"))
        return dates.map((day) => ({ day, status: "digested" }));
      if (route.startsWith("/feed/history?"))
        return { items: [], nextCursor: null };
      if (route.startsWith("/operations?"))
        return { radar: [], missed: [], runs };
      if (route.endsWith("&kind=weekly")) return null;
      const day = route.match(/^\/digests\/(\d{4}-\d{2}-\d{2})\?/)?.[1];
      if (day && dates.includes(day))
        return {
          day,
          bodyMd: `Daily for ${day}` + "x".repeat(dailyPadding),
          picks: [],
          radar: [],
        };
      throw new Error(`Unexpected path ${route}`);
    }),
    write: vi.fn(async (_path: string, _body: unknown) => ({})),
  };
  return result;
}

it("uses the local Sunday and includes reports exactly from Monday through Sunday", async () => {
  const api = week([past, monday, sunday, future]);
  const result = await weeklyCommand([], api, deps, config);
  expect(result).toMatchObject({
    day: sunday,
    bodyMd: expect.stringContaining(`${monday} — ${sunday}`),
  });
  expect(result.bodyMd).toContain(`Daily for ${monday}`);
  expect(result.bodyMd).toContain(`Daily for ${sunday}`);
  expect(result.bodyMd).not.toContain(`Daily for ${past}`);
  expect(result.bodyMd).not.toContain(`Daily for ${future}`);
  expect(api.write.mock.calls.at(-1)?.[1]).toMatchObject({
    runs: [{ stats: { reports: 2 } }],
  });
});

it("does not publish an empty weekly digest just because a prior-week report exists", async () => {
  const api = week([past]);
  await expect(weeklyCommand([], api, deps, config)).resolves.toMatchObject({
    day: sunday,
  });
  expect(api.write).not.toHaveBeenCalled();
});

it("publishes a week of full-size daily digests (about 15,000 characters each)", async () => {
  const days = Array.from({ length: 7 }, (_, i) =>
    new Date(Date.UTC(2026, 10, 16 + i)).toISOString().slice(0, 10),
  );
  const api = week(days, 15_000);
  const result = await weeklyCommand([], api, deps, config);
  expect(result.bodyMd.length).toBeGreaterThan(7 * 15_000);
  const put = api.write.mock.calls.find(
    ([path]) => path === `/digests/${sunday}`,
  );
  expect(put?.[1]).toMatchObject({ kind: "weekly" });
  expect(digestRecordSchema.safeParse(put?.[1]).success).toBe(true);
});

it("reads the week's health from crawl, summary and digest runs and ignores other kinds", async () => {
  const run = (kind: string, startedAt: string, day = monday) => ({
    id: `run_${kind}`,
    kind,
    day,
    status: "done",
    startedAt,
    finishedAt: startedAt,
    stats: {},
    error: null,
  });
  // Retention and the Worker's cron record runs too (2026-11-22 rerun).
  const api = week([monday, sunday], 0, [
    run("crawl", "2026-11-16T01:50:00.000Z"),
    run("prune", "2026-11-22T13:47:54.000Z", sunday),
    run("cron", "2026-11-22T02:00:00.000Z", sunday),
  ]);
  const result = await weeklyCommand([], api, deps, config);
  expect(result.bodyMd).toContain(`- ${monday}: 16 Nov 2026, 09:50`);
});
