import { daySchema } from "@litscout/pipeline/contracts/index";
import { UsageError } from "./command-types";
import { flowOptions } from "./flow-options";

/** Shared syntax for the guide and the M3c day-reopen command. */
export function dayReopenOptions(args: readonly string[]) {
  const [action, ...rest] = args;
  const usage = "Use day reopen <day> [--dry-run] [--yes]";
  if (action !== "reopen") throw new UsageError(usage);
  const { values, positional } = flowOptions(rest, ["dry-run", "yes"]);
  if (positional.length !== 1) throw new UsageError(usage);
  return {
    day: daySchema.parse(positional[0]),
    dryRun: values["dry-run"] === "true",
    confirmed: values.yes === "true",
  };
}
