import path from "node:path";
import { UsageError, type SetupDeps } from "./command-types";
import { loadConfig } from "./config-loader";
export function configOptions(input: readonly string[]) {
  const args: string[] = [];
  let explicit: string | undefined;
  for (let i = 0; i < input.length; i++) {
    const arg = input[i]!;
    if (arg === "--config") {
      if (
        explicit !== undefined ||
        !input[i + 1] ||
        input[i + 1]!.startsWith("--")
      )
        throw new UsageError("Use --config PATH once");
      explicit = input[++i];
    } else {
      args.push(arg);
      if (
        ["--name", "--scopes", "--expires-in"].includes(arg) &&
        input[i + 1] !== undefined
      )
        args.push(input[++i]!);
    }
  }
  return { args, explicit };
}
export async function commandConfig(deps: SetupDeps, explicit?: string) {
  return deps.loadConfig
    ? {
        file: path.resolve(deps.cwd, explicit ?? "litscout.config.ts"),
        config: await deps.loadConfig(),
      }
    : loadConfig(deps.cwd, explicit);
}
