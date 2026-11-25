import { z } from "zod";

const count = z.number().int().nonnegative();

/** Where the Worker runs: Cloudflare, or an own server through apps/server,
 * which sets LITSCOUT_RUNTIME=server. */
export const runtimeSchema = z.enum(["cloudflare", "server"]);
export type Runtime = z.output<typeof runtimeSchema>;

/** The own server's facts, sent after every scheduled run (housekeep.py
 * --status-file, then `litscout server report FILE`) and shown in Health and
 * `doctor` instead of the Cloudflare-only numbers. */
export const serverStatusPath = "/ingest/server-status";
export const serverModes = ["main", "retry", "final"] as const;
export const serverStatusSchema = z.strictObject({
  checkedAt: z.iso.datetime(),
  /** The LitScout user's home: data, releases, Node and the agent CLIs. */
  footprintBytes: count,
  warningBytes: count,
  capBytes: count,
  /** The newest snapshot in backups/, if any. */
  snapshot: z.strictObject({ at: z.iso.datetime(), bytes: count }).nullable(),
  /** The newest run of each timer, and whether a step failed. */
  runs: z
    .array(
      z.strictObject({
        mode: z.enum(serverModes),
        startedAt: z.iso.datetime(),
        failed: z.boolean(),
      }),
    )
    .max(serverModes.length),
});
export type ServerStatus = z.output<typeof serverStatusSchema>;
