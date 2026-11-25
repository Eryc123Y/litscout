import { digestFolder } from "./legacy-folder";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  importLegacy,
  planLegacy,
  legacyWindow,
  importCheckpointSchema,
} from "@litscout/sync/legacy";
import type { FeedApi } from "@litscout/pipeline/api";
import { daySchema } from "@litscout/pipeline/contracts/index";
import { shiftDay } from "@litscout/pipeline/daily";
import { topicsFor, type Topic } from "@litscout/pipeline/topics";
import { gitRead, nowFor, type FlowDeps } from "./flow-runtime";
import { flowOptions, integerOption } from "./flow-options";
import {
  readCheckpoint,
  resumeDirectory,
  resumePath,
  writeCheckpoint,
} from "./checkpoint-store";
import { access, rm } from "node:fs/promises";
import { constants } from "node:fs";
async function readLegacy(
  repo: string,
  window: ReturnType<typeof legacyWindow>,
  deps: FlowDeps,
) {
  const read = deps.flow?.git ?? gitRead;
  const ref = await read(repo, ["rev-parse", "--verify", "refs/heads/data"])
    .then(() => "refs/heads/data")
    .catch(async () => {
      await read(repo, ["rev-parse", "--verify", "refs/remotes/origin/data"]);
      return "refs/remotes/origin/data";
    });
  const listing = (
    await read(repo, ["ls-tree", "-r", "--name-only", ref])
  ).split("\n");
  const files: Record<string, string> = {};
  for (const file of listing) {
    const date = file.match(
      /^data\/(\d{4}-\d{2}-\d{2})(?:_AI_enhanced_(?:Chinese|English)\.jsonl|_hf\.json|\.jsonl)$/,
    )?.[1];
    const metadata =
      /^(?:assets\/(?:feed-cursor|venues|venue-days)\.json|venues\.json|logs\/summary-runs\.jsonl)$/.test(
        file,
      );
    if ((date && date >= window.from && date <= window.to) || metadata)
      files[file] = await read(repo, ["show", `${ref}:${file}`]);
  }
  return files;
}
export type LegacyDefaults = {
  repo: string;
  from: string;
  to: string;
  dir?: string;
};
export function legacyOptions(
  args: readonly string[],
  defaults?: LegacyDefaults,
) {
  const { values: parsed, positional } = flowOptions(args, [
    "repo",
    "dir",
    "from",
    "to",
    "days",
    "dry-run",
    "max-rows",
    "keep-rows",
  ]);
  // Without a repository argument, use the configured window as a whole.
  const useDefaults =
    !parsed.repo &&
    defaults !== undefined &&
    !parsed.from &&
    !parsed.to &&
    parsed.days === undefined;
  // The configured window is one source, so its digest folder is configured too.
  if (useDefaults && parsed.dir !== undefined)
    throw new Error("Set legacy.dir in the config, or pass --repo with --dir");
  const v: Readonly<Record<string, string | undefined>> = useDefaults
    ? {
        ...parsed,
        repo: defaults.repo,
        from: defaults.from,
        to: defaults.to,
        dir: defaults.dir,
      }
    : parsed;
  if (positional.length || !v.repo)
    throw new Error(
      "Use legacy import --repo PATH [--dir DIGEST_FOLDER] [--from DAY --to DAY] [--max-rows N] [--keep-rows N] [--dry-run]",
    );
  if (v.days !== undefined && v.from)
    throw new Error("Use either --days or --from");
  if (
    (v["max-rows"] !== undefined || v["keep-rows"] !== undefined) &&
    v["dry-run"]
  )
    throw new Error("--max-rows and --keep-rows apply only when importing");
  return {
    repo: v.repo,
    dir: v.dir,
    from: daySchema.optional().parse(v.from),
    to: daySchema.optional().parse(v.to),
    days: integerOption(v.days, 30, 36600),
    maxRows:
      v["max-rows"] === undefined
        ? undefined
        : integerOption(v["max-rows"], 0, Number.MAX_SAFE_INTEGER),
    keepRows:
      v["keep-rows"] === undefined
        ? undefined
        : integerOption(v["keep-rows"], 0, Number.MAX_SAFE_INTEGER),
    dryRun: v["dry-run"] === "true",
    fromConfig: useDefaults,
  };
}

export async function legacyCommand(
  args: readonly string[],
  deps: FlowDeps,
  api?: FeedApi,
  topics: readonly Topic[] = [],
  endpoint = "configured-instance",
  defaults?: LegacyDefaults,
) {
  const options = legacyOptions(args, defaults);
  const today = nowFor(deps).toISOString().slice(0, 10);
  const requested = legacyWindow(
    today,
    options.from ?? shiftDay(options.to ?? today, 1 - options.days),
    options.to ?? today,
  );
  // Configured paths are relative to the config file, as doctor reads them.
  const base = options.fromConfig ? (deps.configDir ?? deps.cwd) : deps.cwd;
  const repo = path.resolve(base, options.repo);
  const directory = options.dir ? path.resolve(base, options.dir) : undefined;
  // The UTC date changes between runs. Keep an implicit endpoint fixed until
  // the current capped import finishes.
  const pin =
    options.dryRun ||
    options.to ||
    (options.maxRows === undefined && options.keepRows === undefined)
      ? undefined
      : path.join(
          await resumeDirectory(deps.dir, endpoint),
          "window-" +
            createHash("sha256")
              .update(
                JSON.stringify({
                  repo,
                  directory,
                  from: options.from,
                  days: options.days,
                }),
              )
              .digest("hex")
              .slice(0, 32) +
            ".json",
        );
  const saved = pin ? await readCheckpoint(pin, windowSchema, 2048) : null;
  const window = saved ?? requested;
  // A fixed window that finished once is not read again on later runs.
  const done =
    // Only the configured window: an explicit window imports again on request.
    options.fromConfig && options.to && !options.dryRun
      ? doneMarker(
          await resumeDirectory(deps.dir, endpoint),
          repo,
          directory,
          window,
        )
      : undefined;
  if (done && (await readCheckpoint(done, windowSchema, 2048)))
    return { status: "done" as const, alreadyDone: true, window };
  const files = await readLegacy(repo, window, deps);
  const folder = await digestFolder(directory);
  const raw = planLegacy(files, folder, window);
  const plan = tagLegacy(raw, topics);
  const name =
    "legacy:" +
    createHash("sha256")
      .update(JSON.stringify({ repo, window, plan }))
      .digest("hex")
      .slice(0, 32);
  if (options.dryRun) return importLegacy(plan, dryApi, name, true);
  if (!api) throw new Error("Legacy import needs a configured API");
  if (pin && !saved) await writeCheckpoint(pin, window, 2048);
  const result = await importResuming(
    plan,
    api,
    name,
    deps,
    endpoint,
    options.maxRows,
    options.keepRows,
  );
  if (pin && result.status === "done") await rm(pin, { force: true });
  if (done && result.status === "done")
    await writeCheckpoint(done, window, 2048);
  return result;
}

const windowSchema = z.strictObject({ from: daySchema, to: daySchema });

function doneMarker(
  folder: string,
  repo: string,
  directory: string | undefined,
  window: { from: string; to: string },
) {
  const key = createHash("sha256")
    .update(JSON.stringify({ repo, directory, window }))
    .digest("hex")
    .slice(0, 32);
  return path.join(folder, "legacy-done-" + key + ".json");
}

const readableDirectory = (target: string) =>
  access(target, constants.R_OK | constants.X_OK).then(
    () => true,
    () => false,
  );

/** Where the configured window stands, for doctor. Reads no repository content. */
export async function legacyStatus(
  deps: Pick<FlowDeps, "cwd" | "dir">,
  legacy: LegacyDefaults | undefined,
  endpoint = "configured-instance",
  configDir = deps.cwd,
) {
  if (!legacy) return { ok: true, configured: false } as const;
  const repo = path.resolve(configDir, legacy.repo);
  const directory = legacy.dir
    ? path.resolve(configDir, legacy.dir)
    : undefined;
  const window = legacyWindow(legacy.to, legacy.from, legacy.to);
  const marker = doneMarker(
    resumePath(deps.dir, endpoint),
    repo,
    directory,
    window,
  );
  // A finished window needs nothing more from its source, wherever it is now.
  if (await readCheckpoint(marker, windowSchema, 2048))
    return { ok: true, configured: true, ...window, done: true } as const;
  const readable =
    (await readableDirectory(repo)) &&
    (!directory || (await readableDirectory(directory)));
  if (!readable)
    return {
      ok: false,
      configured: true,
      hint: "Set legacy.repo (and legacy.dir, if set) to a readable local directory.",
    } as const;
  return { ok: true, configured: true, ...window, done: false } as const;
}

function tagLegacy(
  raw: ReturnType<typeof planLegacy>,
  topics: readonly Topic[],
) {
  const plan = {
    ...raw,
    days: raw.days.map((d) => ({
      ...d,
      papers: d.papers.map((p) => {
        const names = topicsFor(
          { title: p.title, summary: p.abstract ?? "" },
          topics,
        );
        return { ...p, topics: names, shortlisted: Boolean(names.length) };
      }),
    })),
  };
  return plan;
}

const dryApi: FeedApi = {
  get: async () => null,
  write: async () => {
    throw new Error("Dry run must never upload");
  },
};

async function importResuming(
  plan: ReturnType<typeof planLegacy>,
  api: FeedApi,
  name: string,
  deps: FlowDeps,
  endpoint: string,
  maxRows?: number,
  keepRows?: number,
) {
  const file = path.join(
    await resumeDirectory(deps.dir, endpoint),
    "legacy-" + name.slice(7) + ".json",
  );
  const state = await readCheckpoint(file, importCheckpointSchema, 2048);
  const result = await importLegacy(
    plan,
    api,
    name,
    false,
    {
      state,
      save: (value) => writeCheckpoint(file, value, 2048),
    },
    maxRows,
    nowFor(deps),
    keepRows,
  );
  if (result.status === "done") await rm(file, { force: true });
  return result;
}
