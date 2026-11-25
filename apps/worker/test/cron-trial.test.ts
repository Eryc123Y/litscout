import { afterEach, expect, it, vi } from "vitest";
import { cappedCvListing, scheduledFixtureUrl } from "./helpers/cron-listing";
import { securityWorker } from "./helpers/security-worker";

type Local = Awaited<ReturnType<typeof securityWorker>>;
let local: Local | undefined;
afterEach(async () => {
  await local?.worker.dispose();
  local = undefined;
});

const listingUrl = "https://arxiv.org/list/cs.CV/new?skip=0&show=10";
const key = "arxiv/2026-11-16/cs.CV/0";

async function tick(
  flag?: string,
  serve = () => new Response(cappedCvListing()),
) {
  const source = vi.fn((request: Request) =>
    request.url === listingUrl
      ? serve()
      : new Response("Unexpected outbound request", { status: 503 }),
  );
  local = await securityWorker({
    bindings: flag === undefined ? undefined : { CRON_CRAWL_TRIAL: flag },
    kvNamespaces: ["CRON_CRAWL_STAGE"],
    scheduled: true,
    outboundService: source,
  });
  const res = await local.worker.dispatchFetch(scheduledFixtureUrl);
  return { local, source, res };
}

it("keeps the trial off unless enabled, even when storage is bound", async () => {
  const { source, local, res } = await tick();
  expect(res.status, await res.text()).toBe(200);
  expect(source).not.toHaveBeenCalled();
  const stage = await local.worker.getKVNamespace("CRON_CRAWL_STAGE");
  expect((await stage.list()).keys).toEqual([]);
});

it("fetches and stages one partial page with its own date and expiry", async () => {
  const { local, source, res } = await tick("true");
  expect(source.mock.calls.map(([req]) => req.url)).toEqual([listingUrl]);
  expect(res.status, await res.text()).toBe(200);
  const stage = await local.worker.getKVNamespace("CRON_CRAWL_STAGE");
  expect(await stage.get(key, "json")).toMatchObject({
    listingDay: "2026-11-16",
    category: "cs.CV",
    offset: 0,
    total: 140,
    core: {
      required: ["new", "cross"],
      sections: [
        { kind: "new", total: 72, valid: true, ids: expect.any(Array) },
      ],
    },
  });
  expect((await stage.list()).keys).toMatchObject([
    { name: key, expiration: expect.any(Number) },
  ]);
  expect(
    await local.db
      .prepare("SELECT COUNT(*) AS count FROM feed_days")
      .first("count"),
  ).toBe(0);
});

it.each([
  ["an oversized page", () => new Response(" ".repeat(64 * 1024 + 1))],
  ["a page that ignores the row cap", () => new Response(cappedCvListing(11))],
  ["an upstream failure", () => new Response("", { status: 503 })],
  ["a redirect", () => Response.redirect("https://arxiv.org/")],
])("leaves staging empty after %s", async (_name, serve) => {
  const { local, res, source } = await tick("true", serve);
  expect(res.status, await res.text()).toBe(500);
  expect(source.mock.calls.map(([req]) => req.url)).toEqual([listingUrl]);
  const stage = await local.worker.getKVNamespace("CRON_CRAWL_STAGE");
  expect((await stage.list()).keys).toEqual([]);
});
