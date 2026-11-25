import { expect, it, vi } from "vitest";
import { dailyFetch } from "../src/daily";
import { paperSchema, schemas } from "../src/contracts/index";
it("L3 explains that deferred counts unique venue papers beyond 150, retains progress and excludes arXiv", async () => {
  const day = "2026-11-17",
    complete = vi.fn(async () => {});
  const papers = Array.from({ length: 218 }, (_, i) =>
    paperSchema.parse({
      key: `doi:10.1234/${i}`,
      title: `Venue ${String.fromCharCode(256 + i)}`,
      authors: [`Author ${i}`],
      source: "crossref",
      identifiers: [{ scheme: "doi", value: `10.1234/${i}` }],
    }),
  );
  const arxiv = paperSchema.parse({
    key: "2611.00001",
    title: "Arxiv",
    source: "arxiv",
    identifiers: [{ scheme: "arxiv", value: "2611.00001" }],
  });
  const api = {
    get: vi.fn(async (path: string) =>
      path.startsWith("/feed/history")
        ? { items: [], nextCursor: null }
        : path.startsWith("/sync/")
          ? null
          : path === "/feed/days?limit=100"
            ? []
            : { day, status: "pending", counts: {}, items: [] },
    ),
    write: vi.fn(
      async (_path: string, _body: unknown, _estimate: number) => ({}),
    ),
  };
  const result = schemas.fetchReport.parse(
    await dailyFetch(
      day,
      api,
      async () => ({
        days: { [day]: [...papers, papers[0]!, arxiv] },
        gaps: [],
        cursor: "next",
        invalid: [
          { day, id: "invalid", field: "links.0.url", reason: "Invalid URL" },
        ],
        complete,
      }),
      [],
    ),
  );
  expect(result).toMatchObject({ added: 151, deferred: 68, skipped: 1 });
  expect(result.deferredExplanation).toMatch(/150.*per.*day/i);
  expect(result.deferredExplanation).toMatch(/deduplicated.*venue/i);
  expect(result.deferredExplanation).toMatch(/next fetch/i);
  expect(api.write.mock.calls.some(([p]) => p === "/ingest/legacy")).toBe(
    false,
  );
  expect(complete).not.toHaveBeenCalled();
});
