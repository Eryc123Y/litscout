import { beforeAll, afterAll, expect, it } from "vitest";
import { securityWorker } from "./helpers/security-worker";
let local: Awaited<ReturnType<typeof securityWorker>>;
const day = new Date().toISOString().slice(0, 10);
const papers = Array.from({ length: 40 }, (_, n) => ({
  key: `2611.${String(n).padStart(5, "0")}`,
  title: `Measured paper ${n}`,
  source: "arxiv",
  identifiers: [
    { scheme: "arxiv", value: `2611.${String(n).padStart(5, "0")}` },
  ],
  links: [
    { kind: "landing", url: `https://arxiv.org/abs/2611.${n}` },
    { kind: "pdf_arxiv", url: `https://arxiv.org/pdf/2611.${n}` },
  ],
}));
beforeAll(async () => {
  local = await securityWorker();
});
afterAll(async () => {
  await local?.worker.dispose();
});
async function used(rows: number, reserved = 0) {
  await local.db
    .prepare(
      "INSERT INTO daily_write_usage(day,rows_written,reserved) VALUES (?,?,?) ON CONFLICT(day) DO UPDATE SET rows_written=excluded.rows_written,reserved=excluded.reserved",
    )
    .bind(day, rows, reserved)
    .run();
}
it("W1 accepts 40 papers at 70,000 and settles their actual cost", async () => {
  await used(70000);
  const response = await local.call("/ingest/papers", "POST", {
    day: "2026-11-17",
    papers,
  });
  expect(response.status).toBe(200);
  const out = (await response.json()) as {
    meta: {
      rowsWritten: number;
      authRowsWritten: number;
      budgetRowsWritten: number;
    };
  };
  expect(
    await local.db
      .prepare(
        "SELECT rows_written,reserved FROM daily_write_usage WHERE day=?",
      )
      .bind(day)
      .first(),
  ).toEqual({
    rows_written:
      70000 +
      out.meta.rowsWritten +
      out.meta.authRowsWritten +
      out.meta.budgetRowsWritten,
    reserved: 0,
  });
});
it("W1 accepts 40 summaries at 70,000 using their measured reservation", async () => {
  await used(0);
  await local.call("/ingest/papers", "POST", { day: "2026-11-17", papers });
  const rows = await local.db
    .prepare("SELECT id FROM papers ORDER BY id")
    .all<{ id: string }>();
  const content = {
    tldr: "One",
    motivation: "Two",
    method: "Three",
    result: "Four",
    conclusion: "Five",
  };
  await used(70000);
  const response = await local.call("/ingest/summaries", "POST", {
    summaries: rows.results.map((p) => ({ paperId: p.id, content })),
  });
  expect(response.status).toBe(200);
  expect(
    ((await response.json()) as { data: { accepted: number } }).data.accepted,
  ).toBe(40);
});
it("W1/W2 refuses 40 papers at 79,000 and reports matching budget fields in body and headers", async () => {
  await used(79000, 100);
  const response = await local.call("/ingest/papers", "POST", {
    day: "2026-11-17",
    papers,
  });
  expect(response.status).toBe(429);
  const out = (await response.json()) as { error: Record<string, unknown> };
  expect(out.error).toMatchObject({
    code: "WRITE_BUDGET_EXCEEDED",
    used: 79000,
    reserved: 100,
    limit: 80000,
    needed: 3082,
    remaining: 900,
    retry_after: new Date(Date.parse(day) + 86400000).toISOString(),
  });
  for (const field of ["used", "reserved", "limit", "needed", "remaining"])
    expect(response.headers.get(`X-Write-Budget-${field}`)).toBe(
      String(out.error[field]),
    );
  expect(response.headers.get("Retry-After")).toMatch(/^\d+$/);
  expect(response.headers.get("X-Write-Budget-Retry-After")).toBe(
    out.error.retry_after,
  );
});
