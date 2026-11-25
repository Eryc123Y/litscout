import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LitScoutConfig } from "@litscout/core";
import {
  alphaXivUrl,
  arxivId,
  arxivMetadata,
  knownArxivResult,
  mirrorPath,
  mirrorState,
  type MirrorItem,
  type MirrorRun,
  type MirrorWrite,
} from "@litscout/pipeline/alphaxiv-contracts";
import { BudgetStop, chunks, type FeedApi } from "@litscout/pipeline/api";
import { QuotaExceeded } from "@litscout/pipeline/quota";
import {
  alphaXivSnapshot,
  orderedAlphaXivSnapshot,
  reconcileAlphaXiv,
  type MirrorChange,
} from "@litscout/sync/alphaxiv";
import { createArxivClient } from "@litscout/sources/sources/arxiv";
import { localLimiter } from "@litscout/sources/watch/limiter";
import { type CommandResult, UsageError } from "./command-types";
import { flowApi, withFlowLock, type FlowDeps } from "./flow-runtime";
import { flowOptions } from "./flow-options";
import { alphaXivCapture } from "./alphaxiv-capture";

const usage =
  "Use alphaxiv import <file> [--dry-run] or alphaxiv capture [--import] [--dir DIR]";
const runReply = z.object({ applied: z.boolean(), completed: z.boolean() });
const finishReply = runReply.extend({
  missingMetadata: z.number().int().nonnegative(),
});
const writeReply = z.object({ accepted: z.number().int().nonnegative() });
const sameRun = (a: MirrorRun | null, b: MirrorRun) =>
  a?.takenAt === b.takenAt && a.digest === b.digest;

export function alphaXivOptions(args: readonly string[]) {
  const [command, ...rest] = args;
  let options;
  try {
    options = flowOptions(
      rest,
      command === "capture" ? ["import", "dir"] : ["dry-run"],
    );
  } catch {
    throw new UsageError(usage);
  }
  if (command === "capture" && !options.positional.length)
    return {
      command,
      import: options.values.import === "true",
      dir: options.values.dir,
    } as const;
  if (command !== "import" || options.positional.length !== 1)
    throw new UsageError(usage);
  return {
    command,
    file: options.positional[0]!,
    dryRun: options.values["dry-run"] === "true",
  } as const;
}

export async function alphaXivCommand(
  args: readonly string[],
  deps: FlowDeps,
  config: LitScoutConfig,
  /** The config file's folder: the capture keeps its snapshots beside it. */
  configDir = deps.cwd,
): Promise<CommandResult> {
  const options = alphaXivOptions(args);
  if (options.command === "capture")
    return alphaXivCapture(
      {
        import: options.import,
        dir: path.resolve(
          deps.cwd,
          options.dir ?? path.join(configDir, "alphaxiv"),
        ),
      },
      deps,
      config,
      {
        importSnapshot: (file) =>
          alphaXivCommand(["import", file], deps, config, configDir),
      },
    );
  const { file, dryRun } = options;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.resolve(deps.cwd, file), "utf8"));
  } catch {
    throw new UsageError("Could not read the alphaXiv snapshot as JSON.");
  }
  const snapshot = orderedAlphaXivSnapshot(alphaXivSnapshot.parse(raw));
  const run = {
    takenAt: snapshot.takenAt,
    digest: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
  };
  const work = async () => {
    const api = await flowApi(deps, config);
    if (!dryRun) {
      const start = runReply.parse(
        await api.write(mirrorPath + "/start", run, 8),
      );
      if (start.completed)
        return { data: { status: "already-synced", takenAt: run.takenAt } };
      if (!start.applied)
        throw new UsageError(
          "AlphaXiv already has a newer or different snapshot at this time.",
        );
    }
    const current = await readMirror(api, dryRun ? undefined : run);
    const changes = reconcileAlphaXiv(snapshot, current.items);
    const counts = { add: 0, update: 0, remove: 0, restore: 0 };
    for (const { kind } of changes) counts[kind]++;
    if (dryRun)
      return {
        data: {
          dryRun,
          takenAt: run.takenAt,
          counts,
          changes: changes.map(describeChange),
        },
      };

    const { items, snapshotFallbacks } = await prepareWrites(
      api,
      deps,
      changes,
      current,
    );
    if (items.length) {
      const result = writeReply.parse(
        await api.write(mirrorPath, { ...run, items }, 0),
      );
      if (result.accepted !== items.length)
        throw new UsageError(
          "AlphaXiv import stopped before completion. Retry the same file if it is still current.",
        );
    }
    const finish = finishReply.parse(
      await api.write(mirrorPath + "/finish", run, 8),
    );
    if (!finish.completed)
      throw new UsageError("A newer alphaXiv snapshot took over this import.");
    return {
      data: {
        status: "synced",
        takenAt: run.takenAt,
        counts,
        snapshotFallbacks,
        missingMetadata: finish.missingMetadata,
      },
    };
  };
  try {
    return dryRun ? await work() : await withFlowLock(deps, work);
  } catch (error) {
    if (error instanceof BudgetStop || error instanceof QuotaExceeded)
      throw new UsageError(
        "Write budget reached. Retry the same alphaXiv snapshot after " +
          error.resumeAt +
          ".",
      );
    throw error;
  }
}

async function readMirror(api: FeedApi, expected?: MirrorRun) {
  const items: MirrorItem[] = [];
  const pendingMetadata = new Set<string>();
  let after: string | null = "";
  do {
    const page = mirrorState.parse(
      await api.get(mirrorPath + "?" + new URLSearchParams({ after })),
    );
    if (expected && !sameRun(page.active, expected))
      throw new UsageError("A newer alphaXiv snapshot took over this import.");
    items.push(...page.items);
    for (const id of page.pendingMetadata) pendingMetadata.add(id);
    after = page.nextCursor;
  } while (after !== null);
  return { items, pendingMetadata };
}

function describeChange({ kind, item, previous }: MirrorChange) {
  const { title, paperId, paperType } = item;
  const summary = { kind, title, url: alphaXivUrl(paperId, paperType) };
  if (item.paperType === "private") return summary;
  const fields = (p: Extract<MirrorItem, { paperType: "public" }>) => ({
    title: p.title,
    folders: p.folders.map((f) => f.path),
    status: p.status,
    publicationDate: p.publicationDate,
    annotation: p.annotation,
  });
  return {
    ...summary,
    before: previous?.paperType === "public" ? fields(previous) : null,
    after: kind === "remove" ? null : fields(item),
  };
}

async function prepareWrites(
  api: FeedApi,
  deps: FlowDeps,
  changes: MirrorChange[],
  current: Awaited<ReturnType<typeof readMirror>>,
) {
  const candidates = changes.flatMap(({ kind, item }) =>
    kind === "add" && item.paperType === "public" ? [item.paperId] : [],
  );
  const unknown = new Set<string>();
  for (const batch of chunks(candidates, 50)) {
    const params = new URLSearchParams(batch.map((id) => ["id", id]));
    const known = new Set(
      knownArxivResult.parse(await api.get(mirrorPath + "/known?" + params)),
    );
    for (const id of batch) if (!known.has(id)) unknown.add(id);
  }
  const changedPublic = new Map(
    changes.flatMap(({ item }) =>
      item.paperType === "public" ? [[item.paperId, item] as const] : [],
    ),
  );
  const retries = current.items.flatMap((item) => {
    if (
      item.paperType !== "public" ||
      !current.pendingMetadata.has(item.paperId)
    )
      return [];
    const next = changedPublic.get(item.paperId) ?? item;
    return next.folders.length ? [next] : [];
  });
  const requested = new Set([
    ...unknown,
    ...retries.map((item) => item.paperId),
  ]);
  const metadata = await fetchMetadata(deps, [...requested]);
  const itemsToSend = [...changes.map(({ item }) => item)];
  for (const item of retries)
    if (
      !changedPublic.has(item.paperId) &&
      metadata.get(item.paperId)?.abstract
    )
      itemsToSend.push(item);

  const items: MirrorWrite["items"] = itemsToSend.map((item) => {
    const found =
      item.paperType === "public" && item.folders.length
        ? metadata.get(item.paperId)
        : undefined;
    return found ? { ...item, metadata: found } : item;
  });
  return {
    items,
    snapshotFallbacks: [...unknown].filter((id) => !metadata.has(id)).length,
  };
}

async function fetchMetadata(deps: FlowDeps, ids: string[]) {
  const sleep =
    deps.flow?.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const arxiv = createArxivClient({
    fetchImpl: deps.fetch,
    acquire: localLimiter("arxiv", sleep).acquire,
    sleep,
  });
  const metadata = new Map<string, z.output<typeof arxivMetadata>>();
  for (const batch of chunks(ids, 50)) {
    const papers = await arxiv.byIds(batch).catch(() => []);
    const requested = new Set(batch);
    for (const paper of papers) {
      const id = arxivId.safeParse(paper.arxiv);
      if (!id.success || !requested.has(id.data)) continue;
      const parsed = arxivMetadata.safeParse({
        title: paper.title.slice(0, 1000),
        authors: paper.authors
          .filter((author) => author.name.trim())
          .slice(0, 200)
          .map(({ name }) => ({ name: name.slice(0, 300) })),
        abstract: paper.abstract?.trim().slice(0, 20_000) || undefined,
        publicationDate: z.iso.date().safeParse(paper.published?.slice(0, 10))
          .data,
      });
      if (parsed.success) metadata.set(id.data, parsed.data);
    }
  }
  return metadata;
}
