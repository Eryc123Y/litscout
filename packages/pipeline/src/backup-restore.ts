import type { BackupBundle } from "./backup-contracts";
import {
  restoreOrder,
  restorePageBytes,
  restorePageCost,
  restorePageRows,
  restorePageSize,
  restorePersonalSections,
  restoreRowCost,
  restoreRowLimit,
  type RestoreItem,
  type RestorePage,
  type RestoreResult,
} from "./backup-restore-contracts";

export class RestoreError extends Error {}
/** The instance refused a page because today's write budget is spent. */
export class RestoreBudgetStop extends Error {
  constructor() {
    super("Daily write budget reached");
  }
}

const utf8 = new TextEncoder();
const rowBytes = (item: RestoreItem) =>
  utf8.encode(JSON.stringify(item)).length + 1;

/**
 * Pages in dependency order, within the row, byte and reservation caps. The
 * split depends only on the bundle, so a saved page index resumes the same work.
 */
export function* restorePages(bundle: BackupBundle): Generator<RestorePage> {
  for (const section of restoreOrder) {
    let items: RestoreItem[] = [];
    let bytes = 0;
    let rows = 2;
    for (const item of bundle.data[section] as RestoreItem[]) {
      const size = rowBytes(item);
      if (size > restorePageBytes)
        throw new RestoreError(
          `A ${section} row is too large to restore (${size} bytes).`,
        );
      const cost = restoreRowCost(section, item);
      if (cost > restoreRowLimit)
        throw new RestoreError(
          `A ${section} row needs ${cost} rows written, more than one day allows.`,
        );
      if (
        items.length === restorePageSize ||
        bytes + size > restorePageBytes ||
        (items.length > 0 && rows + cost > restorePageRows)
      ) {
        yield { section, items } as RestorePage;
        items = [];
        bytes = 0;
        rows = 2;
      }
      items = [...items, item];
      bytes += size;
      rows += cost;
    }
    if (items.length) yield { section, items } as RestorePage;
  }
}

/** Rows to restore, pages, and the most rows they can write. */
export function restorePlan(bundle: BackupBundle) {
  const pages = [...restorePages(bundle)];
  const personal = pages.findIndex(({ section }) =>
    (restorePersonalSections as readonly string[]).includes(section),
  );
  return {
    /** Pages before this index write no personal rows. */
    firstPersonalPage: personal === -1 ? pages.length : personal,
    rows: Object.fromEntries(
      restoreOrder.map((section) => [section, bundle.data[section].length]),
    ),
    pages: pages.length,
    maxRowsWritten: pages.reduce((sum, page) => sum + restorePageCost(page), 0),
  };
}

export type RestoreTotals = {
  inserted: number;
  skipped: number;
  rowsWritten: number;
};
export type RestoreProgress = RestoreTotals & { next: number; pages: number };
type Write = (page: RestorePage) => Promise<RestoreResult & RestoreTotals>;
type Options = {
  /** The first page to write: a saved checkpoint's `next`. */
  from?: number;
  /** Totals carried over from earlier runs. */
  totals?: RestoreTotals;
  /** Rows this run may write. A page that could exceed them waits. */
  maxRows?: number;
  onPage?: (progress: RestoreProgress) => Promise<void> | void;
};

/** Write pages in order until done, or until the budget stops the next one. */
export async function restoreBackup(
  write: Write,
  bundle: BackupBundle,
  { from = 0, totals, maxRows, onPage }: Options = {},
) {
  const pages = [...restorePages(bundle)];
  let progress: RestoreProgress = {
    inserted: totals?.inserted ?? 0,
    skipped: totals?.skipped ?? 0,
    rowsWritten: totals?.rowsWritten ?? 0,
    next: from,
    pages: pages.length,
  };
  let allowance = maxRows;
  for (let index = from; index < pages.length; index++) {
    const page = pages[index]!;
    if (allowance !== undefined && restorePageCost(page) > allowance)
      return { status: "budget" as const, ...progress };
    let result;
    try {
      result = await write(page);
    } catch (error) {
      if (error instanceof RestoreBudgetStop)
        return { status: "budget" as const, ...progress };
      throw error;
    }
    if (allowance !== undefined) allowance -= result.rowsWritten;
    progress = {
      ...progress,
      inserted: progress.inserted + result.inserted,
      skipped: progress.skipped + result.skipped,
      rowsWritten: progress.rowsWritten + result.rowsWritten,
      next: index + 1,
    };
    await onPage?.(progress);
  }
  return { status: "done" as const, ...progress };
}
