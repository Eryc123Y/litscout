import { apiJson } from "./api-response";
import type { Context } from "hono";
import type { WorkerBindings } from "./api-auth";
import { writeBudgetUsage, nextReset } from "@litscout/db/write-budget";
export class WriteQuotaError extends Error {
  constructor(readonly needed: number) {
    super("Daily write budget reached");
  }
}
export async function quotaResponse(
  c: Context<WorkerBindings>,
  needed: number,
) {
  const day = new Date().toISOString().slice(0, 10);
  const { used, reserved, limit } = await writeBudgetUsage(c.env.DB!, day);
  const retry_after = nextReset(day);
  const fields = {
    used,
    reserved,
    limit,
    needed,
    remaining: Math.max(0, limit - used - reserved),
    retry_after,
  };
  for (const [key, value] of Object.entries(fields))
    c.header(`X-Write-Budget-${key.replace("_", "-")}`, String(value));
  c.header(
    "Retry-After",
    String(
      Math.max(0, Math.ceil((Date.parse(retry_after) - Date.now()) / 1000)),
    ),
  );
  return apiJson(
    c,
    {
      success: false,
      error: {
        code: "WRITE_BUDGET_EXCEEDED",
        message: "Daily write budget reached",
        ...fields,
      },
    },
    429,
  );
}
