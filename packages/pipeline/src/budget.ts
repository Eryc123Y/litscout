import { z } from "zod";
import { ApiFailure } from "./api-failure";
export const budgetSafetyFields = {
  baseLimit: z.number().int().positive().max(10_000_000).optional(),
  unaccounted: z.number().int().nonnegative().optional(),
  estimateOverrun: z.number().int().nonnegative().optional(),
};
export const serverBudgetSchema = z.strictObject({
  ...budgetSafetyFields,
  day: z.iso.date(),
  used: z.number().int().nonnegative(),
  reserved: z.number().int().nonnegative(),
  migration: z.number().int().nonnegative().optional(),
  staleLeasesReleased: z.number().int().nonnegative(),
  limit: z.number().int().positive().max(10_000_000),
  resetAt: z.iso.datetime(),
});
export const budgetSchema = z.strictObject({
  day: z.iso.date(),
  rows: z.number().int().nonnegative(),
  reserved: z.number().int().nonnegative().optional(),
});
export class BudgetStop extends Error {
  constructor(readonly resumeAt: string) {
    super(`Write budget reached; resume at ${resumeAt} (00:00 UTC)`);
  }
}
export class WriteBudget {
  constructor(
    public state: z.infer<typeof budgetSchema>,
    private now: () => Date,
    private persist: (
      state: z.infer<typeof budgetSchema> | z.infer<typeof serverBudgetSchema>,
    ) => Promise<void>,
    public readonly authoritative = false,
    private cachedServer?: z.infer<typeof serverBudgetSchema>,
  ) {
    budgetSchema.parse(state);
    if (authoritative) this.state = { ...state, reserved: 0 };
  }
  remaining() {
    if (this.authoritative) return Infinity;
    const today = this.now().toISOString().slice(0, 10);
    if (this.state.day !== today) this.state = { day: today, rows: 0 };
    const limit =
      this.cachedServer?.day === today ? this.cachedServer.limit : 80000;
    return limit - this.state.rows - (this.state.reserved ?? 0);
  }
  resetAt() {
    return new Date(Date.parse(this.state.day) + 86400000).toISOString();
  }
  async rejected(
    estimate: number,
    used: number | undefined,
    _uncertain: boolean,
  ) {
    this.state = {
      ...this.state,
      rows: Math.max(this.state.rows, used ?? 0),
      reserved: Math.max(0, (this.state.reserved ?? 0) - estimate),
    };
    if (!this.authoritative) await this.persist(this.state);
  }
  reserve(estimate: number) {
    z.number().int().nonnegative().parse(estimate);
    if (estimate >= this.remaining()) throw new BudgetStop(this.resetAt());
  }

  async record(rows: number) {
    z.number().int().nonnegative().parse(rows);
    if (this.authoritative) return;
    this.state = { ...this.state, rows: this.state.rows + rows };
    if (!this.authoritative) await this.persist(this.state);
  }
  async begin(estimate: number) {
    this.reserve(estimate);
    this.state = {
      ...this.state,
      reserved: (this.state.reserved ?? 0) + estimate,
    };
    if (!this.authoritative) await this.persist(this.state);
  }
  async synchronize(value: unknown) {
    const usage = serverBudgetSchema.parse(value);
    this.cachedServer = usage;
    this.state = { day: usage.day, rows: usage.used, reserved: 0 };
    await this.persist(this.authoritative ? usage : this.state);
    return usage;
  }
  /**
   * Why the server's budget could not be read, for the command's output. A
   * reply that arrived but does not match the schema means the CLI and the
   * server are on different versions (2026-11-22: a CLI built before the
   * instance write limit met a server reporting a higher limit).
   */
  unreadMessage(error: unknown) {
    if (error instanceof z.ZodError)
      return (
        "The server's budget reply does not fit this CLI (" +
        error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ") +
        "). The CLI and the server are probably on different versions: update and rebuild the CLI. No writes sent."
      );
    const cache = this.cachedServer;
    return (
      "Cannot read server budget" +
      (error instanceof ApiFailure ? ` (${error.message})` : "") +
      "; no writes sent. " +
      (cache
        ? `Last cached budget (may be stale): ${cache.day}, used ${cache.used}, reserved ${cache.reserved}, reset ${cache.resetAt}`
        : "No cached server budget available")
    );
  }
  async settle(rows: number, estimate: number, _uncertain: boolean) {
    this.state = {
      ...this.state,
      reserved: Math.max(0, (this.state.reserved ?? 0) - estimate),
    };
    await this.record(rows);
  }
}
