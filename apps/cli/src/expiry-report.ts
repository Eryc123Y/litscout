import { z } from "zod";
import type { LitScoutConfig } from "@litscout/core";
import {
  expirePath,
  expiryPreviewSchema,
  expiryResultSchema,
} from "@litscout/pipeline/retention-contracts";
import { credential, type FlowDeps } from "./flow-runtime";
import { endpointConfig } from "./endpoint";
import { UsageError } from "./command-types";

// A run expires at most this many pages (100 rows each); the next run goes on.
const maxPages = 50;

/** Compact rows past their horizon (`storage.compactMonths`, or over the
 * storage cap a week past the oldest row): a dry run previews them with
 * GET; otherwise pages are expired until one is not full. Later pages keep
 * the first page's horizon (`notAfter`), so over the cap only the oldest
 * week goes in one run. */
export async function expiryReport(
  deps: FlowDeps,
  config: LitScoutConfig,
  dryRun: boolean,
  overCap: boolean,
) {
  const endpoint = (await endpointConfig(config, deps.dir)).config.instance
    .publicUrl;
  if (!endpoint)
    throw new UsageError("Set instance.publicUrl before checking retention");
  const token = await credential(deps, endpoint);
  const url = new URL("/api/v1" + expirePath, endpoint);
  const send = async <T>(schema: z.ZodType<T>, body?: object) => {
    const response = await deps
      .fetch(url, {
        method: body ? "POST" : "GET",
        headers: {
          authorization: "Bearer " + token,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      .catch(() => undefined);
    if (!response?.ok)
      throw new UsageError(
        response
          ? `Expiry request failed (HTTP ${response.status}).`
          : "Expiry request could not reach the Worker.",
      );
    return z
      .object({ success: z.literal(true), data: schema })
      .parse(await response.json()).data;
  };
  if (dryRun) {
    if (overCap) url.searchParams.set("overCap", "1");
    const preview = await send(expiryPreviewSchema);
    return {
      enabled: preview.enabled,
      dryRun,
      before: preview.before,
      due: preview.count,
      oldestDay: preview.oldestDay,
      sample: preview.sample,
      expired: 0,
      rowsWritten: 0,
      waiting: 0,
    };
  }
  const body = overCap ? { overCap: true } : {};
  const first = await send(expiryResultSchema, body);
  let last = first,
    expired = first.expired,
    rowsWritten = first.rowsWritten;
  for (let page = 1; page < maxPages; page++) {
    if (!last.more || last.expired === 0 || last.waiting > 0) break;
    const next = await send(expiryResultSchema, {
      ...body,
      notAfter: first.before,
    });
    expired += next.expired;
    rowsWritten += next.rowsWritten;
    last = next;
  }
  return {
    enabled: first.enabled,
    dryRun,
    before: first.before,
    expired,
    rowsWritten,
    waiting: last.waiting,
  };
}
