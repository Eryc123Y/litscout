import { z } from "zod";
import { BudgetStop } from "./budget";
export const quotaSchema = z.object({
  used: z.number().int().nonnegative(),
  reserved: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(10_000_000),
  needed: z.number().int().nonnegative(),
  retry_after: z.iso.datetime().max(35),
});
export type Quota = z.output<typeof quotaSchema>;
export class QuotaExceeded extends BudgetStop {
  constructor(
    readonly quota: Quota | null,
    resumeAt: string,
    readonly uncertain: boolean,
  ) {
    super(resumeAt);
  }
}
export async function quotaFailure(response: Response, uncertain: boolean) {
  const parsed = z
    .object({
      error: quotaSchema.extend({ code: z.literal("WRITE_BUDGET_EXCEEDED") }),
    })
    .safeParse(await response.json().catch(() => null));
  if (parsed.success)
    return new QuotaExceeded(
      parsed.data.error,
      parsed.data.error.retry_after,
      uncertain,
    );
  const header = response.headers.get("Retry-After"),
    now = Date.now();
  const retry =
    header && /^\d+$/.test(header)
      ? now + Number(header) * 1000
      : Date.parse(header ?? "");
  const fallback =
    new Date(new Date().toISOString().slice(0, 10)).getTime() + 86400000;
  return new QuotaExceeded(
    null,
    new Date(
      Number.isFinite(retry) && retry > now && retry < 8640000000000000
        ? retry
        : fallback,
    ).toISOString(),
    uncertain,
  );
}
