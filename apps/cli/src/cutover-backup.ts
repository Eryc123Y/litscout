import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { z } from "zod";

// Version 1 export sections, in the order used by the M3e checksum.
const sections = [
  "library",
  "alphaXiv",
  "paperState",
  "quickNotes",
  "digests",
  "weeklyDigests",
  "topics",
  "projects",
  "vaultIndex",
  "ideaIndex",
  "workingPaperIndex",
  "captures",
  "vaultRequests",
  "suggestions",
  "papers",
  "paperIdentifiers",
  "paperLinks",
];
const counts = z.record(z.string(), z.number().int().nonnegative());
const bundle = z.object({
  schemaVersion: z.literal(1),
  instanceName: z.string(),
  createdAt: z.iso.datetime(),
  counts,
  expectedCounts: counts,
  configuredTopics: z.array(z.json()),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  data: z.record(z.string(), z.array(z.json())),
});
const dayMs = 86_400_000;
const maxBundleBytes = 64 * 1024 * 1024;

function canonicalJson(value: z.output<ReturnType<typeof z.json>>): string {
  if (Array.isArray(value))
    return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key]!))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}

function consistent(value: z.output<typeof bundle>) {
  const hash = createHash("sha256").update("{");
  for (const [index, section] of sections.entries()) {
    const rows = value.data[section];
    if (
      !rows ||
      value.counts[section] !== rows.length ||
      value.expectedCounts[section] !== rows.length
    )
      return false;
    hash.update((index ? "," : "") + JSON.stringify(section) + ":[");
    for (const [offset, row] of rows.entries())
      hash.update((offset ? "," : "") + canonicalJson(row));
    hash.update("]");
  }
  return (
    value.counts.configuredTopics === value.configuredTopics.length &&
    value.expectedCounts.configuredTopics === value.configuredTopics.length &&
    hash.update("}").digest("hex") === value.sha256
  );
}

export async function checkBackup(
  cwd: string,
  instance: string,
  now: Date,
  explicit?: string,
) {
  let file: string | null = explicit ? path.resolve(cwd, explicit) : null;
  try {
    if (!file) {
      const name = (await readdir(cwd))
        .filter((name) =>
          /^litscout-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.json\.gz$/.test(
            name,
          ),
        )
        .sort()
        .at(-1);
      if (!name)
        return {
          ok: false,
          file,
          reason: "Supply a verified LitScout export with --backup PATH.",
        };
      file = path.join(cwd, name);
    }
    const info = await lstat(file);
    if (!info.isFile() || info.size > maxBundleBytes)
      return {
        ok: false,
        file,
        reason:
          "Expected a regular LitScout gzip export no larger than 64 MiB.",
      };
    const raw = await promisify(gunzip)(await readFile(file), {
      maxOutputLength: 4 * maxBundleBytes,
    });
    const value = bundle.parse(JSON.parse(raw.toString("utf8")));
    if (value.instanceName !== instance)
      return {
        ok: false,
        file,
        reason: "The export is for a different LitScout instance.",
      };
    const createdAt = value.createdAt;
    const age = now.getTime() - Date.parse(createdAt);
    if (age < 0 || age > 7 * dayMs)
      return {
        ok: false,
        file,
        createdAt,
        reason: "Take a backup created within the last 7 days.",
      };
    if (!consistent(value))
      return {
        ok: false,
        file,
        reason:
          "The export's section counts or checksum do not match. Create and verify a new export.",
      };
    return { ok: true, file, createdAt };
  } catch {
    return {
      ok: false,
      file,
      reason:
        "Could not read a valid LitScout v1 gzip export. Check the backup path and verify the export.",
    };
  }
}
