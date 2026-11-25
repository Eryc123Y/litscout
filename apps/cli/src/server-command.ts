import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LitScoutConfig } from "@litscout/core";
import {
  serverStatusPath,
  serverStatusSchema,
} from "@litscout/pipeline/server-contracts";
import { credential, type FlowDeps } from "./flow-runtime";
import { endpointConfig } from "./endpoint";
import { flowOptions } from "./flow-options";
import { UsageError } from "./command-types";
import { serverInit } from "./server-init";

const usage =
  "Use server init [--base DIR] [--local] [--force] [--dry-run] or server report FILE";

export function serverOptions(args: readonly string[]) {
  const { values, positional } = flowOptions(args, [
    "base",
    "local",
    "force",
    "dry-run",
  ]);
  const [action, file, ...extra] = positional;
  if (action === "init" && !file)
    return {
      action,
      base: values.base,
      local: values.local === "true",
      force: values.force === "true",
      dryRun: values["dry-run"] === "true",
    } as const;
  if (
    action !== "report" ||
    !file ||
    extra.length ||
    Object.keys(values).length
  )
    throw new UsageError(usage);
  return { action, file } as const;
}

/** `server report FILE`: send the own server's facts, written by
 * housekeep.py --status-file after each scheduled run, to the Worker. */
export async function serverCommand(
  args: readonly string[],
  deps: FlowDeps & { cwd: string; templateDir: string },
  config: LitScoutConfig,
) {
  const options = serverOptions(args);
  if (options.action === "init")
    return { data: await serverInit(options, deps, config) };
  const { file } = options;
  const text = await readFile(path.resolve(deps.cwd, file), "utf8").catch(
    () => {
      throw new UsageError(`Could not read ${file}`);
    },
  );
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new UsageError(`${file} is not JSON`);
  }
  const status = serverStatusSchema.safeParse(raw);
  if (!status.success)
    throw new UsageError(
      `${file} is not a server status: ${z.prettifyError(status.error)}`,
    );
  const endpoint = (await endpointConfig(config, deps.dir)).config.instance
    .publicUrl;
  if (!endpoint)
    throw new UsageError("Set instance.publicUrl before reporting the server");
  const token = await credential(deps, endpoint);
  const response = await deps
    .fetch(new URL("/api/v1" + serverStatusPath, endpoint), {
      method: "PUT",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify(status.data),
    })
    .catch(() => undefined);
  if (!response?.ok)
    throw new UsageError(
      response
        ? `Server report failed (HTTP ${response.status}).`
        : "Server report could not reach the Worker.",
    );
  return { data: { stored: true, checkedAt: status.data.checkedAt } };
}
