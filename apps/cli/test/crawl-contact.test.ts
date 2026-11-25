import { expect, it, vi } from "vitest";
import { defineConfig } from "@litscout/core";
import { sourceCrawl } from "../src/source-crawl";
const watch = vi.hoisted(() => vi.fn());
vi.mock("@litscout/sources/watch/library", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@litscout/sources/watch/library")>()),
  watchVenues: watch,
}));
const folder = new URL("./fixtures/round3/", import.meta.url);
const configured = "reader" + "@" + "example.org";
const exported = "runner" + "@" + "example.org";
async function crawlEnv(env: Record<string, string>, email?: string) {
  watch.mockReset();
  watch.mockResolvedValueOnce([]);
  const config = defineConfig({
    sources: {
      arxiv: { categories: [] },
      huggingface: { dailyPapers: false },
      venues: { watchlist: new URL("venues.json", folder).pathname },
    },
    ...(email ? { library: { unpaywallEmail: email } } : {}),
  });
  await sourceCrawl(config, {
    cwd: "/",
    dir: "/unused-test-state",
    env,
    fetch: vi.fn() as typeof fetch,
    now: () => new Date("2026-11-17T03:30:00Z"),
    sleep: async () => {},
    warn: () => {},
  })("2026-11-17", [], null, []);
  return watch.mock.calls[0]![1].env as Record<string, string | undefined>;
}
it("gives the sources the config's contact address when the environment has none", async () => {
  expect((await crawlEnv({}, configured)).UNPAYWALL_EMAIL).toBe(configured);
});
it("keeps an address from the environment over the config's", async () => {
  const env = await crawlEnv({ UNPAYWALL_EMAIL: exported }, configured);
  expect(env.UNPAYWALL_EMAIL).toBe(exported);
});
it("sends no address when neither the config nor the environment has one", async () => {
  expect((await crawlEnv({})).UNPAYWALL_EMAIL).toBeUndefined();
});
