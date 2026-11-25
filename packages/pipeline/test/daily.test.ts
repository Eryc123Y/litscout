import { expect, it, vi } from "vitest";
import { dailyFetch, dailyStatus } from "../src/daily";
import { WriteBudget, BudgetStop, apiClient } from "../src/api";
import { paperSchema } from "../src/contracts/index";
const paper = paperSchema.parse({
  key: "2611.00001",
  title: "Depth stereo",
  abstract: "Text",
  source: "arxiv",
  identifiers: [{ scheme: "arxiv", value: "2611.00001" }],
});
it("records response writes, reserves before requests and rolls over at UTC midnight", async () => {
  let now = new Date("2026-11-17T23:59:00Z");
  const save = vi.fn(async () => {});
  const budget = new WriteBudget(
    { day: "2026-11-17", rows: 79990 },
    () => now,
    save,
  );
  expect(() => budget.reserve(10)).toThrow(BudgetStop);
  budget.reserve(9);
  await budget.record(9);
  expect(budget.state.rows).toBe(79999);
  now = new Date("2026-11-18T00:00:00Z");
  budget.reserve(20);
  await budget.record(20);
  expect(budget.state).toEqual({ day: "2026-11-18", rows: 20 });
  expect(save).toHaveBeenCalledTimes(2);
});
it("records singleton transient failures without retrying or losing the run", async () => {
  const impl = vi.fn(async () => new Response("bad", { status: 503 }));
  const budget = new WriteBudget(
    { day: "2026-11-17", rows: 0 },
    () => new Date("2026-11-17"),
    async () => {},
  );
  const api = apiClient(
    "http://local",
    "synthetic",
    impl as typeof fetch,
    budget,
    async () => {},
  );
  expect(await api.write("/ingest/feed-day", {}, 100)).toMatchObject({
    accepted: 0,
    skipped: 1,
  });
  expect(budget.state).toMatchObject({ rows: 12, reserved: 0 });
  expect(impl).toHaveBeenCalledTimes(1);
});
it("charges a measured estimate after a connection failure and refuses an unaffordable next request", async () => {
  const persist = vi.fn(async () => {}),
    impl = vi.fn(async () => {
      throw new Error("connection lost");
    });
  const budget = new WriteBudget(
    { day: "2026-11-17", rows: 79980 },
    () => new Date("2026-11-17"),
    persist,
  );
  const api = apiClient(
    "http://local",
    "synthetic",
    impl as typeof fetch,
    budget,
    async () => {},
  );
  await expect(api.write("/ingest/feed-day", {}, 10)).resolves.toMatchObject({
    skipped: 1,
  });
  expect(budget.state.reserved).toBe(0);
  await expect(api.write("/ingest/feed-day", {}, 10)).rejects.toThrow(
    BudgetStop,
  );
  expect(impl).toHaveBeenCalledTimes(1);
});
it("fetch resumes partially uploaded days, chunks at 100, marks status last and skips finished days", async () => {
  let status = "pending";
  const writes: { path: string; body: unknown }[] = [];
  const api = {
    get: vi.fn(async (path: string) =>
      path.startsWith("/feed/history")
        ? { items: [], nextCursor: null }
        : path === "/feed/days?limit=100"
          ? [{ day: "2026-11-17", status }]
          : path.startsWith("/sync/")
            ? null
            : { day: "2026-11-17", status, counts: {}, items: [] },
    ),
    write: vi.fn(async (path: string, body: unknown) => {
      writes.push({ path, body });
      if (path === "/ingest/feed-day") status = "crawled";
      return { papers: [] };
    }),
  };
  const crawl = vi.fn(async () => ({
    days: {
      "2026-11-17": Array.from({ length: 205 }, (_, n) => ({
        ...paper,
        title: `Paper ${String.fromCharCode(256 + n)} ${n}`,
        authors: [`Author ${n}`],
        key: `2611.${n}`,
        identifiers: [{ scheme: "arxiv" as const, value: `2611.${n}` }],
      })),
    },
    gaps: [],
    cursor: "2026-11-17",
  }));
  await dailyFetch("2026-11-17", api, crawl, []);
  expect(writes.filter((w) => w.path === "/ingest/papers")).toHaveLength(3);
  expect(writes.at(-1)?.path).toBe("/ingest/feed-day");
  status = "final";
  await dailyFetch("2026-11-17", api, crawl, []);
  expect(crawl).toHaveBeenCalledTimes(1);
  expect(await dailyStatus(api)).toEqual([
    {
      day: "2026-11-17",
      status: "final",
      crawled: true,
      summarised: true,
      digested: true,
      final: true,
    },
  ]);
});

it("preflights the full listing and reports a shortfall before ingesting any slice", async () => {
  const day = "2026-11-18",
    listing = "2026-11-17";
  const api = {
    get: vi.fn(async (route: string) => {
      if (route === "/feed/days?limit=100") return [];
      return null;
    }),
    readBudget: async () => ({
      day,
      used: 79669,
      reserved: 10,
      limit: 80000 as const,
      resetAt: "2026-11-19T00:00:00.000Z",
      staleLeasesReleased: 0,
    }),
    write: vi.fn(async () => ({})),
  };
  const complete = vi.fn(async () => {});
  const papers = Array.from({ length: 1155 }, (_, i) => ({
    ...paper,
    key: `2611.${10000 + i}`,
    title: `Stereo study ${i}`,
    authors: [`Synthetic Author ${i}`],
    identifiers: [{ scheme: "arxiv" as const, value: `2611.${10000 + i}` }],
  }));
  const result = await dailyFetch(
    day,
    api,
    async () => ({
      days: { [listing]: papers },
      gaps: [],
      cursor: null,
      pending: true,
      complete,
    }),
    [],
  );
  expect(result).toMatchObject({
    status: "budget-short",
    day,
    added: 0,
    availableRows: 321,
    requiredRows: expect.any(Number),
    shortfall: expect.any(Number),
    resumeAt: "2026-11-19T00:00:00.000Z",
  });
  if (result.status !== "budget-short") throw new Error("Expected a shortfall");
  // About 29 estimated rows a paper since M6e's calibration (measured: 22).
  expect(result.requiredRows).toBeGreaterThan(30000);
  expect(result.requiredRows).toBeLessThan(40000);
  expect(result.shortfall).toBe(result.requiredRows - result.availableRows);
  expect(api.write).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
});

it("keeps one DOI across venues and applies HF votes only to papers already in the feed", async () => {
  const day = "2026-11-17";
  const venue = (name: string, doi: string) =>
    paperSchema.parse({
      key: `doi:${doi}`,
      title: "Journal article fixture",
      abstract: "Text",
      source: "crossref",
      venue: name,
      identifiers: [{ scheme: "doi", value: doi }],
    });
  const prior = {
    ...paper,
    paperId: "pap_existing",
    day,
    authors: [],
    hasAbstract: true,
  };
  const api = {
    get: vi.fn(async (route: string) => {
      if (route === "/feed/days?limit=100") return [{ day, status: "crawled" }];
      if (route.startsWith("/sync/")) return null;
      if (route.startsWith("/feed/history"))
        return { items: [prior], nextCursor: null };
      return { day, status: "crawled", counts: { arxiv: 1 }, items: [] };
    }),
    write: vi.fn(async (_path: string, _body: unknown) => ({ accepted: 1 })),
  };
  const result = await dailyFetch(
    day,
    api,
    async () => ({
      cursor: null,
      gaps: [],
      days: {
        [day]: [
          venue("Venue A", "10.1234/Article"),
          venue("Venue B", "10.1234/article"),
        ],
      },
      signals: { [paper.key]: 12, "2611.99999": 160 },
    }),
    [],
  );
  expect(result).toMatchObject({ venuesAdded: 1, signalsUpdated: 1 });
  const uploads = api.write.mock.calls.filter(
    ([path]) => path === "/ingest/papers",
  );
  expect(uploads.map(([, body]) => body)).toEqual([
    { day, papers: [expect.objectContaining({ venue: "Venue A" })] },
    {
      day,
      papers: [expect.objectContaining({ key: paper.key, hfUpvotes: 12 })],
    },
  ]);
});

it("recognises an archived duplicate without attempting abstract or vote backfills", async () => {
  const oldDay = "2026-10-01",
    day = "2026-11-18";
  const archived = {
    ...paper,
    paperId: "pap_archive",
    day: oldDay,
    abstract: null,
    authors: [],
    compact: true,
    hasAbstract: false,
  };
  const api = {
    get: vi.fn(async (route: string) => {
      if (route === "/feed/days?limit=100")
        return [{ day: oldDay, status: "crawled" }];
      if (route.startsWith("/feed/history"))
        return { items: [archived], nextCursor: null };
      if (route.startsWith("/sync/")) return null;
      return { day, status: "empty", counts: {}, items: [] };
    }),
    write: vi.fn(async (_route: string, _body: unknown) => ({ accepted: 1 })),
  };
  await dailyFetch(
    day,
    api,
    async () => ({
      days: { [day]: [paper] },
      gaps: [],
      cursor: null,
      signals: { [paper.key]: 9 },
    }),
    [],
  );
  expect(api.write.mock.calls.map(([route]) => route)).not.toContain(
    "/ingest/papers",
  );
});

it("marks a crawled day the runs skipped since the last finished day, and leaves older imports alone", async () => {
  // Staging on 2026-11-19: 11-17 was crawled but never summarised or
  // digested, because the 11-18 run read 11-18. Nothing pointed at the gap.
  const rows = [
    { day: "2026-11-19", status: "pending", counts: { sources: {} } },
    {
      day: "2026-11-18",
      status: "crawled",
      counts: { sources: { arxiv: 565 } },
    },
    {
      day: "2026-11-17",
      status: "crawled",
      counts: { sources: { arxiv: 1104 } },
    },
    { day: "2026-11-16", status: "final", counts: { sources: { arxiv: 372 } } },
    {
      day: "2026-11-02",
      status: "summarised",
      counts: { sources: { arxiv: 450 } },
    },
    {
      day: "2026-10-30",
      status: "summarised",
      counts: { sources: { arxiv: 910 } },
    },
  ];
  const api = {
    get: vi.fn(async (route: string) =>
      route === "/feed/days?limit=100" ? rows : null,
    ),
    write: vi.fn(async () => ({})),
  };
  const status = await dailyStatus(api);
  const byDay = Object.fromEntries(status.map((row) => [row.day, row]));
  expect(byDay["2026-11-18"]).toMatchObject({ target: true });
  expect(byDay["2026-11-17"]).toMatchObject({
    behind: true,
    suggestion: "litscout summaries run --day 2026-11-17",
  });
  // Days before the last finished one (here, imported legacy days) are not gaps.
  for (const day of ["2026-11-18", "2026-11-16", "2026-11-02", "2026-10-30"])
    expect(byDay[day]).not.toHaveProperty("behind");
});

it("does not reach further back than two weeks for skipped days", async () => {
  const rows = [
    {
      day: "2026-11-18",
      status: "crawled",
      counts: { sources: { arxiv: 500 } },
    },
    {
      day: "2026-11-10",
      status: "crawled",
      counts: { sources: { arxiv: 500 } },
    },
    {
      day: "2026-11-01",
      status: "crawled",
      counts: { sources: { arxiv: 500 } },
    },
  ];
  const api = {
    get: vi.fn(async () => rows),
    write: vi.fn(async () => ({})),
  };
  const byDay = Object.fromEntries(
    (await dailyStatus(api)).map((row) => [row.day, row]),
  );
  expect(byDay["2026-11-10"]).toMatchObject({ behind: true });
  expect(byDay["2026-11-01"]).not.toHaveProperty("behind");
});

it("suggests the digest for a skipped day whose summaries are done", async () => {
  const rows = [
    {
      day: "2026-11-18",
      status: "crawled",
      counts: { sources: { arxiv: 500 } },
    },
    {
      day: "2026-11-17",
      status: "summarised",
      counts: { sources: { arxiv: 900 } },
    },
    { day: "2026-11-16", status: "final", counts: { sources: { arxiv: 300 } } },
  ];
  const api = { get: vi.fn(async () => rows), write: vi.fn(async () => ({})) };
  const byDay = Object.fromEntries(
    (await dailyStatus(api)).map((row) => [row.day, row]),
  );
  expect(byDay["2026-11-17"]).toMatchObject({
    behind: true,
    suggestion: "litscout digest run --day 2026-11-17",
  });
});
