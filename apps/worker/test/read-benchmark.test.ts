import { expect, it } from "vitest";
import { benchColdDays, benchRead } from "../scripts/bench-read";
it("F4 reads a synthetic 372-paper day without SQL or network", async () => {
  const result = await benchRead(2);
  expect(result.papers).toBe(372);
  expect(result.results.every((r) => r.status === 200)).toBe(true);
  expect(result.results.every((r) => r.medianMs > 0)).toBe(true);
});

it("measures the first paged archive request with the same fake D1 approach", async () => {
  expect(await benchColdDays()).toMatchObject({
    status: 200,
    bytes: 2703,
    cpuMs: expect.any(Number),
  });
});
