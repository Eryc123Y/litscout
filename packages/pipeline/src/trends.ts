import type { z } from "zod";
import type {
  TrendComparison,
  TrendPaper,
  TrendRow,
  trendEvent,
  trendRadar,
} from "./trends-contracts";

type TermsInput = { papers: TrendPaper[]; picks: string[] };
/** Last month's terms, with the listing days its papers came from when known. */
type BaselineInput = TermsInput & { days?: readonly string[] };
export type TrendMonthInput = TermsInput & {
  radar: z.output<typeof trendRadar>[];
  events: z.output<typeof trendEvent>[];
  references: TrendPaper[];
};
type TrendTopic = { name: string; keywords: string[] };

const words = /[\p{L}\p{N}]+/gu;
const startsWithLetter = /^\p{L}/u;
const normalized = (text: string) => text.normalize("NFKC").toLowerCase();
const tokens = (text: string) =>
  (normalized(text).match(words) ?? []).filter((term) =>
    startsWithLetter.test(term),
  );

export function trendTermMatcher(term: string) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const whole = new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`,
    "u",
  );
  return (text: string) => {
    const value = normalized(text);
    return value.includes(term) && whole.test(value);
  };
}

const stopWords = new Set(
  `about across after again against also among analysis approach based because
  been before being between both can compared could despite does during each
  effective existing first from further have having here however into large
  less most more method methods model models novel only other over paper performance
  present previous problem propose proposed provide recent research results
  same should show shown some study such system systems task tasks than that
  their them then there these they this those through thus under until upon use
  used uses using very via want were what when where which while will with
  within without work would your and are for has how its may new not one our
  out the two was who yet all any few per dataset datasets framework
  but three introduce introduces demonstrate demonstrates address addresses
  extensive establish establishes state art experiments experimental achieve
  achieves outperform outperforms leverage leverages enable enables
  significantly furthermore often including leading relies researchers
  highest previously every key current available making improving
  empirically settings challenges next match perfect hard classic paradigm
  properties strong design prior baselines complex maximize level multi fine
  aware`.split(/\s+/),
);

function uniquePapers(papers: TrendPaper[]) {
  const result = new Map<
    string,
    TrendPaper & { shortlistedTopics: Set<string> }
  >();
  for (const paper of papers) {
    const first = result.get(paper.paperId);
    if (first) {
      first.topics = [...new Set([...first.topics, ...paper.topics])];
      if (paper.shortlisted)
        for (const topic of paper.topics) first.shortlistedTopics.add(topic);
    } else {
      result.set(paper.paperId, {
        ...paper,
        shortlistedTopics: new Set(paper.shortlisted ? paper.topics : []),
      });
    }
  }
  return result;
}

function documentTerms(papers: Iterable<TrendPaper>) {
  return new Map(
    Array.from(papers, (paper) => [
      paper.paperId,
      new Set(
        tokens(`${paper.title} ${paper.abstract ?? ""}`).filter(
          (term) =>
            term.length >= 3 && term.length <= 32 && !stopWords.has(term),
        ),
      ),
    ]),
  );
}

function frequencies(
  papers: TrendPaper[],
  picked: Set<string>,
  byPaper: Map<string, Set<string>>,
  excluded: Set<string>,
) {
  const terms = new Map<string, { count: number; weight: number }>();
  let totalWeight = 0;
  for (const { paperId } of papers) {
    const weight = picked.has(paperId) ? 2 : 1;
    totalWeight += weight;
    for (const term of byPaper.get(paperId) ?? []) {
      if (excluded.has(term)) continue;
      const entry = terms.get(term) ?? { count: 0, weight: 0 };
      entry.count++;
      entry.weight += weight;
      terms.set(term, entry);
    }
  }
  return { terms, totalWeight };
}

/** How rare a term is among all of the month's papers: ln((N + 1) / df).
 * Words most abstracts use ("experiments", "introduce") score near zero. */
function rarity(byPaper: Map<string, Set<string>>) {
  const df = new Map<string, number>();
  for (const terms of byPaper.values())
    for (const term of terms) df.set(term, (df.get(term) ?? 0) + 1);
  return (term: string) => Math.log((byPaper.size + 1) / (df.get(term) ?? 1));
}

function termRanks(
  current: ReturnType<typeof frequencies>,
  previous: ReturnType<typeof frequencies>,
  rare: (term: string) => number,
) {
  const recurring: TrendRow["recurring"] = [],
    rising: TrendRow["rising"] = [];
  for (const [term, { count, weight }] of current.terms) {
    if (count < 2) continue;
    // Recurring: weighted topic count times rarity in the whole month.
    recurring.push({
      term,
      count,
      score: Math.round(weight * rare(term) * 100) / 100,
    });
    if (!previous.totalWeight) continue;
    // Smoothed weighted document rates, with one positive and one negative prior.
    const rate = (weight + 1) / (current.totalWeight + 2);
    const old =
      ((previous.terms.get(term)?.weight ?? 0) + 1) /
      (previous.totalWeight + 2);
    // Rising: growth times rarity, so words most abstracts use don't lead.
    if (
      rate >= old * 1.25 &&
      weight / current.totalWeight >
        (previous.terms.get(term)?.weight ?? 0) / previous.totalWeight
    )
      rising.push({
        term,
        count,
        score: Math.round((rate / old) * rare(term) * 100) / 100,
      });
  }
  const top = (results: TrendRow["recurring"]) =>
    results
      .sort(
        (a, b) =>
          b.score - a.score || b.count - a.count || (a.term < b.term ? -1 : 1),
      )
      .slice(0, 15);
  return { recurring: top(recurring), rising: top(rising) };
}

function comparison(days: readonly string[]): TrendComparison {
  const unique = [...new Set(days)].sort();
  return {
    days: unique.length,
    first: unique[0] ?? null,
    last: unique.at(-1) ?? null,
  };
}

export function aggregateTrends(
  month: string,
  topics: TrendTopic[],
  current: TrendMonthInput,
  previous: BaselineInput,
): TrendRow[] {
  const baseline = previous.days && comparison(previous.days);
  const papers = uniquePapers(current.papers);
  const oldPapers = uniquePapers(previous.papers);
  const documents = documentTerms(papers.values());
  const oldDocuments = documentTerms(oldPapers.values());
  const rare = rarity(documents);
  const referenceTopics = new Map(
    current.references.map(({ paperId, topics }) => [paperId, topics]),
  );
  const picks = new Set(current.picks),
    oldPicks = new Set(previous.picks);
  const events = new Map<string, TrendRow["activity"][number]>();
  for (const { paperId, kind } of current.events) {
    const activity = events.get(paperId) ?? {
      paperId,
      rating: null,
      saved: false,
    };
    if (kind === "save") activity.saved = true;
    else
      activity.rating =
        kind === "rate_up" ? "up" : kind === "rate_down" ? "down" : null;
    events.set(paperId, activity);
  }
  return topics.map(({ name: topic, keywords }) => {
    const matches = (id: string) =>
      (papers.get(id)?.topics ?? referenceTopics.get(id))?.includes(topic);
    const onTopic = [...papers.values()].filter((paper) =>
      paper.topics.includes(topic),
    );
    const excluded = new Set([topic, ...keywords].flatMap(tokens));
    const byLevel = {
      high: new Set<string>(),
      medium: new Set<string>(),
      borrow: new Set<string>(),
    };
    for (const { paperId, level } of current.radar)
      if (matches(paperId)) byLevel[level].add(paperId);
    return {
      topic,
      month,
      volume: onTopic.length,
      shortlisted: onTopic.filter((paper) => paper.shortlistedTopics.has(topic))
        .length,
      radar: {
        high: byLevel.high.size,
        medium: byLevel.medium.size,
        borrow: byLevel.borrow.size,
      },
      picks: [...picks].filter(matches).reverse(),
      activity: [...events.values()]
        .filter(
          (entry) => (entry.saved || entry.rating) && matches(entry.paperId),
        )
        .reverse(),
      ...termRanks(
        frequencies(onTopic, picks, documents, excluded),
        frequencies(
          [...oldPapers.values()].filter((paper) =>
            paper.topics.includes(topic),
          ),
          oldPicks,
          oldDocuments,
          excluded,
        ),
        rare,
      ),
      ...(baseline && { comparison: baseline }),
    };
  });
}
