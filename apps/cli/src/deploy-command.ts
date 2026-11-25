import { readState } from "./state";
import { deploymentVars } from "./web-vars";
import path from "node:path";
import { z } from "zod";
import type { LitScoutConfig } from "@litscout/core";
import type { SourceKeyMode } from "./source-keys";
import { deployWorker } from "./commands";
import {
  UsageError,
  type SetupDeps,
  type CommandResult,
} from "./command-types";
export function workerName(config: LitScoutConfig, override?: string) {
  return z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,62}$/)
    .parse(
      override ??
        config.instance.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    );
}
export async function deployedWorkerName(
  deps: SetupDeps,
  config: LitScoutConfig,
) {
  const state = await readState(deps.dir).catch(() => null);
  return workerName(config, state?.name);
}
export function deploymentOptions(args: readonly string[]) {
  let name: string | undefined;
  let dryRun = false;
  let allowOverBudget = false;
  let sourceKeyMode: SourceKeyMode | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run" && !dryRun) dryRun = true;
    else if (args[i] === "--allow-over-budget" && !allowOverBudget)
      allowOverBudget = true;
    else if (args[i] === "--name" && !name) {
      name = args[++i];
      if (!name || !/^[a-z][a-z0-9-]{0,62}$/.test(name))
        throw new UsageError("--name requires a valid Worker name");
    } else if (["--skip-keys", "--keys-from-env"].includes(args[i]!)) {
      if (sourceKeyMode)
        throw new UsageError(
          "Choose only one of --skip-keys or --keys-from-env",
        );
      sourceKeyMode = args[i] === "--skip-keys" ? "skip" : "env";
    } else
      throw new UsageError(
        "Use deploy [--name NAME] [--dry-run] [--allow-over-budget] [--skip-keys | --keys-from-env]",
      );
  }
  return { name, dryRun, sourceKeyMode, allowOverBudget };
}
function deploymentBindings(bundlePath: string, name: string, uuid: string) {
  const base = path.dirname(bundlePath);
  return {
    d1_databases: [
      {
        binding: "DB",
        database_name: `${name}-db`,
        database_id: uuid,
        migrations_dir: path.join(base, "migrations"),
      },
    ],
    assets: {
      directory: path.join(base, "web"),
      binding: "ASSETS",
      run_worker_first: true,
    },
    triggers: { crons: ["0 2 * * *"] },
  };
}
export async function deployCommand(
  deps: SetupDeps,
  config: LitScoutConfig,
  options: ReturnType<typeof deploymentOptions>,
): Promise<CommandResult> {
  const name = workerName(config, options.name);
  const messages: string[] = [];
  const preview = await deployWorker(
    {
      ...deps,
      workerName: name,
      sourceKeyMode: options.sourceKeyMode ?? deps.sourceKeyMode,
      workerVars: await deploymentVars(config, deps.cwd),
      publicUrl: config.instance.publicUrl,
      print: (text) => messages.push(text),
    },
    (uuid) => deploymentBindings(deps.bundlePath, name, uuid),
    options.dryRun,
    options.allowOverBudget,
  );
  return { data: preview ? { name, ...preview } : { name, messages } };
}
