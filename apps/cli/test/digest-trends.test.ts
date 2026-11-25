import { defineConfig } from "@litscout/core";
import { BudgetStop, type FeedApi } from "@litscout/pipeline/api";
import { expect, it, vi } from "vitest";
import { withTrends } from "../src/digest-command";

// The 2026-11-19/20 evening runs skipped the separate `trends refresh` step,
// so Trends never got data. A written digest now refreshes its own month.
const config = defineConfig({
  instance: { publicUrl: "https://example.test" },
  topics: [{ name: "Vision", keywords: ["stereo"] }],
} as never);
const api = {} as FeedApi;

it("refreshes the digest's month after a digest is written", async () => {
  const refresh = vi.fn(async () => ({ topics: 1, rowsWritten: 4 }));
  const result = await withTrends(
    { status: "written", day: "2026-10-31" },
    api,
    config,
    refresh,
  );
  expect(refresh).toHaveBeenCalledExactlyOnceWith(api, config, "2026-10");
  expect(result).toMatchObject({
    status: "written",
    trends: { status: "refreshed", month: "2026-10", rowsWritten: 4 },
  });
  await withTrends(
    { status: "written-no-batch", day: "2026-11-21" },
    api,
    config,
    refresh,
  );
  expect(refresh).toHaveBeenLastCalledWith(api, config, "2026-11");
});

it("leaves trends alone when nothing was written", async () => {
  const refresh = vi.fn();
  for (const status of ["exists", "no-new-batch", "summaries-pending"])
    expect(
      await withTrends({ status, day: "2026-11-20" }, api, config, refresh),
    ).toEqual({ status, day: "2026-11-20" });
  expect(refresh).not.toHaveBeenCalled();
});

it("keeps the digest result when the trends refresh stops or fails", async () => {
  const stopped = await withTrends(
    { status: "written", day: "2026-11-20" },
    api,
    config,
    async () => {
      throw new BudgetStop("2026-11-21T00:00:00.000Z");
    },
  );
  expect(stopped).toMatchObject({
    status: "written",
    trends: { status: "budget-stop", month: "2026-11" },
  });
  const failed = await withTrends(
    { status: "written", day: "2026-11-20" },
    api,
    config,
    async () => {
      throw new Error("network");
    },
  );
  expect(failed).toMatchObject({ trends: { status: "failed" } });
});
