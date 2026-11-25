import type { Notice } from "@litscout/core/types";
import type { SourceEnv } from "@litscout/sources/env";
import {
  sourceDeps,
  limiter,
  RateLimitedError,
} from "@litscout/sources/limiter/source-limiter";
import {
  budgetNotice,
  createOpenAlexClient,
  type OpenAlexClient,
} from "@litscout/sources/sources/openalex";
import { createS2Client, type S2Client } from "@litscout/sources/sources/s2";
import { track, failureReason, type SourceReport } from "./provenance";
import {
  createArxivClient,
  type ArxivClient,
} from "@litscout/sources/sources/arxiv";
import {
  createOpenReviewClient,
  type OpenReviewClient,
} from "@litscout/sources/sources/openreview";
import {
  createCoreClient,
  type CoreClient,
} from "@litscout/sources/sources/core";
export interface ToolContext {
  readonly core?: CoreClient;
  readonly openreview?: OpenReviewClient;
  readonly arxiv?: ArxivClient;
  readonly s2: S2Client;
  readonly oa: OpenAlexClient;
  readonly notices: Notice[];
  readonly report?: SourceReport;
}
export function createToolContext(env: SourceEnv): ToolContext {
  const report: SourceReport = { sources_used: [], sources_skipped: [] };
  return {
    core: track(
      createCoreClient({
        apiKey: env.CORE_API_KEY,
        ...sourceDeps(env, "core"),
      }),
      "core",
      report,
    ),
    openreview: track(
      createOpenReviewClient(sourceDeps(env, "openreview")),
      "openreview",
      report,
    ),
    arxiv: track(
      createArxivClient({
        fetchImpl: async (input) => {
          const r = await limiter(env, "arxiv").arxivFetch(String(input));
          return new Response(r.body, { status: r.status, headers: r.headers });
        },
      }),
      "arxiv",
      report,
    ),
    s2: track(
      createS2Client({
        apiKey: env.S2_API_KEY || undefined,
        ...sourceDeps(env, "s2"),
      }),
      "s2",
      report,
    ),
    oa: track(
      createOpenAlexClient({
        apiKey: env.OPENALEX_API_KEY || undefined,
        ...sourceDeps(env, "openalex"),
      }),
      "openalex",
      report,
    ),
    notices: [],
    report,
  };
}
/** Report order, so a query gets the same report whichever source answers first. */
const sourceOrder = [
  "s2",
  "openalex",
  "arxiv",
  "core",
  "openreview",
  "venue_table",
];
const rank = (source: string) => {
  const index = sourceOrder.indexOf(source);
  return index < 0 ? sourceOrder.length : index;
};
export function sourceReport(ctx: ToolContext): SourceReport {
  const report = ctx.report ?? { sources_used: [], sources_skipped: [] };
  return {
    sources_used: report.sources_used.toSorted((a, b) => rank(a) - rank(b)),
    sources_skipped: report.sources_skipped.toSorted(
      (a, b) => rank(a.source) - rank(b.source),
    ),
  };
}
export async function withFallback<T>(
  ctx: ToolContext,
  primary: () => Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> {
  try {
    return await primary();
  } catch (error) {
    ctx.notices.push({
      level: "warn",
      text: `${error instanceof RateLimitedError ? "Semantic Scholar queue is full" : failureReason(error)} (source unavailable); fell back to OpenAlex.`,
    });
    return fallback();
  }
}
export async function optional<T>(
  operation: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await operation();
  } catch {
    return fallback;
  }
}
export function collectNotices(ctx: ToolContext): Notice[] {
  const budget = budgetNotice();
  return budget ? [...ctx.notices, budget] : [...ctx.notices];
}
