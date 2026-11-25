import { expect, it, vi } from "vitest";
import {
  connectionFailure,
  PayloadTooLarge,
  BatchRetry,
} from "../src/ingest-batching";
import { apiClient, WriteBudget } from "../src/api";
import { INGEST_CAPS } from "@litscout/core/ingest-limits";
const reset = () =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("write ECONNRESET"), { code: "ECONNRESET" }),
  });
it("R8 only a known oversize reset is classified as too large", () => {
  const cap = INGEST_CAPS.bytes;
  expect(connectionFailure(reset(), cap + 1, cap)).toBeInstanceOf(
    PayloadTooLarge,
  );
  for (const size of [0, cap - 1, cap]) {
    const error = connectionFailure(reset(), size, cap);
    expect(error).toBeInstanceOf(BatchRetry);
    expect(error).not.toBeInstanceOf(PayloadTooLarge);
  }
  expect(
    connectionFailure(
      Object.assign(new Error("unavailable"), { code: "ENOTFOUND" }),
      cap + 1,
      cap,
    ),
  ).not.toBeInstanceOf(PayloadTooLarge);
});
it("R8 a reset below the known cap keeps halving and replaying the same records", async () => {
  const sizes: number[] = [];
  const fetcher = vi.fn(async (_url, init) => {
    const n = JSON.parse(init.body).papers.length;
    sizes.push(n);
    if (n > 1) throw reset();
    return Response.json({
      success: true,
      data: { accepted: 1, papers: [] },
      meta: { rowsWritten: 0 },
    });
  });
  const budget = new WriteBudget(
    { day: "2026-11-17", rows: 0 },
    () => new Date("2026-11-17"),
    async () => {},
  );
  const api = apiClient(
    "https://local",
    "synthetic",
    fetcher as typeof fetch,
    budget,
    async () => {},
  );
  const out = await api.write(
    "/ingest/papers",
    { papers: [{ key: "one" }, { key: "two" }] },
    10,
  );
  expect(sizes).toEqual([2, 1, 1]);
  expect(out).toMatchObject({ accepted: 2, skipped: 0 });
  expect(api.batching.failures).toEqual([]);
});
