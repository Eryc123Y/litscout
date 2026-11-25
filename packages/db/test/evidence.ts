import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Evidence is optional; assertions and fixtures must work without .artifacts. */
export async function writeEvidence(
  filename: string,
  value: unknown,
  directory = fileURLToPath(new URL("../../../.artifacts/", import.meta.url)),
) {
  if (process.env.LITSCOUT_EVIDENCE !== "1") return;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, filename), JSON.stringify(value, null, 2));
}
