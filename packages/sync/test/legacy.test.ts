import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import {
  planLegacy,
  importLegacy,
  legacyWindow,
  parseRadarTable,
} from "../src/legacy";
import { legacyPaper, parseLedger } from "../src/legacy-records";
import { BudgetStop } from "@litscout/pipeline/api";
const fixture = new URL("./fixtures/", import.meta.url);
it("maps both old ledger items and exported entry arrays, preserving warnings for malformed data", () => {
  const from = "2026-11-10",
    to = "2026-11-11";
  expect(
    parseLedger(JSON.stringify({ items: [{ date: from, id: "a" }] }), from, to)
      .rows,
  ).toEqual([{ day: from, key: "a" }]);
  expect(
    parseLedger(
      JSON.stringify({
        entries: [
          { day: to, ids: ["b"] },
          { day: "2026-01-01", id: "old" },
          { id: "no-day" },
          "bad",
        ],
      }),
      from,
      to,
    ).rows,
  ).toEqual([{ day: to, key: "b" }]);
  expect(parseLedger("broken", from, to).warnings).toHaveLength(1);
  expect(parseLedger("42", from, to).warnings).toHaveLength(1);
  expect(parseLedger("{}", from, to).rows).toEqual([]);
});
const files: Record<string, string> = Object.fromEntries(
  [
    "data/2026-11-10.jsonl",
    "data/2026-11-11.jsonl",
    "data/2026-11-10_AI_enhanced_English.jsonl",
    "data/2026-11-11_AI_enhanced_Chinese.jsonl",
    "data/2026-11-10_hf.json",
    "assets/feed-cursor.json",
    "logs/summary-runs.jsonl",
  ].map((file) => [file, readFileSync(new URL(file, fixture), "utf8")]),
);
it("defaults to the last 30 inclusive days and rejects reversed or invalid windows", () => {
  expect(legacyWindow("2026-11-17")).toEqual({
    from: "2026-10-19",
    to: "2026-11-17",
  });
  expect(() =>
    legacyWindow("2026-11-17", "2026-12-01", "2026-11-01"),
  ).toThrow();
});
it("maps raw records, both summary languages, HF, cursors, run log and digest folder", () => {
  const plan = planLegacy(
    files,
    {
      "digests/2026-11-10.md": "# Daily",
      "ledger.json": JSON.stringify([
        { date: "2026-11-10", ids: ["2611.00001"] },
      ]),
      "project-radar.md":
        "| 2026-11-10 | 2611.00001 | Paper | 可借鉴 | useful | read |",
      "missed.md":
        "| 2026-11-11 | 2611.00001 | Paper | 中 | 2026-11-10 | Sunday |",
      "feedback.md": "| 2026-11-11 | 2611.00001 | up |",
    },
    { from: "2026-11-10", to: "2026-11-11" },
  );
  expect(
    plan.days.map((d) => [
      d.day,
      d.papers.length,
      d.summaries.map((s) => s.lang),
    ]),
  ).toEqual([
    ["2026-11-10", 3, ["en"]],
    ["2026-11-11", 3, ["zh"]],
  ]);
  expect(plan.days[0]!.papers[0]!.hfUpvotes).toBe(7);
  expect(plan.digests).toHaveLength(1);
  expect(plan.radar).toHaveLength(1);
  expect(plan.missed).toHaveLength(1);
  expect(plan.ratings).toHaveLength(1);
  expect(plan.runs).toHaveLength(1);
  expect(plan.cursors.length).toBeGreaterThan(0);
});
it("dry run performs no writes; resumable imports checkpoint each operation", async () => {
  const plan = planLegacy(files, {}, { from: "2026-11-10", to: "2026-11-11" });
  const write = vi.fn(async (path: string, body: unknown) =>
    path === "/ingest/papers"
      ? {
          papers: (body as { papers: { key: string }[] }).papers.map((p) => ({
            key: p.key,
            paperId: "pap_" + p.key,
          })),
        }
      : {},
  );
  const api = { get: vi.fn(async () => null), write };
  const dry = await importLegacy(plan, api, "test", true);
  expect(dry.estimatedRows).toBeGreaterThan(0);
  expect(write).not.toHaveBeenCalled();
  const done = await importLegacy(plan, api, "test", false);
  expect(done.status).toBe("done");
  expect(write.mock.calls.some((c) => c[0] === "/ingest/legacy")).toBe(true);
  api.get.mockResolvedValue({
    name: "test",
    value: JSON.stringify({ offset: done.operations }),
  } as never);
  write.mockClear();
  await importLegacy(plan, api, "test", false);
  expect(write).not.toHaveBeenCalled();
});
it("marks a legacy day summarised when only papers without an abstract lack a summary", async () => {
  const base = planLegacy(files, {}, { from: "2026-11-10", to: "2026-11-11" });
  const day = base.days.find((d) => d.papers.length >= 2)!;
  const summarised = new Set(day.summaries.map((s) => s.key));
  const statusFor = async (papers: typeof day.papers) => {
    const write = vi.fn(async (path: string, body: unknown) =>
      path === "/ingest/papers"
        ? {
            papers: (body as { papers: { key: string }[] }).papers.map((p) => ({
              key: p.key,
              paperId: "pap_" + p.key,
            })),
          }
        : {},
    );
    const plan = { ...base, days: [{ ...day, papers }], digests: [] };
    await importLegacy(
      plan,
      { get: vi.fn(async () => null), write },
      "bare",
      false,
    );
    return (
      write.mock.calls.find(([path]) => path === "/ingest/feed-day")?.[1] as {
        status: string;
      }
    ).status;
  };
  // Every paper without a summary also lacks an abstract: nothing is left to do.
  expect(
    await statusFor(
      day.papers.map((p) =>
        summarised.has(p.key) ? p : { ...p, abstract: null },
      ),
    ),
  ).toBe("summarised");
  // A paper with an abstract and no summary still counts as unfinished.
  expect(await statusFor(day.papers)).toBe("crawled");
});
it("resumes at the persisted checkpoint after a quota stop", async () => {
  const plan = planLegacy(files, {}, { from: "2026-11-10", to: "2026-11-11" });
  let cursor: string | null = null,
    stop = true,
    paperWrites = 0;
  const get = async (path: string) => {
    if (path.startsWith("/sync")) return cursor ? { value: cursor } : null;
    const day = path.split("/").at(-2)!,
      d = plan.days.find((d) => d.day === day)!;
    return {
      day,
      status: "crawled",
      counts: {},
      items: d.papers.map((p) => ({
        paperId: "pap_" + p.key,
        title: p.title,
        abstract: p.abstract,
        authors: p.authors.map((name) => ({ name })),
        source: p.source,
        topics: [],
        shortlisted: false,
        summaries: [],
        identifiers: p.identifiers,
        links: p.links,
      })),
    };
  };
  const write = vi.fn(async (path: string, body: unknown) => {
    if (path === "/ingest/papers") {
      paperWrites++;
      return {
        papers: (body as { papers: { key: string }[] }).papers.map((p) => ({
          key: p.key,
          paperId: "pap_" + p.key,
        })),
      };
    }
    if (path === "/ingest/summaries" && stop)
      throw new BudgetStop("2026-11-18T00:00:00Z");
    const payload = body as { cursors?: { name: string; value: string }[] };
    if (payload.cursors?.[0]?.name === "quota")
      cursor = payload.cursors[0].value;
    return {};
  });
  await expect(
    importLegacy(plan, { get, write }, "quota", false),
  ).rejects.toThrow(BudgetStop);
  expect(JSON.parse(cursor!).offset).toBe(1);
  stop = false;
  await importLegacy(plan, { get, write }, "quota", false);
  expect(paperWrites).toBe(2);
});
it("W3 keeps a completed step locally when quota prevents saving its remote checkpoint", async () => {
  const day = "2026-11-10";
  const plan = planLegacy(
    { [`data/${day}.jsonl`]: files[`data/${day}.jsonl`]! },
    {},
    { from: day, to: day },
  );
  const local: { state: { offset: number; runId?: string } | null } = {
    state: null,
  };
  let stop = true,
    paperWrites = 0;
  const api = {
    get: async (path: string) =>
      path.startsWith("/sync")
        ? { value: '{"offset":0}' }
        : {
            day,
            status: "crawled",
            counts: {},
            items: plan.days[0]!.papers.map((p) => ({
              ...p,
              paperId: "pap_" + p.key,
              authors: p.authors.map((name) => ({ name })),
              summaries: [],
            })),
          },
    write: async (path: string, body: unknown) => {
      if (path === "/ingest/papers") {
        paperWrites++;
        return {
          papers: (body as { papers: { key: string }[] }).papers.map((p) => ({
            key: p.key,
            paperId: "pap_" + p.key,
          })),
        };
      }
      const cursor = (body as { cursors?: { value: string }[] }).cursors?.[0];
      if (stop && cursor && JSON.parse(cursor.value).offset === 1)
        throw new BudgetStop("2026-11-18T00:00:00Z");
      return {};
    },
  };
  const checkpoint = () => ({
    state: local.state,
    save: async (state: { offset: number; runId?: string }) => {
      local.state = state;
    },
  });
  await expect(
    importLegacy(plan, api, "quota-local", false, checkpoint()),
  ).rejects.toThrow(BudgetStop);
  expect(local.state).toMatchObject({ offset: 1 });
  stop = false;
  await importLegacy(plan, api, "quota-local", false, checkpoint());
  expect(paperWrites).toBe(1);
});
it("parses escaped table cells and reports malformed rows without importing them", () => {
  expect(
    parseRadarTable(
      "| 2026-11-10 | 2611.00001 | A \\| B | 高（回溯） | reason | read |\n| broken |",
      "2026-11-10",
      "2026-11-11",
    ).rows[0]?.title,
  ).toBe("A | B");
});
it("maps venue identities, OA/code links, raw abstracts and empty optional metadata", () => {
  const base = { title: "A", authors: ["A"], source: "crossref" };
  for (const r of [
    {
      ...base,
      id: "doi:10.1234/a",
      abstract: "Abstract",
      url: "https://example.org/a",
      published: "2026-11-10",
    },
    {
      ...base,
      id: "doi:ignored",
      doi: "10.1234/b",
      summary: "Summary",
      kind: "conference",
      venue: "Conf",
    },
    {
      ...base,
      id: "openreview:forum",
      doi: "10.1234/c",
      oa_url: "https://example.org/pdf",
      code_url: "https://github.com/example/code",
    },
    {
      ...base,
      id: "url:https://example.org/paper",
      abs: "https://example.org/paper",
      pdf: "https://example.org/pdf",
    },
    { ...base, id: "2611.00001" },
    { id: "2611.00002", title: "Default arxiv", summary: null },
  ])
    expect(legacyPaper(r).identifiers.length).toBeGreaterThan(0);
  expect(legacyPaper({ ...base, id: "openreview:f" }).identifiers).toEqual([
    { scheme: "openreview", value: "f" },
  ]);
  expect(() => legacyPaper({ title: "Missing id" })).toThrow();
});
it("handles date windows, explicit ratings, paused/report logs and invalid table rows", () => {
  const raw = files["data/2026-11-10.jsonl"]!.split("\n")[0]!;
  const input = {
    ...files,
    "data/2026-01-01.jsonl": raw,
    "assets/venues.json": "[]",
    "data/2026-11-10_AI_enhanced_Chinese.jsonl": "",
    "logs/summary-runs.jsonl": [
      { date: "2026-11-10", path: "report", at: "2026-11-10T02:00:00Z" },
      { date: "2026-11-11", path: "paused-no-key", at: "2026-11-11T02:00:00Z" },
      { date: "2026-01-01", path: "api", at: "2026-01-01T02:00:00Z" },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n"),
  };
  const feedback =
    "no dates\n2026-11-10 no id\n2026-01-01 2611.00001 up\n2026-11-10 2611.00001 down\n2026-11-11 2611.00001 clear\n2026-11-11 2611.00001 note";
  const plan = planLegacy(
    input,
    {
      "feedback.md": feedback,
      "digests/2026-01-01.md": "old",
      "ledger.md": "ledger",
      "project-brief.md": "brief",
    },
    { from: "2026-11-10", to: "2026-11-11" },
  );
  expect(plan.runs.map((r) => [r.kind, r.status])).toEqual([
    ["digest", "done"],
    ["summaries", "paused"],
  ]);
  expect(plan.ratings.map((r) => r.kind)).toEqual(["rate_down", "rate_clear"]);
  const tables = parseRadarTable(
    "| Date | arXiv ID | Title | Grade |\n|---|---|---|---|\n| broken |\n| 2026-11-10 | | Title | high |\n| 2026-11-10 | x | T | unknown |\n| 2026-01-01 | x | T | medium |\n| 2026-11-10 | x | T | borrow |",
    "2026-11-10",
    "2026-11-11",
  );
  expect(tables.warnings).toHaveLength(3);
  expect(tables.rows).toHaveLength(1);
});
it("imports all metadata types and resolves identities after a mid-day resume", async () => {
  const raw = JSON.parse(files["data/2026-11-10.jsonl"]!.split("\n")[0]!);
  const key = raw.id as string;
  const plan = planLegacy(
    files,
    {
      "digests/2026-11-10.md": `日报 ${key}`,
      "digests/2026-11-11.md": `Daily ${key}`,
      "project-radar.md": `| 2026-11-10 | ${key} | T | high | | 已读全文 |\n| 2026-11-11 | unknown | T | borrow | ignored | |`,
      "missed.md": `| 2026-11-11 | ${key} | T | medium | reason | action |`,
      "feedback.md": `2026-11-11 ${key} up`,
    },
    { from: "2026-11-10", to: "2026-11-11" },
  );
  const feed = (day: string) => ({
    day,
    status: "crawled",
    counts: {},
    items: plan.days
      .find((d) => d.day === day)!
      .papers.map((p) => ({
        paperId: "pap_" + p.key,
        title: p.title,
        abstract: p.abstract,
        authors: p.authors.map((name) => ({ name })),
        source: p.source,
        topics: [],
        shortlisted: false,
        summaries: [],
        identifiers: p.identifiers,
        links: p.links,
      })),
  });
  const write = vi.fn(async (path: string, body: unknown) =>
    path === "/ingest/papers"
      ? {
          papers: (body as { papers: { key: string }[] }).papers.map((p) => ({
            key: p.key,
            paperId: "pap_" + p.key,
          })),
        }
      : {},
  );
  const api = {
    get: vi.fn(async (path: string) =>
      path.startsWith("/sync")
        ? { value: '{"offset":1}' }
        : feed(path.split("/").at(-2)!),
    ),
    write,
  };
  const result = await importLegacy(plan, api, "resume", false);
  expect(result.status).toBe("done");
  expect(
    write.mock.calls.filter((c) => c[0].startsWith("/digests")),
  ).toHaveLength(2);
  expect(
    write.mock.calls.find((c) => c[0] === "/ingest/radar")?.[1],
  ).toMatchObject({ radar: [{ paperId: "pap_" + key, fullTextRead: true }] });
  const resumeMetadata = {
    ...api,
    get: vi.fn(async (path: string) =>
      path.startsWith("/sync")
        ? { value: '{"offset":6}' }
        : feed(path.split("/").at(-2)!),
    ),
  };
  await importLegacy(plan, resumeMetadata, "resume", false);
  expect(resumeMetadata.get.mock.calls.length).toBeGreaterThan(1);
});

it("stops within the per-run row cap, checkpoints completed work and resumes with a new cap", async () => {
  const plan = planLegacy(files, {}, { from: "2026-11-10", to: "2026-11-11" });
  const write = vi.fn(async (path: string, body: unknown) =>
    path === "/ingest/papers"
      ? {
          papers: (body as { papers: { key: string }[] }).papers.map((p) => ({
            key: p.key,
            paperId: "pap_" + p.key,
          })),
        }
      : {},
  );
  type State = NonNullable<import("../src/legacy").ImportCheckpoint["state"]>;
  let state: State | null = null;
  const get = vi.fn(async (path: string) => {
    if (path.startsWith("/sync/")) return null;
    const day = path.split("/").at(-2)!;
    return {
      day,
      status: "crawled",
      counts: {},
      items:
        plan.days
          .find((d) => d.day === day)
          ?.papers.map((p) => ({
            ...p,
            paperId: "pap_" + p.key,
            authors: [],
            summaries: [],
          })) ?? [],
    };
  });
  const checkpoint = () => ({
    state,
    save: async (next: State) => {
      state = next;
    },
  });
  await expect(
    importLegacy(plan, { get, write }, "cap", false, checkpoint(), 0),
  ).resolves.toMatchObject({
    status: "max-rows",
    rowsBudgeted: 0,
    completedOperations: 0,
  });
  expect(write).not.toHaveBeenCalled();
  const partial = await importLegacy(
    plan,
    { get, write },
    "cap",
    false,
    checkpoint(),
    145,
  );
  expect(partial).toMatchObject({
    status: "max-rows",
    completedOperations: expect.any(Number),
  });
  expect(partial).toHaveProperty("rowsBudgeted", expect.any(Number));
  if (!("rowsBudgeted" in partial)) throw new Error("Expected row usage");
  expect(partial.rowsBudgeted).toBeLessThanOrEqual(145);
  expect(state).toMatchObject({ offset: partial.completedOperations });
  expect(partial.completedOperations).toBeGreaterThan(0);
  const firstDay = plan.days[0]!.day;
  expect(
    write.mock.calls.some(
      ([route, body]) =>
        route === "/ingest/papers" &&
        (body as { day?: string }).day === firstDay,
    ),
  ).toBe(true);
  write.mockClear();
  await expect(
    importLegacy(plan, { get, write }, "cap", false, checkpoint(), 10000),
  ).resolves.toMatchObject({ status: "done" });
  expect(
    write.mock.calls.some(
      ([route, body]) =>
        route === "/ingest/papers" &&
        (body as { day?: string }).day === firstDay,
    ),
  ).toBe(false);
});

it("keeps the requested rows of the live balance, and imports nothing when the balance cannot be read", async () => {
  const plan = planLegacy(files, {}, { from: "2026-11-10", to: "2026-11-11" });
  const write = vi.fn(async (path: string, body: unknown) =>
    path === "/ingest/papers"
      ? {
          papers: (body as { papers: { key: string }[] }).papers.map((p) => ({
            key: p.key,
            paperId: "pap_" + p.key,
          })),
        }
      : {},
  );
  const get = vi.fn(async (path: string) => {
    if (path.startsWith("/sync/")) return null;
    const day = path.split("/").at(-2)!;
    return {
      day,
      status: "crawled",
      counts: {},
      items:
        plan.days
          .find((d) => d.day === day)
          ?.papers.map((p) => ({
            ...p,
            paperId: "pap_" + p.key,
            authors: [],
            summaries: [],
          })) ?? [],
    };
  });
  const balance = (used: number) => async () => ({
    day: "2026-11-19",
    used,
    reserved: 0,
    limit: 80_000,
    resetAt: "2026-11-20T00:00:00.000Z",
    staleLeasesReleased: 0,
  });
  // 145 rows left after keeping 2,000: the same cap as --max-rows 145.
  const kept = await importLegacy(
    plan,
    { get, write, readBudget: balance(80_000 - 2_000 - 145) },
    "keep",
    false,
    undefined,
    undefined,
    new Date("2026-11-19T12:00:00Z"),
    2_000,
  );
  expect(kept).toMatchObject({ status: "max-rows" });
  if (!("rowsBudgeted" in kept)) throw new Error("Expected row usage");
  expect(kept.rowsBudgeted).toBeGreaterThan(0);
  expect(kept.rowsBudgeted).toBeLessThanOrEqual(145);
  expect(kept).not.toHaveProperty("budgetUnread");
  // The smaller of the two caps wins.
  write.mockClear();
  await expect(
    importLegacy(
      plan,
      { get, write, readBudget: balance(0) },
      "keep-small",
      false,
      undefined,
      0,
      new Date("2026-11-19T12:00:00Z"),
      2_000,
    ),
  ).resolves.toMatchObject({ status: "max-rows", rowsBudgeted: 0 });
  expect(write).not.toHaveBeenCalled();
  // An unreadable or missing balance imports nothing.
  for (const api of [
    {
      get,
      write,
      readBudget: async () => {
        throw new Error("Cannot read server budget; no writes sent.");
      },
    },
    { get, write },
  ]) {
    await expect(
      importLegacy(
        plan,
        api,
        "keep-unread",
        false,
        undefined,
        undefined,
        new Date("2026-11-19T12:00:00Z"),
        2_000,
      ),
    ).resolves.toMatchObject({
      status: "budget-unread",
      rowsBudgeted: 0,
      budgetUnread: true,
    });
  }
  expect(write).not.toHaveBeenCalled();
});

it("admits a whole date including its digest before attempting any of its writes, and resumes with the same cap", async () => {
  const from = "2026-11-10",
    to = "2026-11-11";
  const plan = planLegacy(
    files,
    {
      "digests/2026-11-10.md": "# Daily 2611.00001",
      "digests/2026-11-11.md": "# Daily 2611.00001",
    },
    { from, to },
  );
  let stored: string | null = null;
  const write = vi.fn(async (route: string, body: unknown) => {
    const value = body as {
      cursors?: { name: string; value: string }[];
      papers?: { key: string }[];
    };
    for (const cursor of value.cursors ?? [])
      if (cursor.name === "date-cap") stored = cursor.value;
    return route === "/ingest/papers"
      ? {
          papers: value.papers!.map(({ key }) => ({
            key,
            paperId: "pap_" + key,
          })),
        }
      : {};
  });
  const api = {
    get: async (route: string) => {
      if (route.startsWith("/sync")) return stored ? { value: stored } : null;
      const day = route.split("/").at(-2)!;
      return {
        day,
        status: "final",
        counts: {},
        items: plan.days
          .find((d) => d.day === day)!
          .papers.map((p) => ({
            ...p,
            paperId: "pap_" + p.key,
            authors: [],
            summaries: [],
          })),
      };
    },
    write,
    planRows: () => 10,
  };

  await expect(
    importLegacy(plan, api, "date-cap", false, undefined, 39),
  ).resolves.toMatchObject({
    status: "max-rows",
    daysImported: [],
    daysLeft: [from, to],
    rowsUsed: 0,
  });
  expect(write).not.toHaveBeenCalled();

  await expect(
    importLegacy(plan, api, "date-cap", false, undefined, 75),
  ).resolves.toMatchObject({
    status: "max-rows",
    daysImported: [from],
    daysLeft: [to],
    projectedFinishDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
  });
  expect(
    write.mock.calls
      .filter(([route]) => route.startsWith("/digests"))
      .map(([route]) => route),
  ).toEqual([`/digests/${from}`]);
  expect(
    write.mock.calls
      .filter(([route]) => route === "/ingest/papers")
      .map(([, body]) => (body as { day: string }).day),
  ).toEqual([from]);
  write.mockClear();
  await expect(
    importLegacy(plan, api, "date-cap", false, undefined, 75),
  ).resolves.toMatchObject({
    status: "done",
    daysImported: [to],
    daysLeft: [],
  });
  expect(
    write.mock.calls
      .filter(([route]) => route.startsWith("/digests"))
      .map(([route]) => route),
  ).toEqual([`/digests/${to}`]);
});

it("uses actual receipts to admit more dates under the same cap", async () => {
  const from = "2026-11-10",
    to = "2026-11-11";
  const plan = planLegacy(files, {}, { from, to });
  let rows = 0;
  const api = {
    get: async () => null,
    planRows: () => 10,
    writeRows: () => rows,
    write: async (route: string, body: unknown) => {
      rows++;
      return route === "/ingest/papers"
        ? {
            papers: (body as { papers: { key: string }[] }).papers.map(
              ({ key }) => ({ key, paperId: "pap_" + key }),
            ),
          }
        : {};
    },
  };
  const result = await importLegacy(
    plan,
    api,
    "receipts",
    false,
    undefined,
    55,
    new Date("2026-11-20Z"),
  );
  expect(result).toMatchObject({
    status: "done",
    daysImported: [from, to],
    daysLeft: [],
    rowsUsed: rows,
    projectedFinishDate: "2026-11-20",
  });
  expect("rowsBudgeted" in result && result.rowsBudgeted).toBeLessThanOrEqual(
    55,
  );
});

it("admits dates together when a digest references a paper first listed on a later date", async () => {
  const from = "2026-11-10",
    to = "2026-11-11";
  const raw = planLegacy(files, {}, { from, to });
  const firstKeys = new Set(raw.days[0]!.papers.map(({ key }) => key));
  const laterKey = raw.days[1]!.papers.find(
    ({ key }) => !firstKeys.has(key),
  )!.key;
  const plan = planLegacy(
    files,
    { "digests/2026-11-10.md": "# Pick " + laterKey },
    { from, to },
  );
  const write = vi.fn(async (route: string, body: unknown) =>
    route === "/ingest/papers"
      ? {
          papers: (body as { papers: { key: string }[] }).papers.map(
            ({ key }) => ({ key, paperId: "pap_" + key }),
          ),
        }
      : {},
  );
  const api = { get: async () => null, write, planRows: () => 10 };
  await expect(
    importLegacy(plan, api, "linked", false, undefined, 60),
  ).resolves.toMatchObject({
    daysImported: [],
    daysLeft: [from, to],
  });
  expect(write).not.toHaveBeenCalled();
  await expect(
    importLegacy(plan, api, "linked", false, undefined, 100),
  ).resolves.toMatchObject({
    daysImported: [from, to],
    daysLeft: [],
  });
  expect(write).toHaveBeenCalledWith(
    "/digests/" + from,
    expect.objectContaining({
      picks: expect.arrayContaining(["pap_" + laterKey]),
    }),
    10,
    "PUT",
    true,
  );
});
