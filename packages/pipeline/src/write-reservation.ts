import { digestSuggestionLimit } from "@litscout/core/ingest-limits";
import { vaultWriteReservation } from "./vault-contracts";
import { trendsBatchSize, trendsUploadPath } from "./trends-contracts";
import { mirrorFolderCap, mirrorPath } from "./alphaxiv-contracts";
import { dailyRunPath, dailyRunReservation } from "./health-contracts";
/** Headroom above local SQLite/Miniflare measurements, not a billing estimate. */
export function paperReservation(value: unknown) {
  const paper =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const count = (key: string, maximum = 20) =>
    Array.isArray(paper[key]) ? Math.min(maximum, paper[key].length) : 0;
  return (
    64 + count("identifiers") * 3 + count("links") * 5 + count("topics", 50) * 2
  );
}
export function writeReservation(path: string, body: unknown, fallback = 0) {
  const value =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const count = (key: string) =>
    Array.isArray(value[key]) ? value[key].length : 0;
  if (
    ((path === "/ingest/papers" && value.legacy === "import") ||
      (path === "/ingest/summaries" && value.legacy === true)) &&
    typeof value.maxRows === "number"
  )
    return value.maxRows;
  if (path === "/ingest/papers" && Array.isArray(value.papers))
    return value.papers.reduce<number>(
      (total, paper) => total + paperReservation(paper),
      2,
    );
  if (path === "/ingest/summaries") return 16 * count("summaries") + 2;
  if (path === "/ingest/radar") return 8 * count("radar") + 2;
  if (path === "/ingest/legacy")
    return (
      8 *
        (count("cursors") +
          count("runs") +
          count("missed") +
          count("ratings")) +
      2
    );
  if (path === "/ingest/links") return 3 * Math.min(20, count("checks"));
  if (path === mirrorPath && Array.isArray(value.items))
    return value.items.reduce<number>(
      (total, item) =>
        total +
        65 +
        (item?.paperType === "public"
          ? 2 * mirrorFolderCap +
            (Array.isArray(item.folders) ? item.folders.length : 0)
          : 0),
      2,
    );
  if (path === mirrorPath + "/start" || path === mirrorPath + "/finish")
    return 8;
  if (path === trendsUploadPath)
    return Math.min(trendsBatchSize, count("rows"));
  if (path === "/ingest/feed-day") return 8;
  if (path === dailyRunPath) return dailyRunReservation;
  if (/^\/digests\/[^/]+$/.test(path)) {
    // Regeneration can remove an active row and its partial index entry.
    const replacements = value.final === true ? 0 : 2 * digestSuggestionLimit;
    const references =
      Math.min(1000, count("picks")) + Math.min(10_000, count("radar"));
    const proposalReferences = Array.isArray(value.suggestions)
      ? value.suggestions
          .slice(0, digestSuggestionLimit)
          .reduce(
            (sum, item: { paperIds?: unknown } | null) =>
              sum + (Array.isArray(item?.paperIds) ? item.paperIds.length : 0),
            0,
          )
      : 0;
    return (
      2 * (references + proposalReferences) +
      Math.max(
        32,
        6 +
          replacements +
          3 * Math.min(digestSuggestionLimit, count("suggestions")),
      )
    );
  }
  return vaultWriteReservation(path, body) || fallback;
}
/** Local D1 ingest measurements, with a floor for unmeasured paper shapes. */
/**
 * The Worker's estimate for one request. It must cover what the request
 * writes: any excess lowers the day's limit by 5,000 rows, so it stays
 * conservative (at least 37 rows a paper).
 */
export function measuredWriteEstimate(path: string, body: unknown) {
  const value =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  // A legacy import is quoted by the Worker; its cap is the charge.
  if (
    path === "/ingest/papers" &&
    value.legacy === "import" &&
    typeof value.maxRows === "number"
  )
    return value.maxRows;
  if (path === "/ingest/papers" && Array.isArray(value.papers))
    return value.papers.reduce<number>((total, input: unknown) => {
      const paper = (input ?? {}) as Record<string, unknown>;
      const count = (name: string, max: number) =>
        Array.isArray(paper[name]) ? Math.min(max, paper[name].length) : 0;
      const fresh = 19 + 4 * count("identifiers", 20) + 4 * count("links", 20);
      return total + Math.max(37, fresh + 3) + count("topics", 50);
    }, 3);
  if (path === "/ingest/summaries" && Array.isArray(value.summaries))
    return value.summaries.length * 6;
  return writeReservation(path, body);
}

/**
 * What a crawl will most likely write, for the daily fetch's check before it
 * starts. Measured in local D1 (apps/worker/test/crawl-estimate.test.ts,
 * 2026-11-19): a new paper writes about 18.5 rows, plus 2 per identifier, 3
 * per link and 1 per topic; this adds about 30% to each. Per-request
 * accounting keeps `measuredWriteEstimate`.
 */
export function crawlWriteEstimate(path: string, body: unknown) {
  const value =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (path !== "/ingest/papers" || value.legacy || !Array.isArray(value.papers))
    return measuredWriteEstimate(path, body);
  return value.papers.reduce<number>((total, input: unknown) => {
    const paper = (input ?? {}) as Record<string, unknown>;
    const count = (name: string, max: number) =>
      Array.isArray(paper[name]) ? Math.min(max, paper[name].length) : 0;
    return (
      total +
      24 +
      3 * count("identifiers", 20) +
      4 * count("links", 20) +
      count("topics", 50)
    );
  }, 3);
}
