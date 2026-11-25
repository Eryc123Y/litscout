import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { defineConfig } from "@litscout/core";
import { arxivDays } from "../src/arxiv-crawl";
import { sourceCrawl } from "../src/source-crawl";
import type { ListingCursor } from "@litscout/pipeline/daily";

const config = defineConfig({
  sources: {
    arxiv: { categories: ["cs.CV"] },
    huggingface: { dailyPapers: false },
  },
});
const recorded = (file: string) =>
  readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8");
function replay(day: string, page: string, recent = page) {
  const request = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/new")) return new Response(recorded(page));
    if (url.pathname.includes("/recent")) return new Response(recorded(recent));
    if (url.hostname === "export.arxiv.org")
      return new Response(
        `<feed>${url.searchParams
          .get("id_list")!
          .split(",")
          .map(
            (id) =>
              `<entry><id>http://arxiv.org/abs/${id}</id><summary>Recorded-page replay abstract</summary></entry>`,
          )
          .join("")}</feed>`,
      );
    throw new Error(`Unexpected request ${url.pathname}`);
  });
  const deps = {
    cwd: "/unused",
    dir: "/unused",
    env: {},
    fetch: request as typeof fetch,
    now: () => new Date(day + "T03:30:00Z"),
    sleep: async () => {},
    warn: () => {},
  };
  return {
    request,
    run: (existing: string[] = [], last: ListingCursor | null = null) =>
      arxivDays(config, deps, day, existing, last),
  };
}
it("L1.1 Monday morning stores the recorded Monday listing as Monday", async () => {
  const result = await replay("2026-11-16", "round3/arxiv-new.html").run();
  expect(result.pending).toBe(false);
  expect(Object.keys(result.days)).toEqual(["2026-11-16"]);
  expect(result.days["2026-11-16"]).toHaveLength(91);
});
it("L1.2 the real late Tuesday page adds nothing and reports Tuesday pending even without a cursor", async () => {
  const result = await replay("2026-11-17", "round3/arxiv-new.html").run([
    "2026-11-16",
  ]);
  expect(result.days).toEqual({});
  expect(result.pending).toBe(true);
  expect(result.message).toMatch(/2026-11-17.*pending/i);
});
it("L1.3 the recorded Tuesday batch appearing later is stored as Tuesday", async () => {
  const result = await replay(
    "2026-11-10",
    "round4/arxiv-2026-11-10-excerpt.html",
  ).run(["2026-11-09"], {
    listingDate: "2026-11-09",
    runDay: "2026-11-09",
  });
  expect(result.pending).toBe(false);
  expect(Object.keys(result.days)).toEqual(["2026-11-10"]);
  expect(result.days["2026-11-10"]).toHaveLength(317);
  expect(result.listing?.listingDate).toBe("2026-11-10");
});
it("L1.4 first run without history stores Monday under Monday and leaves Tuesday pending", async () => {
  const result = await replay("2026-11-17", "round3/arxiv-new.html").run();
  expect(Object.keys(result.days)).toEqual(["2026-11-16"]);
  expect(result.days["2026-11-16"]).toHaveLength(91);
  expect(result.pending).toBe(true);
  expect(result.listing?.listingDate).toBe("2026-11-16");
});
it("L1 a fresh older listing after Friday does not backfill the same recorded Monday again", async () => {
  const current = replay("2026-11-17", "round3/arxiv-new.html");
  const result = await current.run(["2026-11-13"], {
    listingDate: "2026-11-13",
    runDay: "2026-11-13",
  });
  expect(Object.keys(result.days)).toEqual(["2026-11-16"]);
  expect(result.days["2026-11-16"]).toHaveLength(91);
  expect(result).toMatchObject({ pending: true, gaps: [] });
  expect(current.request).toHaveBeenCalledTimes(1);
});
it("L1.5 a recorded Monday-to-Wednesday jump reports Tuesday as no announcement and remembers it", async () => {
  const current = replay(
    "2026-11-11",
    "round4/arxiv-2026-11-11-excerpt.html",
    "round4/arxiv-merged-recent.html",
  );
  const first = await current.run(["2026-11-09"], {
    listingDate: "2026-11-09",
    runDay: "2026-11-09",
  });
  expect(Object.keys(first.days)).toEqual(["2026-11-11"]);
  expect(first.days["2026-11-11"]).toHaveLength(149);
  expect(first).toMatchObject({
    pending: false,
    gaps: [],
    noAnnouncement: ["2026-11-10"],
    listing: { listingDate: "2026-11-11", noAnnouncement: ["2026-11-10"] },
  });
  current.request.mockClear();
  const second = await current.run(["2026-11-09", "2026-11-11"], first.listing);
  expect(second.days).toEqual({});
  expect(second.gaps).toEqual([]);
  expect(
    current.request.mock.calls.some(([url]) => String(url).includes("/recent")),
  ).toBe(false);
});
it("L1 a known no-announcement day stays explicit on a historical retry without another backfill", async () => {
  const current = replay("2026-11-11", "round4/arxiv-2026-11-11-excerpt.html");
  const deps = {
    cwd: "/unused",
    dir: "/unused",
    env: {},
    fetch: current.request as typeof fetch,
    now: () => new Date("2026-11-11"),
    sleep: async () => {},
    warn: () => {},
  };
  const result = await arxivDays(
    config,
    deps,
    "2026-11-10",
    ["2026-11-09", "2026-11-11"],
    {
      listingDate: "2026-11-11",
      runDay: "2026-11-11",
      noAnnouncement: ["2026-11-10"],
    },
  );
  expect(result).toMatchObject({
    days: {},
    gaps: [],
    pending: false,
    noAnnouncement: ["2026-11-10"],
  });
  expect(current.request).not.toHaveBeenCalled();
});
it("L1 a real Tuesday present in recent is backfilled under Tuesday rather than called no announcement", async () => {
  const result = await replay(
    "2026-11-11",
    "round4/arxiv-2026-11-11-excerpt.html",
    "round3/arxiv-recent.html",
  ).run(["2026-11-09"], { listingDate: "2026-11-09", runDay: "2026-11-09" });
  expect(Object.keys(result.days)).toEqual(["2026-11-10", "2026-11-11"]);
  expect(result.days["2026-11-10"]).toHaveLength(317);
  expect(result.noAnnouncement).toEqual([]);
});
it("L1 the full real recent recording confirms the missing Thursday while recovering Friday by its own date", async () => {
  const result = await replay(
    "2026-11-16",
    "round3/arxiv-new.html",
    "round3/arxiv-recent.html",
  ).run(["2026-11-11"], { listingDate: "2026-11-11", runDay: "2026-11-11" });
  expect(result.noAnnouncement).toEqual(["2026-11-12"]);
  expect(result.days["2026-11-13"]).toHaveLength(196);
  expect(result.days["2026-11-16"]).toHaveLength(91);
  expect(result.gaps).toEqual([]);
});

const firstDay = "2026-11-16";
const nextDay = "2026-11-17";
function fixtureListing(dayLabel: string, expected = 1) {
  return `<div id="dlpage"><h3>Showing new listings for ${dayLabel}</h3>
  <h3>New submissions (showing ${expected} of ${expected} entries)</h3>
  <dl><dt><a name="item1"></a><a title="Abstract" href="/abs/2611.00001">Abstract</a></dt>
  <dd><div class="list-title">Title: Fixture paper</div><p class="mathjax">An abstract</p></dd></dl></div>`;
}
function listingDeps(
  fetch: typeof globalThis.fetch,
  at = "2026-11-16T23:59:00Z",
) {
  return {
    cwd: "/unused",
    dir: "/unused",
    env: {},
    fetch,
    now: () => new Date(at),
    sleep: vi.fn(async () => {}),
    warn: () => {},
  };
}

function pagedCore(skip: number, firstId = "2611.00001") {
  const row = (id: string, item: number) =>
    `<dt><a name="item${item}"></a><a title="Abstract" href="/abs/${id}">Abstract</a></dt><dd><div class="list-title">A paper</div></dd>`;
  return `<div id="dlpage"><h3>Showing new listings for Monday, 16 November 2026</h3>
    <div>Total of 2,101 entries</div>
    <h3>New submissions (showing ${skip ? 0 : 1} of 1 entries)</h3><dl>${skip ? "" : row(firstId, 1)}</dl>
    <h3>Cross submissions (showing 1 of 2 entries)</h3><dl>${row(skip ? "2610.00002" : "2611.00002", skip ? 3 : 2)}</dl>
    <h3>Replacement submissions (showing 0 of 2,098 entries)</h3><dl></dl></div>`;
}

it("paginates an incomplete core section and applies the first-submission month filter across pages", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async (url) =>
      new Response(
        pagedCore(Number(new URL(String(url)).searchParams.get("skip"))),
      ),
  );
  const result = await arxivDays(config, listingDeps(fetch), firstDay, []);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(String(fetch.mock.calls[1]?.[0])).toContain("skip=2000");
  expect(result.pending).toBe(false);
  expect(result.days[firstDay]?.map((paper) => paper.key)).toEqual([
    "2611.00001",
    "2611.00002",
  ]);
});

it("leaves an exhausted core listing pending and never accepts repeated pages", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response(pagedCore(0)),
  );
  const result = await arxivDays(config, listingDeps(fetch), firstDay, []);
  expect(result).toMatchObject({ pending: true, days: {} });
  expect(result.listing).toBeUndefined();
  expect(fetch.mock.calls.length).toBeGreaterThan(1);
  expect(fetch.mock.calls.length).toBeLessThanOrEqual(5);
});

it("reports partial Atom recovery as a gap while retaining the recovered day and current listing", async () => {
  const feed = replay(
    firstDay,
    "round3/arxiv-new.html",
    "round3/arxiv-recent.html",
  );
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/query") return feed.request(input);
    const ids = url.searchParams.get("id_list")!.split(",").slice(1);
    return new Response(
      `<feed>${ids.map((id) => `<entry><id>https://arxiv.org/abs/${id}</id><summary>Recovered</summary></entry>`).join("")}</feed>`,
    );
  };
  const result = await arxivDays(config, listingDeps(fetch), firstDay, [
    "2026-11-11",
  ]);
  expect(result).toMatchObject({ pending: false, gaps: ["2026-11-13"] });
  expect(result.days["2026-11-13"]).toHaveLength(194);
  expect(result.days[firstDay]).toHaveLength(91);
});

it("aborts slow recovery at the crawl deadline and retries the deferred day after advancing the listing", async () => {
  const limited = defineConfig({
    sources: { ...config.sources, crawlTimeoutSeconds: 1 },
  });
  const feed = replay(
    firstDay,
    "round3/arxiv-new.html",
    "round3/arxiv-recent.html",
  );
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    if (!String(input).includes("/recent")) return feed.request(input);
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response("late")), 2000);
      init?.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(init.signal?.reason);
        },
        { once: true },
      );
    });
  });
  const deps = listingDeps(fetch);
  const result = await sourceCrawl(limited, deps)(firstDay, [], null, [], {
    listingDate: "2026-11-12",
    runDay: "2026-11-12",
  });
  expect(result.days[firstDay]).toHaveLength(91);
  expect(result.pending).toBe(false);
  expect(result.warnings).toEqual(
    expect.arrayContaining([expect.stringMatching(/crawl deadline/i)]),
  );
  expect(result.listing).toMatchObject({
    listingDate: firstDay,
    pendingDays: ["2026-11-13"],
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  const retry = await arxivDays(
    config,
    listingDeps(feed.request),
    firstDay,
    [firstDay],
    result.listing,
  );
  expect(retry.days["2026-11-13"]).toHaveLength(196);
  expect(retry.listing?.pendingDays).toBeUndefined();
});

it("ends retry backoff at the crawl deadline and leaves an incomplete current day pending", async () => {
  vi.useFakeTimers();
  const limited = defineConfig({ sources: { crawlTimeoutSeconds: 1 } });
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response("busy", { status: 503, headers: { "Retry-After": "60" } }),
  );
  const deps = {
    ...listingDeps(fetch),
    sleep: (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
  const result = sourceCrawl(limited, deps)(firstDay, [], null, []);
  await vi.advanceTimersByTimeAsync(1000);
  await expect(result).resolves.toMatchObject({
    pending: true,
    days: { [firstDay]: [] },
    warnings: [expect.stringMatching(/crawl deadline/i)],
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("recovers a pending first run from the feed even before any listing cursor exists", async () => {
  const feed = replay(
    nextDay,
    "round3/arxiv-new.html",
    "round3/arxiv-recent.html",
  );
  const fetch: typeof globalThis.fetch = async (input) =>
    String(input).includes("/new")
      ? new Response(fixtureListing("Tuesday, 17 November 2026"))
      : feed.request(input);
  const result = await sourceCrawl(
    config,
    listingDeps(fetch, nextDay + "T01:00:00Z"),
  )(nextDay, [], null, [], null, [firstDay]);
  expect(result.days[firstDay]).toHaveLength(91);
  expect(result.days[nextDay]).toHaveLength(1);
});

it("skips the arXiv request on Saturday and Sunday with no listing", async () => {
  for (const day of ["2026-11-14", "2026-11-15"]) {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const deps = listingDeps(fetch, day + "T12:00:00Z");
    await expect(
      arxivDays(config, deps, day, ["2026-11-13"]),
    ).resolves.toMatchObject({
      days: {},
      gaps: [],
      pending: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  }
});

it("accepts a late batch once, even when the same listing is served again", async () => {
  const previous = "2026-11-13";
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      new Response(fixtureListing("Friday, 13 November 2026")),
    )
    .mockResolvedValueOnce(
      new Response(fixtureListing("Monday, 16 November 2026")),
    )
    .mockResolvedValueOnce(
      new Response(fixtureListing("Monday, 16 November 2026")),
    );
  const deps = listingDeps(fetch);
  const early = await arxivDays(config, deps, firstDay, [previous]);
  expect(early).toMatchObject({ days: {}, pending: true });
  const late = await arxivDays(config, deps, firstDay, [previous]);
  expect(late.days[firstDay]).toHaveLength(1);
  const repeated = await arxivDays(
    config,
    deps,
    firstDay,
    [previous, firstDay],
    late.listing,
  );
  expect(repeated).toMatchObject({ days: {}, pending: false });
  expect(repeated.listing).toBeUndefined();
});

it("deduplicates the same paper across two configured categories", async () => {
  const fetch: typeof globalThis.fetch = async () =>
    new Response(fixtureListing("Monday, 16 November 2026"));
  const twoCategories = defineConfig({
    sources: { arxiv: { categories: ["cs.CV", "cs.AI"] } },
  });
  const result = await arxivDays(
    twoCategories,
    listingDeps(fetch),
    firstDay,
    [],
  );
  expect(result.days[firstDay]?.map((paper) => paper.key)).toEqual([
    "2611.00001",
  ]);
});

it.each([
  '<div id="dlpage"><h3>Showing new listings for Monday, 16 November 2026</h3></div>',
  fixtureListing("Monday, 16 November 2026", 2),
  fixtureListing("Monday, 16 November 2026").replace(
    ' href="/abs/2611.00001"',
    "",
  ),
])(
  "does not advance the listing cursor after an empty or truncated dated page",
  async (html) => {
    const deps = listingDeps(async () => new Response(html));
    await expect(arxivDays(config, deps, firstDay, [])).resolves.toMatchObject({
      days: {},
      pending: true,
    });
    expect(
      (await arxivDays(config, deps, firstDay, [])).listing,
    ).toBeUndefined();
  },
);

it("honors a 503 Retry-After before retrying the scheduled listing", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      new Response("busy", { status: 503, headers: { "Retry-After": "6" } }),
    )
    .mockResolvedValueOnce(
      new Response(fixtureListing("Monday, 16 November 2026")),
    );
  const deps = listingDeps(fetch);
  const result = await arxivDays(config, deps, firstDay, []);
  expect(result.days[firstDay]).toHaveLength(1);
  expect(deps.sleep).toHaveBeenCalledWith(6000);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0]?.[1]?.signal).not.toBe(
    fetch.mock.calls[1]?.[1]?.signal,
  );
});

it("keeps both announcement dates when recovering the prior listing just after UTC midnight", async () => {
  const deps = listingDeps(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/new"))
      return new Response(
        recorded("round3/arxiv-new.html")
          .replace("Monday, 16 November 2026", "Tuesday, 17 November 2026")
          .replaceAll("2611.", "2612."),
      );
    if (url.pathname.endsWith("/recent"))
      return new Response(recorded("round3/arxiv-recent.html"));
    if (url.pathname === "/api/query")
      return new Response(
        `<feed>${url.searchParams
          .get("id_list")!
          .split(",")
          .map(
            (id) =>
              `<entry><id>https://arxiv.org/abs/${id}v1</id><summary>Recovered</summary></entry>`,
          )
          .join("")}</feed>`,
      );
    throw new Error(`Unexpected fixture request ${url.pathname}`);
  }, nextDay + "T00:01:00Z");
  const result = await arxivDays(config, deps, nextDay, ["2026-11-13"]);
  expect(result.days[firstDay]?.[0]?.key).toMatch(/^2611\./);
  expect(result.days[nextDay]?.[0]?.key).toMatch(/^2612\./);
  expect(result.listing?.listingDate).toBe(nextDay);
});

it("keeps yesterday pending after UTC midnight when recent still ends on an older listing", async () => {
  const deps = listingDeps(
    async () => new Response(recorded("round3/arxiv-friday-excerpt.html")),
    nextDay + "T00:01:00Z",
  );
  const result = await arxivDays(config, deps, firstDay, ["2026-11-13"]);
  expect(result).toMatchObject({
    days: {},
    pending: true,
    gaps: [],
    noAnnouncement: [],
  });
});

it("does not accept a listing that advertises more rows than this page shows", async () => {
  const html = fixtureListing("Monday, 16 November 2026").replace(
    "showing 1 of 1 entries",
    "showing 1 of 2 entries",
  );
  const result = await arxivDays(
    config,
    listingDeps(async () => new Response(html)),
    firstDay,
    [],
  );
  expect(result).toMatchObject({ days: {}, pending: true });
  expect(result.listing).toBeUndefined();
});

it("does not treat recent rows without an announcement date as a holiday", async () => {
  const html = fixtureListing("Monday, 16 November 2026").replace(
    /<h3>[^<]+<\/h3>/g,
    "",
  );
  const deps = listingDeps(
    async () => new Response(html),
    nextDay + "T00:01:00Z",
  );
  await expect(
    arxivDays(config, deps, firstDay, ["2026-11-13"]),
  ).resolves.toMatchObject({ pending: true, days: {}, noAnnouncement: [] });
});
