import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { backupBundleSchema } from "@litscout/pipeline/backup-contracts";
import { UsageError } from "./command-types";

/** Parse a v1 gzip export. Verify it with `verifyBackup` before trusting it. */
export async function readBundle(file: string) {
  try {
    const unpacked = await promisify(gunzip)(await readFile(file));
    return backupBundleSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(unpacked)),
    );
  } catch {
    throw new UsageError(
      "Cannot verify this file as a LitScout v1 gzip export",
    );
  }
}
