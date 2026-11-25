import { dailyFetchResuming } from "../src/daily-resume";
import { apiClient, WriteBudget } from "@litscout/pipeline/api";
import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeEvidence } from "@litscout/db/test/evidence";
import { defineConfig } from "@litscout/core";
import { shiftDay } from "@litscout/pipeline/daily";
import { paperSchema } from "@litscout/pipeline/contracts/index";
import { digestCommand } from "../src/digest-command";
import type { FlowDeps } from "../src/flow-runtime";
const day = "2026-11-17";
it("R12 bounds a 400-paper daily run and digest context with 60 populated history days", async () => {
  const stored = new Map<string, ReturnType<typeof rows>>();
  function rows(date: string) {
    return Array.from({ length: 400 }, (_, i) => ({
      paperId: `pap_${date.replaceAll("-", "")}_${i}`,
      title: `Title ${date} ${i}`,
      abstract: "Useful abstract",
      authors: [{ name: `Author${date.replaceAll("-", "")}${i}` }],
      source: "arxiv",
      topics: [],
      shortlisted: false,
      identifiers: [
        { scheme: "arxiv" as const, value: `${date.replaceAll("-", "")}.${i}` },
      ],
      summaries: [],
      links: [],
      venue: null,
      venueKind: "preprint",
      year: null,
      publishedOn: null,
      categories: [],
      hfUpvotes: null,
      rankInSource: i,
    }));
  }
  for (let i = 1; i <= 60; i++)
    stored.set(shiftDay(day, -i), rows(shiftDay(day, -i)));
  const calls: string[] = [];
  const backend = {
    get: vi.fn(async (path: string) => {
      calls.push(`GET ${path}`);
      const url = new URL(path, "https://local");
      if (url.pathname === "/feed/days")
        return [...stored.keys()].map((d) => ({ day: d, status: "crawled" }));
      if (url.pathname.startsWith("/sync/")) return null;
      if (url.pathname.startsWith("/operations"))
        return { ratings: [], radar: [], missed: [], runs: [] };
      if (url.pathname === "/feed/history") {
        const all = [...stored]
          .filter(
            ([d]) =>
              d >= url.searchParams.get("from")! &&
              d <= url.searchParams.get("to")!,
          )
          .flatMap(([d, items]) =>
            items.map(({ abstract: _a, summaries: _s, links: _l, ...p }) => ({
              ...p,
              day: d,
              hasAbstract: true,
            })),
          );
        const at = Number(url.searchParams.get("cursor") ?? 0),
          limit = 200;
        return {
          items: all.slice(at, at + limit),
          nextCursor: at + limit < all.length ? String(at + limit) : null,
        };
      }
      if (url.pathname.startsWith("/papers/")) {
        const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
        return [...stored.values()].flat().find((p) => p.paperId === id);
      }
      if (url.pathname.startsWith("/feed/days/")) {
        const date = url.pathname.split("/")[3]!,
          items = stored.get(date) ?? [],
          full = url.pathname.endsWith("/full");
        const at = Number(url.searchParams.get("cursor") ?? 0),
          limit = Number(url.searchParams.get("limit") ?? 50);
        return {
          day: date,
          status: "crawled",
          counts: { arxiv: items.length, sources: { arxiv: items.length } },
          items: items
            .slice(at, at + limit)
            .map((p) => (full ? p : { paperId: p.paperId, source: p.source })),
          nextCursor: at + limit < items.length ? String(at + limit) : null,
        };
      }
      throw new Error(`Unexpected ${path}`);
    }),
    write: vi.fn(async (path: string, input: unknown) => {
      calls.push(`POST ${path}`);
      if (path === "/ingest/papers") {
        const value = input as { day: string; papers: unknown[] };
        const all = rows(value.day);
        const n = stored.get(value.day)?.length ?? 0;
        stored.set(value.day, [
          ...(stored.get(value.day) ?? []),
          ...all.slice(n, n + value.papers.length),
        ]);
        return { accepted: value.papers.length, skipped: 0, invalid: [] };
      }
      return {};
    }),
  };
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      path = url.pathname.replace("/api/v1", "") + url.search;
    let data: unknown;
    if (path === "/budget") {
      calls.push("GET /budget");
      data = {
        day,
        used: 0,
        reserved: 0,
        staleLeasesReleased: 0,
        limit: 80000,
        resetAt: "2026-11-18T00:00:00.000Z",
      };
    } else
      data =
        init?.method === "POST"
          ? await backend.write(path, JSON.parse(String(init.body)))
          : await backend.get(path);
    return Response.json({
      success: true,
      data,
      meta: { rowsWritten: 0, authRowsWritten: 0, budgetRowsWritten: 0 },
    });
  };
  const api = apiClient(
    "https://local",
    "synthetic",
    transport,
    new WriteBudget(
      { day, rows: 0 },
      () => new Date(day),
      async () => {},
      true,
    ),
    async () => {},
  );
  const input = rows(day).map(({ paperId: _id, summaries: _s, ...p }) =>
    paperSchema.parse({
      ...p,
      key: p.identifiers[0]!.value,
      authors: p.authors.map((a) => a.name),
    }),
  );
  const directory = await mkdtemp(join(tmpdir(), "litscout-read-requests-"));
  try {
    await dailyFetchResuming(
      day,
      api,
      {
        dir: directory,
        cwd: directory,
        flow: {
          now: () => new Date(day),
          crawl: async () => ({
            days: { [day]: input },
            gaps: [],
            cursor: null,
          }),
        },
      } as unknown as FlowDeps,
      defineConfig({ instance: { publicUrl: "https://local" } }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const dailyRequests = calls.length;
  const context = await digestCommand(
    ["context", "--day", day],
    api,
    {} as FlowDeps,
    defineConfig({}),
  );
  expect(context).toMatchObject({ all: expect.any(Array) });
  const result = {
    historyDays: 60,
    papersPerDay: 400,
    dailyRequests,
    digestRequests: calls.length - dailyRequests,
    total: calls.length,
  };
  await writeEvidence("m1c-r6-request-count.json", result);
  expect(calls.filter((p) => p.startsWith("GET /papers/"))).toHaveLength(0);
  // History pages hold at most 200 rows and paper uploads hold at most five.
  expect(calls.length).toBeLessThan(250);
  expect(calls.filter((p) => p === "POST /ingest/papers")).toHaveLength(80);
});
