import { z } from "zod";
import { loadFullFeed } from "@litscout/pipeline/read-client";
import { chunks, type FeedApi } from "@litscout/pipeline/api";
import { externalId } from "@litscout/pipeline/daily";
import type { LegacyPlan } from "./legacy";
type Step = () => Promise<void>;
type Day = LegacyPlan["days"][number];
type Ids = Map<string, string>;
export async function resolveDay(api: FeedApi, day: string, ids: Ids) {
  const feed = await loadFullFeed(api, day);
  for (const p of feed.items) ids.set(externalId(p), p.paperId);
}
function paperSteps(d: Day, api: FeedApi, ids: Ids): Step[] {
  return chunks(d.papers).map((papers) => async () => {
    const out = z
      .object({
        papers: z.array(z.object({ key: z.string(), paperId: z.string() })),
      })
      .parse(
        await api.write(
          "/ingest/papers",
          { day: d.day, papers, legacy: "import" },
          papers.length * 200,
        ),
      );
    out.papers.forEach((p) => ids.set(p.key, p.paperId));
  });
}
function summarySteps(
  d: Day,
  api: FeedApi,
  ids: Ids,
  grouped: boolean,
): Step[] {
  const seen = new Set<string>();
  return chunks(d.summaries).map((summaries) => async () => {
    if (!grouped && summaries.some((s) => !ids.has(s.key)))
      await resolveDay(api, d.day, ids);
    const known = summaries.filter((s) => {
      const id = ids.get(s.key);
      const token = id + ":" + s.lang;
      if (!id || seen.has(token)) return false;
      seen.add(token);
      return true;
    });
    if (!known.length) return;
    const values = known.map((s) => ({
      paperId: ids.get(s.key),
      lang: s.lang,
      content: s.content,
      client: "legacy",
    }));
    await api.write(
      "/ingest/summaries",
      { day: d.day, summaries: values, legacy: true },
      known.length * 100,
    );
  });
}
function daySteps(
  plan: LegacyPlan,
  api: FeedApi,
  ids: Ids,
  grouped: boolean,
): Step[] {
  return plan.days.flatMap((d) => [
    ...paperSteps(d, api, ids),
    ...summarySteps(d, api, ids, grouped),
    async () => {
      const counts = Object.fromEntries(
        [...new Set(d.papers.map((p) => p.source))].map((s) => [
          s,
          d.papers.filter((p) => p.source === s).length,
        ]),
      );
      // As in the regular run, a paper without an abstract cannot be
      // summarised, so it does not keep the day "in progress" for ever.
      const complete = new Set(d.summaries.map((s) => s.key));
      const status = d.papers.every(
        (p) => !p.abstract?.trim() || complete.has(p.key),
      )
        ? "summarised"
        : "crawled";
      await api.write("/ingest/feed-day", { day: d.day, status, counts }, 10);
    },
  ]);
}
function digestSteps(plan: LegacyPlan, api: FeedApi, ids: Ids): Step[] {
  return plan.digests.map((d) => async () => {
    const mentioned = [...ids]
      .filter(
        ([key]) =>
          d.bodyMd.includes(key) || d.bodyMd.includes(encodeURIComponent(key)),
      )
      .map(([, id]) => id);
    const picks = [
      ...new Set([
        ...mentioned,
        ...plan.ledger
          .filter((p) => p.day === d.day && ids.has(p.key))
          .map((p) => ids.get(p.key)!),
      ]),
    ];
    await api.write(
      `/digests/${d.day}`,
      {
        ...d,
        lang: /[\u3400-\u9fff]/.test(d.bodyMd) ? "zh" : "en",
        kind: "daily",
        picks,
        radar: [],
        final: true,
      },
      20,
      "PUT",
    );
  });
}
function radarSteps(plan: LegacyPlan, api: FeedApi, ids: Ids): Step[] {
  return chunks(plan.radar).map((rows) => async () => {
    const radar = rows
      .filter((r) => ids.has(r.key))
      .map((r) => ({
        day: r.day,
        paperId: ids.get(r.key),
        level: r.level,
        reason: r.reason || "Legacy radar",
        fullTextRead: /已读全文|full text read/i.test(r.action),
        action: r.action,
        lookBack: r.lookBack,
      }));
    await api.write("/ingest/radar", { radar }, rows.length * 10);
  });
}
function missedSteps(plan: LegacyPlan, api: FeedApi, ids: Ids): Step[] {
  return chunks(plan.missed).map((rows) => async () => {
    const missed = rows
      .filter((m) => ids.has(m.key))
      .map((m) => ({
        id: `miss_legacy_${m.day}_${m.key}`,
        paperId: ids.get(m.key),
        foundOn: m.day,
        where: "legacy",
        note: `${m.level}: ${m.reason}`,
      }));
    await api.write("/ingest/legacy", { missed }, 1000);
  });
}
function ratingSteps(plan: LegacyPlan, api: FeedApi, ids: Ids): Step[] {
  return chunks(plan.ratings).map((rows) => async () => {
    const ratings = rows
      .filter((r) => ids.has(r.key))
      .map((r) => ({
        id: `evt_legacy_${r.day}_${r.key}`,
        paperId: ids.get(r.key),
        day: r.day,
        kind: r.kind,
        source: "legacy",
        at: r.day + "T00:00:00Z",
      }));
    await api.write("/ingest/legacy", { ratings }, 1000);
  });
}
export function legacySteps(
  plan: LegacyPlan,
  api: FeedApi,
  ids: Ids = new Map(),
  grouped = false,
): Step[] {
  const resolve = async () => {
    for (const d of plan.days)
      if (d.papers.some((p) => !ids.has(p.key)))
        await resolveDay(api, d.day, ids);
  };
  return [
    ...daySteps(plan, api, ids, grouped),
    ...(grouped ? [] : [resolve]),
    ...digestSteps(plan, api, ids),
    ...radarSteps(plan, api, ids),
    ...chunks(plan.cursors).map((cursors) => async () => {
      await api.write("/ingest/legacy", { cursors }, 1000);
    }),
    ...chunks(plan.runs).map((runs) => async () => {
      await api.write("/ingest/legacy", { runs }, 1000);
    }),
    ...missedSteps(plan, api, ids),
    ...ratingSteps(plan, api, ids),
  ];
}
