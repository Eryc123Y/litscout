import productionWorker from "../src/index";
import { parseListing } from "@litscout/sources/listings";
import { listingInput } from "@litscout/pipeline/arxiv-listing-input";
import { validateRecords } from "@litscout/pipeline/records";
import {
  batchFor,
  fitBatch,
  payloadFor,
} from "@litscout/pipeline/ingest-batching";
import { ingestLimitsSchema } from "@litscout/core/ingest-limits";
import { countingDb } from "../test/helpers/counting-db";
import type { AppEnv } from "../src/env";

export { PairingStore, SourceLimiter } from "../src/index";

const limits = ingestLimitsSchema.parse({});

function plan(
  papers: Awaited<ReturnType<typeof parseListing>>["papers"],
  day: string,
) {
  const seen = new Set<string>();
  const unique = papers.filter(({ id }) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const { accepted, invalid } = validateRecords(day, unique, (paper) =>
    listingInput(paper as (typeof unique)[number]),
  );
  if (invalid.length) throw new Error("Invalid benchmark papers");
  const batch = batchFor("/ingest/papers", { day, papers: accepted }, limits)!;
  let batches = 0;
  for (let offset = 0; offset < batch.rows.length; batches++) {
    offset += fitBatch(
      Math.min(batch.cap, batch.rows.length - offset),
      limits.bytes,
      (size) => payloadFor(batch, offset, size),
    );
  }
  return { papers: accepted.length, batches };
}

export default {
  scheduled: productionWorker.scheduled,
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const day = url.searchParams.get("day") ?? "2026-11-17";
    if (url.pathname === "/noop") {
      await request.arrayBuffer();
      return Response.json({});
    }
    if (url.pathname === "/parse") {
      const result = await parseListing(
        await request.text(),
        url.searchParams.get("category")!,
        url.searchParams.get("kind") === "recent" ? "recent" : "new",
        day,
      );
      return Response.json({
        papers: result.papers.length,
        complete: result.complete,
        total: result.total,
      });
    }
    if (url.pathname === "/plan")
      return Response.json(plan(await request.json(), day));
    const counter = countingDb(env.DB!);
    const response = await productionWorker.fetch(
      request,
      { ...env, DB: counter.db },
      ctx,
    );
    const output = await response.json<object>();
    return Response.json(
      { ...output, d1Calls: counter.stats().calls },
      { status: response.status },
    );
  },
} satisfies ExportedHandler<AppEnv>;
