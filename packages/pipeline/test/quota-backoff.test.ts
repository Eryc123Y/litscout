import { expect, it, vi } from "vitest";
import { apiClient, BudgetStop, WriteBudget } from "../src/api";
const retry = "2026-11-18T00:00:00.000Z";
const quota = (used: number, needed: number, reserved = 0) =>
  Response.json(
    {
      success: false,
      error: {
        code: "WRITE_BUDGET_EXCEEDED",
        used,
        reserved,
        limit: 80000,
        needed,
        remaining: Math.max(0, 80000 - used - reserved),
        retry_after: retry,
      },
    },
    { status: 429, headers: { "Retry-After": "60" } },
  );
function harness(impl: typeof fetch, rows = 0) {
  const persist = vi.fn(async () => {}),
    sleep = vi.fn(async () => {});
  const budget = new WriteBudget(
    { day: "2026-11-17", rows },
    () => new Date("2026-11-17T03:30:00Z"),
    persist,
  );
  return {
    api: apiClient("https://local", "synthetic", impl, budget, sleep, {
      papers: 20,
      summaries: 25,
    }),
    budget,
    persist,
    sleep,
  };
}
const papers = Array.from({ length: 100 }, (_, i) => ({
  key: `paper-${i}`,
  identifiers: [{ scheme: "arxiv", value: `2611.${i}` }],
  links: [],
}));
it("W3 retries the largest fitting paper prefix on 429 and combines every mapping", async () => {
  const sizes: number[] = [];
  const request = vi.fn(
    async (_url: RequestInfo | URL, options?: RequestInit) => {
      const body = JSON.parse(options!.body as string),
        rows = body.papers as { key: string }[];
      sizes.push(rows.length);
      if (sizes.length === 1) return quota(79300, 1346);
      return Response.json({
        success: true,
        data: {
          accepted: rows.length,
          skipped: 0,
          invalid: [],
          papers: rows.map((p) => ({ key: p.key, paperId: "pap_" + p.key })),
        },
        meta: { rowsWritten: rows.length * 2 },
      });
    },
  );
  const h = harness(request as typeof fetch);
  const out = (await h.api.write(
    "/ingest/papers",
    { day: "2026-11-17", papers },
    20000,
  )) as { papers: unknown[]; accepted: number };
  expect(sizes.slice(0, 2)).toEqual([20, 10]);
  expect(sizes.every((n) => n <= 20)).toBe(true);
  expect(out.papers).toHaveLength(100);
  expect(out.accepted).toBe(100);
  expect(h.budget.state.reserved).toBe(0);
  expect(h.sleep).not.toHaveBeenCalled();
});
it("W3 shrinks summary batches independently and does not resend the rejected 100", async () => {
  const sizes: number[] = [];
  const h = harness(
    vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => {
      const n = JSON.parse(options!.body as string).summaries.length;
      sizes.push(n);
      return sizes.length === 1
        ? quota(79800, 406)
        : Response.json({
            success: true,
            data: { accepted: n },
            meta: { rowsWritten: 0 },
          });
    }) as typeof fetch,
  );
  await h.api.write(
    "/ingest/summaries",
    { summaries: Array(100).fill({}) },
    10000,
  );
  expect(sizes).toEqual([25, ...Array(8).fill(12), 4]);
});
it("W3 stops with the server reset time if no singleton fits and releases the rejected local reservation", async () => {
  const request = vi.fn(async () => quota(79930, 1346));
  const h = harness(request as typeof fetch);
  await expect(
    h.api.write("/ingest/papers", { papers }, 20000),
  ).rejects.toMatchObject({ resumeAt: retry });
  expect(request).toHaveBeenCalledTimes(1);
  expect(h.budget.state).toMatchObject({ rows: 79930, reserved: 0 });
});
it("W1 client settlement persists an underestimate before refusing the next write", async () => {
  const request = vi.fn(async () =>
    Response.json({ success: true, data: {}, meta: { rowsWritten: 200 } }),
  );
  const h = harness(request as typeof fetch, 79900);
  await h.api.write("/ingest/feed-day", {}, 10);
  expect(h.budget.state.rows).toBe(80100);
  await expect(h.api.write("/ingest/feed-day", {}, 10)).rejects.toBeInstanceOf(
    BudgetStop,
  );
  expect(request).toHaveBeenCalledTimes(1);
  expect(h.persist).toHaveBeenLastCalledWith(
    expect.objectContaining({ rows: 80100 }),
  );
});
it("W1 a second in-flight settlement is recorded even after another response exhausted the local budget", async () => {
  const h = harness(vi.fn() as typeof fetch, 79900);
  await h.budget.begin(10);
  await h.budget.record(200);
  await h.budget.settle(5, 10, false);
  expect(h.budget.state).toMatchObject({ rows: 80105, reserved: 0 });
  expect(() => h.budget.reserve(0)).toThrow(BudgetStop);
});
it.each([79926, 79927])(
  "W3 honors the 1-item floor and the ledger's strict boundary at %i used",
  async (used) => {
    const sizes: number[] = [];
    const request = vi.fn(
      async (_url: RequestInfo | URL, options?: RequestInit) => {
        const n = JSON.parse(options!.body as string).papers.length;
        sizes.push(n);
        return sizes.length === 1
          ? quota(used, 1346)
          : Response.json({
              success: true,
              data: { accepted: n },
              meta: { rowsWritten: 0 },
            });
      },
    );
    const h = harness(request as typeof fetch);
    const work = h.api.write("/ingest/papers", { papers }, 20000);
    if (used === 79926) {
      await work;
      expect(sizes).toEqual([20, ...Array(100).fill(1)]);
    } else {
      await expect(work).rejects.toBeInstanceOf(BudgetStop);
      expect(sizes).toEqual([20]);
    }
  },
);
it("W3 charges uncertain attempts without leaking reservations when a 500 is followed by a quota rejection", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(new Response("failed", { status: 500 }))
    .mockImplementation(async () => quota(79930, 1346));
  const h = harness(request as typeof fetch);
  await expect(
    h.api.write("/ingest/papers", { papers }, 20000),
  ).rejects.toBeInstanceOf(BudgetStop);
  expect(request).toHaveBeenCalledTimes(2);
  // Round 5: 20 * 37 + 3 estimated rows, plus 4 accounting rows for
  // the uncertain attempt, on top of the server's 79,930-row snapshot.
  expect(h.budget.state).toMatchObject({ rows: 80677, reserved: 0 });
  expect(h.persist).toHaveBeenLastCalledWith(
    expect.objectContaining({ rows: 80677, reserved: 0 }),
  );
});
it("W3 a 429 without budget fields stops once and releases its known rejected reservation", async () => {
  const request = vi.fn(
    async () =>
      new Response("invalid", {
        status: 429,
        headers: { "Retry-After": "60" },
      }),
  );
  const h = harness(request as typeof fetch);
  await expect(
    h.api.write("/ingest/papers", { papers }, 20000),
  ).rejects.toBeInstanceOf(BudgetStop);
  expect(request).toHaveBeenCalledTimes(1);
  expect(h.budget.state.reserved).toBe(0);
});
it("W3 repeated conflicting quota snapshots cannot cause an endless retry loop", async () => {
  const request = vi.fn(async () => quota(0, 6704));
  const h = harness(request as typeof fetch);
  await expect(
    h.api.write("/ingest/papers", { papers }, 20000),
  ).rejects.toBeInstanceOf(BudgetStop);
  expect(request).toHaveBeenCalledTimes(4);
});
