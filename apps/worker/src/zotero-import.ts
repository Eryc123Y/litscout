import type { Context } from "hono";
import { drizzle } from "drizzle-orm/d1";
import {
  applyZoteroBatch,
  planZoteroBatch,
  zoteroCheckpoint,
} from "@litscout/db/zotero-import";
import {
  reserveWriteBudget,
  settleWriteBudget,
} from "@litscout/db/write-budget";
import {
  zoteroBatch,
  zoteroBatchSize,
  zoteroEntry,
  zoteroId,
  type ZoteroEntry,
} from "@litscout/pipeline/zotero-contracts";
import { groupZoteroEntries } from "@litscout/pipeline/zotero-import";
import type { WorkerBindings } from "./api-auth";
import { apiJson } from "./api-response";
import { userDay } from "./instance-day";
import { citations, resolutionHttp } from "./resolution-http";
import { resolutionSources } from "./resolution-sources";
import { quotaResponse } from "./write-quota";

function fallbackMetadata(env: WorkerBindings["Bindings"]) {
  const http = resolutionHttp(2 * zoteroBatchSize);
  const sources = resolutionSources(env, http);
  return async (entry: ZoteroEntry): Promise<ZoteroEntry> => {
    const doi = zoteroId(entry.doi);
    const arxiv = zoteroId(entry.arxiv);
    let metadata: Partial<ZoteroEntry> | undefined;
    if (doi) {
      const works = await sources.crossref(doi).catch(() => []);
      const work = works.find(
        (work) => zoteroId(work.doi)?.value === doi.value,
      );
      if (work)
        metadata = {
          title: work.title,
          authors: work.authors.map((author) => author.name),
          year: work.year,
          venue: work.venue,
        };
    }
    if (!metadata && arxiv) {
      const page = await http.page(
        new URL("https://arxiv.org/abs/" + arxiv.value),
        0,
      );
      if (page) {
        const fields = citations(page.html);
        metadata = {
          title: fields.get("citation_title")?.[0],
          authors: fields.get("citation_author"),
          year:
            Number(fields.get("citation_date")?.[0]?.match(/^\d{4}/)?.[0]) ||
            undefined,
        };
      }
    }
    const title = metadata?.title?.trim().slice(0, 1000);
    if (!title) return entry;
    return zoteroEntry.parse({
      ...entry,
      title,
      authors: entry.authors.length
        ? entry.authors
        : (metadata?.authors ?? [])
            .map((author) => author.trim().slice(0, 300))
            .filter(Boolean)
            .slice(0, 50),
      year:
        entry.year ??
        (metadata?.year && metadata.year >= 1 && metadata.year <= 9999
          ? metadata.year
          : undefined),
      venue:
        entry.venue ?? (metadata?.venue?.trim().slice(0, 500) || undefined),
    });
  };
}

export async function importZotero(c: Context<WorkerBindings>) {
  const batch = zoteroBatch.parse(await c.req.json());
  const db = c.env.DB!;
  const now = new Date();
  const day = userDay(c.env, now);
  const at = now.toISOString();
  const resolve = fallbackMetadata(c.env);
  let records = groupZoteroEntries(batch.entries).entries;
  for (let attempt = 0; attempt < 2; attempt++) {
    const checkpoint = batch.dryRun
      ? undefined
      : await zoteroCheckpoint(db, batch);
    if (
      checkpoint &&
      checkpoint.progress.next > batch.offset &&
      checkpoint.progress.next <= batch.total
    )
      return apiJson(c, { success: true, data: checkpoint.progress });
    if (checkpoint && checkpoint.progress.next !== batch.offset) break;

    let plan = await planZoteroBatch(db, batch, records, checkpoint, day, at);
    if (plan.unresolved.length && !attempt) {
      const recovered: ZoteroEntry[] = [];
      // Keep open metadata connections below the Worker's concurrency cap.
      for (let start = 0; start < plan.unresolved.length; start += 5) {
        const indices = plan.unresolved.slice(start, start + 5);
        recovered.push(
          ...(await Promise.all(
            indices.map((index) => resolve(records[index]!)),
          )),
        );
      }
      if (recovered.some((record) => record.title)) {
        const unresolved = new Set(plan.unresolved);
        // File titles take precedence if a lookup reveals a duplicate.
        records = groupZoteroEntries([
          ...records.filter((_, index) => !unresolved.has(index)),
          ...recovered,
        ]).entries;
        plan = await planZoteroBatch(db, batch, records, checkpoint, day, at);
      }
    }
    if (!checkpoint) return apiJson(c, { success: true, data: plan.progress });

    // Reserving the entire batch before any library writes is the budget pre-check.
    const lease = await reserveWriteBudget(
      db,
      plan.cost,
      new Date(),
      plan.cost,
    );
    if (!lease) return quotaResponse(c, plan.cost);
    let rowsWritten: number;
    try {
      rowsWritten = await applyZoteroBatch(drizzle(db), checkpoint, plan, at);
    } catch (error) {
      const conflict =
        /malformed JSON|revision conflict|UNIQUE constraint/i.test(
          String(error),
        );
      await settleWriteBudget(db, lease, 0, !conflict);
      if (conflict) continue;
      throw error;
    }
    c.set("budgetRowsWritten", await settleWriteBudget(db, lease, rowsWritten));
    return apiJson(c, {
      success: true,
      data: plan.progress,
      meta: { rowsWritten },
    });
  }
  return apiJson(
    c,
    {
      success: false,
      error: {
        code: "CONFLICT",
        message:
          "Import progress or a matching paper changed. Run the same import to resume.",
      },
    },
    409,
  );
}
