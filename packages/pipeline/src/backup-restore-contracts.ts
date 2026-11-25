import { z } from "zod";
import {
  backupDataSections,
  backupIdentifierSchema,
  backupLinkSchema,
  backupPageSize,
  backupPaperRecordSchema,
  backupSectionSchemas,
  backupSections,
} from "./backup-contracts";

/** Owner-only: the route sits under /backup, which needs the write scope. */
export const restorePath = "/backup/restore";

/** Parents before children, so each foreign key finds its row. */
export const restoreOrder = [
  "topics",
  "papers",
  "paperIdentifiers",
  "paperLinks",
  "vaultIndex",
  "projects",
  "ideaIndex",
  "workingPaperIndex",
  "vaultRequests",
  "captures",
  "suggestions",
  "library",
  "alphaXiv",
  "paperState",
  "quickNotes",
  "digests",
  "weeklyDigests",
] as const satisfies readonly (typeof backupDataSections)[number][];
export type RestoreSection = (typeof restoreOrder)[number];

export const restoreItemSchemas = {
  ...backupSectionSchemas,
  papers: backupPaperRecordSchema,
  paperIdentifiers: backupIdentifierSchema,
  paperLinks: backupLinkSchema,
} satisfies Record<RestoreSection, z.ZodType>;
export type RestoreItem<S extends RestoreSection = RestoreSection> = z.output<
  (typeof restoreItemSchemas)[S]
>;
export type RestorePage = {
  [S in RestoreSection]: { section: S; items: RestoreItem<S>[] };
}[RestoreSection];

export const restorePageSize = backupPageSize;
/** Below the Worker's 1 MiB request cap, with room for the JSON framing. */
export const restorePageBytes = 768 * 1024;
/** Most rows a page of several items may reserve; a costlier row goes alone. */
export const restorePageRows = 2_000;
/** Half the 80,000-row daily limit: a row that needs more cannot restore. */
export const restoreRowLimit = 40_000;

const sectionOnly = z.object({ section: z.enum(restoreOrder) });
export function parseRestorePage(input: unknown): RestorePage {
  const { section } = sectionOnly.parse(input);
  return z
    .strictObject({
      section: z.literal(section),
      items: z.array(restoreItemSchemas[section]).min(1).max(restorePageSize),
    })
    .parse(input) as RestorePage;
}

const count = z.number().int().nonnegative();
export const restoreResultSchema = z.strictObject({
  inserted: count,
  skipped: count,
});
export type RestoreResult = z.output<typeof restoreResultSchema>;

/** Sections whose rows mean the instance already holds someone's data. */
export const restorePersonalSections = backupSections.filter(
  (section) => section !== "topics",
);
export const restoreStatusSchema = z.strictObject({
  personalRows: count,
  counts: z.record(z.enum(backupDataSections), count),
});
export type RestoreStatus = z.output<typeof restoreStatusSchema>;

/**
 * Rows one insert writes in local D1 (the row, its indexes and the triggers
 * that index it), measured per section with about 40% headroom. Long text
 * does not change the count, for one row or a full page of 25 (measured).
 * A reservation, not a billing estimate.
 */
const rowCost: Record<RestoreSection, number> = {
  topics: 4,
  papers: 9,
  paperIdentifiers: 3,
  paperLinks: 4,
  vaultIndex: 10,
  projects: 8,
  ideaIndex: 5,
  workingPaperIndex: 4,
  vaultRequests: 10,
  captures: 4,
  suggestions: 8,
  library: 7,
  alphaXiv: 9,
  paperState: 4,
  quickNotes: 7,
  digests: 5,
  weeklyDigests: 5,
};
/** A retention reference or a folder count with its index entry (2 measured). */
const referenceCost = 3;

function references(section: RestoreSection, item: RestoreItem) {
  const row = item as Record<string, unknown>;
  const length = (column: string) =>
    Array.isArray(row[column]) ? (row[column] as unknown[]).length : 0;
  switch (section) {
    case "digests":
    case "weeklyDigests":
      return length("picks") + length("radar");
    case "ideaIndex":
    case "workingPaperIndex":
    case "suggestions":
      return length("paper_ids");
    case "alphaXiv":
      return length("folders");
    default:
      return 0;
  }
}

export function restoreRowCost(section: RestoreSection, item: RestoreItem) {
  return rowCost[section] + referenceCost * references(section, item);
}

export function restorePageCost(page: RestorePage) {
  return (page.items as RestoreItem[]).reduce(
    (sum, item) => sum + restoreRowCost(page.section, item),
    2,
  );
}
