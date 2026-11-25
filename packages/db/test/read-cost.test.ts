import { expect, it } from "vitest";
import { writeEvidence } from "./evidence";
import { measureAppendCosts } from "../scripts/write-cost";
it("R11 appends 40 papers to 1000 with at most 100 D1 rows read per paper", async () => {
  const cost = await measureAppendCosts();
  await writeEvidence("m1c-r6-read-cost.json", cost);
  expect(cost.seeded).toEqual({
    papers: 1000,
    feedItems: 1000,
    summaries: 1000,
  });
  expect(cost.paperReadsPerPaper).toBeLessThanOrEqual(100);
  expect(cost.summaryReadsPerSummary).toBeLessThanOrEqual(100);
  expect(cost.unchanged).toBe(0);
}, 180_000);
