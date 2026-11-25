import { link, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import type { LitScoutConfig } from "@litscout/core";
import type { BackupBundle } from "@litscout/pipeline/backup-contracts";
import {
  BackupError,
  backupReader,
  backupFilename,
  collectBackup,
  verifyBackup,
} from "@litscout/pipeline/backup";
import { UsageError, type CommandResult } from "./command-types";
import { credential, nowFor, type FlowDeps } from "./flow-runtime";
import { endpointConfig } from "./endpoint";
import { flowOptions } from "./flow-options";
import { readBundle } from "./backup-file";
import { restoreCommand, restoreOptions } from "./restore-command";

async function saveBundle(file: string, bundle: BackupBundle) {
  const temp = path.join(
    path.dirname(file),
    `.litscout-backup-${crypto.randomUUID()}.tmp`,
  );
  try {
    await writeFile(temp, await promisify(gzip)(JSON.stringify(bundle)), {
      flag: "wx",
      mode: 0o600,
    });
    await link(temp, file);
  } catch (error) {
    throw new UsageError(
      (error as NodeJS.ErrnoException).code === "EEXIST"
        ? "That export already exists. Choose a new --out file."
        : "Could not write the export. Check the destination directory and available space.",
    );
  } finally {
    await rm(temp, { force: true });
  }
}

export function backupOptions(args: readonly string[]) {
  return args[0] === "restore"
    ? restoreOptions(args.slice(1))
    : exportOptions(args);
}

function exportOptions(args: readonly string[]) {
  let options;
  try {
    options = flowOptions(args, ["out", "verify"]);
  } catch {
    throw new UsageError("Use backup [--out FILE] or backup --verify FILE");
  }
  const { values, positional } = options;
  if (positional.length || (values.out && values.verify))
    throw new UsageError("Use backup [--out FILE] or backup --verify FILE");
  return values;
}

export async function backupCommand(
  args: readonly string[],
  deps: FlowDeps,
  loadConfig: () => Promise<LitScoutConfig>,
): Promise<CommandResult> {
  if (args[0] === "restore")
    return restoreCommand(args.slice(1), deps, loadConfig);
  const values = exportOptions(args);
  if (values.verify) {
    const file = path.resolve(deps.cwd, values.verify);
    const bundle = await readBundle(file);
    let warnings;
    try {
      warnings = verifyBackup(bundle);
    } catch (error) {
      if (error instanceof BackupError) throw new UsageError(error.message);
      throw error;
    }
    const { schemaVersion, instanceName, createdAt, counts, expectedCounts } =
      bundle;
    return {
      data: {
        verified: true,
        file,
        schemaVersion,
        instanceName,
        createdAt,
        counts,
        expectedCounts,
        warnings,
      },
    };
  }
  const createdAt = nowFor(deps);
  const file = path.resolve(
    deps.cwd,
    values.out ?? backupFilename(createdAt.toISOString()),
  );
  let bundle;
  try {
    const { config } = await endpointConfig(await loadConfig(), deps.dir);
    const base = config.instance.publicUrl;
    if (!base)
      throw new UsageError("Set instance.publicUrl before running backup");
    const token = await credential(deps, base);
    const read = backupReader((route, init) =>
      deps.fetch(new URL(route, base), {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      }),
    );
    bundle = await collectBackup(read, { createdAt });
  } catch (error) {
    if (error instanceof BackupError) throw new UsageError(error.message);
    throw error;
  }
  await saveBundle(file, bundle);
  return {
    data: {
      file,
      schemaVersion: bundle.schemaVersion,
      counts: bundle.counts,
    },
  };
}
