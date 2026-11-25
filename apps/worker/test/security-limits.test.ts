import { beforeEach, afterEach, it, expect } from "vitest";
import { securityWorker } from "./helpers/security-worker";
let local: Awaited<ReturnType<typeof securityWorker>>;
beforeEach(async () => {
  local = await securityWorker();
});
afterEach(async () => {
  await local?.worker.dispose();
});
it("R8 declared-length and chunked 1.1 MB digest uploads return 413 through the local HTTP bridge", async () => {
  const text = JSON.stringify({
    day: "2026-11-17",
    bodyMd: "x".repeat(1100000),
  });
  const bytes = new TextEncoder().encode(text);
  const headers = {
    authorization: "Bearer " + local.tokens.ingest,
    "content-type": "application/json",
  };
  const declared = await local.endpoint.fetch(
    "https://local/api/v1/digests/2026-11-17",
    {
      method: "PUT",
      headers: { ...headers, "content-length": String(bytes.byteLength) },
      body: text,
    },
  );
  expect(declared.status).toBe(413);
  expect(await declared.json()).toMatchObject({
    error: { code: "PAYLOAD_TOO_LARGE" },
  });
  let offset = 0;
  const chunked = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        if (offset === bytes.length) {
          c.close();
          return;
        }
        const next = Math.min(offset + 32768, bytes.length);
        c.enqueue(bytes.subarray(offset, next));
        offset = next;
      },
    },
    { highWaterMark: 0 },
  );
  const response = await local.endpoint.fetch(
    "https://local/api/v1/digests/2026-11-17",
    {
      method: "PUT",
      headers,
      body: chunked,
      duplex: "half",
    } as unknown as Parameters<typeof local.endpoint.fetch>[1],
  );
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({
    error: { code: "PAYLOAD_TOO_LARGE" },
  });
  expect(offset).toBe(bytes.length);
});
it("S2 returns 413 by actual bytes, including streams without content-length; all ingest and digests have a 512 KB limit", async () => {
  const body = { summaries: [], padding: "x".repeat(1024 * 1024) };
  expect((await local.call("/ingest/summaries", "POST", body)).status).toBe(
    413,
  );
  expect(
    (
      await local.call("/ingest/summaries", "POST", {
        padding: "界".repeat(350000),
      })
    ).status,
  ).toBe(413);
  expect(
    (
      await local.call("/digests/2026-11-17", "PUT", {
        day: "2026-11-17",
        bodyMd: "x".repeat(1100000),
      })
    ).status,
  ).toBe(413);
  expect(
    (
      await local.call("/digests/2026-11-17", "PUT", {
        bodyMd: "x".repeat(2 * 1024 * 1024),
      })
    ).status,
  ).toBe(413);
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(700000));
      c.enqueue(new Uint8Array(700000));
      c.close();
    },
  });
  const response = await local.endpoint.fetch(
    "https://local/api/v1/ingest/papers",
    {
      method: "POST",
      headers: { authorization: "Bearer " + local.tokens.ingest },
      body: stream,
      duplex: "half",
    } as unknown as Parameters<typeof local.endpoint.fetch>[1],
  );
  expect(response.status).toBe(413);
});
it("S2 accepts exactly 20 identifiers within D1's 100 bound parameters", async () => {
  const paper = {
    key: "many-ids",
    title: "Metadata",
    source: "test",
    identifiers: Array.from({ length: 20 }, (_, i) => ({
      scheme: "doi",
      value: `10.1234/limit${i}`,
    })),
  };
  expect(
    (
      await local.call("/ingest/papers", "POST", {
        day: "2026-11-17",
        papers: [paper],
      })
    ).status,
  ).toBe(200);
  expect(
    await local.db
      .prepare(
        "SELECT count(*) AS n FROM paper_ids WHERE value LIKE '10.1234/limit%'",
      )
      .first("n"),
  ).toBe(20);
  expect(
    (
      await local.call("/ingest/papers", "POST", {
        day: "2026-11-17",
        papers: [
          {
            ...paper,
            identifiers: [
              ...paper.identifiers,
              { scheme: "doi", value: "10.1234/overflow" },
            ],
          },
        ],
      })
    ).status,
  ).toBe(200);
  expect(
    await local.db
      .prepare(
        "SELECT count(*) AS n FROM paper_ids WHERE value LIKE '10.1234/limit%'",
      )
      .first("n"),
  ).toBe(20);
});
it("S4 ingest cannot mutate final digests, while an additional write scope can", async () => {
  const path = "/digests/2026-11-16",
    body = { day: "2026-11-16", bodyMd: "Original", final: true };
  expect((await local.call(path, "PUT", body)).status).toBe(200);
  expect(
    (await local.call(path, "PUT", { ...body, bodyMd: "Attack" })).status,
  ).toBe(409);
  expect(await (await local.call(path + "?lang=en")).json()).toMatchObject({
    data: { bodyMd: "Original", final: true },
  });
  expect(
    (await local.call(path, "PUT", { ...body, bodyMd: "Authorized" }, "admin"))
      .status,
  ).toBe(200);
});
it("S2 persists D1 row counts, refuses writes at the UTC-day quota and leaves other days independent", async () => {
  const day = new Date().toISOString().slice(0, 10),
    resume = new Date(Date.parse(day) + 86400000).toISOString();
  const first = (await (
    await local.call("/ingest/feed-day", "POST", {
      day: "2026-11-17",
      status: "crawled",
    })
  ).json()) as {
    meta: {
      rowsWritten: number;
      authRowsWritten: number;
      budgetRowsWritten: number;
    };
  };
  const previous = await local.db
    .prepare("SELECT rows_written FROM daily_write_usage WHERE day=?")
    .bind(day)
    .first<number>("rows_written");
  expect(previous).toBeGreaterThan(0);
  expect(previous).toBe(
    first.meta.rowsWritten +
      first.meta.authRowsWritten +
      first.meta.budgetRowsWritten,
  );
  await local.db
    .prepare(
      "UPDATE daily_write_usage SET rows_written=80000,reserved=0 WHERE day=?",
    )
    .bind(day)
    .run();
  const response = await local.call("/ingest/feed-day", "POST", {
    day: "2026-11-18",
    status: "crawled",
  });
  expect(response.status).toBe(429);
  expect(await response.json()).toMatchObject({
    error: { retry_after: resume },
  });
  expect(
    await local.db
      .prepare("SELECT count(*) AS n FROM feed_days WHERE day='2026-11-18'")
      .first("n"),
  ).toBe(0);
  expect((await local.call("/feed/days")).status).toBe(200);
  await local.db
    .prepare("UPDATE daily_write_usage SET day='2000-01-01' WHERE day=?")
    .bind(day)
    .run();
  expect(
    (
      await local.call("/ingest/feed-day", "POST", {
        day: "2026-11-18",
        status: "crawled",
      })
    ).status,
  ).toBe(200);
});
