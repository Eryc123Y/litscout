import { z } from "zod";
import type { LitScoutConfig } from "@litscout/core";
import {
  pruneCursorSchema,
  pruneOverhead,
  prunePath,
  pruneResultSchema,
  retentionPageSize,
  retentionReasons,
} from "@litscout/pipeline/retention-contracts";
import { credential, type FlowDeps } from "./flow-runtime";
import { endpointConfig } from "./endpoint";
import { flowOptions } from "./flow-options";
import { UsageError } from "./command-types";
import { expiryReport } from "./expiry-report";

export function pruneOptions(args: readonly string[]) {
  const { values, positional } = flowOptions(args, ["dry-run", "over-cap"]);
  if (positional.length)
    throw new UsageError("Use prune [--dry-run] [--over-cap]");
  return {
    dryRun: values["dry-run"] === "true",
    overCap: values["over-cap"] === "true",
  };
}

const envelope = z.object({
  success: z.literal(true),
  data: pruneResultSchema,
});
export const databaseLimitBytes = 500_000_000;

export async function retentionReport(
  deps: FlowDeps,
  config: LitScoutConfig,
  dryRun: boolean,
  oldOnly = false,
) {
  const endpoint = (await endpointConfig(config, deps.dir)).config.instance
    .publicUrl;
  let token: string | undefined;
  const request = async ({
    after,
    waiting,
  }: {
    after?: z.infer<typeof pruneCursorSchema>;
    waiting?: number;
  }) => {
    if (!endpoint)
      throw new UsageError("Set instance.publicUrl before checking retention");
    token ??= await credential(deps, endpoint);
    const url = new URL("/api/v1" + prunePath, endpoint);
    if (dryRun && after) url.search = new URLSearchParams(after).toString();
    if (oldOnly) url.searchParams.set("oldOnly", "1");
    // Each advance is a fresh transaction. Retrying a lost response with
    // fewer candidates is safe because successful prunes have left the queue.
    const sizes =
      dryRun || waiting !== undefined
        ? [retentionPageSize]
        : [retentionPageSize, 5, 1];
    let status: number | undefined;
    for (const batchSize of sizes) {
      const response = await deps
        .fetch(url, {
          method: dryRun ? "GET" : "POST",
          headers: {
            authorization: "Bearer " + token,
            ...(dryRun ? {} : { "content-type": "application/json" }),
          },
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
          ...(dryRun
            ? {}
            : { body: JSON.stringify({ after, waiting, batchSize }) }),
        })
        .catch(() => undefined);
      status = response?.status;
      if (response?.ok) return envelope.parse(await response.json()).data;
      if (response && response.status < 500) break;
      void response?.body?.cancel().catch(() => {});
    }
    throw new UsageError(
      status
        ? `Retention request failed (HTTP ${status}).`
        : "Retention request could not reach the Worker.",
    );
  };

  const kept = { library: 0, reading: 0, digest: 0, research: 0, recent: 0 };
  const sample: string[] = [];
  let prunable = 0,
    waitingForBudget = 0,
    papersPruned = 0,
    rowsWritten = 0,
    young = 0;
  let remaining: number | undefined;
  let sizeBytes: number | null = null;
  let next: z.infer<typeof pruneCursorSchema> | undefined;
  let enabled = config.storage.prune;
  if (dryRun || enabled) {
    do {
      const page = await request({ after: next });
      enabled = enabled && page.enabled;
      sizeBytes = page.sizeBytes ?? sizeBytes;
      remaining ??= page.available;
      let batchCharge = 0;
      for (const row of page.rows) {
        for (const reason of retentionReasons)
          if (row.reasons.includes(reason)) kept[reason]++;
        if (!row.eligible) {
          if (!row.reasons.length) young++;
          continue;
        }
        prunable++;
        if (sample.length < 10) sample.push(row.title);
        if (!dryRun) continue;
        const cost = row.bound + (batchCharge === 0 ? pruneOverhead : 0);
        if (cost + batchCharge + pruneOverhead > remaining) waitingForBudget++;
        else batchCharge += cost;
      }
      remaining -= batchCharge;
      papersPruned += page.papersPruned;
      rowsWritten += page.rowsWritten;
      if (!dryRun) waitingForBudget += page.waiting;
      next = page.next ?? undefined;
    } while (next && (dryRun || enabled));
    if (!dryRun && enabled)
      rowsWritten += (await request({ waiting: waitingForBudget })).rowsWritten;
  }
  return {
    enabled,
    dryRun,
    sizeBytes,
    databaseLimitBytes,
    kept,
    young,
    prunable,
    waitingForBudget,
    papersPruned,
    rowsWritten,
    sample,
  };
}

export async function pruneCommand(
  args: readonly string[],
  deps: FlowDeps,
  config: LitScoutConfig,
) {
  const { dryRun, overCap } = pruneOptions(args);
  const report = await retentionReport(deps, config, dryRun);
  // Compaction first, so rows it makes compact today are never expired early.
  const expiry = await expiryReport(deps, config, dryRun, overCap);
  return { data: { ...report, expiry } };
}
