import { expect, it } from "vitest";
import { estimateSize } from "../scripts/size-model";
import { selectedVariant } from "../scripts/fts-variants";
it("W1 separates measured paper and summary row changes including FTS", () => {
  const measured = estimateSize(1000, "lean");
  expect(measured.sqlitePaperRowsPerPaper).toBeGreaterThan(0);
  expect(measured.sqliteSummaryRowsPerSummary).toBeGreaterThan(1);
  expect(
    measured.sqlitePaperRowsPerPaper +
      measured.sqliteSummaryRowsPerSummary +
      measured.sqliteCommitRowsPerPaper,
  ).toBeCloseTo(measured.sqliteRowsWrittenPerPaper, 5);
  expect(measured.sqliteSummaryRowsPerSummary).toBeLessThan(16);
});
it("compares the same byte-sized deterministic workload and selects the smaller index", () => {
  const compact = estimateSize(1000, "compact");
  const lean = estimateSize(1000, "lean");
  expect(
    compact.bytesPerPaper > 6000 || compact.sqliteRowsWrittenPerPaper > 20,
  ).toBe(true);
  expect(lean.sqliteRowsWrittenPerPaper).toBeLessThan(
    compact.sqliteRowsWrittenPerPaper,
  );
  expect(lean.bytesPerPaper).toBeLessThan(compact.bytesPerPaper);
  expect(selectedVariant()).toBe("lean");
  expect(lean).toMatchObject({
    papers: 1000,
    titleBytes: 84,
    abstractBytes: 1362,
    summaryBytes: 1211,
  });
});
