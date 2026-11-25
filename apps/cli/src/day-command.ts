import type { LitScoutConfig } from "@litscout/core";
import {
  dayReopenPlanSchema,
  daySchema,
} from "@litscout/pipeline/contracts/index";
import { z } from "zod";
import {
  UsageError,
  type CommandResult,
  type SetupDeps,
} from "./command-types";
import { endpointConfig } from "./endpoint";
import { flowOptions } from "./flow-options";
import { credential, withFlowLock } from "./flow-runtime";

const replySchema = z.object({
  success: z.literal(true),
  data: dayReopenPlanSchema,
});

function describe(plan: z.infer<typeof dayReopenPlanSchema>) {
  if (plan.oldStatus === null && !plan.changed)
    return `No feed day or daily digest for ${plan.day}.`;
  if (!plan.changed) return `${plan.day} is already open. No changes.`;
  const languages = plan.digests.map((digest) => digest.lang).join(", ");
  const transition = `${plan.oldStatus ?? "no feed day"} → ${plan.newStatus}`;
  const heading = plan.dryRun ? "Reopen preview" : "Reopened";
  const action = plan.dryRun
    ? "Daily digests to delete"
    : "Daily digests deleted";
  return `${heading} ${plan.day} (${transition})\n${action}: ${languages || "none"}`;
}

export async function dayCommand(
  args: readonly string[],
  deps: SetupDeps,
  config: LitScoutConfig,
): Promise<CommandResult> {
  const usage = "Use day reopen <day> [--dry-run] [--yes] [--json]";
  if (args[0] !== "reopen") throw new UsageError(usage);
  let options: ReturnType<typeof flowOptions>;
  try {
    options = flowOptions(args.slice(1), ["dry-run", "yes"]);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  if (options.positional.length !== 1) throw new UsageError(usage);
  const day = daySchema.parse(options.positional[0]);
  const dryRun = options.values["dry-run"] === "true";
  const confirmed = options.values.yes === "true";
  if (!dryRun && !confirmed && !(deps.isTTY ?? Boolean(process.stdin.isTTY)))
    throw new UsageError(
      "Pass --yes to reopen without a terminal, or --dry-run to preview.",
    );

  const base = (await endpointConfig(config, deps.dir)).config.instance
    .publicUrl;
  if (!base)
    throw new UsageError("Set instance.publicUrl before reopening a day");
  const token = await credential(deps, base).catch(() => {
    throw new UsageError(
      "A valid local token with write scope is required to reopen a day",
    );
  });
  const request = async (preview: boolean) => {
    const url = new URL(`/api/v1/days/${day}/reopen`, base);
    if (preview) url.searchParams.set("dryRun", "1");
    const response = await deps.fetch(url, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401 || response.status === 403)
      throw new UsageError(
        "Reopening a day requires a valid token with write scope",
      );
    if (!response.ok)
      throw new UsageError(`LitScout API returned HTTP ${response.status}`);
    return replySchema.parse(await response.json()).data;
  };
  if (dryRun || !confirmed) {
    const plan = await request(true);
    const description = describe(plan);
    if (dryRun || !plan.changed)
      return {
        data: { ...plan, messages: [description] },
        empty: !plan.changed,
      };
    if (
      (await deps.prompt(description + "\nType yes to reopen")).trim() !== "yes"
    )
      return {
        data: {
          ...plan,
          cancelled: true,
          messages: [description, "Cancelled."],
        },
        empty: true,
      };
  }
  const plan = await withFlowLock(deps, () => request(false));
  return {
    data: { ...plan, messages: [describe(plan)] },
    empty: !plan.changed,
  };
}
