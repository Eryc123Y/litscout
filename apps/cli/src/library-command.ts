import { z } from "zod";
import {
  libraryQuery,
  linkLimit,
  saveInput,
  type LibraryPage,
  type SaveResult,
} from "@litscout/pipeline/library-contracts";
import type { LitScoutConfig } from "@litscout/core";
import { endpointConfig } from "./endpoint";
import { credential, nowFor } from "./flow-runtime";
import {
  UsageError,
  type SetupDeps,
  type CommandResult,
} from "./command-types";
import { flowOptions } from "./flow-options";
import { checkLink } from "./link-check";
import { zoteroImportCommand, zoteroOptions } from "./zotero-import";

async function libraryRequester(deps: SetupDeps, config: LitScoutConfig) {
  const base = (await endpointConfig(config, deps.dir)).config.instance
    .publicUrl;
  if (!base)
    throw new UsageError("Set instance.publicUrl before using the library");
  const token = await credential(deps, base);
  return (route: string, body?: unknown) =>
    deps.fetch(new URL("/api/v1" + route, base), {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
}

async function requestLibrary(
  request: Awaited<ReturnType<typeof libraryRequester>>,
  route: string,
  body?: unknown,
) {
  const response = await request(route, body);
  if (!response.ok)
    throw new UsageError(
      response.status === 404 && route === "/library/save"
        ? "Paper not found. Check the identifier or try the title."
        : `LitScout API returned HTTP ${response.status}. Check the instance and token scope.`,
    );
  return z
    .object({ success: z.literal(true), data: z.unknown() })
    .parse(await response.json()).data;
}

export function libraryOptions(args: readonly string[]) {
  const [command, ...rest] = args;
  if (command === "library") return zoteroOptions(rest);
  if (command === "links" && rest.shift() !== "check")
    throw new UsageError("Use links check [--limit N]");
  let opts: ReturnType<typeof flowOptions>;
  try {
    opts = flowOptions(
      rest,
      command === "save" ? ["dry-run"] : command === "links" ? ["limit"] : [],
    );
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const query = opts.positional.join(" ");
  if (command === "save")
    return {
      command,
      input: saveInput.parse({
        query,
        source: "cli",
        dry_run: opts.values["dry-run"] === "true",
      }),
    } as const;
  if (command === "search")
    return {
      command,
      query: libraryQuery.required({ q: true }).parse({ q: query }).q,
    } as const;
  if (command !== "links" || query)
    throw new UsageError("Use links check [--limit N]");
  return { command, limit: linkLimit.parse(opts.values.limit) } as const;
}

export async function libraryCommand(
  args: readonly string[],
  deps: SetupDeps,
  config: LitScoutConfig,
): Promise<CommandResult> {
  const options = libraryOptions(args);
  if (options.command === "import")
    return zoteroImportCommand(options, deps, config, () =>
      libraryRequester(deps, config),
    );
  const request = await libraryRequester(deps, config);
  if (options.command === "save") {
    const data = (await requestLibrary(
      request,
      "/library/save",
      options.input,
    )) as SaveResult;
    return {
      data,
      empty: data.status === "confirm" && !data.candidates.length,
    };
  }
  if (options.command === "search") {
    const q = new URLSearchParams({ q: options.query });
    const limit = libraryQuery.parse({}).limit;
    const items: LibraryPage["items"] = [];
    const seen = new Set<string>();
    let data: LibraryPage;
    do {
      data = (await requestLibrary(request, "/library?" + q)) as LibraryPage;
      items.push(...data.items);
      if (!data.nextCursor || items.length >= limit) break;
      if (seen.has(data.nextCursor))
        throw new UsageError("The Library API repeated a search cursor.");
      seen.add(data.nextCursor);
      q.set("cursor", data.nextCursor);
      q.set("limit", String(limit - items.length));
    } while (true);
    return { data: { ...data, items }, empty: !items.length };
  }
  const { items } = z
    .object({
      items: z.array(z.object({ id: z.string(), url: z.string() })).max(20),
    })
    .parse(
      await requestLibrary(request, "/ingest/links?limit=" + options.limit),
    );
  const checks = [];
  const inspect = deps.flow?.probeLink ?? checkLink;
  for (const link of items)
    checks.push({
      ...link,
      httpStatus: await inspect(link.url),
      checkedAt: nowFor(deps).toISOString(),
    });
  if (!checks.length) return { data: { updated: 0 }, empty: true };
  return {
    data: await requestLibrary(request, "/ingest/links", { checks }),
  };
}
