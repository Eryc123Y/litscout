import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LitScoutConfig } from "@litscout/core";
import { fitBatch, jsonBytes } from "@litscout/pipeline/ingest-batching";
import {
  newZoteroProgress,
  zoteroBatchSize,
  zoteroFileBytes,
  zoteroFormat,
  zoteroImportPath,
  zoteroProgress,
  type ZoteroBatch,
} from "@litscout/pipeline/zotero-contracts";
import {
  groupZoteroEntries,
  parseZotero,
} from "@litscout/pipeline/zotero-import";
import {
  UsageError,
  type CommandResult,
  type SetupDeps,
} from "./command-types";
import { flowOptions } from "./flow-options";

export function zoteroOptions(args: readonly string[]) {
  const usage =
    "Use library import <file> [--format bibtex|csl] [--dry-run] [--json]";
  if (args[0] !== "import") throw new UsageError(usage);
  let opts: ReturnType<typeof flowOptions>;
  try {
    opts = flowOptions(args.slice(1), ["format", "dry-run"]);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  if (opts.positional.length !== 1) throw new UsageError(usage);
  const file = opts.positional[0]!;
  const extension = path.extname(file).toLowerCase();
  const inferred =
    extension === ".bib" || extension === ".bibtex"
      ? "bibtex"
      : extension === ".json" || extension === ".csl"
        ? "csl"
        : undefined;
  const format = zoteroFormat.safeParse(opts.values.format ?? inferred);
  if (!format.success)
    throw new UsageError("Use --format bibtex or --format csl for this export");
  return {
    command: "import" as const,
    file,
    format: format.data,
    dryRun: opts.values["dry-run"] === "true",
  };
}

async function readExport(file: string) {
  const tooLarge = () => new UsageError("Zotero exports are limited to 5 MB");
  try {
    const handle = await open(file, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile())
        throw new UsageError("Choose a regular Zotero export file");
      if (info.size > zoteroFileBytes) throw tooLarge();
      const bytes = Buffer.alloc(zoteroFileBytes + 1);
      let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await handle.read(
          bytes,
          size,
          bytes.length - size,
          size,
        );
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > zoteroFileBytes) throw tooLarge();
      return bytes.subarray(0, size);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError("Could not read the Zotero export file");
  }
}

const resultSchema = z.object({
  success: z.literal(true),
  data: zoteroProgress,
});
const budgetError = z.object({
  error: z.object({
    code: z.literal("WRITE_BUDGET_EXCEEDED"),
    retry_after: z.iso.datetime(),
  }),
});

export async function zoteroImportCommand(
  { file, format, dryRun }: ReturnType<typeof zoteroOptions>,
  deps: SetupDeps,
  config: LitScoutConfig,
  connect: () => Promise<
    (route: string, body: ZoteroBatch) => Promise<Response>
  >,
): Promise<CommandResult> {
  const bytes = await readExport(path.resolve(deps.cwd, file));
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new UsageError("Expected a UTF-8 Zotero export");
  }
  let parsed: ReturnType<typeof parseZotero>;
  try {
    parsed = parseZotero(text, format);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { entries, duplicates: fileDuplicates } = groupZoteroEntries(
    parsed.entries,
  );
  const total = entries.length;
  const hash = createHash("sha256").update(bytes).digest("hex");
  const { bytes: maximum, papers: batchSize } = config.instance.limits.ingest;
  let progress = newZoteroProgress();
  const payload = (offset: number, size: number): ZoteroBatch => ({
    format,
    dryRun,
    hash,
    total,
    offset,
    entries: entries.slice(offset, offset + size),
  });
  const result = (
    status: "dry-run" | "imported" | "budget-short",
    retryAt?: string,
  ) => {
    const invalid = parsed.issues.length + progress.invalid;
    const duplicates = fileDuplicates + progress.duplicates;
    const remaining = total - progress.next;
    return {
      status,
      new: progress.new,
      linked: progress.linked,
      duplicates,
      unverified: progress.unverified,
      invalid,
      remaining,
      issues: parsed.issues,
      ...(retryAt ? { retryAt } : {}),
      messages: [
        dryRun ? "Zotero import preview" : "Zotero import " + status,
        "New: " +
          progress.new +
          " · Linked: " +
          progress.linked +
          " · Duplicates: " +
          duplicates +
          " · Unverified: " +
          progress.unverified +
          " · Invalid: " +
          invalid,
        ...parsed.issues.map(
          (issue) =>
            ("line" in issue ? "Line " + issue.line : "Item " + issue.item) +
            ": " +
            issue.message,
        ),
        ...(retryAt
          ? [
              "Run the same import after " +
                retryAt +
                " to resume (" +
                remaining +
                " remaining).",
            ]
          : []),
      ],
    };
  };

  if (!total)
    return {
      data: result(dryRun ? "dry-run" : "imported"),
      empty: !parsed.issues.length,
      failed: Boolean(parsed.issues.length),
    };

  if (entries.some((_, offset) => jsonBytes(payload(offset, 1)) > maximum))
    throw new UsageError(
      "An export record exceeds the configured ingest request size.",
    );

  const request = await connect();
  while (progress.next < total) {
    const offset = progress.next;
    const size = fitBatch(
      Math.min(zoteroBatchSize, batchSize, total - offset),
      maximum,
      (count) => payload(offset, count),
    );
    const response = await request(
      zoteroImportPath,
      payload(offset, size),
    ).catch(() => {
      throw new UsageError(
        "Could not reach LitScout. Run the same import again to resume.",
      );
    });
    if (response.status === 429) {
      const budget = budgetError.safeParse(
        await response.json().catch(() => null),
      );
      if (budget.success)
        return {
          data: result("budget-short", budget.data.error.retry_after),
          failed: true,
        };
    }
    if (response.status === 409)
      throw new UsageError(
        "Import progress changed. Run the same import again to resume.",
      );
    if (!response.ok)
      throw new UsageError(
        "LitScout import returned HTTP " +
          response.status +
          ". Check the instance and the token's write scope.",
      );
    const data = resultSchema.parse(await response.json()).data;
    if (
      data.next <= offset ||
      data.next > total ||
      (dryRun && data.next !== offset + size)
    )
      throw new UsageError("LitScout returned an invalid import offset.");
    progress = dryRun
      ? {
          next: data.next,
          new: progress.new + data.new,
          linked: progress.linked + data.linked,
          duplicates: progress.duplicates + data.duplicates,
          unverified: progress.unverified + data.unverified,
          invalid: progress.invalid + data.invalid,
        }
      : data;
  }
  return { data: result(dryRun ? "dry-run" : "imported") };
}
