import { Hono } from "hono";
import {
  readRestoreStatus,
  restoreBackupPage,
} from "@litscout/db/backup-restore";
import {
  reserveWriteBudget,
  settleWriteBudget,
} from "@litscout/db/write-budget";
import {
  parseRestorePage,
  restorePageCost,
  restorePath,
} from "@litscout/pipeline/backup-restore-contracts";
import type { WorkerBindings } from "./api-auth";
import { apiJson } from "./api-response";
import { unavailable } from "./diagnostics";
import { quotaResponse } from "./write-quota";

/** Owner-only restore of a verified export, one bounded page per request. */
export const restoreApi = new Hono<WorkerBindings>();
restoreApi.get(restorePath, async (c) => {
  const db = c.env.DB;
  if (!db) return unavailable("Restore: DB binding missing");
  c.header("Cache-Control", "no-store");
  return apiJson(c, { success: true, data: await readRestoreStatus(db) });
});
restoreApi.post(restorePath, async (c) => {
  const db = c.env.DB;
  if (!db) return unavailable("Restore: DB binding missing");
  const page = parseRestorePage(await c.req.json());
  const cost = restorePageCost(page);
  // Reserve the whole page before writing, as the Zotero import does.
  const lease = await reserveWriteBudget(db, cost, new Date(), cost);
  if (!lease) return quotaResponse(c, cost);
  let result;
  try {
    result = await restoreBackupPage(db, page);
  } catch (error) {
    await settleWriteBudget(db, lease, 0, true);
    throw error;
  }
  const { rowsWritten, ...data } = result;
  c.set("budgetRowsWritten", await settleWriteBudget(db, lease, rowsWritten));
  return apiJson(c, { success: true, data, meta: { rowsWritten } });
});
