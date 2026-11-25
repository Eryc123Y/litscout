import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LitScoutConfig } from "@litscout/core";
import { watchVenues, feedLineSchema } from "@litscout/sources/watch/library";
import { paperSchema } from "@litscout/pipeline/contracts/index";
import { shiftDay } from "@litscout/pipeline/daily";
import { topicsFor } from "@litscout/pipeline/topics";
import type { CrawlDeps } from "./source-crawl";
import { validateRecords } from "@litscout/pipeline/records";
function feedInput(
  raw: z.infer<typeof feedLineSchema>,
  kinds: Map<string, string>,
) {
  const identifiers = [
    raw.arxiv_id ? { scheme: "arxiv", value: raw.arxiv_id } : null,
    raw.doi ? { scheme: "doi", value: raw.doi } : null,
    raw.openreview_id
      ? { scheme: "openreview", value: raw.openreview_id }
      : null,
  ].filter(Boolean);
  if (!identifiers.length) identifiers.push({ scheme: "url", value: raw.url });
  const i = identifiers[0]!;
  return paperSchema.parse({
    key: i.scheme === "arxiv" ? i.value : i.scheme + ":" + i.value,
    title: raw.title,
    abstract: raw.abstract,
    authors: raw.authors,
    source: raw.source,
    venue: raw.venue,
    venueKind: kinds.get(raw.venue) ?? "journal",
    publishedOn: raw.published,
    identifiers,
    links: [
      { kind: "landing", url: raw.url },
      ...(raw.oa_url ? [{ kind: "pdf_oa", url: raw.oa_url }] : []),
    ],
  });
}

export async function venuePapers(
  config: LitScoutConfig,
  deps: CrawlDeps,
  day: string,
  cursor: string | null,
  state: Map<string, string>,
) {
  const file = path.resolve(deps.cwd, config.sources.venues.watchlist);
  const venues = await readVenues(file);
  if (!venues.length) return [];
  const stored = cursor
    ? z.object({ since: z.iso.date() }).parse(JSON.parse(cursor)).since
    : shiftDay(day, -7);
  const since = [stored, shiftDay(day, -4)].sort()[0]!;
  const lines = await watchVenues(
    [
      "--venues",
      file,
      "--since",
      since,
      "--until",
      day,
      "--kinds",
      config.sources.venues.kinds.join(","),
    ],
    watchDependencies(deps, file, state),
  );
  const kinds = new Map(venues.map((v) => [v.name, v.kind]));
  const parsed = validateRecords(day, lines, (line) =>
    feedInput(feedLineSchema.parse(line), kinds),
  );
  parsed.invalid.forEach((issue) => deps.onInvalid?.(issue));
  return parsed.accepted.filter(
    (p) =>
      venues.find((v) => v.name === p.venue)?.match !== "topics" ||
      topicsFor({ title: p.title, summary: p.abstract ?? "" }, config.topics)
        .length > 0,
  );
}

function watchDependencies(
  deps: CrawlDeps,
  file: string,
  state: Map<string, string>,
) {
  return {
    fetch: deps.fetch,
    env: deps.env,
    readFile: (f: string) =>
      readFile(
        f === file ? file : path.join(deps.dir, path.basename(f)),
        "utf8",
      ),
    writeFile: async (f: string, text: string) => {
      state.set(path.basename(f), text);
    },
    stderr: () => {},
    onWarning: (message: string, error?: unknown) => {
      const warning =
        error ?? Object.assign(new Error(message), { name: "WatchWarning" });
      deps.report?.("venues", warning, message);
    },
    now: deps.now,
    sleep: deps.sleep,
  };
}

export async function commitState(
  dir: string,
  state: Iterable<[string, string]>,
) {
  for (const [file, text] of state) {
    const target = path.join(dir, path.basename(file));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target + ".tmp", text, { mode: 0o600 });
    await rename(target + ".tmp", target);
  }
}

/** Names of the watchlist venues marked `top`; none when the file is missing. */
export async function topVenueNames(file: string) {
  const venues = await readVenues(file).catch(() => []);
  return venues.filter((v) => v.top === true).map((v) => v.name);
}

async function readVenues(file: string) {
  const raw: unknown = JSON.parse(await readFile(file, "utf8"));
  const venues = z
    .array(
      z
        .object({
          name: z.string(),
          kind: z.string(),
          match: z.enum(["all", "topics"]).optional(),
          top: z.boolean().optional(),
        })
        .passthrough(),
    )
    .parse(z.object({ venues: z.array(z.unknown()) }).parse(raw).venues);
  return venues;
}
