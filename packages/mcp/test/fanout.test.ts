import { beforeEach, expect, it, vi } from "vitest";
import { SourceLimiter } from "@litscout/sources/limiter/source-limiter";
import { createToolContext, sourceReport } from "../src/context";
import { searchPapers } from "../src/papers";
import { clearMemoryCache } from "@litscout/sources/http/cache";
import { memoryState } from "@litscout/core/test/helpers/storage";
import {
  isS2,
  isOA,
  json,
  mockFetch,
} from "@litscout/core/test/helpers/mock-fetch";
import type { SourceEnv } from "@litscout/sources/env";
beforeEach(() => clearMemoryCache());
export function mockEnv(): SourceEnv {
  const limiter = {
    reserve: vi.fn(async () => ({ ok: true, waitMs: 0 })),
    penalize: vi.fn(),
    recordHeaders: vi.fn(),
    status: vi.fn(async () => null),
  };
  return {
    PUBLIC_URL: "https://worker.example",
    SOURCE_LIMITER: { idFromName: (s: string) => s, get: () => limiter },
  } as unknown as SourceEnv;
}
it("persists source schedules, has independent intervals and skips waits above ten seconds", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const { state } = memoryState();
  const a = new SourceLimiter(state, {} as SourceEnv);
  expect(await a.reserve("s2")).toEqual({ ok: true, waitMs: 0 });
  expect(await new SourceLimiter(state, {} as SourceEnv).reserve("s2")).toEqual(
    {
      ok: true,
      waitMs: 3000,
    },
  );
  await a.reserve("s2");
  await a.reserve("s2");
  expect(await a.reserve("s2")).toEqual({ ok: false, retryAfterMs: 12000 });
  const keyed = new SourceLimiter(memoryState().state, {
    S2_API_KEY: "test",
  } as SourceEnv);
  await keyed.reserve("s2");
  expect(await keyed.reserve("s2")).toMatchObject({ waitMs: 1000 });
  const oa = new SourceLimiter(memoryState().state, {} as SourceEnv);
  await oa.reserve("openalex");
  expect(await oa.reserve("openalex")).toMatchObject({ waitMs: 100 });
});
it("retains quota headers and delays reservations after rate-limit exhaustion", async () => {
  const a = new SourceLimiter(memoryState().state, {} as SourceEnv);
  await a.recordHeaders(
    { "x-ratelimit-limit": "1000", "x-ratelimit-remaining": "200" },
    "openalex",
  );
  expect(await a.status()).toMatchObject({
    remaining: 200,
    limit: 1000,
    warning: true,
  });
  await a.penalize(20_000);
  expect(await a.reserve("s2")).toMatchObject({ ok: false });
});
it("fans out, fills abstracts, deduplicates, and returns compact rows and source reports", async () => {
  const mock = mockFetch([
    {
      match: isS2("/paper/search"),
      respond: () =>
        json({
          data: [
            {
              paperId: "s",
              title: "A shared example title",
              year: 2024,
              externalIds: { DOI: "10.1/example" },
            },
          ],
        }),
    },
    {
      match: isOA("/works"),
      respond: () =>
        json({
          results: [
            {
              id: "https://openalex.org/W1",
              display_name: "A shared example title",
              publication_year: 2024,
              doi: "https://doi.org/10.1/example",
              abstract_inverted_index: { ["x".repeat(500)]: [0] },
            },
            {
              id: "https://openalex.org/W2",
              display_name: "Additional journal paper",
              publication_year: 2024,
            },
          ],
        }),
    },
  ]);
  vi.stubGlobal("fetch", mock.fetch);
  const ctx = createToolContext(mockEnv());
  const result = await searchPapers(ctx, {
    query: "example",
    limit: 10,
    offset: 0,
  });
  expect(result.papers).toHaveLength(2);
  expect(result.papers[0]?.abstract?.length).toBeLessThanOrEqual(300);
  expect(sourceReport(ctx)).toMatchObject({
    sources_used: ["s2", "openalex"],
    sources_skipped: [],
  });
  expect(mock.calls.some((c) => c.url.searchParams.has("mailto"))).toBe(false);
});
it("returns OpenAlex rows when S2 would wait too long, marking the exact failed source", async () => {
  const env = mockEnv();
  const base = env.SOURCE_LIMITER.get("" as never) as unknown as {
    reserve: ReturnType<typeof vi.fn>;
  };
  base.reserve.mockImplementation(async (s: string) =>
    s === "s2" ? { ok: false, retryAfterMs: 12000 } : { ok: true, waitMs: 0 },
  );
  vi.stubGlobal(
    "fetch",
    mockFetch([
      {
        match: isOA("/works"),
        respond: () =>
          json({
            results: [
              { id: "https://openalex.org/W3", display_name: "Journal result" },
            ],
          }),
      },
    ]).fetch,
  );
  const ctx = createToolContext(env);
  const result = await searchPapers(ctx, {
    query: "journal",
    limit: 10,
    offset: 0,
  });
  expect(result.papers).toHaveLength(1);
  expect(sourceReport(ctx).sources_skipped).toEqual([
    expect.objectContaining({
      source: "s2",
      reason: expect.stringMatching(/12/),
    }),
  ]);
});
it("does not merge equal titles from different years", async () => {
  const { dedupePapers } = await import("@litscout/core/dedupe");
  expect(
    dedupePapers([
      {
        source: "s2",
        id: "a",
        title: "Identical title across years",
        year: 2023,
        authors: [],
      },
      {
        source: "openalex",
        id: "b",
        title: "Identical title across years",
        year: 2024,
        authors: [],
      },
    ]),
  ).toHaveLength(2);
});

it("honors year and venue filters on every source and orders recent results by date", async () => {
  const { searchPapers } = await import("../src/search");
  const { paper } = await import("@litscout/core/test/fixtures");
  const ctx = {
    s2: {
      searchPapers: async () => ({
        papers: [
          paper("s2", "old", "Older relevant paper", [], {
            year: 2024,
            venue: "Example Venue",
          }),
        ],
        total: 1,
      }),
    },
    oa: { searchWorks: async () => ({ papers: [], count: 0 }) },
    arxiv: {
      search: async () => ({
        papers: [
          paper("arxiv", "new", "Recent relevant preprint", [], {
            year: 2026,
            published: "2026-11-10",
            venue: "Example Venue",
          }),
          paper("arxiv", "wrong", "Outside year filter", [], {
            year: 2020,
            venue: "Example Venue",
          }),
        ],
        total: 2,
      }),
    },
    notices: [],
  } as unknown as import("../src/context").ToolContext;
  const result = await searchPapers(ctx, {
    query: "relevant",
    recent: true,
    year_from: 2024,
    year_to: 2026,
    venue: "Example",
    limit: 10,
    offset: 0,
  });
  expect(result.papers.map((p) => p.id)).toEqual(["new", "old"]);
});
it("reports sources in a fixed order, whichever answered first", () => {
  const report = {
    sources_used: ["venue_table", "openalex", "s2"],
    sources_skipped: [
      { source: "openreview", reason: "HTTP 503" },
      { source: "core", reason: "HTTP 429" },
    ],
  };
  const ctx = { ...createToolContext(mockEnv()), report };
  expect(sourceReport(ctx)).toEqual({
    sources_used: ["s2", "openalex", "venue_table"],
    sources_skipped: [
      { source: "core", reason: "HTTP 429" },
      { source: "openreview", reason: "HTTP 503" },
    ],
  });
  // The live report is not reordered in place.
  expect(report.sources_used).toEqual(["venue_table", "openalex", "s2"]);
});
