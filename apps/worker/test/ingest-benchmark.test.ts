import { expect, it } from "vitest";
import { benchIngest } from "../scripts/bench-ingest";
it("F4 exercises every requested size against only fake D1", async () => {
  const rows = await benchIngest(2);
  expect(rows.map((r) => r.papers)).toEqual([1, 10, 20, 40]);
  expect(rows.every((r) => r.medianMs > 0 && Number.isFinite(r.p95Ms))).toBe(
    true,
  );
});
