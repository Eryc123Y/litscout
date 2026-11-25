import { load, type CheerioAPI } from "cheerio";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import { retryAfterMs } from "./http/fetch-retry";
export const listingPaper = z.object({
  id: z.string().min(1),
  categories: z.array(z.string()),
  pdf: z.string(),
  abs: z.string(),
  authors: z.array(z.string()),
  title: z.string(),
  comment: z.string().nullable(),
  summary: z.string(),
  code_url: z.string().optional(),
  announced: z.iso.date().optional(),
});
export type ListingPaper = z.infer<typeof listingPaper>;
export type SourceDeps = {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
};
const normal = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(Title|Comments|Subjects):\s*/, "");
const categoryCodes = (text: string) =>
  [...text.matchAll(/\(([a-z-]+(?:\.[A-Za-z-]+)?)\)/g)].map((m) => m[1]!);
const repos =
  /^https?:\/\/(?:(?:github\.com|gitlab\.com|codeberg\.org)\/[\w.-]+\/[\w.-]+|anonymous\.4open\.science\/r\/[\w.-]+)/;
const project = /^https?:\/\/[\w-]+\.git(?:hub|lab)\.io(?:\/[\w.\-/]*)?/;
const withdrawal = (text: string) =>
  /^(?:\[withdrawn\]|withdrawn(?:\s+by\b|[:.]|$)|this (?:paper|article|submission|preprint) (?:has been|is|was) withdrawn\b)/i.test(
    text,
  );

function listingId(dt: ReturnType<CheerioAPI>) {
  const anchor = dt.find('a[title="Abstract"]');
  return (
    anchor.attr("id") ||
    anchor.attr("href")?.split("/abs/").at(1) ||
    ""
  ).trim();
}

function paper($: CheerioAPI, dt: ReturnType<CheerioAPI>) {
  const dd = dt.next("dd");
  const identifier = listingId(dt);
  const version = identifier.match(/v(\d+)$/);
  const id = version ? identifier.slice(0, version.index) : identifier;
  const title = normal(dd.find(".list-title").text()),
    comment = normal(dd.find(".list-comments").text()),
    summary = normal(dd.find("p.mathjax").text());
  if (
    !id ||
    !title ||
    (version && Number(version[1]) > 1) ||
    [title, comment, summary].some(withdrawal)
  )
    return undefined;
  const links = dd
    .find("p.mathjax a, .list-comments a")
    .toArray()
    .map((a) => $(a).attr("href") || "");
  const code = [repos, project]
    .flatMap((pattern) =>
      links.map((l) => l.match(pattern)?.[0]).filter(Boolean),
    )[0]
    ?.replace(/[.,)]+$/, "")
    .replace(/\.git$/, "");
  return listingPaper.parse({
    id,
    categories: [
      ...new Set([
        ...categoryCodes(dd.find(".list-subjects .primary-subject").text()),
        ...categoryCodes(normal(dd.find(".list-subjects").text())),
      ]),
    ],
    pdf: `https://arxiv.org/pdf/${id}`,
    abs: `https://arxiv.org/abs/${id}`,
    authors: dd
      .find(".list-authors a")
      .toArray()
      .map((a) => $(a).text().trim())
      .filter(Boolean),
    title,
    comment: comment || null,
    summary,
    ...(code ? { code_url: code } : {}),
  });
}
function cutoff(papers: ListingPaper[], today: string) {
  const months = papers
    .map((p) => p.id.match(/^(\d{4})\.\d{4,5}$/)?.[1])
    .filter((v): v is string => Boolean(v))
    .sort();
  return (
    months[0] ??
    new Date(Date.parse(today) - 7 * 86400000)
      .toISOString()
      .slice(2, 7)
      .replace("-", "")
  );
}
const late = (p: ListingPaper, month: string) =>
  /^(\d{4})\.\d{4,5}$/.test(p.id) && p.id.slice(0, 4) < month;
function parseNew($: CheerioAPI, today: string) {
  let cross = Infinity,
    replace = Infinity;
  $("#dlpage ul li a").each((_, a) => {
    const n = Number(
      $(a)
        .attr("href")
        ?.match(/#item(\d+)$/)?.[1],
    );
    const label = $(a).text().toLowerCase();
    if (n && label.includes("cross")) cross = n;
    if (n && label.includes("replace")) replace = n;
  });
  const fresh: ListingPaper[] = [],
    crosses: ListingPaper[] = [];
  $("#dlpage dl dt").each((_, el) => {
    const dt = $(el),
      anchor = dt.find('a[name^="item"]').attr("name");
    if (!anchor) return;
    const n = Number(anchor.slice(4));
    const entry = n < replace ? paper($, dt) : undefined;
    if (entry) (n >= cross ? crosses : fresh).push(entry);
  });
  return newPapers(fresh, crosses, today);
}
function newPapers(
  fresh: ListingPaper[],
  crosses: ListingPaper[],
  today: string,
) {
  const month = cutoff(fresh, today);
  return [...fresh, ...crosses.filter((p) => !late(p, month))];
}
function recentDate(block: ReturnType<CheerioAPI>) {
  const date = block
    .find("h3")
    .first()
    .text()
    .match(/^\s*\w{3}, (\d{1,2} \w{3} \d{4})/)?.[1];
  const instant = Date.parse(date + " UTC");
  return Number.isFinite(instant)
    ? new Date(instant).toISOString().slice(0, 10)
    : undefined;
}
function parseRecent($: CheerioAPI, category: string) {
  const result: ListingPaper[] = [];
  $("#dlpage dl").each((_, el) => {
    const announced = recentDate($(el));
    if (!announced) return;
    const items = $(el)
      .find("dt")
      .toArray()
      .flatMap((dt) => paper($, $(dt)) ?? []);
    const month = cutoff(
      items.filter((p) => p.categories[0] === category),
      announced,
    );
    result.push(
      ...items
        .filter((p) => p.categories[0] === category || !late(p, month))
        .map((p) => ({ ...p, announced })),
    );
  });
  return result;
}

function sectionKind(title: string) {
  if (/^new submissions\b/i.test(title)) return "new";
  if (/^cross\b/i.test(title)) return "cross";
  if (/^replacement/i.test(title)) return "replacement";
}

function sectionCount(title: string) {
  const match = title.match(/showing ([\d,]+) of ([\d,]+) entries/i);
  if (match)
    return {
      shown: Number(match[1]!.replaceAll(",", "")),
      total: Number(match[2]!.replaceAll(",", "")),
    };
}

function validRow(dt: ReturnType<CheerioAPI>) {
  return Boolean(
    listingId(dt) && normal(dt.next("dd").find(".list-title").text()),
  );
}

function newSections($: CheerioAPI) {
  const headings = $("#dlpage h3")
    .toArray()
    .filter((heading) => sectionKind($(heading).text().trim()));
  if (!headings.length) return undefined;
  const starts = new Map(
    $("#dlpage ul li a[href^='#item']")
      .toArray()
      .flatMap((link) => {
        const kind = sectionKind($(link).text().trim());
        const start = Number($(link).attr("href")?.slice(5));
        return kind && Number.isFinite(start) ? [[kind, start] as const] : [];
      }),
  );
  const required = [...starts.keys()].filter(
    (kind) => kind === "new" || kind === "cross",
  );
  const sections = headings.flatMap((heading) => {
    const title = $(heading).text().trim();
    const kind = sectionKind(title);
    if (kind !== "new" && kind !== "cross") return [];
    const section = $(heading);
    const list = section.nextUntil("h3", "dl");
    const rows = section.parent().is("dl")
      ? section.nextUntil("h3", "dt").toArray()
      : list.length
        ? list.find("dt").toArray()
        : $("#dlpage dl dt")
            .toArray()
            .filter((row) => {
              const name = $(row).find('a[name^="item"]').attr("name");
              const item = Number(name?.slice(4));
              const first = starts.get(kind);
              const next =
                kind === "new"
                  ? (starts.get("cross") ?? starts.get("replacement"))
                  : starts.get("replacement");
              return (
                first !== undefined &&
                item >= first &&
                item < (next ?? Infinity)
              );
            });
    const count = sectionCount(title);
    return [
      {
        kind,
        total: count?.total,
        ids: rows.map((row) => listingId($(row))),
        valid:
          count?.shown === rows.length && rows.every((row) => validRow($(row))),
        papers: rows.flatMap((row) => paper($, $(row)) ?? []),
      },
    ];
  });
  return { required, sections };
}

type CorePage = NonNullable<ReturnType<typeof newSections>>;
function mergeCorePages(pages: CorePage[], today: string) {
  const sections = pages.flatMap((page) => page.sections);
  const required = pages.flatMap((page) => page.required);
  const complete =
    sections.length > 0 &&
    (["new", "cross"] as const).every((kind) => {
      const parts = sections.filter((section) => section.kind === kind);
      if (!parts.length) return !required.includes(kind);
      const total = parts[0]!.total;
      const ids = parts.flatMap((part) => part.ids);
      return (
        total === ids.length &&
        new Set(ids).size === ids.length &&
        parts.every((part) => part.valid && part.total === total)
      );
    });
  const papersFor = (kind: "new" | "cross") =>
    sections.flatMap((section) =>
      section.kind === kind ? section.papers : [],
    );
  return {
    complete,
    papers: newPapers(papersFor("new"), papersFor("cross"), today),
  };
}

export function mergeNewListings(
  pages: ReturnType<typeof parseListing>[],
  today: string,
) {
  const first = pages[0]!;
  if (pages.length === 1) return first;
  if (pages.every((page) => page.core && page.day === first.day))
    return {
      ...first,
      ...mergeCorePages(
        pages.map((page) => page.core!),
        today,
      ),
    };
  return { ...first, complete: false };
}

export function parseListing(
  html: string,
  category: string,
  kind: "new" | "recent",
  today = new Date().toISOString().slice(0, 10),
) {
  const $ = load(html);
  if (!$("#dlpage").length) throw new Error("arXiv listing unavailable");
  const rows = $("#dlpage dl dt");
  const day = $("#dlpage h3")
    .first()
    .text()
    .match(/(?:\w+,?\s+)?(\d{1,2} \w+ \d{4})/)?.[1];
  const reported = html.match(/Total of ([\d,]+) entries/)?.[1];
  const total =
    reported === undefined ? rows.length : Number(reported.replaceAll(",", ""));
  const core = kind === "new" ? newSections($) : undefined;
  if (core) return { ...mergeCorePages([core], today), total, core, day };
  const sections = $("#dlpage h3")
    .toArray()
    .flatMap((heading) => sectionCount($(heading).text()) ?? []);
  const complete =
    (rows.length > 0 || reported === "0" || sections.length > 0) &&
    (kind !== "new" ||
      (total === rows.length && sections.every((s) => s.shown === s.total))) &&
    (!sections.length ||
      sections.reduce((sum, section) => sum + section.shown, 0) ===
        rows.length) &&
    rows.toArray().every((row) => validRow($(row))) &&
    (kind !== "recent" ||
      $("#dlpage dl")
        .toArray()
        .every((el) => {
          const block = $(el);
          return !block.find("dt").length || Boolean(recentDate(block));
        }));
  const papers = kind === "new" ? parseNew($, today) : parseRecent($, category);
  return { papers, complete, total, core, day };
}
/** One shared client for listings, pagination, abstracts and retries. */
export function arxivClient(impl: typeof fetch, sleep: SourceDeps["sleep"]) {
  let called = false;
  return (async (input, init) => {
    if (called) await sleep(3000);
    called = true;
    return impl(input, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(60000),
      headers: { "User-Agent": "LitScout/0.1 (local feed)", ...init?.headers },
    });
  }) as typeof fetch;
}
const atom = z.object({
  feed: z.union([
    z.literal("").transform(() => ({ entry: [] })),
    z.object({
      entry: z
        .array(
          z.object({
            id: z.string(),
            summary: z.string().optional(),
            title: z.string().optional(),
            comment: z.string().optional(),
          }),
        )
        .default([]),
    }),
  ]),
});
export async function fetchAbstracts(
  ids: readonly string[],
  deps: SourceDeps & {
    signal?: AbortSignal;
    onUnavailable?: (ids: string[], error: unknown) => void;
  },
  throttled = false,
) {
  const request = throttled ? deps.fetch : arxivClient(deps.fetch, deps.sleep);
  const found = new Map<string, string | null>();
  for (let start = 0; start < ids.length; start += 100) {
    if (deps.signal?.aborted) {
      if (!deps.onUnavailable) deps.signal.throwIfAborted();
      deps.onUnavailable?.(ids.slice(start), deps.signal.reason);
      break;
    }
    const batch = ids.slice(start, start + 100);
    const wanted = new Set(batch);
    const query = new URLSearchParams({
      id_list: batch.join(","),
      max_results: String(batch.length),
    });
    let error: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        deps.signal?.throwIfAborted();
        const response = await request(
          `https://export.arxiv.org/api/query?${query}`,
        );
        if (!response.ok) {
          const failure = new Error(`arXiv API HTTP ${response.status}`);
          const delay = retryAfterMs(
            response.headers.get("retry-after"),
            deps.now,
          );
          await response.body?.cancel();
          if (delay !== undefined && delay > 60_000) {
            error = failure;
            break;
          }
          if (delay && attempt < 2) await deps.sleep(delay);
          throw failure;
        }
        const xml = await response.text();
        if (XMLValidator.validate(xml) !== true)
          throw new Error("Invalid arXiv Atom");
        const parsed = atom.parse(
          new XMLParser({
            removeNSPrefix: true,
            parseTagValue: false,
            isArray: (name) => name === "entry",
          }).parse(xml),
        );
        for (const entry of parsed.feed.entry) {
          const id = entry.id.split("/abs/").at(1)?.replace(/v\d+$/, "");
          const summary = normal(entry.summary ?? "");
          if (!id || !wanted.has(id)) continue;
          if (
            [
              summary,
              normal(entry.title ?? ""),
              normal(entry.comment ?? ""),
            ].some(withdrawal)
          )
            found.set(id, null);
          else if (summary && !found.has(id)) found.set(id, summary);
        }
        error = undefined;
        if (batch.every((id) => found.has(id))) break;
      } catch (caught) {
        error = caught;
        if (deps.signal?.aborted) break;
      }
    }
    if (error) {
      if (!deps.onUnavailable)
        throw new Error("arXiv API did not answer", { cause: error });
      deps.onUnavailable(
        batch.filter((id) => !found.has(id)),
        error,
      );
    }
  }
  return Object.fromEntries(found);
}
export function backfill(
  papers: ListingPaper[],
  wanted: readonly string[],
  abstracts: Record<string, string | null>,
) {
  const covered = [
    ...new Set(papers.flatMap((p) => (p.announced ? [p.announced] : []))),
  ].sort();
  const days: Record<string, ListingPaper[]> = {};
  const gaps = new Set<string>();
  for (const { announced, ...p } of papers) {
    if (!announced || !wanted.includes(announced)) continue;
    const abstract = Object.hasOwn(abstracts, p.id)
      ? abstracts[p.id]
      : undefined;
    if (abstract) (days[announced] ??= []).push({ ...p, summary: abstract });
    else if (abstract === undefined) gaps.add(announced);
  }
  return { covered, days, gaps: [...gaps].sort() };
}
