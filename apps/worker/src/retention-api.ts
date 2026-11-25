import { Hono } from "hono";
import { z } from "zod";
import {
  expirePath,
  expiryInputSchema,
  pruneCursorSchema,
  prunePath,
  retentionPageSize,
} from "@litscout/pipeline/retention-contracts";
import { expiryBatch, expiryStatus } from "./compact-expiry";
import type { WorkerBindings } from "./api-auth";
import { apiJson } from "./api-response";
import { unavailable } from "./diagnostics";
import { retentionBatch } from "./retention";

const options = z.strictObject({
  after: pruneCursorSchema.optional(),
  waiting: z.number().int().nonnegative().max(10_000_000).optional(),
  batchSize: z.number().int().min(1).max(retentionPageSize).optional(),
});
export const retentionApi = new Hono<WorkerBindings>();
retentionApi.get(prunePath, async (c) => {
  if (!c.env.DB) return unavailable("Retention: DB binding missing");
  const { age, id, oldOnly } = c.req.query();
  const after = age || id ? pruneCursorSchema.parse({ age, id }) : undefined;
  const data = await retentionBatch(
    c.env,
    new Date(),
    { after, oldOnly: oldOnly === "1" },
    true,
  );
  return apiJson(c, { success: true, data });
});
retentionApi.post(prunePath, async (c) => {
  if (!c.env.DB) return unavailable("Retention: DB binding missing");
  const { batchSize, ...input } = options.parse(c.get("ingestBody"));
  const data = await retentionBatch(c.env, new Date(), input, false, batchSize);
  return apiJson(c, { success: true, data });
});
// Compact rows past their horizon: GET previews, POST expires one page.
retentionApi.get(expirePath, async (c) => {
  if (!c.env.DB) return unavailable("Expiry: DB binding missing");
  const overCap = c.req.query("overCap") === "1";
  const data = await expiryStatus(c.env, new Date(), { overCap });
  return apiJson(c, { success: true, data });
});
retentionApi.post(expirePath, async (c) => {
  if (!c.env.DB) return unavailable("Expiry: DB binding missing");
  const options = expiryInputSchema.parse(c.get("ingestBody") ?? {});
  const data = await expiryBatch(c.env, new Date(), options);
  return apiJson(c, { success: true, data });
});
