import { expect, it } from "vitest";
import {
  measureWriteBreakdown,
  measureWriteCosts,
} from "../scripts/write-cost";
import { migrationFiles } from "./harness";
import { writeEvidence } from "./evidence";
// Writes 100 papers through a local D1; shared CI runners need more than the default 15 s.
const MEASUREMENT_TIMEOUT_MS = 120_000;
it(
  "W1 measures the actual ingest paths with local D1 metadata and unchanged replays",
  async () => {
    const cost = await measureWriteCosts(100);
    expect(cost.paperRowsPerPaper).toBeGreaterThan(1);
    expect(cost.paperRowsPerPaper).toBeLessThanOrEqual(30);
    expect(cost.summaryRowsPerSummary).toBeGreaterThan(1);
    expect(cost.summaryRowsPerSummary).toBeLessThan(16);
    expect(cost.unchangedRowsWritten).toBe(0);
    // Two links per paper, each with one table write and two index writes.
    expect(cost.paperWrites.paper_links).toBe(cost.papers * 6);
    // The vault title key adds one index write. The title/TL;DR search index stays untouched.
    expect(cost.metadataRows).toBeLessThanOrEqual(cost.papers * 5);
  },
  MEASUREMENT_TIMEOUT_MS,
);

it(
  "attributes D1 writes for each phase to named tables and indexes",
  async () => {
    const before = await measureWriteBreakdown("0016");
    const after = await measureWriteBreakdown("0022");
    expect(before.paper.rowsWritten).toBe(41);
    expect(after.paper.rowsWritten).toBeLessThanOrEqual(30);
    expect(before.paper.tables).toMatchObject({
      paper_ids: 2,
      paper_links: 2,
      feed_read_counts: 2,
      paper_fts: 1,
    });
    expect(before.paper.indexes).toMatchObject({
      paper_ids_backup_key: 2,
      paper_ids_value: 2,
      sqlite_autoindex_paper_ids_1: 2,
      paper_links_check_queue: 2,
    });
    expect(after.paper.indexes).toHaveProperty("paper_ids_backup_key", 2);
    expect(after.paper.indexes).not.toHaveProperty("paper_ids_value");
    expect(after.paper.newFtsShadowRows).toEqual({
      paper_fts_idx: 1,
      paper_fts_data: 1,
    });
    expect(after.summary.tables).toEqual({
      summaries: 1,
      feed_read_counts: 1,
      papers: 1,
      paper_fts: 2,
    });
    expect(after.digest.rowsWritten).toBe(5);
    expect(after.feedDay.rowsWritten).toBe(2);
    expect(after.replay.rowsWritten).toBe(0);
    expect(after.vaultRefresh.rowsWritten).toBe(0);
    for (const result of [before, after])
      for (const cost of Object.values(result))
        expect(
          [
            ...Object.values(cost.tables),
            ...Object.values(cost.indexes),
          ].reduce((total, rows) => total + rows, 0),
        ).toBe(cost.rowsWritten);
  },
  MEASUREMENT_TIMEOUT_MS,
);

it(
  "keeps ingest write costs steady through 0015 and 0016",
  async () => {
    const baseline = await measureWriteCosts(
      1,
      true,
      migrationFiles.filter((file) => file < "0015"),
    );
    const current = await measureWriteCosts(
      1,
      true,
      migrationFiles.filter((file) => file < "0017"),
    );
    await writeEvidence("m3e-ingest-cost.json", { baseline, current });
    expect(current.paperWrites).toEqual(baseline.paperWrites);
    expect(current.paperRows).toBe(baseline.paperRows);
  },
  MEASUREMENT_TIMEOUT_MS,
);
