import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { defineConfig } from "@litscout/core";
import { sourceCrawl } from "../src/source-crawl";
const watch = vi.hoisted(() => vi.fn());
vi.mock("@litscout/sources/watch/library", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@litscout/sources/watch/library")>()),
  watchVenues: watch,
}));
const folder = new URL("./fixtures/round3/", import.meta.url);
const real = readFileSync(
  new URL(
    "../../../packages/sync/test/fixtures/round3/data/2026-11-11.jsonl",
    import.meta.url,
  ),
  "utf8",
)
  .trim()
  .split("\n")
  .map((s) => JSON.parse(s))
  .find((p) => p.id === "doi:10.46298/lmcs-22(4:18)2026");
const line = { ...real, abstract: null, arxiv_id: null, openreview_id: null };
function replay(
  env: Record<string, string> = {},
  now = "2026-11-17T03:30:00Z",
) {
  const config = defineConfig({
    sources: {
      arxiv: { categories: [] },
      huggingface: { dailyPapers: false },
      venues: { watchlist: new URL("venues.json", folder).pathname },
    },
  });
  return sourceCrawl(config, {
    cwd: "/",
    dir: "/unused-test-state",
    env,
    fetch: vi.fn() as typeof fetch,
    now: () => new Date(now),
    sleep: async () => {},
    warn: () => {},
  });
}
it("T2 a first-run 63-venue watch result survives conversion, with the expected lookback window", async () => {
  watch.mockResolvedValueOnce([line]);
  const result = await replay()("2026-11-17", [], null, []);
  expect(
    JSON.parse(readFileSync(new URL("venues.json", folder), "utf8")).venues,
  ).toHaveLength(63);
  expect(watch.mock.calls[0]![0]).toEqual(
    expect.arrayContaining([
      "--since",
      "2026-11-10",
      "--until",
      "2026-11-17",
      "--kinds",
      "journal,conference",
    ]),
  );
  expect(result.days["2026-11-17"]).toHaveLength(1);
  expect(result.cursor).toBe('{"since":"2026-11-17"}');
});
it("T2 records the actual failure class/message and a redacted stack instead of swallowing it", async () => {
  watch.mockRejectedValueOnce(
    new TypeError("Publisher failed with lsk_" + "synthetic-private-key"),
  );
  const result = await replay({
    OPENALEX_API_KEY: "lsk_" + "synthetic-private-key",
  })("2026-11-17", [], null, []);
  expect(result.cursor).toBeNull();
  expect(result.warnings!.join(" ")).toContain("TypeError");
  expect(result.warnings!.join(" ")).toContain("Publisher failed");
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      source: "venues",
      name: "TypeError",
      stack: expect.stringContaining("TypeError"),
    }),
  );
  expect(JSON.stringify(result)).not.toContain("synthetic-private-key");
});
it("looks back four days from the last completed venue read, so deferred papers stay in the window", async () => {
  // 11-25: OpenAlex listed 1,376 ICML papers with a created date of 11-23.
  // While some are deferred the cursor stays at 11-25; on 11-28 a window
  // starting four days before the run day (11-24) would drop the rest.
  const since = async (day: string, cursor: string) => {
    watch.mockReset();
    watch.mockResolvedValueOnce([]);
    await replay({}, `${day}T03:30:00Z`)(
      day,
      [],
      JSON.stringify({ since: cursor }),
      [],
    );
    const args = watch.mock.calls[0]![0] as string[];
    return args[args.indexOf("--since") + 1];
  };
  expect(await since("2026-11-28", "2026-11-25")).toBe("2026-11-21");
  // A read every day keeps the usual four-day look-back.
  expect(await since("2026-11-26", "2026-11-26")).toBe("2026-11-22");
  expect(await since("2026-11-26", "2026-11-25")).toBe("2026-11-21");
});
