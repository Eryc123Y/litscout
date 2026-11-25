import { z } from "zod";
import { apiOrigin } from "@litscout/core/config";
import {
  runtimeSchema,
  serverStatusSchema,
  type Runtime,
  type ServerStatus,
} from "@litscout/pipeline/server-contracts";
import { credential } from "./flow-runtime";
import type { SetupDeps } from "./command-types";

/** A check that does not apply where the Worker runs. */
export const notUsed = { ok: true, notUsed: "own server" } as const;

// The report is parsed on its own, so a bad one never hides the runtime.
const detailsSchema = z.object({
  data: z.object({
    runtime: runtimeSchema.optional(),
    trial: z.boolean().optional(),
    server: z.unknown().optional(),
  }),
});

/** Where the Worker runs and, on an own server, its newest report. A Worker
 * that cannot be asked counts as Cloudflare, so the usual checks run. */
export async function workerRuntime(
  deps: SetupDeps,
  endpoint: string | undefined,
  readOnly: boolean,
): Promise<{ runtime: Runtime; trial: boolean; server: ServerStatus | null }> {
  const fallback = {
    runtime: "cloudflare" as const,
    trial: false,
    server: null,
  };
  const base = apiOrigin(endpoint);
  if (!base) return fallback;
  try {
    const token = await credential(deps, base);
    const response = await deps.fetch(
      new URL(readOnly ? "/api/v1/vault/health" : "/api/v1/health", base),
      {
        headers: { authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      },
    );
    const parsed = detailsSchema.safeParse(await response.json());
    if (!parsed.success) return fallback;
    return {
      runtime: parsed.data.data.runtime ?? "cloudflare",
      trial: parsed.data.data.trial === true,
      server:
        serverStatusSchema.safeParse(parsed.data.data.server).data ?? null,
    };
  } catch {
    return fallback;
  }
}

const gigabytes = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
const hoursSince = (at: string, now: number) =>
  Math.floor((now - Date.parse(at)) / 3_600_000);
// A nightly snapshot and three runs a day: more than a day and a half
// without one means a timer stopped.
const staleHours = 36;

/** The own server's storage check and warnings from its newest report. */
export function serverChecks(
  server: ServerStatus | null,
  now = Date.now(),
  /** A trial has no scheduled runs, so no report is expected. */
  trial = false,
) {
  if (!server)
    return {
      storage: { ok: true, footprintBytes: null, capBytes: null },
      warnings: trial
        ? []
        : [
            "The server has not reported its status yet; it does after each scheduled run.",
          ],
    };
  const over = server.footprintBytes > server.capBytes;
  const storage = {
    ...(over
      ? {
          ok: false,
          hint: "Run python3 ~/litscout/current/scripts/housekeep.py ~/litscout --dry-run on the server to see what can go; while over the cap the final run removes the oldest week of compact rows.",
        }
      : { ok: true }),
    footprintBytes: server.footprintBytes,
    capBytes: server.capBytes,
  };
  const warnings: string[] = [];
  if (!over && server.footprintBytes > server.warningBytes)
    warnings.push(
      `Server storage at ${gigabytes(server.footprintBytes)} GB (warning level ${gigabytes(server.warningBytes).replace(/\.0$/, "")} GB)`,
    );
  if (!server.snapshot) warnings.push("No snapshot on the server yet.");
  else if (hoursSince(server.snapshot.at, now) > staleHours)
    warnings.push(
      `The newest snapshot is ${hoursSince(server.snapshot.at, now)} hours old; check litscout-snapshot.timer.`,
    );
  for (const run of server.runs)
    if (run.failed)
      warnings.push(
        `The last ${run.mode} run (started ${run.startedAt}) had a failed step; read its log in ~/litscout/logs.`,
      );
  if (hoursSince(server.checkedAt, now) > staleHours)
    warnings.push(
      `The server last reported ${hoursSince(server.checkedAt, now)} hours ago; the scheduled runs may have stopped.`,
    );
  return { storage, warnings };
}
