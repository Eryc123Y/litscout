import { expect, it } from "vitest";
import { backupDataSections, type BackupBundle } from "../src/backup-contracts";
import {
  restorePageCost,
  restorePageRows,
  restoreRowCost,
  restoreRowLimit,
} from "../src/backup-restore-contracts";
import {
  restoreBackup,
  RestoreError,
  restorePages,
  restorePlan,
} from "../src/backup-restore";

const at = "2026-11-19T00:00:00.000Z";
const digest = (i: number, radar: number) => ({
  day: `2026-10-${String(i + 1).padStart(2, "0")}`,
  lang: "en",
  kind: "daily" as const,
  body_md: "Digest",
  picks: [],
  radar: Array.from({ length: radar }, (_, j) => ({ paperId: `pap_${j}` })),
  final: 1 as const,
  created_at: at,
  updated_at: at,
  rev: 1,
});
const bundleWith = (digests: ReturnType<typeof digest>[]) =>
  ({
    sha256: "0".repeat(64),
    data: {
      ...Object.fromEntries(backupDataSections.map((section) => [section, []])),
      digests,
    },
  }) as unknown as BackupBundle;

it("splits pages by reservation as well as by rows", () => {
  const digests = Array.from({ length: 10 }, (_, i) => digest(i, 300));
  const pages = [...restorePages(bundleWith(digests))];
  expect(pages.map((page) => page.items.length)).toEqual([2, 2, 2, 2, 2]);
  for (const page of pages)
    expect(restorePageCost(page)).toBeLessThanOrEqual(restorePageRows);
  expect(restorePlan(bundleWith(digests))).toMatchObject({
    pages: 5,
    rows: { digests: 10 },
  });
});

it("gives a costly row its own page and refuses one too large for a day", () => {
  const large = digest(0, 1000);
  expect(restoreRowCost("digests", large)).toBeGreaterThan(restorePageRows);
  const pages = [
    ...restorePages(bundleWith([digest(1, 1), large, digest(2, 1)])),
  ];
  expect(pages.map((page) => page.items.length)).toEqual([1, 1, 1]);

  const huge = digest(3, 14_000);
  expect(restoreRowCost("digests", huge)).toBeGreaterThan(restoreRowLimit);
  expect(() => [...restorePages(bundleWith([huge]))]).toThrow(RestoreError);
  expect(() => [...restorePages(bundleWith([huge]))]).toThrow(
    /digests row needs .* rows/,
  );
});

it("stops before a page that could exceed the row limit and carries totals", async () => {
  const bundle = bundleWith(
    Array.from({ length: 4 }, (_, i) => digest(i, 300)),
  );
  const written: number[] = [];
  const write = async (page: { items: unknown[] }) => {
    written.push(page.items.length);
    return { inserted: page.items.length, skipped: 0, rowsWritten: 1500 };
  };
  const first = await restoreBackup(write, bundle, { maxRows: 2000 });
  expect(first).toMatchObject({ status: "budget", next: 1, inserted: 2 });
  const second = await restoreBackup(write, bundle, {
    from: first.next,
    totals: first,
  });
  expect(second).toMatchObject({
    status: "done",
    next: 2,
    inserted: 4,
    rowsWritten: 3000,
  });
  expect(written).toEqual([2, 2]);
});
