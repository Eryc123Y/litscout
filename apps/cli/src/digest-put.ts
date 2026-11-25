import { loadFullFeed } from "@litscout/pipeline/read-client";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { LitScoutConfig } from "@litscout/core";
import {
  digestSchema,
  type DigestDraft,
  type FeedItem,
} from "@litscout/pipeline/contracts/index";
import { digestSelection, renderDigest } from "@litscout/pipeline/digest";
import type { FeedApi } from "@litscout/pipeline/api";
import type { FlowDeps } from "./flow-runtime";
import {
  localDigestResearch,
  privateDigestText,
  readDigestBriefs,
  type DigestResearch,
} from "./digest-research";
import { filterDigestOutput, markdownFilter } from "./digest-output";
import { recordStep } from "./summary-command";
/** A draft that breaks a digest rule the writer can fix by writing it again. */
export class DigestRuleError extends Error {}
/** IDs from model output, shortened and capped before they go into a prompt. */
const named = (ids: readonly string[]) =>
  ids
    .slice(0, 5)
    .map((id) => id.slice(0, 40))
    .join(", ") + (ids.length > 5 ? ", ..." : "");
/**
 * Radar entries name their project twice: a label the writer reasons with
 * and a 64-character ID it copies. When the label starts with a known
 * project's title and the ID names another, the label wins (2026-11-19: an
 * entry labelled Sparse Reward was saved under ViewSynth). An ID outside
 * the digest's projects is dropped; the label stays.
 */
export function repairRadarProjects<
  T extends { projectId: string | null; project?: string },
>(radar: readonly T[], projects: readonly { id: string; title: string }[]) {
  const fold = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
  const known = new Set(projects.map(({ id }) => id));
  const byLabel = (label?: string) =>
    label
      ? [...projects]
          .filter(({ title }) => fold(label).startsWith(fold(title)))
          .sort((a, b) => b.title.length - a.title.length)[0]
      : undefined;
  let corrected = 0;
  let dropped = 0;
  const repaired = radar.map((entry) => {
    if (!entry.projectId) return entry;
    const named = byLabel(entry.project);
    if (named && named.id !== entry.projectId) {
      corrected += 1;
      return { ...entry, projectId: named.id };
    }
    if (!known.has(entry.projectId)) {
      dropped += 1;
      return { ...entry, projectId: null };
    }
    return entry;
  });
  const repairs: string[] = [];
  if (corrected)
    repairs.push(
      corrected === 1
        ? "Corrected 1 radar project ID to match its project label"
        : `Corrected ${corrected} radar project IDs to match their project labels`,
    );
  if (dropped)
    repairs.push(
      `Dropped ${dropped} radar project ID${dropped === 1 ? "" : "s"} outside the digest context`,
    );
  return { radar: repaired, repairs };
}

/**
 * Fixes rule breaks in a writer's draft that cost nothing to correct: picks
 * over a topic's limit, picks under a topic that is not configured, and
 * journal picks that are arXiv papers. Each fix is reported. A paper outside
 * the day is not repaired: it can mean an invented ID, so validation fails.
 */
function repairDraft(
  draft: DigestDraft,
  papers: FeedItem[],
  config: LitScoutConfig,
  research?: DigestResearch,
): { draft: DigestDraft; repairs: string[] } {
  const repairs: string[] = [];
  // Only with the vault's projects at hand: without them every ID would look
  // unknown.
  const radar = research
    ? repairRadarProjects(draft.radar, research.fields.vaultProjects)
    : { radar: draft.radar, repairs: [] };
  repairs.push(...radar.repairs);
  const known = new Set(config.topics.map((topic) => topic.name));
  const topics = Object.fromEntries(
    Object.entries(draft.topics).flatMap(([name, picks]) => {
      if (!known.has(name)) {
        if (picks.length)
          repairs.push(
            `Dropped picks for unknown topic "${name.slice(0, 80)}"`,
          );
        return [];
      }
      const limit = config.digest.picksPerTopic;
      if (picks.length > limit)
        repairs.push(
          `Dropped ${picks.length - limit} topic pick${picks.length - limit === 1 ? "" : "s"} beyond the limit of ${limit} for ${name}`,
        );
      return [[name, picks.slice(0, limit)]];
    }),
  );
  const journal = draft.journal.filter(
    (pick) =>
      papers.find((p) => p.paperId === pick.paperId)?.source !== "arxiv",
  );
  const droppedJournal = draft.journal.length - journal.length;
  if (droppedJournal)
    repairs.push(
      `Dropped ${droppedJournal} journal pick${droppedJournal === 1 ? "" : "s"} that ${droppedJournal === 1 ? "is" : "are"} not a venue paper`,
    );
  // Report each kind of repair once, in a stable order.
  return {
    draft: { ...draft, topics, journal, radar: radar.radar },
    repairs: [...new Set(repairs)],
  };
}
function validatePicks(
  draft: DigestDraft,
  papers: FeedItem[],
  config: LitScoutConfig,
  research: DigestResearch,
) {
  if (draft.lang !== config.instance.language)
    throw new DigestRuleError("Digest language must follow instance.language");
  const suggestions = draft.suggestions ?? [];
  if (suggestions.length > config.digest.suggestionsPerDay)
    throw new DigestRuleError("Too many idea suggestions for the day");
  const strayIdeas = suggestions.flatMap((item) =>
    item.paperIds.filter((id) => !papers.some((p) => p.paperId === id)),
  );
  if (strayIdeas.length)
    throw new DigestRuleError(
      `A suggestion names a paper outside this day (${named(strayIdeas)})`,
    );
  const ideas = new Set(research?.fields.openIdeas.map(({ id }) => id));
  const projects = new Set(research?.fields.vaultProjects.map(({ id }) => id));
  if (
    suggestions.some(
      ({ ideaIds, projectIds }) =>
        ideaIds.some((id) => !ideas.has(id)) ||
        projectIds.some((id) => !projects.has(id)),
    )
  )
    throw new DigestRuleError(
      "A suggestion names an idea or project outside the digest context",
    );
  const picks = [
    ...Object.values(draft.topics).flat(),
    ...draft.other,
    ...draft.journal,
  ].map((p) => p.paperId);
  const ids = [...new Set([...picks, ...draft.radar.map((r) => r.paperId)])];
  const stray = ids.filter((id) => !papers.some((p) => p.paperId === id));
  if (stray.length)
    throw new DigestRuleError(
      `Digest names a paper outside this day (${named(stray)})`,
    );
  if (
    Object.keys(draft.topics).some(
      (t) => !config.topics.some((topic) => topic.name === t),
    )
  )
    throw new DigestRuleError("Digest names an unknown topic");
  if (
    Object.values(draft.topics).some(
      (p) => p.length > config.digest.picksPerTopic,
    )
  )
    throw new DigestRuleError("Too many picks for a topic");
  if (
    draft.journal.some(
      (p) => papers.find((v) => v.paperId === p.paperId)?.source === "arxiv",
    )
  )
    throw new DigestRuleError("Journal picks must be venue papers");
}
async function validateFullText(draft: DigestDraft, api: FeedApi) {
  if (!draft.radar.some((r) => r.fullTextRead)) return;
  const cursor = z
    .object({ value: z.string() })
    .nullable()
    .parse(await api.get(`/sync/cursors?name=fulltext:${draft.day}`));
  const read = cursor
    ? z.array(z.string()).parse(JSON.parse(cursor.value))
    : [];
  if (draft.radar.some((r) => r.fullTextRead && !read.includes(r.paperId)))
    throw new DigestRuleError(
      "Full-text grades require a successful fulltext context request; grade those radar papers as borrow without fullTextRead",
    );
}
/**
 * A day has a reading batch once its arXiv listing is in. A day without one
 * (venue papers only, such as a weekend) has one only when the run names it
 * with --day; a pending day is still waiting for its listing either way.
 */
export function hasReadingBatch(
  feed: Awaited<ReturnType<typeof loadFullFeed>>,
  namedDay = false,
) {
  return (
    !["pending", "empty"].includes(feed.status) &&
    (namedDay
      ? feed.items.length > 0
      : feed.items.some((paper) => paper.source === "arxiv"))
  );
}
export function summaryCompletion(papers: FeedItem[], lang: "en" | "zh") {
  const eligible = papers.filter((p) => p.abstract?.trim());
  const done = eligible.filter((p) =>
    p.summaries.some((s) => s.lang === lang || s.client === "legacy"),
  ).length;
  return { done, total: eligible.length };
}
async function uploadDraft(
  draft: DigestDraft,
  bodyMd: string,
  ids: string[],
  api: FeedApi,
) {
  await api.write(
    "/ingest/radar",
    { radar: draft.radar.map((r) => ({ ...r, day: draft.day })) },
    draft.radar.length * 10,
  );
  await api.write(
    `/digests/${draft.day}`,
    {
      day: draft.day,
      lang: draft.lang,
      bodyMd,
      picks: ids,
      radar: draft.radar,
      final: draft.final,
      ...(draft.suggestions?.length ? { suggestions: draft.suggestions } : {}),
    },
    20 + (draft.suggestions?.length ?? 0),
    "PUT",
  );
}
export async function putDigest(
  file: string,
  api: FeedApi,
  deps: FlowDeps,
  config: LitScoutConfig,
) {
  const draft = digestSchema.parse(JSON.parse(await readFile(file, "utf8")));
  const base = deps.configDir ?? deps.cwd;
  const [briefs, research] = await Promise.all([
    readDigestBriefs(config.digest.briefFiles, base),
    config.digest.suggestionsPerDay
      ? localDigestResearch(config.vault, base, false)
      : undefined,
  ]);
  return putDigestDraft(draft, api, deps, config, research, briefs);
}
export async function putDigestDraft(
  input: unknown,
  api: FeedApi,
  deps: FlowDeps,
  config: LitScoutConfig,
  research: DigestResearch,
  briefs: { body: string }[],
  {
    dryRun = false,
    namedDay = false,
  }: { dryRun?: boolean; namedDay?: boolean } = {},
) {
  const proposed = digestSchema.parse(input);
  // A dry run checks the draft against a day that may have its digest.
  const existing =
    !dryRun &&
    (await api.get(`/digests/${proposed.day}?lang=${proposed.lang}`));
  if (existing) return { status: "exists", day: proposed.day };
  const feed = await loadFullFeed(api, proposed.day);
  if (!hasReadingBatch(feed, namedDay))
    return { status: "no-new-batch", day: proposed.day };
  const { draft: repaired, repairs } = repairDraft(
    proposed,
    feed.items,
    config,
    research,
  );
  validatePicks(repaired, feed.items, config, research);
  const { draft, droppedSuggestions, redactions } = filterDigestOutput(
    repaired,
    feed.items,
    privateDigestText(briefs, research),
    config.topics.map(({ name }) => name),
  );
  const completion = summaryCompletion(feed.items, draft.lang);
  if (!draft.final && completion.done < 0.95 * completion.total)
    return { status: "summaries-pending", day: draft.day, ...completion };
  await validateFullText(draft, api);
  const selection = digestSelection(draft, config.topics);
  const browserUrl = config.instance.webUrl;
  if (!browserUrl)
    throw new Error(
      "Set instance.webUrl to a browser origin or use an HTTPS origin for instance.publicUrl",
    );
  const bodyMd = markdownFilter(
    feed.items,
    browserUrl,
  )(
    renderDigest(
      draft,
      feed.items,
      config.topics,
      browserUrl,
      config.instance.publicFeed,
      selection,
    ),
  );
  if (dryRun)
    return {
      status: "dry-run",
      written: false,
      ...(repairs.length ? { repairs } : {}),
      droppedSuggestions,
      redactions,
      day: draft.day,
      counts: selection.counts,
      bodyMdBytes: Buffer.byteLength(bodyMd),
    };
  await uploadDraft(
    { ...draft, radar: selection.radar },
    bodyMd,
    selection.ids,
    api,
  );
  await recordStep(api, deps, "digest", draft.day, "done", {
    picks: selection.counts.total,
    counts: selection.counts,
    redactions,
  });
  return {
    status: "written",
    ...(repairs.length ? { repairs } : {}),
    droppedSuggestions,
    redactions,
    day: draft.day,
    bodyMd,
    counts: selection.counts,
  };
}
