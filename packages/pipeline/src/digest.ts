import { z } from "zod";
import { reportStrings } from "@litscout/i18n";
import { chunks } from "./api";
import { schemas, type FeedItem, type DigestDraft } from "./contracts/index";
import { shiftDay } from "./daily";
import type { Topic } from "./topics";
import { httpUrlSchema } from "./contracts/limits";
import { radarProjectTitle } from "./radar-project";
export function summaryTodo(
  day: string,
  papers: FeedItem[],
  lang: "en" | "zh",
  chunkSize: number,
) {
  const todo = papers.filter(
    (p) =>
      p.abstract?.trim() &&
      !p.summaries.some((s) => s.lang === lang || s.client === "legacy"),
  );
  return schemas.todo.parse({
    day,
    lang,
    chunks: chunks(
      todo.map((p) => ({
        paperId: p.paperId,
        title: p.title,
        abstract: p.abstract!,
      })),
      chunkSize,
    ),
    noAbstract: papers.filter((p) => !p.abstract?.trim()).length,
  });
}
export function radarCandidate(text: string, brief: string) {
  const hits = new Set<string>();
  for (const match of brief.matchAll(
    /^(SUP|REUSE|INFO|GROUND)\s*=\s*(.+)$/gm,
  )) {
    try {
      if (new RegExp(match[2]!.trim(), "i").test(text)) hits.add(match[1]!);
    } catch {
      /* Old pipeline ignores unusable expressions. */
    }
  }
  return (
    hits.has("REUSE") ||
    hits.has("GROUND") ||
    (hits.has("SUP") &&
      /efficien|sample|epoch|update|budget|compute|information|bits|scal/i.test(
        text,
      )) ||
    (hits.has("INFO") && /supervis|label|feedback|reward/i.test(text))
  );
}
export function digestContext(
  day: string,
  papers: FeedItem[],
  briefs: { path: string; body: string }[],
  ratings: unknown[],
  lang: "en" | "zh",
  known: readonly string[] = [],
  topics: readonly Topic[] = [],
) {
  const text = briefs.map((b) => b.body).join("\n");
  const briefIds = new Set(
    text.match(/\b\d{4}\.\d{4,5}\b|\b(?:doi|openreview|url):[^\s|]+/g) ?? [],
  );
  const available = papers.filter(
    (p) =>
      !known.includes(p.paperId) &&
      !p.identifiers.some((i) =>
        briefIds.has(i.scheme === "arxiv" ? i.value : i.scheme + ":" + i.value),
      ),
  );
  const topicCandidates = topics.map(({ name, keywords }) => ({
    name,
    keywords,
    paperIds: [
      ...new Set(
        available
          .filter((paper) => paper.topics.includes(name))
          .map((paper) => paper.paperId),
      ),
    ],
  }));
  const matched = new Set(topicCandidates.flatMap(({ paperIds }) => paperIds));
  return schemas.context.parse({
    day,
    lang,
    candidates: available.filter(
      (paper) => paper.shortlisted || matched.has(paper.paperId),
    ),
    topicCandidates,
    all: available.map((p) => ({
      paperId: p.paperId,
      title: p.title,
      tldr:
        p.summaries.find((s) => s.lang === lang)?.content.tldr ??
        p.summaries[0]?.content.tldr ??
        "",
    })),
    briefs,
    ratings,
    radar: available.filter((p) =>
      radarCandidate(
        `${p.title} ${p.abstract ?? p.summaries[0]?.content.tldr ?? ""}`,
        text,
      ),
    ),
  });
}
type DayLink = (
  paper?: Pick<FeedItem, "paperId" | "source">,
  topic?: string,
) => string;
function dayLink(site: string, day: string, isPublic: boolean): DayLink {
  const route = new URL(
    `/${isPublic ? "public" : "app"}/days/${day}`,
    httpUrlSchema.parse(site),
  ).href;
  return (paper, topic) => {
    const query = new URLSearchParams();
    if (paper) {
      query.set("paper", paper.paperId);
      query.set("paperSource", paper.source);
    }
    if (topic) query.set("topic", topic);
    return query.size ? `${route}?${query}` : route;
  };
}
const singleLine = (text: string) => text.replace(/[\r\n]+/g, " ");
const clean = (text: string) => singleLine(text).replace(/[\[\]<>]/g, "");
function paperLine(
  pick: { paperId: string; gist: string },
  papers: FeedItem[],
  draft: DigestDraft,
  href: DayLink,
  topic?: string,
) {
  const p = papers.find((p) => p.paperId === pick.paperId)!;
  const s = reportStrings[draft.lang],
    venue = p.source === "arxiv" ? "" : ` (${p.venue ?? p.source})`;
  const link = p.links.find((l) => ["code", "project"].includes(l.kind));
  const code = link
    ? { ...link, url: httpUrlSchema.parse(link.url) }
    : undefined;
  const title = clean(p.title),
    label = title.length > 90 ? title.slice(0, 89) + "…" : title;
  return `- [${label}](${href(p, topic ?? p.topics[0])})${venue} — ${singleLine(pick.gist)}${code ? ` · [${code.kind === "project" || /^https?:\/\/[\w-]+\.git(?:hub|lab)\.io(?:\/|$)/i.test(code.url) ? s.project : s.code}](${code.url})` : ""}`;
}
function topicLines(
  draft: DigestDraft,
  papers: FeedItem[],
  href: DayLink,
  picksByTopic: ReturnType<typeof digestSelection>["topics"],
) {
  const s = reportStrings[draft.lang],
    lines: string[] = [];
  for (const [topic, picks] of picksByTopic) {
    const matched = papers.filter((p) => p.topics.includes(topic)).length;
    lines.push(
      "",
      `**${topic}** (${s.matched} ${matched} · [${draft.lang === "zh" ? "全部" : "All"}](${href(undefined, topic)}))${matched || picks.length ? "" : `: ${s.empty}`}`,
    );
    for (const p of picks) lines.push(paperLine(p, papers, draft, href, topic));
  }
  return lines;
}
export function digestSelection(draft: DigestDraft, topics: readonly Topic[]) {
  const seen = new Set<string>();
  const select = <T extends { paperId: string }>(rows: T[]) =>
    rows.filter(({ paperId }) => {
      if (seen.has(paperId)) return false;
      seen.add(paperId);
      return true;
    });
  const levels = ["high", "medium", "borrow"] as const;
  const radar = select(
    draft.radar.toSorted(
      (a, b) => levels.indexOf(a.level) - levels.indexOf(b.level),
    ),
  );
  const byTopic = new Map(
    [...new Set(topics.map(({ name }) => name))].map((name) => [
      name,
      select(Object.hasOwn(draft.topics, name) ? draft.topics[name]! : []),
    ]),
  );
  const other = select(draft.other);
  const beforeJournal = new Set(seen);
  const journal = select(draft.journal);
  const topicCounts = Object.fromEntries(
    Array.from(byTopic, ([name, picks]) => [name, picks.length]),
  );
  return {
    radar,
    topics: byTopic,
    other,
    journal,
    beforeJournal,
    ids: [...seen],
    counts: {
      radar: {
        high: radar.filter(({ level }) => level === "high").length,
        medium: radar.filter(({ level }) => level === "medium").length,
        borrow: radar.filter(({ level }) => level === "borrow").length,
        fullText: radar.filter(({ fullTextRead }) => fullTextRead).length,
      },
      topics: topicCounts,
      topicPicks: Object.values(topicCounts).reduce(
        (total, count) => total + count,
        0,
      ),
      other: other.length,
      journal: journal.length,
      total: seen.size,
    },
  };
}
export function renderDigest(
  draft: DigestDraft,
  papers: FeedItem[],
  topics: readonly Topic[],
  site: string,
  isPublic = false,
  selection = digestSelection(draft, topics),
) {
  const href = dayLink(site, draft.day, isPublic);
  const s = reportStrings[draft.lang];
  const lines = reportHeader(draft, papers, href);
  lines.push(...radarLines(draft, papers, selection.radar, href));
  lines.push(...topicLines(draft, papers, href, selection.topics));
  if (selection.other.length)
    lines.push(
      "",
      `**${s.other}**`,
      ...selection.other.map((p) => paperLine(p, papers, draft, href)),
    );
  lines.push(...journalSection(draft, papers, selection, href));
  if (draft.reportText || draft.note)
    lines.push("", `> ${singleLine(draft.reportText || draft.note)}`);
  return lines.join("\n") + "\n";
}
function journalSection(
  draft: DigestDraft,
  papers: FeedItem[],
  selection: ReturnType<typeof digestSelection>,
  href: DayLink,
) {
  const s = reportStrings[draft.lang],
    matched = papers.filter(
      (p) =>
        p.source !== "arxiv" &&
        (p.shortlisted || selection.radar.some((r) => r.paperId === p.paperId)),
    );
  const chosen = selection.journal;
  if (!matched.length && !chosen.length) return [];
  const venues = new Map<string, number>();
  matched.forEach((p) => {
    const venue = String(p.venue ?? p.source);
    venues.set(venue, (venues.get(venue) ?? 0) + 1);
  });
  const counts = [...venues]
    .sort(([a, n], [b, m]) => m - n || a.localeCompare(b))
    .map(([v, n]) => `${v} ${n}`)
    .join(" · ");
  const above = papers.filter(
    (p) => p.source !== "arxiv" && selection.beforeJournal.has(p.paperId),
  ).length;
  const extra = above
    ? draft.lang === "zh"
      ? `，其中 ${above} 篇已列在上面`
      : `; ${above} already listed above`
    : chosen.length
      ? ""
      : `; ${s.empty}`;
  return [
    "",
    `**${s.journal}**: ${s.matched} ${matched.length} (${counts})${extra}`,
    ...chosen.map((p) => paperLine(p, papers, draft, href)),
  ];
}
export function finalDecision(
  day: string,
  final: boolean,
  exists: boolean,
  hasBatch: boolean,
  pending: number,
) {
  if (final && new Date(day).getUTCDay() === 0) return "sunday-stop";
  if (exists) return "exists";
  if (!hasBatch) return final ? "no-batch-note" : "no-new-batch";
  if (pending) return final ? "resume-summaries" : "summaries-pending";
  return "needs-digest";
}
export function noBatchNote(day: string, lang: "en" | "zh") {
  const s = reportStrings[lang];
  return `# ${s.daily} · ${day}\n\n${s.noBatch}\n`;
}
function isoWeek(day: string) {
  const date = new Date(day),
    weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  return Math.ceil(
    ((date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86400000 + 1) /
      7,
  );
}
export function weeklyReview(
  day: string,
  reports: { day: string; bodyMd: string; picks: string[]; radar: unknown[] }[],
  papers: FeedItem[],
  misses: z.output<typeof schemas.legacy>["missed"],
  lang: "en" | "zh",
) {
  const s = reportStrings[lang],
    week = reports.filter((r) => r.day >= shiftDay(day, -6) && r.day <= day);
  const picked = new Set(week.flatMap((r) => r.picks));
  const bodyMd =
    [
      `# ${s.weekly} · ${shiftDay(day, -6)} — ${day}`,
      "",
      ...week.map((r) => `## ${r.day}\n\n${r.bodyMd}`),
      "",
      `**${s.missed}**: ${misses.length}`,
    ].join("\n") + "\n";
  return schemas.weekly.parse({
    day,
    bodyMd,
    missed: misses,
    lookBack: papers.filter((p) => !picked.has(p.paperId)).slice(0, 3),
    direction: ((isoWeek(day) - 1) % 5) + 1,
  });
}

function reportHeader(draft: DigestDraft, papers: FeedItem[], href: DayLink) {
  const s = reportStrings[draft.lang];
  const done = papers.filter((p) =>
    p.summaries.some((v) => v.lang === draft.lang),
  ).length;
  const venues = papers.filter((p) => p.source !== "arxiv");
  const counts = `${papers.length - venues.length} ${draft.lang === "zh" ? "篇新论文" : "new papers"}${venues.length ? ` · ${draft.lang === "zh" ? "期刊和会议" : "venues"} ${venues.length}` : ""}`;
  const lines = [
    `# ${s.daily} · ${draft.day}`,
    "",
    `**${counts}** (${s.summary} ${done}/${papers.length}) · [${s.open}](${href()})`,
    "",
  ];
  const hot = papers
    .flatMap((paper) =>
      typeof paper.hfUpvotes === "number" && paper.hfUpvotes >= 10
        ? [{ paper, upvotes: paper.hfUpvotes }]
        : [],
    )
    .sort((first, second) => second.upvotes - first.upvotes);
  const seen = new Set<string>();
  const popular = hot
    .filter(({ paper }) => {
      if (seen.has(paper.paperId)) return false;
      seen.add(paper.paperId);
      return true;
    })
    .slice(0, 2);
  if (popular.length)
    lines.push(
      `**${s.hot}**: ${popular
        .map(
          ({ paper, upvotes }) =>
            `[${clean(paper.title)}](${href(paper)}) ▲${upvotes}`,
        )
        .join("; ")}`,
      "",
    );
  return lines;
}
/** Why the paper matters and how it could help, after what it shows. */
function radarHelp(item: DigestDraft["radar"][number], lang: "en" | "zh") {
  const s = reportStrings[lang];
  const [colon, join] = lang === "zh" ? ["：", "；"] : [": ", "; "];
  return [
    item.relevance ? ` ${s.whyItMatters}${colon}${item.relevance}` : "",
    item.angles.length
      ? ` ${s.waysToHelp}${colon}${item.angles.join(join)}`
      : "",
  ].join("");
}
function radarLines(
  draft: DigestDraft,
  papers: FeedItem[],
  radar: DigestDraft["radar"],
  href: DayLink,
) {
  const s = reportStrings[draft.lang],
    lines: string[] = [];
  lines.push(`**${s.radar}**${radar.length ? ":" : `: ${s.noRadar}`}`);
  for (const item of radar) {
    const title = radarProjectTitle(item);
    lines.push(
      paperLine(
        {
          paperId: item.paperId,
          gist: `${title ? `${title} · ` : ""}${s.levels[item.level]}, ${item.fullTextRead ? s.full : s.abstract}: ${item.reason}${radarHelp(item, draft.lang)}`,
        },
        papers,
        draft,
        href,
      ),
    );
  }
  return lines;
}
