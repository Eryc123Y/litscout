import { expect, it, vi } from "vitest";
import { apiClient, WriteBudget } from "../src/api";
import {
  crawlWriteEstimate,
  measuredWriteEstimate,
  writeReservation,
} from "../src/write-reservation";
const day = "2026-11-17";
it("uses the ingest estimates and digest reservations without backup counter writes", () => {
  expect(
    measuredWriteEstimate("/ingest/papers", {
      papers: [{ identifiers: [1, 2], links: [1, 2, 3] }],
    }),
  ).toBe(45);
  expect(writeReservation(`/digests/${day}`, { suggestions: [1, 2, 3] })).toBe(
    35,
  );
  expect(
    writeReservation(`/digests/${day}`, {
      final: true,
      suggestions: Array(10),
    }),
  ).toBe(36);
});
it("charges a legacy import its quoted cap, and plans crawls from measured rows", () => {
  const papers = [{ identifiers: [1], topics: ["Vision"] }];
  expect(
    measuredWriteEstimate("/ingest/papers", {
      legacy: "import",
      maxRows: 412,
      papers,
    }),
  ).toBe(412);
  // The Worker's own estimate keeps its 37-row floor; a crawl plan is measured.
  expect(measuredWriteEstimate("/ingest/papers", { papers })).toBe(41);
  expect(crawlWriteEstimate("/ingest/papers", { papers })).toBe(31);
  expect(
    crawlWriteEstimate("/ingest/papers", {
      legacy: "import",
      maxRows: 9,
      papers,
    }),
  ).toBe(9);
});
function setup(
  reply?: (body: Record<string, unknown>) => Response | Promise<Response>,
  limits?: object,
) {
  const bodies: Record<string, unknown>[] = [];
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (reply) return reply(body);
    const values = Object.values(body).filter(Array.isArray).flat();
    return Response.json({
      success: true,
      data: { accepted: values.length },
      meta: { rowsWritten: 0 },
    });
  });
  const budget = new WriteBudget(
    { day, rows: 0 },
    () => new Date(day),
    async () => {},
  );
  return {
    bodies,
    budget,
    api: apiClient(
      "https://local",
      "synthetic",
      fetcher as typeof fetch,
      budget,
      async () => {},
      limits,
    ),
  };
}
it.each([
  ["papers", 5],
  ["summaries", 20],
  ["radar", 20],
  ["runs", 20],
] as const)("F1 bounds %s requests and reports sizes", async (key, size) => {
  const h = setup();
  await h.api.write(
    key === "runs" ? "/ingest/legacy" : `/ingest/${key}`,
    { [key]: Array.from({ length: 61 }, (_, i) => ({ key: String(i) })) },
    100,
  );
  expect(h.bodies.every((b) => (b[key] as unknown[]).length <= size)).toBe(
    true,
  );
  expect(h.bodies.flatMap((b) => b[key])).toHaveLength(61);
  expect(h.api.batching.requests.map((r) => r.items)).toEqual(
    h.bodies.map((b) => (b[key] as unknown[]).length),
  );
});
it("F1 bounds mixed legacy totals and UTF-8 JSON bytes including the envelope", async () => {
  const h = setup(undefined, {
    papers: 40,
    summaries: 50,
    legacy: 40,
    radar: 40,
    bytes: 700,
  });
  await h.api.write(
    "/ingest/legacy",
    {
      runs: Array(30).fill({ id: "中文".repeat(15) }),
      missed: Array(30).fill({ id: "miss" }),
    },
    100,
  );
  expect(
    h.bodies.every((b) => Buffer.byteLength(JSON.stringify(b)) <= 700),
  ).toBe(true);
  expect(h.bodies.flatMap((b) => Object.values(b).flat())).toHaveLength(60);
});
it.each([503, 500, 520, "reset"])(
  "F1 halves and replays the same items for recoverable %s, continues after a singleton",
  async (failure) => {
    const sent: string[][] = [];
    const h = setup((body) => {
      const ids = (body.papers as { key: string }[]).map((p) => p.key);
      sent.push(ids);
      if (ids.includes("bad")) {
        if (failure === "reset")
          throw Object.assign(new Error("connection reset"), {
            code: "ECONNRESET",
          });
        return new Response(
          failure === 500
            ? "Error 1102: exceeded CPU time"
            : "exceeded resource limits",
          { status: failure as number },
        );
      }
      return Response.json({
        success: true,
        data: {
          accepted: ids.length,
          papers: ids.map((key) => ({ key, paperId: "pap_" + key })),
        },
        meta: { rowsWritten: 0 },
      });
    });
    const result = await h.api.write(
      "/ingest/papers",
      { papers: ["a", "bad", "c", "d"].map((key) => ({ key })) },
      100,
    );
    expect(sent.slice(0, 3)).toEqual([
      ["a", "bad", "c", "d"],
      ["a", "bad"],
      ["a"],
    ]);
    expect(result).toMatchObject({ accepted: 3, skipped: 1 });
    expect(h.api.batching.failures).toEqual([
      expect.objectContaining({ id: "bad" }),
    ]);
    expect(h.api.batching.retries).toBeGreaterThan(0);
    expect(h.budget.state.reserved).toBe(0);
  },
);
it("F1 records oversize singletons locally and bounds singleton feed-day and digest requests", async () => {
  const h = setup(undefined, { bytes: 100 });
  for (const [route, body] of [
    [
      "/ingest/papers",
      { papers: [{ key: "large", title: "x".repeat(200) }, { key: "ok" }] },
    ],
    ["/ingest/feed-day", { counts: { huge: "x".repeat(200) } }],
    ["/digests/2026-11-17", { bodyMd: "x".repeat(200) }],
  ] as const)
    await h.api.write(route, body, 10);
  expect(h.bodies).toEqual([{ papers: [{ key: "ok" }] }]);
  expect(h.api.batching.failures).toHaveLength(3);
});
it("F5 a retried 500 is charged at measured cost and leaves no local reservation", async () => {
  let calls = 0;
  const h = setup(() =>
    ++calls === 1
      ? new Response("failed", { status: 500 })
      : Response.json({
          success: true,
          data: { accepted: 1 },
          meta: { rowsWritten: 5 },
        }),
  );
  await h.api.write(
    "/ingest/summaries",
    { summaries: [{ paperId: "pap_one" }] },
    100,
  );
  expect(h.budget.state).toMatchObject({ rows: 15, reserved: 0 });
});
it("F5 budget recovery remains reachable when the local counter is exhausted", async () => {
  const budget = new WriteBudget(
    { day, rows: 80000, reserved: 30000 },
    () => new Date(day),
    async () => {},
  );
  const state = {
    day,
    used: 52600,
    reserved: 0,
    staleLeasesReleased: 2,
    limit: 80000,
    resetAt: "2026-11-18T00:00:00.000Z",
  };
  const api = apiClient(
    "https://local",
    "synthetic",
    vi.fn(async () =>
      Response.json({ success: true, data: state }),
    ) as typeof fetch,
    budget,
    async () => {},
  );
  expect(await api.get("/budget")).toEqual(state);
  expect(budget.state).toEqual({ day, rows: 52600, reserved: 0 });
});
